const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Listar artículos
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("items")
    .select(
      `
    *,
    taxes ( name, rate, is_exempt ),
    item_prices!item_prices_item_id_fkey (
      price,
      date
    )
  `
    )
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Crear o editar artículo
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id, name, description, category, tax_id } = req.body;

  if (!name) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  const payload = {
    user_id,
    name,
    description,
    category,
    tax_id: tax_id || null,
  };

  if (id) payload.id = id;

  const { data, error } = await supabase
    .from("items")
    .upsert([payload], { onConflict: "id" })
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: data[0] });
});


module.exports = router;
