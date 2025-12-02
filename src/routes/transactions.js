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

// ✅ Obtener transacciones del usuario
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
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
    .eq("user_id", user_id)
    .order("date", { ascending: false });

  if (error) {
    console.error("🔥 Error al obtener transacciones:", error);
    return res.status(500).json({ error: error.message });
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

  // ✅ Insertar transacción (encaja con tu schema: discount_percent existe)
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

module.exports = router;
