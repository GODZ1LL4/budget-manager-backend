const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const dayjs = require("dayjs"); // para manejar fechas

router.get("/for-calendar", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const result = [];

  for (const tx of data) {
    if (!tx.recurrence) {
      result.push(tx);
    } else {
      const startDate = dayjs(tx.date);
      const endDate = tx.recurrence_end_date
        ? dayjs(tx.recurrence_end_date)
        : dayjs().add(3, "months"); // proyección corta si no hay fin

      let current = startDate;

      while (current.isBefore(endDate)) {
        result.push({ ...tx, date: current.format("YYYY-MM-DD") });

        current = current.add(
          tx.recurrence === "monthly"
            ? 1
            : tx.recurrence === "biweekly"
            ? 2
            : 1,
          tx.recurrence === "weekly" ? "week" : "month"
        );
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
      .from("items_with_price") // usa la vista con latest_price
      .select("id, latest_price")
      .in("id", itemIds);

    if (itemError) {
      console.error("🧨 Error al obtener precios:", itemError);
      return res.status(500).json({ error: "Error al obtener precios." });
    }

    let total = 0;

    for (const item of items) {
      const ref = itemData.find((i) => i.id === item.item_id);
      if (!ref) continue;

      const qty = parseFloat(item.quantity) || 1;
      const price = parseFloat(ref.latest_price || 0);

      total += qty * price;

      transactionItems.push({
        item_id: item.item_id,
        quantity: qty,
        price,
      });
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
