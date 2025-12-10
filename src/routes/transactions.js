const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);

router.get("/for-calendar", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  // 1. Obtener todas las transacciones (planificadas y reales)
  const { data: allTxs, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  // 2. Mapear transacciones reales insertadas por recurrencia
  const realRecurringTxsSet = new Set();

  for (const tx of allTxs) {
    if (tx.recurrence_origin_id) {
      const key = `${tx.recurrence_origin_id}_${tx.date}`;
      realRecurringTxsSet.add(key);
    }
  }

  const result = [];

  for (const tx of allTxs) {
    // Transacción normal (no recurrente)
    if (!tx.recurrence) {
      result.push(tx);
      continue;
    }

    const startDate = dayjs(tx.date);
    const endDate = tx.recurrence_end_date
      ? dayjs(tx.recurrence_end_date)
      : dayjs().add(3, "months"); // proyección corta si no hay fin

    let current = startDate;

    // Generar fechas según recurrencia
    while (current.isSameOrBefore(endDate)) {
      const projectedDate = current.format("YYYY-MM-DD");
      const key = `${tx.id}_${projectedDate}`;

      if (!realRecurringTxsSet.has(key)) {
        result.push({
          ...tx,
          date: projectedDate,
          isProjected: true, // útil para diferenciar en UI
        });
      }

      // Avanzar según recurrencia
      if (tx.recurrence === "weekly") {
        current = current.add(1, "week");
      } else if (tx.recurrence === "biweekly") {
        current = current.add(2, "week");
      } else if (tx.recurrence === "monthly") {
        current = current.add(1, "month");
      } else {
        current = current.add(1, "day");
      }
    }
  }

  res.json({ success: true, data: result });
});

