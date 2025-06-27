const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// 🔧 Utilidad para obtener el último día del mes
const getLastDayOfMonth = (yyyyMm) => {
  const [year, month] = yyyyMm.split("-");
  return new Date(year, parseInt(month), 0).getDate(); // día 0 del mes siguiente
};

// GET /budgets — Obtener presupuestos por mes o año
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { month, year } = req.query;



  let targetMonths = [];

  if (month) {
    targetMonths = [month];
   
  } else if (year) {
    targetMonths = Array.from({ length: 12 }, (_, i) =>
      `${year}-${String(i + 1).padStart(2, "0")}`
    );
   
  } else {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`;
    targetMonths = [currentMonth];

  }

  try {
    const { data: budgets, error: errBudgets } = await supabase
      .from("budgets")
      .select("id, month, limit_amount, category_id, categories (name)")
      .eq("user_id", user_id)
      .in("month", targetMonths);

    if (errBudgets) {
      console.log("🔥 Error al obtener presupuestos:", errBudgets);
      return res.status(500).json({ error: errBudgets.message });
    }



    const startDate = `${targetMonths[0]}-01`;
    const last = targetMonths.at(-1);
    const lastDay = getLastDayOfMonth(last);
    const endDate = `${last}-${String(lastDay).padStart(2, "0")}`;



    const { data: expenses, error: errTx } = await supabase
      .from("transactions")
      .select("category_id, amount, date")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", startDate)
      .lte("date", endDate);

    if (errTx) {
      console.log("🔥 Error al obtener transacciones:", errTx);
      return res.status(500).json({ error: errTx.message });
    }



    const gastoPorMesCat = {};
    expenses.forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      const cat = tx.category_id;
      gastoPorMesCat[key] ??= {};
      gastoPorMesCat[key][cat] ??= 0;
      gastoPorMesCat[key][cat] += parseFloat(tx.amount);
    });



    const result = budgets.map((b) => ({
      id: b.id,
      category_id: b.category_id,
      category_name: b.categories?.name || "Sin nombre",
      month: b.month,
      limit: parseFloat(b.limit_amount),
      spent: gastoPorMesCat[b.month]?.[b.category_id] || 0,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.log("🔥 Error inesperado en GET /budgets:", err);
    res.status(500).json({ error: "Error inesperado en /budgets" });
  }
});

// POST /budgets — Crear presupuesto (soporte para repeat anual)
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { category_id, month, limit_amount, repeat } = req.body;



  if (!category_id || !month || !limit_amount) {
    console.log("⚠️ Faltan campos obligatorios");
    return res.status(400).json({ error: "Todos los campos son obligatorios." });
  }

  const baseMonth = new Date(`${month}-01`);
  if (isNaN(baseMonth)) {
    console.log("❌ Fecha inválida:", month);
    return res.status(400).json({ error: "Mes inválido." });
  }

  const months = repeat
    ? Array.from({ length: 12 - baseMonth.getMonth() }, (_, i) => {
        const d = new Date(baseMonth.getFullYear(), baseMonth.getMonth() + i, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      })
    : [month];



  const insertData = [];

  for (const m of months) {

    const { data: existing, error: checkErr } = await supabase
      .from("budgets")
      .select("id")
      .eq("user_id", user_id)
      .eq("category_id", category_id)
      .eq("month", m)
      .maybeSingle();

    if (checkErr) {
      console.log("🔥 Error al verificar duplicado:", checkErr);
      return res.status(500).json({ error: "Error al verificar duplicados." });
    }

    if (existing) {
      console.log(`⚠️ Ya existe presupuesto para ${m}`);
    } else {
      insertData.push({
        user_id,
        category_id,
        month: m,
        limit_amount,
      });
    }
  }



  if (insertData.length === 0) {
    console.log("⚠️ No hay nuevos presupuestos para insertar.");
    return res.status(400).json({ error: "Todos los presupuestos ya existen." });
  }

  const { data, error } = await supabase.from("budgets").insert(insertData).select();

  if (error) {
    console.log("🔥 Error al insertar presupuestos:", error);
    return res.status(500).json({ error: "No se pudo crear presupuesto(s)." });
  }


  res.status(201).json({ success: true, data });
});

// DELETE /budgets/:id — Eliminar presupuesto
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("budgets")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: "Presupuesto eliminado" });
});

module.exports = router;
