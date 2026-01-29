const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);

const ExcelJS = require("exceljs");

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

// ✅ Actualizar transacción (sin tocar artículos)
// - Si es lista de compras (is_shopping_list = true), el monto NO se puede editar
//   ni tampoco el tipo (siempre será "expense") ni el descuento ya aplicado.
// - Para transacciones normales, se puede editar monto, tipo y demás campos.
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const {
    amount,
    account_id,
    category_id,
    type,
    description,
    date,
    recurrence,
    recurrence_end_date,
  } = req.body;

  try {
    // 1) Buscar la transacción y validar que es del usuario
    const { data: existing, error: existingError } = await supabase
      .from("transactions")
      .select(
        `
        id,
        user_id,
        is_shopping_list,
        type
      `
      )
      .eq("id", id)
      .single();

    if (existingError || !existing) {
      console.error("❌ Error buscando transacción:", existingError);
      return res
        .status(404)
        .json({ error: "TRANS_NOT_FOUND", message: "Transacción no encontrada" });
    }

    if (existing.user_id !== user_id) {
      return res
        .status(403)
        .json({ error: "FORBIDDEN", message: "No puedes modificar esta transacción" });
    }

    const isShoppingList = existing.is_shopping_list === true;

    // 2) Construir payload de actualización
    const updatePayload = {};

    if (account_id) updatePayload.account_id = account_id;
    if (category_id) updatePayload.category_id = category_id;
    if (description !== undefined) updatePayload.description = description;
    if (date) updatePayload.date = date;

    // Recurrencia (opcional)
    updatePayload.recurrence = recurrence || null;
    updatePayload.recurrence_end_date = recurrence_end_date || null;

    // 3) Si NO es lista de compras → se puede editar monto y tipo
    if (!isShoppingList) {
      if (amount != null) {
        const numericAmount = Number(amount);
        if (Number.isNaN(numericAmount) || numericAmount < 0) {
          return res.status(400).json({
            error: "INVALID_AMOUNT",
            message: "El monto debe ser un número válido y no negativo",
          });
        }
        updatePayload.amount = numericAmount;
      }

      if (type) {
        // Opcional: validar que type sea uno de ["income", "expense", "transfer"]
        if (!["income", "expense", "transfer"].includes(type)) {
          return res.status(400).json({
            error: "INVALID_TYPE",
            message: "Tipo de transacción inválido",
          });
        }
        updatePayload.type = type;
      }
    } else {
      // 4) Si ES lista de compras → NO permitir cambiar amount ni type
      //    Para mayor seguridad, ignoramos cualquier amount/type que venga en el body
      //    y dejamos los existentes.
      // Podrías permitir cambiar type a futuro, pero por ahora lo fijamos.
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        error: "NO_FIELDS_TO_UPDATE",
        message: "No se enviaron campos válidos para actualizar",
      });
    }

    // 5) Ejecutar update
    const { data: updated, error: updateError } = await supabase
      .from("transactions")
      .update(updatePayload)
      .eq("id", id)
      .eq("user_id", user_id)
      .select(
        `
        *,
        account:accounts!transactions_account_id_fkey (id, name),
        account_from:accounts!transactions_account_from_fkey (id, name),
        account_to:accounts!transactions_account_to_fkey (id, name),
        categories (id, name, type)
      `
      )
      .single();

    if (updateError) {
      console.error("❌ Error actualizando transacción:", updateError);
      return res
        .status(500)
        .json({ error: updateError.message || "Error al actualizar transacción" });
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("🔥 Error inesperado en PUT /transactions/:id:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ===============================
// ✅ Shopping List V2 (Preview + Resolve Conflicts)
// Endpoints:
//   POST /transactions/shopping-list/preview
//   POST /transactions/shopping-list
// ===============================

const EPSILON = 0.0001;

function nearlyEqual(a, b, eps = EPSILON) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= eps;
}

function toNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function fetchItemsTaxAndLatestPrice({ supabase, user_id, itemIds }) {
  // 1) Info de impuestos (items + taxes)
  const { data: itemsData, error: itemsError } = await supabase
    .from("items")
    .select("id, user_id, tax_id, taxes:tax_id(rate, is_exempt)")
    .in("id", itemIds);

  if (itemsError) {
    console.error("❌ Error leyendo items:", itemsError);
    throw new Error("No se pudieron leer los artículos");
  }

  const ownedItems = (itemsData || []).filter((it) => it.user_id === user_id);
  const itemTaxMap = new Map(ownedItems.map((it) => [it.id, it]));

  // 2) latest_price (vista items_with_price)
  const { data: latestData, error: latestErr } = await supabase
    .from("items_with_price")
    .select("id, latest_price, user_id")
    .eq("user_id", user_id)
    .in("id", itemIds);

  if (latestErr) {
    console.error("❌ Error leyendo items_with_price:", latestErr);
    throw new Error("No se pudieron leer los precios latest_price");
  }

  const latestMap = new Map(
    (latestData || []).map((r) => [r.id, toNumber(r.latest_price, 0)])
  );

  return { itemTaxMap, latestMap };
}

async function fetchExistingPricesOnDate({ supabase, user_id, date, itemIds }) {
  // Nota: item_prices no tiene user_id. Por seguridad hacemos join a items
  // para filtrar por el usuario (similar a tu /item-prices/by-date).
  const { data, error } = await supabase
    .from("item_prices")
    .select("id, item_id, price, date, items:item_id (user_id)")
    .eq("date", date)
    .in("item_id", itemIds);

  if (error) {
    console.error("❌ Error leyendo item_prices:", error);
    throw new Error("No se pudieron leer los precios existentes para esa fecha");
  }

  const filtered = (data || []).filter(
    (row) => row.items && row.items.user_id === user_id
  );

  const existingMap = new Map(
    filtered.map((row) => [
      row.item_id,
      { id: row.id, price: toNumber(row.price, 0), date: row.date },
    ])
  );

  return existingMap;
}

// Calcula todo lo necesario por línea (net/gross)
// Retorna:
// - unit_price_net
// - unit_price_final
// - line_total_gross (antes de descuento)
// - tax_rate, is_exempt, tax_amount, net_total
function computeLine({ qty, taxRate, isExempt, price_input_mode, unit_price_net_input, gross_total_input }) {
  const q = qty > 0 ? qty : 1;
  const rate = isExempt ? 0 : toNumber(taxRate, 0);
  const factor = 1 + rate / 100;

  if (price_input_mode === "gross") {
    const grossTotal = toNumber(gross_total_input, 0);
    if (!grossTotal || grossTotal <= 0) {
      throw new Error("gross_total debe ser > 0 en modo 'gross'");
    }

    // net_total = gross_total / (1 + rate)
    const netTotal = factor > 0 ? grossTotal / factor : grossTotal;
    const taxAmount = grossTotal - netTotal;

    const unitNet = netTotal / q;
    const unitFinal = grossTotal / q;

    return {
      unit_price_net: unitNet,
      unit_price_final: unitFinal,
      line_total_gross: grossTotal, // ya incluye ITBIS
      net_total: netTotal,
      tax_amount: taxAmount,
      tax_rate_used: rate,
      is_exempt_used: isExempt === true,
    };
  }

  // default: net
  const unitNet = toNumber(unit_price_net_input, 0);
  if (!unitNet || unitNet <= 0) {
    throw new Error("unit_price_net debe ser > 0 en modo 'net'");
  }

  const netTotal = unitNet * q;
  const taxAmount = netTotal * (rate / 100);
  const grossTotal = netTotal + taxAmount;
  const unitFinal = grossTotal / q;

  return {
    unit_price_net: unitNet,
    unit_price_final: unitFinal,
    line_total_gross: grossTotal,
    net_total: netTotal,
    tax_amount: taxAmount,
    tax_rate_used: rate,
    is_exempt_used: isExempt === true,
  };
}

// -------------------------------
// POST /transactions/shopping-list/preview
// -------------------------------
router.post("/shopping-list/preview", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { date, discount = 0, lines = [] } = req.body;

  if (!date) {
    return res.status(400).json({ error: "Falta 'date' (YYYY-MM-DD)" });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "Debes enviar 'lines' con al menos 1 fila" });
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
      return res.status(400).json({ error: "No hay item_id válidos en lines" });
    }

    const { itemTaxMap, latestMap } = await fetchItemsTaxAndLatestPrice({
      supabase,
      user_id,
      itemIds,
    });

    // Precios existentes para esa fecha
    const existingMap = await fetchExistingPricesOnDate({
      supabase,
      user_id,
      date,
      itemIds,
    });

    const discountPct = toNumber(discount, 0);
    const discountFactor = discountPct > 0 ? 1 - discountPct / 100 : 1;

    const previewLines = [];
    let totalBeforeDiscount = 0;

    for (const raw of lines) {
      const item_id = raw.item_id;
      const qty = toNumber(raw.quantity, 1);
      const price_input_mode = raw.price_input_mode === "gross" ? "gross" : "net";

      const itemRow = itemTaxMap.get(item_id);
      if (!itemRow) {
        // item no es del usuario o no existe → lo marcamos como invalid
        previewLines.push({
          item_id,
          status: "invalid_item",
          message: "Artículo no encontrado o no pertenece al usuario",
        });
        continue;
      }

      const taxRate = toNumber(itemRow.taxes?.rate, 0);
      const isExempt = itemRow.taxes?.is_exempt === true;

      // Inputs de precio:
      const unit_price_net_input = toNumber(raw.unit_price_net, 0);
      const gross_total_input = toNumber(raw.gross_total, 0);

      let computed;
      try {
        computed = computeLine({
          qty,
          taxRate,
          isExempt,
          price_input_mode,
          unit_price_net_input,
          gross_total_input,
        });
      } catch (e) {
        previewLines.push({
          item_id,
          quantity: qty,
          price_input_mode,
          status: "invalid_price",
          message: e.message,
        });
        continue;
      }

      const latest_price = latestMap.get(item_id) ?? 0;

      const existing = existingMap.get(item_id) || null;
      const existing_price_on_date = existing ? existing.price : null;

      // Comparación dura contra el precio del día (si existe)
      let price_status = "insert_new";
      let needs_resolution = false;
      let default_resolution = "insert_new";

      if (existing) {
        if (nearlyEqual(existing.price, computed.unit_price_net)) {
          price_status = "same_as_existing";
          needs_resolution = false;
          default_resolution = "use_existing";
        } else {
          price_status = "conflict";
          needs_resolution = true;
          default_resolution = "use_existing";
        }
      } else {
        // No existe precio ese día
        // (Opcional) si es igual al latest, igual insertamos precio del día para trazabilidad.
        price_status = "insert_new";
        needs_resolution = false;
        default_resolution = "insert_new";
      }

      totalBeforeDiscount += computed.line_total_gross;

      previewLines.push({
        item_id,
        quantity: qty,
        price_input_mode,

        // Inputs originales
        input: {
          unit_price_net: price_input_mode === "net" ? unit_price_net_input : null,
          gross_total: price_input_mode === "gross" ? gross_total_input : null,
        },

        // Datos fiscales
        tax_rate: isExempt ? 0 : taxRate,
        is_exempt: isExempt,

        // Referencias
        latest_price,
        existing_price_on_date,
        existing_price_id: existing ? existing.id : null,

        // Computados (neto unitario y totales)
        computed: {
          unit_price_net: round2(computed.unit_price_net),
          unit_price_final: round2(computed.unit_price_final),
          net_total: round2(computed.net_total),
          tax_amount: round2(computed.tax_amount),
          line_total_gross: round2(computed.line_total_gross),
        },

        // Estado
        price_status, // same_as_existing | insert_new | conflict | invalid_*
        needs_resolution,
        default_resolution,
      });
    }

    const totalAfterDiscount = totalBeforeDiscount * discountFactor;

    return res.json({
      success: true,
      data: {
        date,
        discount: discountPct,
        totals: {
          totalBeforeDiscount: round2(totalBeforeDiscount),
          totalAfterDiscount: round2(totalAfterDiscount),
        },
        lines: previewLines,
      },
    });
  } catch (e) {
    console.error("❌ Error en /transactions/shopping-list/preview:", e);
    return res.status(500).json({ error: e.message || "Error interno" });
  }
});

