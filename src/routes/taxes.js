const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// ✅ Listar impuestos del usuario
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("taxes")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("🔥 Error al listar impuestos:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// ✅ Crear impuesto (solo del usuario)
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, rate, is_exempt } = req.body;

  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });

  // Si es exento, puedes forzar rate = 0 (opcional)
  const parsedRate = is_exempt ? 0 : parseFloat(rate);
  if (!is_exempt && (isNaN(parsedRate) || parsedRate < 0)) {
    return res.status(400).json({ error: "El porcentaje debe ser un número válido" });
  }

  const payload = {
    user_id,
    name,
    rate: parsedRate,
    is_exempt: !!is_exempt,
  };

  const { data, error } = await supabase
    .from("taxes")
    .insert([payload])
    .select();

  if (error) {
    console.error("🔥 Error al crear impuesto:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ success: true, data: data[0] });
});

// ✅ Editar impuesto (solo si es del usuario)
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { name, rate, is_exempt } = req.body;

  const update = {};
  if (typeof name !== "undefined") update.name = name;
  if (typeof is_exempt !== "undefined") update.is_exempt = !!is_exempt;

  if (typeof rate !== "undefined") {
    const parsedRate = !!is_exempt ? 0 : parseFloat(rate);
    if (!is_exempt && (isNaN(parsedRate) || parsedRate < 0)) {
      return res.status(400).json({ error: "El porcentaje debe ser un número válido" });
    }
    update.rate = parsedRate;
  } else if (is_exempt === true) {
    // Si lo marcaron exento en esta edición, forzar rate = 0
    update.rate = 0;
  }

  const { data, error } = await supabase
    .from("taxes")
    .update(update)
    .eq("id", id)
    .eq("user_id", user_id)
    .select();

  if (error) {
    console.error("🔥 Error al editar impuesto:", error.message);
    return res.status(500).json({ error: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(404).json({ error: "Impuesto no encontrado" });
  }

  res.json({ success: true, data: data[0] });
});

// ✅ Eliminar impuesto (solo si es del usuario)
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("taxes")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) {
    console.error("🔥 Error al eliminar impuesto:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

module.exports = router;
