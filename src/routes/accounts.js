const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Obtener cuentas del usuario
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("accounts")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Crear nueva cuenta
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name } = req.body;

  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });

  const { data, error } = await supabase
    .from("accounts")
    .insert([{ user_id, name }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: data[0] });
});

// Actualizar cuenta
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { name } = req.body;

  const { data, error } = await supabase
    .from("accounts")
    .update({ name })
    .eq("id", id)
    .eq("user_id", user_id)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data: data[0] });
});

// Eliminar cuenta
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("accounts")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: "Cuenta eliminada" });
});

// Obtener saldos por cuenta
router.get("/balances", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("account_id, amount, type")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  // Agrupar y calcular saldo
  const balances = {};

  data.forEach((tx) => {
    const acc = tx.account_id;
    if (!acc) return;
    if (!balances[acc]) balances[acc] = 0;

    if (tx.type === "income") {
      balances[acc] += parseFloat(tx.amount);
    } else if (tx.type === "expense") {
      balances[acc] -= parseFloat(tx.amount);
    }
  });

  res.json({ success: true, data: balances });
});

module.exports = router;
