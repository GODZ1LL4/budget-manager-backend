const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Obtener todas las metas del usuario
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("goals")
    .select("*")
    .eq("user_id", user_id)
    .order("due_date", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Crear una nueva meta
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, target_amount, due_date } = req.body;

  if (!name || !target_amount) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  const { data, error } = await supabase
    .from("goals")
    .insert([{ user_id, name, target_amount, due_date }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: data[0] });
});

// Actualizar progreso de meta
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { current_amount } = req.body;

  const { data, error } = await supabase
    .from("goals")
    .update({ current_amount })
    .eq("id", id)
    .eq("user_id", user_id)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data: data[0] });
});

// Eliminar meta
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("goals")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: "Meta eliminada" });
});

module.exports = router;
