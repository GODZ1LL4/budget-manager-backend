const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// 🔧 Utilidad para obtener el último día del mes
const getLastDayOfMonth = (yyyyMm) => {
  const [year, month] = yyyyMm.split("-");
  return new Date(year, parseInt(month), 0).getDate(); // día 0 del mes siguiente
};

/**
 * GET /budgets/history-import-preview
 * Sugerencias de presupuesto basadas en el mes anterior.
 * - Calcula el mes anterior al month destino.
 * - Suma gastos por categoría en ese mes.
 * - Indica si la categoría ya tiene presupuesto en el mes destino.
 */
router.get("/history-import-preview",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    let { month } = req.query;

    try {
      // 1) Determinar mes destino (por defecto: mes actual)
      if (!month) {
        const now = new Date();
        month = `${now.getFullYear()}-${String(
          now.getMonth() + 1
        ).padStart(2, "0")}`;
      }

      // Validación básica
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "Parámetro month inválido." });
      }

      // 2) Calcular mes anterior
      const [yearStr, monthStr] = month.split("-");
      const baseDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1, 1);
      const prevDate = new Date(
        baseDate.getFullYear(),
        baseDate.getMonth() - 1,
        1
      );
      const prevYear = prevDate.getFullYear();
      const prevMonthNum = prevDate.getMonth() + 1;
      const prevMonth = `${prevYear}-${String(prevMonthNum).padStart(
        2,
        "0"
      )}`;

      // 3) Rango de fechas del mes anterior
      const lastDayPrev = getLastDayOfMonth(prevMonth);
      const startPrev = `${prevMonth}-01`;
      const endPrev = `${prevMonth}-${String(lastDayPrev).padStart(2, "0")}`;

      // 4) Obtener gastos reales del mes anterior por categoría
      const { data: expenses, error: errTx } = await supabase
        .from("transactions")
        .select("category_id, amount, date, categories (name, type)")
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", startPrev)
        .lte("date", endPrev);

      if (errTx) {
        console.log("🔥 Error al obtener transacciones para history-import:", errTx);
        return res.status(500).json({ error: errTx.message });
      }

      // 5) Agregar por categoría (solo expense)
      const aggregated = {};
      expenses
        .filter((tx) => tx.category_id && tx.categories?.type === "expense")
        .forEach((tx) => {
          const catId = tx.category_id;
          aggregated[catId] ??= {
            category_id: catId,
            category_name: tx.categories?.name || "Sin nombre",
            spent_last_month: 0,
          };
          aggregated[catId].spent_last_month += parseFloat(tx.amount);
        });

      const itemsArray = Object.values(aggregated);

      if (itemsArray.length === 0) {
        return res.json({
          success: true,
          data: {
            from_month: prevMonth,
            to_month: month,
            items: [],
          },
        });
      }

      // 6) Buscar presupuestos existentes para el mes destino
      const { data: existingBudgets, error: errBudgets } = await supabase
        .from("budgets")
        .select("id, category_id, limit_amount")
        .eq("user_id", user_id)
        .eq("month", month);

      if (errBudgets) {
        console.log(
          "🔥 Error al obtener budgets existentes en history-import:",
          errBudgets
        );
        return res.status(500).json({ error: errBudgets.message });
      }

      const budgetMap = {};
      existingBudgets.forEach((b) => {
        budgetMap[b.category_id] = {
          id: b.id,
          limit_amount: parseFloat(b.limit_amount),
        };
      });

      // 7) Combinar info en items de preview
      const items = itemsArray
        .map((it) => {
          const existing = budgetMap[it.category_id];
          return {
            category_id: it.category_id,
            category_name: it.category_name,
            spent_last_month: it.spent_last_month,
            existing_budget_limit: existing ? existing.limit_amount : null,
            existing_budget_id: existing ? existing.id : null,
          };
        })
        .sort((a, b) => b.spent_last_month - a.spent_last_month);

      return res.json({
        success: true,
        data: {
          from_month: prevMonth,
          to_month: month,
          items,
        },
      });
    } catch (err) {
      console.log(
        "🔥 Error inesperado en GET /budgets/history-import-preview:",
        err
      );
      res.status(500).json({
        error: "Error inesperado en /budgets/history-import-preview",
      });
    }
  }
);