// ✅ Obtener transacciones del usuario (con filtros)
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { description, type, account_id, category_id, date_from, date_to } =
    req.query;

  try {
    let query = supabase
      .from("transactions")
      .select(
        `
      *,
      account:accounts!transactions_account_id_fkey (id, name),
      account_from:accounts!transactions_account_from_fkey (id, name),
      account_to:accounts!transactions_account_to_fkey (id, name),
      categories (id, name, type)
    `
      )
      .eq("user_id", user_id);

    // 🔍 Filtro por descripción (búsqueda parcial)
    if (description && description.trim() !== "") {
      query = query.ilike("description", `%${description.trim()}%`);
    }

    // 🔍 Filtro por tipo (expense, income, transfer...)
    if (type && type !== "all") {
      query = query.eq("type", type);
    }

    // 🔍 Filtro por categoría
    if (category_id) {
      query = query.eq("category_id", category_id);
    }

    // 🔍 Filtro por cuenta (en cualquiera de los campos de cuenta)
    if (account_id) {
      query = query.or(
        `account_id.eq.${account_id},account_from_id.eq.${account_id},account_to_id.eq.${account_id}`
      );
    }

    // 🔍 Filtro por fecha desde / hasta
    if (date_from) {
      query = query.gte("date", date_from);
    }
    if (date_to) {
      query = query.lte("date", date_to);
    }

    // Orden por fecha descendente
    query = query.order("date", { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error("🔥 Error al obtener transacciones:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error("🔥 Error inesperado al obtener transacciones:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/:id/items", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  // Validar que la transacción sea del usuario
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("id, user_id")
    .eq("id", id)
    .eq("user_id", user_id)
    .single();

  if (txError || !tx) {
    return res.status(404).json({ error: "Transacción no encontrada" });
  }

  const { data, error } = await supabase
    .from("transaction_items")
    .select(
      `
      id,
      quantity,
      unit_price_net,
      unit_price_final,
      line_total_final,
      tax_rate_used,
      is_exempt_used,
      items ( id, name )
    `
    )
    .eq("transaction_id", id);

  if (error) {
    console.error("Error obteniendo items de transacción:", error);
    return res.status(500).json({ error: "Error obteniendo artículos." });
  }

  res.json({ success: true, data });
});

// ✅ Crear transacción con o sin artículos
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const {
    amount: rawAmount,
    account_id,
    category_id,
    type,
    description,
    date,
    recurrence,
    recurrence_end_date,
    items = [],
    discount = 0, // descuento % a nivel de transacción
  } = req.body;

  let amount = rawAmount;
  let transactionItems = [];

  if (!account_id || !category_id || !type || !date) {
    return res.status(400).json({ error: "Campos obligatorios faltantes." });
  }

  // ✅ Si se proveen artículos, usamos "items_with_price" y calculamos totales
  if (items.length > 0) {
    const itemIds = items.map((i) => i.item_id);

    const { data: itemData, error: itemError } = await supabase
      .from("items_with_price")
      .select("id, latest_price, is_exempt, tax_rate")
      .in("id", itemIds);

    if (itemError) {
      console.error("🧨 Error al obtener datos de artículos:", itemError);
      return res.status(500).json({ error: "Error al obtener precios." });
    }

    const discountRate = parseFloat(discount) || 0;
    let totalFinal = 0;

    for (const item of items) {
      const ref = itemData.find((i) => i.id === item.item_id);
      if (!ref) continue;

      const qty = parseFloat(item.quantity) || 1;
      const unitPriceNet = parseFloat(ref.latest_price || 0); // sin ITBIS
      const taxRate = ref.is_exempt ? 0 : parseFloat(ref.tax_rate || 0);

      const lineSubtotalNet = unitPriceNet * qty;
      const lineTaxAmount = lineSubtotalNet * (taxRate / 100);
      const lineTotalGross = lineSubtotalNet + lineTaxAmount; // con ITBIS, sin desc.

      const lineDiscountAmount =
        discountRate > 0 ? lineTotalGross * (discountRate / 100) : 0;

      const lineTotalFinal = lineTotalGross - lineDiscountAmount; // con ITBIS y desc.
      const unitPriceFinal = qty > 0 ? lineTotalFinal / qty : lineTotalFinal;

      totalFinal += lineTotalFinal;

      transactionItems.push({
        item_id: item.item_id,
        quantity: qty,
        unit_price_net: unitPriceNet,
        unit_price_final: unitPriceFinal,
        line_total_final: lineTotalFinal,
        tax_rate_used: taxRate,
        is_exempt_used: ref.is_exempt ?? false,
      });
    }

    // amount de la transacción = suma de totales finales (ITBIS + descuento)
    amount = totalFinal;
  }

  // ✅ AHORA SÍ, después de construir transactionItems
  const isShoppingList = transactionItems.length > 0;

  // ✅ Insertar transacción
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .insert([
      {
        user_id,
        amount,
        account_id,
        category_id,
        type,
        description,
        date,
        recurrence: recurrence || null,
        recurrence_end_date: recurrence_end_date || null,
        discount_percent: parseFloat(discount) || 0,
        is_shopping_list: isShoppingList, // 👈 ahora sí correcto
      },
    ])
    .select()
    .single();

  if (txError) {
    console.error("❌ Error al crear transacción:", txError);
    return res
      .status(500)
      .json({ error: txError.message || "Error al crear transacción." });
  }

  // ✅ Insertar relación con artículos
  if (transactionItems.length > 0) {
    const insertData = transactionItems.map((i) => ({
      transaction_id: tx.id,
      item_id: i.item_id,
      quantity: i.quantity,
      unit_price_net: i.unit_price_net,
      unit_price_final: i.unit_price_final,
      line_total_final: i.line_total_final,
      tax_rate_used: i.tax_rate_used,
      is_exempt_used: i.is_exempt_used,
    }));

    const { error: insertError } = await supabase
      .from("transaction_items")
      .insert(insertData);

    if (insertError) {
      console.error("🧨 Error al guardar artículos:", insertError);
      return res
        .status(500)
        .json({ error: insertError.message || "Error al guardar artículos." });
    }
  }

  res.json({ success: true, data: tx });
});

