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
    .from("accounts")
    .select("id,current_balance")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const balances = Object.fromEntries(
    (data || []).map((a) => [a.id, Number(a.current_balance || 0)])
  );

  res.json({ success: true, data: balances });
});

// POST /accounts/transfer
// body: { from_account_id, to_account_id, amount, date, description }
router.post("/transfer", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { from_account_id, to_account_id, amount, date, description } =
    req.body;

  if (!from_account_id || !to_account_id || !amount || !date) {
    return res.status(400).json({ error: "Datos incompletos" });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: "Las cuentas deben ser distintas" });
  }

  const { data, error } = await supabase
    .from("transactions")
    .insert([
      {
        user_id,
        type: "transfer",
        account_from_id: from_account_id,
        account_to_id: to_account_id,
        amount,
        date,
        description: description || null,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  // Los triggers ya ajustaron balances de ambas cuentas
  res.status(201).json({ success: true, data });
});

module.exports = router;
