const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// Listar precios de un artículo
router.get("/:item_id", authenticateUser, async (req, res) => {
  const { item_id } = req.params;

  const { data, error } = await supabase
    .from("item_prices")
    .select("*")
    .eq("item_id", item_id)
    .order("date", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// Agregar nuevo precio
router.post("/", authenticateUser, async (req, res) => {
  const { item_id, price, date } = req.body;

  if (!item_id || !price || !date) {
    return res.status(400).json({ error: "Todos los campos son obligatorios" });
  }

  const { data, error } = await supabase
    .from("item_prices")
    .insert([{ item_id, price, date }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: data[0] });
});

module.exports = router;
