const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// ✅ Listar impuestos
router.get("/", authenticateUser, async (req, res) => {
  const { data, error } = await supabase
    .from("taxes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("🔥 Error al listar impuestos:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// ✅ Crear o editar impuesto
router.post("/", authenticateUser, async (req, res) => {
  const { id, name, rate, is_exempt } = req.body;

  if (!name) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  const parsedRate = parseFloat(rate);
  if (isNaN(parsedRate)) {
    return res
      .status(400)
      .json({ error: "El porcentaje debe ser un número válido" });
  }

  const payload = {
    name,
    rate: parsedRate,
    is_exempt: !!is_exempt,
  };

  // Solo incluir ID si se está editando
  if (id) payload.id = id;

  const { data, error } = await supabase
    .from("taxes")
    .upsert([payload], { onConflict: "id" })
    .select();

  if (error) {
    console.error("🔥 Error al guardar impuesto:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data: data[0] });
});

// ✅ Eliminar impuesto
router.delete("/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("taxes").delete().eq("id", id);

  if (error) {
    console.error("🔥 Error al eliminar impuesto:", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

module.exports = router;