// -------------------------------
// POST /transactions/shopping-list
// Crea transacción + transaction_items
// y aplica decisiones de precios por línea.
// -------------------------------
router.post("/shopping-list", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const {
    account_id,
    category_id,
    date,
    description = "",
    discount = 0,
    lines = [],
  } = req.body;

  if (!account_id || !category_id || !date) {
    return res.status(400).json({ error: "Faltan account_id, category_id o date" });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "Debes enviar 'lines' con al menos 1 fila" });
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
      return res.status(400).json({ error: "No hay item_id válidos en lines" });
    }

    const { itemTaxMap, latestMap } = await fetchItemsTaxAndLatestPrice({
      supabase,
      user_id,
      itemIds,
    });

    const existingMap = await fetchExistingPricesOnDate({
      supabase,
      user_id,
      date,
      itemIds,
    });

    const discountPct = toNumber(discount, 0);
    const discountFactor = discountPct > 0 ? 1 - discountPct / 100 : 1;

    const pricesToInsert = [];
    const pricesToUpdate = [];

    const txItemsToInsert = [];
    let totalBeforeDiscount = 0;

    for (const raw of lines) {
      const item_id = raw.item_id;
      const qty = toNumber(raw.quantity, 1);

      const resolution = raw.resolution; 
      // resolution esperado:
      // - "insert_new"
      // - "use_existing"
      // - "update_existing"

      const price_input_mode = raw.price_input_mode === "gross" ? "gross" : "net";
      const unit_price_net_input = toNumber(raw.unit_price_net, 0);
      const gross_total_input = toNumber(raw.gross_total, 0);

      const itemRow = itemTaxMap.get(item_id);
      if (!itemRow) {
        return res.status(400).json({
          error: "INVALID_ITEM",
          message: `Artículo inválido o no pertenece al usuario: ${item_id}`,
        });
      }

      const taxRate = toNumber(itemRow.taxes?.rate, 0);
      const isExempt = itemRow.taxes?.is_exempt === true;

      // Computo del "nuevo" neto por si se necesita insertar/actualizar
      const computed = computeLine({
        qty,
        taxRate,
        isExempt,
        price_input_mode,
        unit_price_net_input,
        gross_total_input,
      });

      const existing = existingMap.get(item_id) || null;

      // Determinar si hay conflicto real
      const conflict =
        existing && !nearlyEqual(existing.price, computed.unit_price_net);

      // Validación de resolución
      if (conflict) {
        if (!resolution || !["use_existing", "update_existing"].includes(resolution)) {
          return res.status(400).json({
            error: "MISSING_RESOLUTION",
            message: `Conflicto de precio detectado para item_id=${item_id} en date=${date}. Debes elegir resolution: use_existing | update_existing.`,
            item_id,
            existing_price_on_date: existing.price,
            computed_unit_price_net: computed.unit_price_net,
          });
        }
      } else {
        // Si no hay conflicto, resolution puede venir o no. Normalizamos.
        // Si existe precio del día y es igual, "use_existing" (no tocamos item_prices)
        // Si no existe precio del día, "insert_new" (insertamos precio del día)
      }

      // Aplicar la decisión de precio del día (item_prices)
      let usedUnitNet;

      if (existing) {
        if (conflict) {
          if (resolution === "use_existing") {
            usedUnitNet = existing.price;
          } else if (resolution === "update_existing") {
            usedUnitNet = computed.unit_price_net;
            pricesToUpdate.push({ id: existing.id, price: usedUnitNet });
          }
        } else {
          // igual al existente
          usedUnitNet = existing.price;
        }
      } else {
        // no existe precio ese día
        usedUnitNet = computed.unit_price_net;
        pricesToInsert.push({
          item_id,
          price: usedUnitNet,
          date,
        });
      }

      // Calcular línea para transaction_items usando el "usedUnitNet" definitivo
      const rate = isExempt ? 0 : taxRate;
      const netTotal = usedUnitNet * qty;
      const taxAmount = netTotal * (rate / 100);
      const lineGross = netTotal + taxAmount;

      totalBeforeDiscount += lineGross;

      const lineTotalFinal = lineGross * discountFactor;
      const unitFinal = qty > 0 ? lineTotalFinal / qty : lineTotalFinal;

      txItemsToInsert.push({
        item_id,
        quantity: qty,
        unit_price_net: usedUnitNet,
        unit_price_final: unitFinal,
        line_total_final: lineTotalFinal,
        tax_rate_used: rate,
        is_exempt_used: isExempt === true,

        // extra opcional por si quieres debug en frontend
        meta: {
          latest_price: latestMap.get(item_id) ?? 0,
          existing_price_on_date: existing ? existing.price : null,
          computed_unit_price_net: computed.unit_price_net,
          conflict,
          resolution: conflict ? resolution : (existing ? "use_existing" : "insert_new"),
        },
      });
    }

    if (txItemsToInsert.length === 0) {
      return res.status(400).json({
        error: "EMPTY_LINES",
        message: "No hay líneas válidas para crear la lista de compra",
      });
    }

    const totalAfterDiscount = totalBeforeDiscount * discountFactor;

    // 1) Insertar precios nuevos (si aplica)
    if (pricesToInsert.length > 0) {
      const { error: insertErr } = await supabase
        .from("item_prices")
        .insert(
          pricesToInsert.map((p) => ({
            item_id: p.item_id,
            price: p.price,
            date: p.date,
          }))
        );

      if (insertErr) {
        console.error("❌ Error insertando item_prices:", insertErr);
        return res.status(500).json({
          error: "ITEM_PRICES_INSERT_FAILED",
          message: "No se pudieron insertar nuevos precios del día",
        });
      }
    }

    // 2) Actualizar precios existentes (si aplica)
    if (pricesToUpdate.length > 0) {
      const updateResults = await Promise.all(
        pricesToUpdate.map((p) =>
          supabase.from("item_prices").update({ price: p.price }).eq("id", p.id)
        )
      );
      const someError = updateResults.find((r) => r.error);
      if (someError) {
        console.error("❌ Error actualizando item_prices:", someError.error);
        return res.status(500).json({
          error: "ITEM_PRICES_UPDATE_FAILED",
          message: "No se pudieron actualizar algunos precios del día",
        });
      }
    }

    // 3) Crear transacción
    const { data: tx, error: txErr } = await supabase
      .from("transactions")
      .insert([
        {
          user_id,
          account_id,
          category_id,
          amount: totalAfterDiscount,
          type: "expense",
          description: description || "Lista de compra",
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
        error: "TRANSACTION_CREATE_FAILED",
        message: "No se pudo crear la transacción de lista de compras",
      });
    }

    // 4) Insertar transaction_items
    const txItemsRows = txItemsToInsert.map((row) => ({
      transaction_id: tx.id,
      item_id: row.item_id,
      quantity: row.quantity,
      unit_price_net: row.unit_price_net,
      unit_price_final: row.unit_price_final,
      line_total_final: row.line_total_final,
      tax_rate_used: row.tax_rate_used,
      is_exempt_used: row.is_exempt_used,
    }));

    const { error: txItemsErr } = await supabase
      .from("transaction_items")
      .insert(txItemsRows);

    if (txItemsErr) {
      console.error("❌ Error insertando transaction_items:", txItemsErr);
      return res.status(500).json({
        error: "TRANSACTION_ITEMS_FAILED",
        message: "La transacción se creó, pero falló el detalle de artículos",
      });
    }

    return res.json({
      success: true,
      data: {
        transaction: tx,
        totals: {
          totalBeforeDiscount: round2(totalBeforeDiscount),
          totalAfterDiscount: round2(totalAfterDiscount),
          discount: discountPct,
        },
        lines: txItemsRows.length,
      },
    });
  } catch (e) {
    console.error("❌ Error en /transactions/shopping-list:", e);
    return res.status(500).json({
      error: "SHOPPING_LIST_FAILED",
      message: e.message || "Error inesperado creando lista de compra",
    });
  }
});



