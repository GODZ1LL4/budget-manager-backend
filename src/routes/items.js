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
    .order("name", { ascending: true });

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

router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  // 1) Verificar que el artículo exista y pertenezca al usuario
  const { data: item, error: itemError } = await supabase
    .from("items")
    .select("id")
    .eq("id", id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (itemError) {
    return res.status(500).json({ error: itemError.message });
  }

  if (!item) {
    return res
      .status(404)
      .json({ error: "Artículo no encontrado para este usuario" });
  }

  // 2) Verificar si está usado en alguna transacción
  //    (gracias a las políticas de RLS, sólo verás transacciones del usuario)
  const { data: usedRows, error: usedError } = await supabase
    .from("transaction_items")
    .select("id")
    .eq("item_id", id)
    .limit(1);

  if (usedError) {
    return res.status(500).json({ error: usedError.message });
  }

  if (usedRows && usedRows.length > 0) {
    return res.status(400).json({
      error: "ITEM_IN_USE",
      message:
        "No se puede eliminar el artículo porque ya se ha usado en transacciones.",
    });
  }

  // 3) Borrar historial de precios del artículo
  const { error: pricesError } = await supabase
    .from("item_prices")
    .delete()
    .eq("item_id", id);

  if (pricesError) {
    return res.status(500).json({ error: pricesError.message });
  }

  // 4) Borrar el artículo
  const { error: deleteError } = await supabase
    .from("items")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message });
  }

  return res.json({ success: true });
});

module.exports = router;
