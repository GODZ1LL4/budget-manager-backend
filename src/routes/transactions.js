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
      accounts (name),
      categories (name, type)
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
    discount = 0,
  } = req.body;

  let amount = rawAmount;
  let transactionItems = [];

  if (!account_id || !category_id || !type || !date) {
    return res.status(400).json({ error: "Campos obligatorios faltantes." });
  }

  // ✅ Si se proveen artículos, usar sus precios más recientes desde la vista
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
  

    let total = 0;
  
    for (const item of items) {
      const ref = itemData.find((i) => i.id === item.item_id);
      if (!ref) continue;
  
      const qty = parseFloat(item.quantity) || 1;
      const price = parseFloat(ref.latest_price || 0);
      const taxRate = ref.is_exempt ? 0 : parseFloat(ref.tax_rate || 0);
  
      const subtotal = price * qty;
      const taxAmount = subtotal * (taxRate / 100);
      const lineTotal = subtotal + taxAmount;
  
      total += lineTotal;
  
      transactionItems.push({
        item_id: item.item_id,
        quantity: qty,
        price, // precio sin ITBIS (para referencia)
      });
    }
  
    if (discount > 0) {
      total = total * (1 - discount / 100);
    }
    
    amount = total;
  }
  

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
      },
    ])
    .select()
    .single();

  if (txError) {
    console.error("❌ Error al crear transacción:", txError);
    return res.status(500).json({ error: "Error al crear transacción." });
  }

  // ✅ Insertar relación con artículos
  if (transactionItems.length > 0) {
    const insertData = transactionItems.map((i) => ({
      transaction_id: tx.id,
      item_id: i.item_id,
      quantity: i.quantity,
      price: i.price,
    }));

    const { error: insertError } = await supabase
      .from("transaction_items")
      .insert(insertData);

    if (insertError) {
      console.error("🧨 Error al guardar artículos:", insertError);
      return res.status(500).json({ error: "Error al guardar artículos." });
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
