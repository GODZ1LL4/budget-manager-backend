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

    const pastMonths = Array.from({ length: 3 }).map((_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (i + 1), 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });

    const { data: pastTx } = await supabase
      .from("transactions")
      .select("amount, type, date, categories(stability_type)")
      .eq("user_id", user_id)
      .eq("type", "expense");

    const monthlyTotals = {};

    pastTx?.forEach((tx) => {
      const stab = tx.categories?.stability_type;
      if (!["fixed", "variable"].includes(stab)) return;

      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      if (pastMonths.includes(key)) {
        monthlyTotals[key] = (monthlyTotals[key] || 0) + parseFloat(tx.amount);
      }
    });

    const averageMonthlyExpense =
      Object.values(monthlyTotals).reduce((a, b) => a + b, 0) /
        pastMonths.length || 0;

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
    prevTx?.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
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

    const totalTransactions = tx.length;
    const averageTransactionsPerDay =
      daysPassed > 0 ? totalTransactions / daysPassed : 0;

    const { data: goalsData } = await supabase
      .from("goals")
      .select("current_amount, target_amount")
      .eq("user_id", user_id);

    const completedGoals = goalsData.filter(
      (g) => parseFloat(g.current_amount) >= parseFloat(g.target_amount)
    ).length;
    const totalGoals = goalsData.length;

    const totalCategoryExpense =
      Object.values(expensesByCategory).reduce((a, b) => a + b, 0) || 0;
    const expenseByCategoryPercent = {};
    for (const [cat, amount] of Object.entries(expensesByCategory)) {
      expenseByCategoryPercent[cat] = (amount / totalCategoryExpense) * 100;
    }

    const { data: prevByCat } = await supabase
      .from("transactions")
      .select("amount, category_id")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", prevStart)
      .lte("date", prevEnd);

    const prevExpensesByCategory = {};
    prevByCat?.forEach((t) => {
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

    const topCat = Object.entries(expensesByCategory).sort(
      (a, b) => b[1] - a[1]
    )[0];
    const topCategoryThisMonth = topCat
      ? { category_id: topCat[0], amount: topCat[1] }
      : null;

    const allCategoryIds = Array.from(
      new Set([
        ...Object.keys(expensesByCategory),
        ...Object.keys(prevExpensesByCategory),
        topCategoryThisMonth?.category_id,
      ])
    );

    const { data: categoryNames } = await supabase
      .from("categories")
      .select("id, name")
      .in("id", allCategoryIds);

    const categoryNameMap = {};
    categoryNames?.forEach((c) => {
      categoryNameMap[c.id] = c.name;
    });

    const topCategoryName = topCategoryThisMonth
      ? categoryNameMap[topCategoryThisMonth.category_id] || "Sin nombre"
      : null;

    const { data: txWithStability } = await supabase
      .from("transactions")
      .select("amount, type, date, categories(stability_type, name)")
      .eq("user_id", user_id)
      .gte("date", `${year}-01-01`)
      .lte("date", end);

    const fixedIncomeByMonth = {};
    let variableExpenseTotal = 0;
    let variableExpenseCount = 0;
    let ytdIncome = 0;
    let ytdExpense = 0;
    let foodCategoryTotal = 0;

    txWithStability?.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
      const stab = t.categories?.stability_type;
      const name = t.categories?.name?.toLowerCase() || "";
      const monthKey = t.date.slice(0, 7);

      if (t.type === "income") {
        ytdIncome += amt;
        if (stab === "fixed") {
          if (!fixedIncomeByMonth[monthKey]) fixedIncomeByMonth[monthKey] = 0;
          fixedIncomeByMonth[monthKey] += amt;
        }
      }

      if (t.type === "expense") {
        ytdExpense += amt;
        if (stab === "variable") {
          variableExpenseTotal += amt;
          variableExpenseCount += 1;
        }
        if (name.includes("comida") || name.includes("alimentación")) {
          foodCategoryTotal += amt;
        }
      }
    });

    const fixedIncomeAverage =
      Object.values(fixedIncomeByMonth).reduce((a, b) => a + b, 0) /
        Object.keys(fixedIncomeByMonth).length || 0;

    // === Gasto en categorías presupuestadas ===
    const { data: budgetedCategories } = await supabase
      .from("budgets")
      .select("category_id")
      .eq("user_id", user_id)
      .eq("month", `${year}-${month}`);

    const budgetedCategoryIds =
      budgetedCategories?.map((b) => b.category_id) || [];

    const budgetedExpenseTotal = tx
      .filter(
        (t) =>
          t.type === "expense" && budgetedCategoryIds.includes(t.category_id)
      )
      .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

    const totalYtdSaving = ytdIncome - ytdExpense;
    const foodSpendingRate =
      totalExpense > 0 ? (foodCategoryTotal / totalExpense) * 100 : 0;

    const { data: itemTx } = await supabase
      .from("transaction_items")
      .select("price, quantity, transaction_id, items(name)")
      .in(
        "transaction_id",
        tx.map((t) => t.id)
      );

    let maxItem = null;
    let maxItemValue = 0;
    let totalItemizedSpending = 0;

    itemTx?.forEach((i) => {
      const total = (parseFloat(i.price) || 0) * (i.quantity || 1);
      totalItemizedSpending += total;
      if (total > maxItemValue) {
        maxItemValue = total;
        maxItem = {
          name: i.items?.name || "Sin nombre",
          amount: total,
        };
      }
    });

    const { data: budgetsThisMonth } = await supabase
      .from("budgets")
      .select("limit_amount")
      .eq("user_id", user_id)
      .eq("month", `${year}-${month}`);

    const totalMonthlyBudget =
      budgetsThisMonth?.reduce(
        (sum, b) => sum + parseFloat(b.limit_amount),
        0
      ) || 0;

    const budgetBalance = totalMonthlyBudget - budgetedExpenseTotal;

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
        topCategoryThisMonth,
        topCategoryName,
        fixedIncomeAverage,
        budgetedExpenseTotal,
        totalYtdSaving,
        foodSpendingRate,
        totalItemizedSpending,
        topItemSpent: maxItem,
        totalMonthlyBudget,
        budgetBalance,
      },
    });
  } catch (err) {
    console.error("🔥 Error en dashboard/summary:", err);
    res.status(500).json({ error: "Error al calcular métricas financieras." });
  }
});

module.exports = router;
