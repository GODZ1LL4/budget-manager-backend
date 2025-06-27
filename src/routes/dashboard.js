const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

router.get("/summary", authenticateUser, async (req, res) => {
  const user_id = req.user?.id;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const start = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;

  try {
    // 1. Transacciones del mes actual
    const { data: tx, error } = await supabase
      .from("transactions")
      .select("amount, type, category_id, date")
      .eq("user_id", user_id)
      .gte("date", start)
      .lte("date", end);

    if (error) throw error;

    let totalIncome = 0;
    let totalExpense = 0;
    const expensesByCategory = {};
    tx.forEach((t) => {
      const amt = parseFloat(t.amount);
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

    // 2. Promedio diario del mes actual
    const daysPassed = now.getDate();
    const averageDailyExpense = daysPassed > 0 ? totalExpense / daysPassed : 0;

    // 3. Promedio mensual de últimos 3 meses
    const pastMonths = Array.from({ length: 3 }).map((_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (i + 1), 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });

    const { data: pastTx } = await supabase
      .from("transactions")
      .select("amount, type, date")
      .eq("user_id", user_id)
      .eq("type", "expense");

    const monthlyTotals = {};
    pastTx.forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      if (pastMonths.includes(key)) {
        monthlyTotals[key] = (monthlyTotals[key] || 0) + parseFloat(tx.amount);
      }
    });

    const averageMonthlyExpense =
      Object.values(monthlyTotals).reduce((a, b) => a + b, 0) /
      pastMonths.length;

    // 4. Comparativa con mes anterior
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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

    let prevIncome = 0,
      prevExpense = 0;
    prevTx.forEach((t) => {
      const amt = parseFloat(t.amount);
      if (t.type === "income") prevIncome += amt;
      if (t.type === "expense") prevExpense += amt;
    });

    const incomeDiffPercent =
      ((totalIncome - prevIncome) / (prevIncome || 1)) * 100;
    const expenseDiffPercent =
      ((totalExpense - prevExpense) / (prevExpense || 1)) * 100;
    const prevSavingRate =
      prevIncome > 0 ? (1 - prevExpense / prevIncome) * 100 : 0;
    const savingRateDiff = savingRate - prevSavingRate;

    // 5. Número total de transacciones del mes
    const totalTransactions = tx.length;
    const averageTransactionsPerDay =
      daysPassed > 0 ? totalTransactions / daysPassed : 0;

    // 6. Metas
    const { data: goalsData } = await supabase
      .from("goals")
      .select("current_amount, target_amount")
      .eq("user_id", user_id);

    const completedGoals = goalsData.filter(
      (g) => parseFloat(g.current_amount) >= parseFloat(g.target_amount)
    ).length;
    const totalGoals = goalsData.length;

    // 7. Porcentaje por categoría
    const totalCategoryExpense = Object.values(expensesByCategory).reduce(
      (a, b) => a + b,
      0
    );
    const expenseByCategoryPercent = {};
    for (const [cat, amount] of Object.entries(expensesByCategory)) {
      expenseByCategoryPercent[cat] = (amount / totalCategoryExpense) * 100;
    }

    // 8. Categoría con mayor aumento/disminución
    const { data: prevByCat } = await supabase
      .from("transactions")
      .select("amount, category_id")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", prevStart)
      .lte("date", prevEnd);

    const prevExpensesByCategory = {};
    prevByCat.forEach((t) => {
      prevExpensesByCategory[t.category_id] =
        (prevExpensesByCategory[t.category_id] || 0) + parseFloat(t.amount);
    });

    const variationByCategory = {};
    for (const cat of new Set([
      ...Object.keys(expensesByCategory),
      ...Object.keys(prevExpensesByCategory),
    ])) {
      const current = expensesByCategory[cat] || 0;
      const previous = prevExpensesByCategory[cat] || 0;
      variationByCategory[cat] = ((current - previous) / (previous || 1)) * 100;
    }

    const sortedVariation = Object.entries(variationByCategory).sort(
      (a, b) => b[1] - a[1]
    );
    const mostIncreasedCategory = sortedVariation[0]
      ? { category_id: sortedVariation[0][0], percent: sortedVariation[0][1] }
      : null;
    const mostDecreasedCategory = sortedVariation.slice(-1)[0]
      ? {
          category_id: sortedVariation.slice(-1)[0][0],
          percent: sortedVariation.slice(-1)[0][1],
        }
      : null;

    // Obtener nombres de categorías (de ambos meses)
    const allCategoryIds = Array.from(
      new Set([
        ...Object.keys(expensesByCategory),
        ...Object.keys(prevExpensesByCategory),
      ])
    );

    const { data: categoryNames, error: categoryError } = await supabase
      .from("categories")
      .select("id, name")
      .in("id", allCategoryIds);

    if (categoryError) {
      console.error(
        "❌ Error al obtener nombres de categorías:",
        categoryError.message
      );
    }

    const categoryNameMap = {};
    categoryNames?.forEach((c) => {
      categoryNameMap[c.id] = c.name;
    });

    res.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        balance,
        savingRate,
        averageDailyExpense,
        averageMonthlyExpense,
        previousMonthComparison: {
          incomeDiffPercent,
          expenseDiffPercent,
          savingRateDiff,
        },
        totalTransactions,
        averageTransactionsPerDay,
        goalsSummary: {
          totalGoals,
          completedGoals,
        },
        expensesByCategory,
        expenseByCategoryPercent,
        categoryNameMap,
        mostIncreasedCategory,
        mostDecreasedCategory,
      },
    });
  } catch (err) {
    console.error("🔥 Error en dashboard/summary:", err);
    res.status(500).json({ error: "Error al calcular métricas financieras." });
  }
});

module.exports = router;