// ✅ Exportar transacciones a XLSX (con filtros)
router.get("/export", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { description, type, account_id, category_id, date_from, date_to } = req.query;

  try {
    // Headers de descarga
    const filename = `transacciones_${dayjs().format("YYYYMMDD_HHmmss")}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Workbook streaming directo al response
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet("Transacciones");

    // Columnas requeridas
    sheet.columns = [
      { header: "DESCRIPCION", key: "descripcion", width: 40 },
      { header: "CATEGORIA", key: "categoria", width: 22 },
      { header: "TIPO TRANSACCION", key: "tipo", width: 18 },
      { header: "FECHA", key: "fecha", width: 12 },
      { header: "TOTAL", key: "total", width: 14 },
    ];

    // Helper: tipo traducido
    const mapType = (t) =>
      t === "expense" ? "Gasto" : t === "income" ? "Ingreso" : "Transferencia";

    // Paginación (evita traer todo a memoria)
    const pageSize = 1000;
    let from = 0;

    while (true) {
      let query = supabase
        .from("transactions")
        .select(
          `
          id,
          amount,
          type,
          description,
          date,
          categories ( name )
        `
        )
        .eq("user_id", user_id);

      // 🔍 mismos filtros que tu GET /
      if (description && description.trim() !== "") {
        query = query.ilike("description", `%${description.trim()}%`);
      }
      if (type && type !== "all") {
        query = query.eq("type", type);
      }
      if (category_id) {
        query = query.eq("category_id", category_id);
      }
      if (account_id) {
        query = query.or(
          `account_id.eq.${account_id},account_from_id.eq.${account_id},account_to_id.eq.${account_id}`
        );
      }
      if (date_from) query = query.gte("date", date_from);
      if (date_to) query = query.lte("date", date_to);

      query = query.order("date", { ascending: false }).range(from, from + pageSize - 1);

      const { data, error } = await query;

      if (error) {
        console.error("🔥 Error exportando transacciones:", error);
        // Si ya escribimos algo al stream, igual cerramos bien
        sheet.addRow({
          descripcion: "ERROR",
          categoria: "",
          tipo: "",
          fecha: "",
          total: error.message,
        }).commit();
        break;
      }

      if (!data || data.length === 0) break;

      // escribir filas
      for (const tx of data) {
        sheet.addRow({
          descripcion: tx.description || "",
          categoria: tx.type === "transfer" ? "" : (tx.categories?.name || ""),
          tipo: mapType(tx.type),
          fecha: tx.date, // YYYY-MM-DD
          total: Number(tx.amount || 0),
        }).commit();
      }

      // siguiente página
      from += pageSize;

      // si vino menos de una página, terminamos
      if (data.length < pageSize) break;
    }

    sheet.commit();
    await workbook.commit(); // esto cierra el stream correctamente
  } catch (err) {
    console.error("🔥 Error inesperado en /transactions/export:", err);
    // Si falla antes de headers/stream, mandamos JSON
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error interno exportando XLSX" });
    }
    // Si ya envió headers, solo finaliza
    try { res.end(); } catch {}
  }
});


module.exports = router;
