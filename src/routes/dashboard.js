const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

/* ============================================================
   GET: RESUMEN DASHBOARD
   ============================================================ */
router.get("/summary", authenticateUser, async (req, res) => {
  const user_id = req.user?.id;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");

  const start = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const end = `${year}-${month}-${lastDay}`;

  try {
    /* ------------------------------------------------------------
       1) TRANSACCIONES DEL MES ACTUAL
       ------------------------------------------------------------ */
    const { data: tx, error } = await supabase
      .from("transactions")
      .select("id, amount, type, category_id, date")
      .eq("user_id", user_id)
      .gte("date", start)
      .lte("date", end);

    if (error) throw error;

    let totalIncome = 0;
    let totalExpense = 0;
    const expensesByCategory = {};

    tx.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
      if (t.type === "income") totalIncome += amt;
      if (t.type === "expense") {
        totalExpense += amt;
        expensesByCategory[t.category_id] =
          (expensesByCategory[t.category_id] || 0) + amt;
      }
    });

    const balance = totalIncome - totalExpense;
    const savingRate =
      totalIncome > 0 ? (1 - totalExpense / totalIncome) * 100 : 0;
    const daysPassed = now.getDate();
    const averageDailyExpense = daysPassed > 0 ? totalExpense / daysPassed : 0;

    /* ------------------------------------------------------------
       2) GASTO MENSUAL PROMEDIO (ÚLTIMOS 3 MESES, FIJOS/VARIABLES)
       ------------------------------------------------------------ */
    const pastMonths = Array.from({ length: 3 }).map((_, i) => {
      const d = new Date(year, now.getMonth() - (i + 1), 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });

    const { data: pastTx } = await supabase
      .from("transactions")
      .select("amount, type, date, categories(stability_type)")
      .eq("user_id", user_id)
      .eq("type", "expense");

    const monthlyTotals = {};

    pastTx?.forEach((t) => {
      const stab = t.categories?.stability_type;
      if (!["fixed", "variable"].includes(stab)) return;
      const key = t.date.slice(0, 7);
      if (pastMonths.includes(key)) {
        monthlyTotals[key] =
          (monthlyTotals[key] || 0) + parseFloat(t.amount || 0);
      }
    });

    const averageMonthlyExpense =
      Object.values(monthlyTotals).reduce((a, b) => a + b, 0) /
        (pastMonths.length || 1) || 0;

    /* ------------------------------------------------------------
       3) MES ANTERIOR (COMPARACIÓN)
       ------------------------------------------------------------ */
    const prevDate = new Date(year, now.getMonth() - 1, 1);
    const prevMonth = `${prevDate.getFullYear()}-${String(
      prevDate.getMonth() + 1
    ).padStart(2, "0")}`;
    const prevStart = `${prevMonth}-01`;
    const prevEnd = `${prevMonth}-${new Date(
      prevDate.getFullYear(),
      prevDate.getMonth() + 1,
      0
    ).getDate()}`;

    const { data: prevTx } = await supabase
      .from("transactions")
      .select("amount, type")
      .eq("user_id", user_id)
      .gte("date", prevStart)
      .lte("date", prevEnd);

    let prevIncome = 0;
    let prevExpense = 0;

    prevTx?.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
      if (t.type === "income") prevIncome += amt;
      if (t.type === "expense") prevExpense += amt;
    });

    const incomeDiffPercent =
      prevIncome > 0 ? ((totalIncome - prevIncome) / prevIncome) * 100 : 0;

    const expenseDiffPercent =
      prevExpense > 0 ? ((totalExpense - prevExpense) / prevExpense) * 100 : 0;

    const prevSavingRate =
      prevIncome > 0 ? (1 - prevExpense / prevIncome) * 100 : 0;

    const savingRateDiff = savingRate - prevSavingRate;

    const incomeDiffAbs = totalIncome - prevIncome;
    const expenseDiffAbs = totalExpense - prevExpense;
    const savingDiffAbs =
      totalIncome - totalExpense - (prevIncome - prevExpense);

    /* ------------------------------------------------------------
       4) METAS DE AHORRO
       ------------------------------------------------------------ */
    const { data: goalsData } = await supabase
      .from("goals")
      .select("current_amount, target_amount")
      .eq("user_id", user_id);

    const goalsSafe = goalsData || [];
    const completedGoals = goalsSafe.filter(
      (g) =>
        parseFloat(g.current_amount || 0) >= parseFloat(g.target_amount || 0)
    ).length;
    const totalGoals = goalsSafe.length;

    /* ------------------------------------------------------------
       5) TRANSACCIONES CON ESTABILIDAD (AÑO EN CURSO)
       ------------------------------------------------------------ */
    const { data: txWithStability } = await supabase
      .from("transactions")
      .select(
        "amount, type, date, category_id, categories(stability_type, name)"
      )
      .eq("user_id", user_id)
      .gte("date", `${year}-01-01`)
      .lte("date", end);

    // Para variaciones por categoría (solo fijos/variables)
    let fixedVarCurrentByCat = {};
    let fixedVarPrevByCat = {};

    // Para ingreso fijo promedio
    const fixedIncomeByMonth = {};

    txWithStability?.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
      const stab = t.categories?.stability_type;
      const monthKey = t.date.slice(0, 7);

      if (t.type === "income" && stab === "fixed") {
        fixedIncomeByMonth[monthKey] =
          (fixedIncomeByMonth[monthKey] || 0) + amt;
      }

      if (t.type !== "expense") return;
      if (!["fixed", "variable"].includes(stab)) return;

      if (t.date >= start && t.date <= end) {
        fixedVarCurrentByCat[t.category_id] =
          (fixedVarCurrentByCat[t.category_id] || 0) + amt;
      }

      if (t.date >= prevStart && t.date <= prevEnd) {
        fixedVarPrevByCat[t.category_id] =
          (fixedVarPrevByCat[t.category_id] || 0) + amt;
      }
    });

    const fixedIncomeAverageRaw = Object.values(fixedIncomeByMonth);
    const fixedIncomeAverage =
      fixedIncomeAverageRaw.length > 0
        ? fixedIncomeAverageRaw.reduce((a, b) => a + b, 0) /
          fixedIncomeAverageRaw.length
        : 0;

    // Variación por categoría (solo fijos + variables)
    const diffByCategory = {};
    const variationByCategory = {};
    const allCatsFixedVar = new Set([
      ...Object.keys(fixedVarCurrentByCat),
      ...Object.keys(fixedVarPrevByCat),
    ]);

    allCatsFixedVar.forEach((cat) => {
      const cur = fixedVarCurrentByCat[cat] || 0;
      const prev = fixedVarPrevByCat[cat] || 0;
      const diff = cur - prev;

      diffByCategory[cat] = diff;
      variationByCategory[cat] = prev > 0 ? (diff / prev) * 100 : 0;
    });

    // =========================
    // NUEVA LÓGICA CORREGIDA
    // =========================
    let mostIncreasedCategoryAbs = null;
    let mostDecreasedCategoryAbs = null;

    for (const [cat, diff] of Object.entries(diffByCategory)) {
      // Mayor aumento -> solo diffs POSITIVOS
      if (diff > 0) {
        if (!mostIncreasedCategoryAbs || diff > mostIncreasedCategoryAbs.diff) {
          mostIncreasedCategoryAbs = { category_id: cat, diff };
        }
      }

      // Mayor disminución -> solo diffs NEGATIVOS
      if (diff < 0) {
        if (!mostDecreasedCategoryAbs || diff < mostDecreasedCategoryAbs.diff) {
          mostDecreasedCategoryAbs = { category_id: cat, diff };
        }
      }
    }

    const sortedVar = Object.entries(variationByCategory).sort(
      (a, b) => b[1] - a[1]
    );

    const mostIncreasedCategory = sortedVar[0]
      ? { category_id: sortedVar[0][0], percent: sortedVar[0][1] }
      : null;

    const mostDecreasedCategory = sortedVar.slice(-1)[0]
      ? {
          category_id: sortedVar.slice(-1)[0][0],
          percent: sortedVar.slice(-1)[0][1],
        }
      : null;

    /* ------------------------------------------------------------
       6) TOP CATEGORÍA DEL MES ACTUAL
       ------------------------------------------------------------ */
    const topCatEntry = Object.entries(expensesByCategory).sort(
      (a, b) => b[1] - a[1]
    )[0];

    const topCategoryThisMonth = topCatEntry
      ? { category_id: topCatEntry[0], amount: topCatEntry[1] }
      : null;

    /* ------------------------------------------------------------
       7) NOMBRES DE CATEGORÍAS
       ------------------------------------------------------------ */
    const categoryIdsNeeded = Array.from(
      new Set([
        ...Object.keys(expensesByCategory),
        ...allCatsFixedVar,
        topCategoryThisMonth?.category_id,
      ])
    ).filter(Boolean);

    let categoryNameMap = {};

    if (categoryIdsNeeded.length > 0) {
      const { data: catNames } = await supabase
        .from("categories")
        .select("id, name")
        .in("id", categoryIdsNeeded);

      catNames?.forEach((c) => {
        categoryNameMap[c.id] = c.name;
      });
    }

    const topCategoryName = topCategoryThisMonth
      ? categoryNameMap[topCategoryThisMonth.category_id] || "Sin nombre"
      : null;

    /* ------------------------------------------------------------
       8) PRESUPUESTO DEL MES, DÍAS ALTOS/BAJOS, ETC.
       ------------------------------------------------------------ */
    const totalTransactions = tx.length;

    const { data: budgetsThisMonth } = await supabase
      .from("budgets")
      .select("limit_amount")
      .eq("user_id", user_id)
      .eq("month", `${year}-${month}`);

    const totalMonthlyBudget =
      budgetsThisMonth?.reduce(
        (sum, b) => sum + parseFloat(b.limit_amount || 0),
        0
      ) || 0;

    const { data: budgetedCategories } = await supabase
      .from("budgets")
      .select("category_id")
      .eq("user_id", user_id)
      .eq("month", `${year}-${month}`);

    const budgetedCatIds = (budgetedCategories || []).map((b) => b.category_id);

    const budgetedExpenseTotal = tx
      .filter(
        (t) => t.type === "expense" && budgetedCatIds.includes(t.category_id)
      )
      .reduce((s, t) => s + parseFloat(t.amount || 0), 0);

    const budgetBalance = totalMonthlyBudget - budgetedExpenseTotal;

    // Días con gasto
    const dailyMap = {};
    tx.forEach((t) => {
      if (t.type === "expense") {
        dailyMap[t.date] = (dailyMap[t.date] || 0) + parseFloat(t.amount || 0);
      }
    });

    let minExpenseDay = null;
    let maxExpenseDay = null;

    for (const [date, amt] of Object.entries(dailyMap)) {
      if (!minExpenseDay || amt < minExpenseDay.amount) {
        minExpenseDay = { date, amount: amt };
      }
      if (!maxExpenseDay || amt > maxExpenseDay.amount) {
        maxExpenseDay = { date, amount: amt };
      }
    }

    let daysBelowAverage = 0;
    let daysAboveAverage = 0;

    for (const amt of Object.values(dailyMap)) {
      if (amt < averageDailyExpense) daysBelowAverage++;
      if (amt > averageDailyExpense) daysAboveAverage++;
    }

    /* ------------------------------------------------------------
       9) RESPUESTA FINAL
       ------------------------------------------------------------ */
    res.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        balance,
        savingRate,
        averageDailyExpense,
        averageMonthlyExpense,

        // comparacion con mes anterior
        previousMonthComparison: {
          incomeDiffPercent,
          expenseDiffPercent,
          savingRateDiff,
          incomeDiffAbs,
          expenseDiffAbs,
          savingDiffAbs,
        },

        // metas
        goalsSummary: { totalGoals, completedGoals },

        // variaciones por categoría (solo fijos/variables)
        mostIncreasedCategoryAbs,
        mostDecreasedCategoryAbs,
        mostIncreasedCategory,
        mostDecreasedCategory,
        categoryNameMap,

        // para métricas de presupuesto
        totalMonthlyBudget,
        budgetedExpenseTotal,
        budgetBalance,

        // para métricas de días
        minExpenseDay,
        maxExpenseDay,
        daysBelowAverage,
        daysAboveAverage,

        // para otras tarjetas
        totalTransactions,
        fixedIncomeAverage,

        // para el pie chart y "Mayor gasto por categoría"
        expensesByCategory,
        topCategoryThisMonth,
        topCategoryName,
      },
    });
  } catch (err) {
    console.error("🔥 Error en /dashboard/summary:", err);
    res
      .status(500)
      .json({ error: "Error al calcular métricas financieras del dashboard." });
  }
});

