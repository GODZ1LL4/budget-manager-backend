const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Listar artículos
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Crear artículo
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, description, category } = req.body;

  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });

  const { data, error } = await supabase
    .from("items")
    .insert([{ user_id, name, description, category }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: data[0] });
});

module.exports = router;