// ✅ Eliminar transacción (y sus artículos por cascade)
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("transactions")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) {
    console.error("🧨 Error al eliminar transacción:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, message: "Transacción eliminada" });
});

router.post("/import-shopping-list",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const {
      account_id,
      category_id,
      date,
      description = "",
      discount = 0,   // porcentaje 0–100
      lines = [],
    } = req.body;

    if (!account_id || !category_id || !date) {
      return res
        .status(400)
        .json({ error: "Faltan account_id, category_id o date" });
    }

    if (!Array.isArray(lines) || lines.length === 0) {
      return res
        .status(400)
        .json({ error: "Debes enviar al menos una línea en 'lines'" });
    }

    try {
      const itemIds = Array.from(
        new Set(
          lines
            .map((l) => l.item_id)
            .filter((id) => typeof id === "string" && id.length > 0)
        )
      );

      if (itemIds.length === 0) {
        return res
          .status(400)
          .json({ error: "Las líneas no contienen item_id válidos" });
      }

      // 1) Items + impuestos
      const { data: itemsData, error: itemsError } = await supabase
        .from("items")
        .select("id, user_id, tax_id, taxes:tax_id(rate, is_exempt)")
        .in("id", itemIds);

      if (itemsError) {
        console.error("❌ Error leyendo items:", itemsError);
        return res
          .status(500)
          .json({ error: "No se pudieron leer los artículos" });
      }

      // asegurar que todo es del usuario
      const filteredItems = (itemsData || []).filter(
        (it) => it.user_id === user_id
      );
      const itemMap = new Map(filteredItems.map((it) => [it.id, it]));

      // 2) Precios existentes para esa fecha
      const { data: existingPrices, error: priceFetchErr } = await supabase
        .from("item_prices")
        .select("id, item_id, price, date")
        .eq("date", date)
        .in("item_id", itemIds);

      if (priceFetchErr) {
        console.error("❌ Error leyendo item_prices:", priceFetchErr);
        return res
          .status(500)
          .json({ error: "No se pudieron leer precios existentes" });
      }

      const existingMap = new Map(
        (existingPrices || []).map((p) => [p.item_id, p])
      );

      const discountPct = Number(discount || 0);
      const discountFactor =
        discountPct > 0 ? 1 - discountPct / 100 : 1;

      let totalBeforeDiscount = 0;

      const pricesToInsert = [];
      const pricesToUpdate = [];
      const transactionItemRows = [];

      for (const line of lines) {
        const itemId = line.item_id;
        const rawQty = Number(line.quantity || 0) || 1;
        const priceSource = line.price_source === "existing" ? "existing" : "new";

        const item = itemMap.get(itemId);
        if (!item) {
          console.warn(
            "⚠️ Línea con item_id no encontrado o de otro usuario, se omite:",
            itemId
          );
          continue;
        }

        const existingRow = existingMap.get(itemId);
        const existingPrice = existingRow
          ? Number(existingRow.price || 0)
          : 0;

        let usedPrice;

        if (priceSource === "existing") {
          // 👇 importante: el "precio existente" viene de BD, no del cliente
          usedPrice = existingPrice;
        } else {
          // usamos el precio nuevo del archivo
          usedPrice = Number(line.unit_price || 0);
        }

        // ✅ Validación: precio > 0 obligatorio
        if (!usedPrice || usedPrice <= 0) {
          return res.status(400).json({
            error: `El artículo seleccionado tiene precio 0 para la fecha ${date}. Revisa el archivo o registra un precio válido.`,
            item_id: itemId,
          });
        }

        const qty = rawQty;
        const taxRate = Number(item.taxes?.rate || 0);
        const isExempt =
          item.taxes?.is_exempt === true ? true : false;

        const subtotal = usedPrice * qty;
        const taxAmount = isExempt ? 0 : subtotal * (taxRate / 100);
        const lineTotalWithTax = subtotal + taxAmount;

        totalBeforeDiscount += lineTotalWithTax;

        // Manejo de item_prices (sin duplicar fechas)
        if (!existingRow) {
          // no hay precio ese día → insert
          pricesToInsert.push({
            item_id: itemId,
            price: usedPrice,
            date,
          });
        } else if (priceSource === "new" && usedPrice !== existingPrice) {
          // hay precio y el usuario eligió "nuevo" → actualizar
          pricesToUpdate.push({
            id: existingRow.id,
            price: usedPrice,
          });
        }
        // si elige "existing" y ya había precio → no tocamos item_prices

        // info para transaction_items
        transactionItemRows.push({
          item_id: itemId,
          quantity: qty,
          unit_price_net: usedPrice,
          tax_rate_used: taxRate,
          is_exempt_used: isExempt,
          lineTotalWithTax,
        });
      }

      if (transactionItemRows.length === 0) {
        return res.status(400).json({
          error:
            "Ninguna línea del archivo coincide con artículos válidos para este usuario.",
        });
      }

      const totalAfterDiscount =
        totalBeforeDiscount * discountFactor;

      // 3) Insertar / actualizar precios
      if (pricesToInsert.length > 0) {
        const { error: insertPriceErr } = await supabase
          .from("item_prices")
          .insert(pricesToInsert);
        if (insertPriceErr) {
          console.error(
            "❌ Error insertando item_prices:",
            insertPriceErr
          );
          return res.status(500).json({
            error: "No se pudieron guardar los precios de los artículos",
          });
        }
      }

      if (pricesToUpdate.length > 0) {
        const updateResults = await Promise.all(
          pricesToUpdate.map((p) =>
            supabase
              .from("item_prices")
              .update({ price: p.price })
              .eq("id", p.id)
          )
        );
        const someError = updateResults.find((r) => r.error);
        if (someError) {
          console.error(
            "❌ Error actualizando item_prices:",
            someError.error
          );
          return res.status(500).json({
            error: "No se pudieron actualizar algunos precios",
          });
        }
      }

      // 4) Crear la transacción
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .insert([
          {
            user_id,
            account_id,
            category_id,
            amount: totalAfterDiscount,
            type: "expense",
            description:
              description ||
              "Lista de compra importada desde archivo",
            date,
            discount_percent: discountPct,
            is_shopping_list: true,
          },
        ])
        .select()
        .single();

      if (txErr || !tx) {
        console.error("❌ Error creando transacción:", txErr);
        return res.status(500).json({
          error: "No se pudo crear la transacción de lista de compras",
        });
      }

      // 5) Insertar transaction_items
      const txItemsToInsert = transactionItemRows.map((row) => {
        const lineTotalFinal =
          row.lineTotalWithTax * discountFactor;
        const unitPriceFinal =
          row.quantity > 0
            ? lineTotalFinal / row.quantity
            : row.lineTotalWithTax;

        return {
          transaction_id: tx.id,
          item_id: row.item_id,
          unit_price_net: row.unit_price_net,
          quantity: row.quantity,
          unit_price_final: unitPriceFinal,
          line_total_final: lineTotalFinal,
          tax_rate_used: row.tax_rate_used,
          is_exempt_used: row.is_exempt_used,
        };
      });

      const { error: txItemsErr } = await supabase
        .from("transaction_items")
        .insert(txItemsToInsert);

      if (txItemsErr) {
        console.error(
          "❌ Error insertando transaction_items:",
          txItemsErr
        );
        return res.status(500).json({
          error:
            "La transacción se creó, pero falló el detalle de artículos",
        });
      }

      return res.json({
        success: true,
        data: {
          transaction: tx,
          totalBeforeDiscount,
          totalAfterDiscount,
          discount: discountPct,
          lines: txItemsToInsert.length,
        },
      });
    } catch (e) {
      console.error(
        "❌ Error inesperado en import-shopping-list:",
        e
      );
      return res.status(500).json({
        error: "Error inesperado al importar la lista de compras",
      });
    }
  }
);



module.exports = router;