/* ============================================================
   GET: GASTO DE HOY
   ============================================================ */
router.get("/today-expense", authenticateUser, async (req, res) => {
  const user_id = req.user?.id;

  const userTZOffset = -4; // RD está en GMT-4
  const now = new Date();
  const localTime = new Date(now.getTime() + userTZOffset * 60 * 60 * 1000);
  const today = localTime.toISOString().split("T")[0];

  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("amount")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .eq("date", today);

    if (error) throw error;

    const totalToday = (data || []).reduce(
      (sum, tx) => sum + parseFloat(tx.amount || 0),
      0
    );

    res.json({ success: true, data: { totalExpenseToday: totalToday } });
  } catch (err) {
    console.error("🔥 Error en /dashboard/today-expense:", err);
    res.status(500).json({ error: "Error al calcular gasto de hoy." });
  }
});

/* ============================================================
   GET: TRANSACCIONES POR CATEGORÍA (MES ACTUAL)
   ============================================================ */
router.get("/transactions-by-category", authenticateUser, async (req, res) => {
  const user_id = req.user?.id;
  const category_id = req.query.category_id;

  if (!category_id) return res.status(400).json({ error: "Falta category_id" });

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const start = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const end = `${year}-${month}-${lastDay}`;

  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("id, amount, description, date")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .eq("category_id", category_id)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true });

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error("🔥 Error en /transactions-by-category:", err);
    res.status(500).json({ error: "Error al obtener transacciones." });
  }
});

module.exports = router;
