const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// ✅ 1) Buscar precios por fecha para varios items
router.get("/by-date", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { date, item_ids } = req.query;

  if (!date || !item_ids) {
    return res
      .status(400)
      .json({ error: "Faltan parámetros: date y item_ids" });
  }

  const ids = String(item_ids)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  if (ids.length === 0) {
    return res.status(400).json({ error: "item_ids está vacío" });
  }

  try {
    // Leemos precios de esa fecha y esos items
    const { data, error } = await supabase
      .from("item_prices")
      .select("item_id, price, date, items: item_id (user_id)")
      .eq("date", date)
      .in("item_id", ids);

    if (error) {
      console.error("❌ Error leyendo item_prices:", error);
      return res
        .status(500)
        .json({ error: "No se pudieron leer precios existentes" });
    }

    // Filtramos por items del usuario (por seguridad)
    const filtered = (data || []).filter(
      (row) => row.items && row.items.user_id === user_id
    );

    const result = filtered.map((row) => ({
      item_id: row.item_id,
      price: Number(row.price || 0),
    }));

    return res.json({ success: true, data: result });
  } catch (e) {
    console.error("❌ Error en /item-prices/by-date:", e);
    return res
      .status(500)
      .json({ error: "Error inesperado al leer precios por fecha" });
  }
});

// ✅ 2) Listar precios de un artículo 
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

  if (!item_id || price == null || !date) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "Todos los campos son obligatorios" });
  }

  const numericPrice = Number(price);
  if (Number.isNaN(numericPrice) || numericPrice < 0) {
    return res
      .status(400)
      .json({ error: "INVALID_PRICE", message: "El precio debe ser un número válido" });
  }

  // 🔍 1) Validar que no exista ya un precio para ese item + fecha
  const { data: existing, error: existingError } = await supabase
    .from("item_prices")
    .select("id")
    .eq("item_id", item_id)
    .eq("date", date)
    .limit(1);

  if (existingError) {
    console.error("Error verificando precio existente:", existingError);
    return res
      .status(500)
      .json({ error: "DB_CHECK_ERROR", message: existingError.message });
  }

  if (existing && existing.length > 0) {
    return res.status(409).json({
      error: "DUPLICATE_PRICE_FOR_DATE",
      message: "Ya existe un precio para este artículo en la fecha indicada.",
    });
  }

  // 🧾 2) Insertar el precio si pasó la validación
  const { data, error } = await supabase
    .from("item_prices")
    .insert([{ item_id, price: numericPrice, date }])
    .select();

  if (error) {
    console.error("Error insertando precio:", error);
    return res
      .status(500)
      .json({ error: "DB_INSERT_ERROR", message: error.message });
  }

  res.status(201).json({ success: true, data: data[0] });
});

router.delete("/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  if (!id) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "Falta el ID del precio." });
  }

  // 1) Buscar el precio y saber a qué item pertenece
  const { data: prices, error: fetchPriceError } = await supabase
    .from("item_prices")
    .select("id, item_id")
    .eq("id", id)
    .limit(1);

  if (fetchPriceError) {
    console.error("Error buscando precio:", fetchPriceError);
    return res
      .status(500)
      .json({ error: "DB_FETCH_ERROR", message: fetchPriceError.message });
  }

  const priceRow = prices?.[0];
  if (!priceRow) {
    return res.status(404).json({
      error: "PRICE_NOT_FOUND",
      message: "No se encontró el precio indicado.",
    });
  }

  // 2) Validar que el item al que pertenece ese precio sea del usuario
  const { data: items, error: itemError } = await supabase
    .from("items")
    .select("id, user_id")
    .eq("id", priceRow.item_id)
    .limit(1);

  if (itemError) {
    console.error("Error buscando item:", itemError);
    return res
      .status(500)
      .json({ error: "DB_ITEM_ERROR", message: itemError.message });
  }

  const item = items?.[0];
  if (!item || item.user_id !== userId) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "No tienes permiso para eliminar este precio.",
    });
  }

  // 3) Eliminar
  const { error: deleteError } = await supabase
    .from("item_prices")
    .delete()
    .eq("id", id);

  if (deleteError) {
    console.error("Error eliminando precio:", deleteError);
    return res
      .status(500)
      .json({ error: "DB_DELETE_ERROR", message: deleteError.message });
  }

  return res.json({ success: true });
});


module.exports = router;