/**
 * POST /budgets/history-import
 * Crea o actualiza presupuestos en lote a partir del gasto del mes anterior.
 * - Si NO existe presupuesto para (user, category, month) → INSERT.
 * - Si SÍ existe y está seleccionado → UPDATE limit_amount.
 */
router.post("/history-import", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { month, items } = req.body;

  if (!month || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      message: "Se requieren month y al menos un item.",
    });
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Mes inválido." });
  }

  try {
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const rawItem of items) {
      const { category_id, limit_amount } = rawItem || {};

      const numericLimit = parseFloat(limit_amount);
      if (!category_id || isNaN(numericLimit) || numericLimit <= 0) {
        skippedCount++;
        continue;
      }

      // Verificar si ya existe presupuesto para esa categoría y mes
      const { data: existing, error: checkErr } = await supabase
        .from("budgets")
        .select("id")
        .eq("user_id", user_id)
        .eq("category_id", category_id)
        .eq("month", month)
        .maybeSingle();

      if (checkErr) {
        console.log(
          "🔥 Error al verificar presupuesto existente en history-import:",
          checkErr
        );
        return res.status(500).json({
          error: "Error al verificar presupuestos existentes.",
        });
      }

      if (existing) {
        // 👉 Actualizar presupuesto existente
        const { error: updErr } = await supabase
          .from("budgets")
          .update({ limit_amount: numericLimit })
          .eq("id", existing.id)
          .eq("user_id", user_id);

        if (updErr) {
          console.log(
            "🔥 Error al actualizar presupuesto en history-import:",
            updErr
          );
          return res.status(500).json({
            error: "Error al actualizar presupuesto existente.",
          });
        }

        updatedCount++;
      } else {
        // 👉 Crear nuevo presupuesto
        const { error: insErr } = await supabase.from("budgets").insert({
          user_id,
          category_id,
          month,
          limit_amount: numericLimit,
        });

        if (insErr) {
          console.log(
            "🔥 Error al crear presupuesto en history-import:",
            insErr
          );
          return res.status(500).json({
            error: "Error al crear presupuesto.",
          });
        }

        insertedCount++;
      }
    }

    if (insertedCount === 0 && updatedCount === 0) {
      return res.status(400).json({
        error: "NO_CHANGES",
        message: "No se realizaron cambios (nada para crear o actualizar).",
      });
    }

    return res.status(201).json({
      success: true,
      insertedCount,
      updatedCount,
      skippedCount,
    });
  } catch (err) {
    console.log("🔥 Error inesperado en POST /budgets/history-import:", err);
    res
      .status(500)
      .json({ error: "Error inesperado en /budgets/history-import" });
  }
});

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

    const result = budgets
      .map((b) => ({
        id: b.id,
        category_id: b.category_id,
        category_name: b.categories?.name || "Sin nombre",
        month: b.month,
        limit: parseFloat(b.limit_amount),
        spent: gastoPorMesCat[b.month]?.[b.category_id] || 0,
      }))
      // 👇 ordenar por nombre de categoría (orden alfabético ES)
      .sort((a, b) =>
        a.category_name.localeCompare(b.category_name, "es", {
          sensitivity: "base",
        })
      );

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
        const d = new Date(
          baseMonth.getFullYear(),
          baseMonth.getMonth() + i,
          1
        );
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}`;
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
    return res
      .status(400)
      .json({ error: "Todos los presupuestos ya existen." });
  }

  const { data, error } = await supabase
    .from("budgets")
    .insert(insertData)
    .select();

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
