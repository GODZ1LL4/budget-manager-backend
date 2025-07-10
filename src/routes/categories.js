const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Listar categorías del usuario
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
  .from("categories")
  .select("*")
  .eq("user_id", user_id)
  .order("name", { ascending: true }); // 👈 orden A-Z


  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Crear nueva categoría
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, type, stability_type = "variable" } = req.body;

  if (
    !name ||
    !["income", "expense"].includes(type) ||
    !["fixed", "variable", "occasional"].includes(stability_type)
  ) {
    return res.status(400).json({ error: "Datos inválidos" });
  }

  const { data, error } = await supabase
    .from("categories")
    .insert([{ user_id, name, type, stability_type }])
    .select();

  if (error) {
    console.error("🔥 Error de Supabase:", error);
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ success: true, data: data[0] });
});

// Editar una categoría
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { name, type, stability_type } = req.body;

  if (
    !name ||
    !["income", "expense"].includes(type) ||
    !["fixed", "variable", "occasional"].includes(stability_type)
  ) {
    return res.status(400).json({ error: "Datos inválidos" });
  }

  const { data, error } = await supabase
    .from("categories")
    .update({ name, type, stability_type })
    .eq("id", id)
    .eq("user_id", user_id)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data: data[0] });
});

// Eliminar categoría
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("categories")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: "Categoría eliminada" });
});

module.exports = router;
