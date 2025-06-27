const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

router.get("/income-expense-by-month", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};

  data.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    if (!grouped[key]) grouped[key] = { month: key, income: 0, expense: 0 };

    const amount = parseFloat(tx.amount);
    if (tx.type === "income") grouped[key].income += amount;
    if (tx.type === "expense") grouped[key].expense += amount;
  });

  const result = Object.values(grouped).sort((a, b) =>
    a.month.localeCompare(b.month)
  );
  res.json({ success: true, data: result });
});

router.get("/item-prices-trend", authenticateUser, async (req, res) => {
  let item_ids = req.query["item_ids[]"] || req.query.item_ids;

  if (!item_ids) {
    return res.status(400).json({ error: "Se requieren item_ids" });
  }

  if (!Array.isArray(item_ids)) {
    item_ids = [item_ids];
  }

  const { data, error } = await supabase
    .from("item_prices")
    .select(
      `
        item_id,
        price,
        date,
        items ( name )
      `
    )
    .in("item_id", item_ids)
    .order("date", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const result = data.map((entry) => ({
    item_id: entry.item_id,
    item_name: entry.items?.name || "Sin nombre",
    price: entry.price,
    date: entry.date,
  }));

  res.json({ success: true, data: result });
});

router.get("/category-spending-summary", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const startDate = sixMonthsAgo.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("transactions")
    .select(
      `
        amount,
        category_id,
        categories ( name, type )
      `
    )
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  const totals = {};

  data.forEach((tx) => {
    const catId = tx.category_id;
    const catName = tx.categories?.name || "Sin categoría";
    const amount = parseFloat(tx.amount);

    if (!totals[catName]) totals[catName] = 0;
    totals[catName] += amount;
  });

  const result = Object.entries(totals)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  res.json({ success: true, data: result });
});

router.get("/category-trend", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
    months.push(key);
  }

  const startDate = `${months[0]}-01`;

  const { data, error } = await supabase
    .from("transactions")
    .select(
      `
        amount,
        date,
        category_id,
        categories ( name )
      `
    )
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  const trendMap = {};

  months.forEach((month) => {
    trendMap[month] = { month };
  });

  data.forEach((tx) => {
    const date = new Date(tx.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
    const cat = tx.categories?.name || "Sin categoría";
    const amount = parseFloat(tx.amount);

    if (!trendMap[key][cat]) trendMap[key][cat] = 0;
    trendMap[key][cat] += amount;
  });

  const result = Object.values(trendMap);
  res.json({ success: true, data: result });
});

router.get(
  "/total-expense-distribution",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const { data, error } = await supabase
      .from("transactions")
      .select(
        `
        amount,
        category_id,
        categories ( name )
      `
      )
      .eq("user_id", user_id)
      .eq("type", "expense");

    if (error) return res.status(500).json({ error: error.message });

    const totals = {};

    data.forEach((tx) => {
      const name = tx.categories?.name || "Sin categoría";
      const amount = parseFloat(tx.amount);
      if (!totals[name]) totals[name] = 0;
      totals[name] += amount;
    });

    const totalGlobal = Object.values(totals).reduce(
      (acc, val) => acc + val,
      0
    );

    const result = Object.entries(totals).map(([category, value]) => ({
      category,
      value,
      percent: (value / totalGlobal) * 100,
    }));

    res.json({ success: true, data: result });
  }
);

router.get(
  "/transaction-counts-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const { data, error } = await supabase
      .from("transactions")
      .select(
        `
        category_id,
        categories ( name ),
        type
      `
      )
      .eq("user_id", user_id);

    if (error) return res.status(500).json({ error: error.message });

    const counts = {};

    data.forEach((tx) => {
      const name = tx.categories?.name || "Sin categoría";
      if (!counts[name]) counts[name] = 0;
      counts[name] += 1;
    });

    const result = Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ success: true, data: result });
  }
);

router.get("/projection-income-expense", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const startDate = threeMonthsAgo.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id)
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  let monthlyData = {};

  data.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    if (!monthlyData[key]) monthlyData[key] = { income: 0, expense: 0 };

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") monthlyData[key].income += amt;
    else if (tx.type === "expense") monthlyData[key].expense += amt;
  });

  // Promedios
  const months = Object.values(monthlyData);
  const avgIncome =
    months.reduce((a, b) => a + b.income, 0) / months.length || 0;
  const avgExpense =
    months.reduce((a, b) => a + b.expense, 0) / months.length || 0;

  // Proyección 6 meses
  const projections = [];
  for (let i = 1; i <= 6; i++) {
    const future = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const label = `${future.getFullYear()}-${String(
      future.getMonth() + 1
    ).padStart(2, "0")}`;
    projections.push({
      month: label,
      projectedIncome: avgIncome,
      projectedExpense: avgExpense,
    });
  }

  res.json({ success: true, data: projections });
});

router.get("/budget-vs-actual", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
  const start = `${currentMonth}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

  // Obtener presupuestos activos para el mes
  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select(
      `
      category_id,
      limit_amount,
      categories ( name )
    `
    )
    .eq("user_id", user_id)
    .eq("month", currentMonth);

  if (budgetError) return res.status(500).json({ error: budgetError.message });

  // Obtener gastos reales de ese mes
  const { data: expenses, error: txError } = await supabase
    .from("transactions")
    .select("category_id, amount")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", start)
    .lte("date", end);

  if (txError) return res.status(500).json({ error: txError.message });

  const gastosPorCategoria = {};
  expenses.forEach((tx) => {
    const cat = tx.category_id;
    if (!cat) return;
    gastosPorCategoria[cat] =
      (gastosPorCategoria[cat] || 0) + parseFloat(tx.amount);
  });

  const result = budgets.map((b) => ({
    category: b.categories?.name || "Sin categoría",
    presupuesto: parseFloat(b.limit_amount),
    gastado: gastosPorCategoria[b.category_id] || 0,
  }));

  res.json({ success: true, data: result });
});

router.get("/account-balances", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("account_id, amount, type, accounts(name)")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const balances = {};

  transactions.forEach((tx) => {
    const id = tx.account_id;
    const name = tx.accounts?.name || "Sin nombre";
    const amt = parseFloat(tx.amount);

    if (!balances[id]) {
      balances[id] = { name, balance: 0 };
    }

    balances[id].balance += tx.type === "income" ? amt : -amt;
  });

  const result = Object.values(balances).sort((a, b) => b.balance - a.balance);
  res.json({ success: true, data: result });
});

router.get("/monthly-balance", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const monthly = {};

  transactions.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    if (!monthly[key]) {
      monthly[key] = { month: key, income: 0, expense: 0 };
    }

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") {
      monthly[key].income += amt;
    } else if (tx.type === "expense") {
      monthly[key].expense += amt;
    }
  });

  const sorted = Object.values(monthly)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      balance: m.income - m.expense,
    }));

  res.json({ success: true, data: sorted });
});

router.get("/savings-projection", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: txs, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const byMonth = {};

  txs.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    if (!byMonth[key]) byMonth[key] = { income: 0, expense: 0 };

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") byMonth[key].income += amt;
    else byMonth[key].expense += amt;
  });

  const sortedMonths = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { income, expense }]) => ({
      month,
      saving: income - expense,
    }));

  const avgSaving =
    sortedMonths.reduce((sum, m) => sum + m.saving, 0) / sortedMonths.length;
  const lastMonth =
    sortedMonths.at(-1)?.month || new Date().toISOString().slice(0, 7);

  const futureMonths = [];
  let [year, month] = lastMonth.split("-").map(Number);

  for (let i = 1; i <= 6; i++) {
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
    const label = `${year}-${String(month).padStart(2, "0")}`;
    futureMonths.push({ month: label, saving: avgSaving });
  }

  res.json({ success: true, data: [...sortedMonths, ...futureMonths] });
});

router.get("/spending-vs-budget", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
  const start = `${currentMonth}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

  // Presupuestos del mes
  const { data: budgets, error: errBudgets } = await supabase
    .from("budgets")
    .select("id, category_id, limit_amount, categories(name)")
    .eq("user_id", user_id)
    .eq("month", currentMonth);

  if (errBudgets) return res.status(500).json({ error: errBudgets.message });

  // Gastos del mes
  const { data: expenses, error: errTx } = await supabase
    .from("transactions")
    .select("category_id, amount")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", start)
    .lte("date", end);

  if (errTx) return res.status(500).json({ error: errTx.message });

  const gastosPorCategoria = {};
  expenses.forEach((tx) => {
    const id = tx.category_id;
    if (!gastosPorCategoria[id]) gastosPorCategoria[id] = 0;
    gastosPorCategoria[id] += parseFloat(tx.amount);
  });

  const result = budgets.map((b) => ({
    category: b.categories?.name || `Categoría ${b.category_id}`,
    spent: gastosPorCategoria[b.category_id] || 0,
    limit: parseFloat(b.limit_amount),
  }));

  res.json({ success: true, data: result });
});

router.get("/overbudget-categories", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
  const start = `${currentMonth}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

  const { data: budgets, error: errBudgets } = await supabase
    .from("budgets")
    .select("category_id, limit_amount, categories(name)")
    .eq("user_id", user_id)
    .eq("month", currentMonth);

  if (errBudgets) return res.status(500).json({ error: errBudgets.message });

  const { data: expenses, error: errTx } = await supabase
    .from("transactions")
    .select("category_id, amount")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", start)
    .lte("date", end);

  if (errTx) return res.status(500).json({ error: errTx.message });

  const gastoPorCategoria = {};
  expenses.forEach((tx) => {
    const id = tx.category_id;
    if (!gastoPorCategoria[id]) gastoPorCategoria[id] = 0;
    gastoPorCategoria[id] += parseFloat(tx.amount);
  });

  const sobres = budgets
    .map((b) => {
      const spent = gastoPorCategoria[b.category_id] || 0;
      const over = spent - b.limit_amount;
      return {
        category: b.categories?.name || `Categoría ${b.category_id}`,
        spent,
        limit: parseFloat(b.limit_amount),
        over,
      };
    })
    .filter((b) => b.over > 0)
    .sort((a, b) => b.over - a.over)
    .slice(0, 3); // top 3

  res.json({ success: true, data: sobres });
});
router.get("/saving-trend", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};

  data.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    const amt = parseFloat(tx.amount);

    if (!grouped[key]) grouped[key] = { month: key, income: 0, expense: 0 };

    if (tx.type === "income") grouped[key].income += amt;
    if (tx.type === "expense") grouped[key].expense += amt;
  });

  const result = Object.values(grouped)
    .map((entry) => ({
      ...entry,
      saving: entry.income - entry.expense,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  res.json({ success: true, data: result });
});
router.get("/saving-projection", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};

  data.forEach((tx) => {
    const [year, month] = tx.date.split("-");
    const key = `${year}-${month}`;
    const amt = parseFloat(tx.amount);

    if (!grouped[key]) grouped[key] = { income: 0, expense: 0 };

    if (tx.type === "income") grouped[key].income += amt;
    if (tx.type === "expense") grouped[key].expense += amt;
  });

  const months = Object.keys(grouped);
  const savingHistory = months.map(
    (m) => grouped[m].income - grouped[m].expense
  );
  const avgSaving = savingHistory.length
    ? savingHistory.reduce((a, b) => a + b, 0) / savingHistory.length
    : 0;

  const now = new Date();
  const projections = [];

  for (let i = 1; i <= 6; i++) {
    const next = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
    projections.push({
      month: key,
      projectedSaving: avgSaving,
    });
  }

  res.json({ success: true, data: projections });
});
router.get("/transactions-by-type", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("type")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const result = {
    income: 0,
    expense: 0,
  };

  data.forEach((tx) => {
    if (tx.type === "income") result.income++;
    if (tx.type === "expense") result.expense++;
  });

  res.json({ success: true, data: result });
});
router.get(
  "/annual-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const yearEnd = `${now.getFullYear()}-12-31`;

    const { data, error } = await supabase
      .from("transactions")
      .select("category_id, amount, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", yearStart)
      .lte("date", yearEnd);

    if (error) return res.status(500).json({ error: error.message });

    const result = {};

    data.forEach((tx) => {
      const cat = tx.categories?.name || "Sin categoría";
      result[cat] = (result[cat] || 0) + parseFloat(tx.amount);
    });

    const response = Object.entries(result).map(([name, value]) => ({
      category: name,
      total: value,
    }));

    res.json({ success: true, data: response });
  }
);
router.get("/monthly-income", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, date")
    .eq("user_id", user_id)
    .eq("type", "income")
    .gte("date", start)
    .lte("date", end);

  if (error) return res.status(500).json({ error: error.message });

  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    total: 0,
  }));

  data.forEach((tx) => {
    const [y, m] = tx.date.split("-");
    const idx = parseInt(m, 10) - 1;
    monthly[idx].total += parseFloat(tx.amount);
  });

  res.json({ success: true, data: monthly });
});
router.get(
  "/monthly-income-expense-avg",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    const { data, error } = await supabase
      .from("transactions")
      .select("amount, type, date")
      .eq("user_id", user_id)
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    const grouped = {};

    data.forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      if (!grouped[key]) grouped[key] = { income: 0, expense: 0 };

      const amount = parseFloat(tx.amount);
      if (tx.type === "income") grouped[key].income += amount;
      else if (tx.type === "expense") grouped[key].expense += amount;
    });

    const result = Object.entries(grouped)
      .map(([month, { income, expense }]) => ({
        month,
        income,
        expense,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    res.json({ success: true, data: result });
  }
);
router.get(
  "/yearly-category-variations",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    const { data, error } = await supabase
      .from("transactions")
      .select("amount, category_id, date")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    // Agrupar por mes y categoría
    const grouped = {};
    data.forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      const cat = tx.category_id;
      if (!grouped[key]) grouped[key] = {};
      if (!grouped[key][cat]) grouped[key][cat] = 0;
      grouped[key][cat] += parseFloat(tx.amount);
    });

    // Reorganizar por categoría
    const perCategory = {};
    Object.entries(grouped).forEach(([month, cats]) => {
      Object.entries(cats).forEach(([catId, amount]) => {
        if (!perCategory[catId]) perCategory[catId] = [];
        perCategory[catId].push({ month, amount });
      });
    });

    res.json({ success: true, data: perCategory });
  }
);
router.get("/budget-vs-actual-history", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  // Últimos 6 meses
  const now = new Date();
  const months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push(key);
  }

  const startDate = `${months[0]}-01`;

  // Obtener presupuestos
  const { data: budgets, error: budgetErr } = await supabase
    .from("budgets")
    .select("month, category_id, limit_amount, categories(name)")
    .eq("user_id", user_id)
    .gte("month", months[0]);

  if (budgetErr) return res.status(500).json({ error: budgetErr.message });

  // Obtener gastos
  const { data: expenses, error: expenseErr } = await supabase
    .from("transactions")
    .select("category_id, amount, date")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", startDate);

  if (expenseErr) return res.status(500).json({ error: expenseErr.message });

  const gastosPorMesCategoria = {};

  expenses.forEach((tx) => {
    const date = new Date(tx.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const cat = tx.category_id;

    if (!gastosPorMesCategoria[key]) gastosPorMesCategoria[key] = {};
    gastosPorMesCategoria[key][cat] =
      (gastosPorMesCategoria[key][cat] || 0) + parseFloat(tx.amount);
  });

  const result = budgets.map((b) => ({
    month: b.month,
    category: b.categories?.name || `Categoría ${b.category_id}`,
    budgeted: parseFloat(b.limit_amount),
    spent: gastosPorMesCategoria[b.month]?.[b.category_id] || 0,
  }));

  res.json({ success: true, data: result });
});
router.get("/budget-vs-actual-yearly", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const now = new Date();
  const year = now.getFullYear();

  // Crear arreglo de meses del año actual
  const months = Array.from({ length: 12 }, (_, i) => {
    return `${year}-${String(i + 1).padStart(2, "0")}`;
  });

  // Obtener presupuestos del año actual
  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select("month, category_id, limit_amount, categories(name)")
    .eq("user_id", user_id)
    .gte("month", `${year}-01`)
    .lte("month", `${year}-12`);

  if (budgetError) return res.status(500).json({ error: budgetError.message });

  // Obtener gastos del año actual
  const { data: expenses, error: txError } = await supabase
    .from("transactions")
    .select("date, amount, category_id")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`);

  if (txError) return res.status(500).json({ error: txError.message });

  const gastosPorMesCat = {};

  expenses.forEach((tx) => {
    const date = new Date(tx.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const cat = tx.category_id;

    if (!gastosPorMesCat[key]) gastosPorMesCat[key] = {};
    gastosPorMesCat[key][cat] = (gastosPorMesCat[key][cat] || 0) + parseFloat(tx.amount);
  });

  const result = budgets.map((b) => ({
    month: b.month,
    category: b.categories?.name || `Categoría ${b.category_id}`,
    budgeted: parseFloat(b.limit_amount),
    spent: gastosPorMesCat[b.month]?.[b.category_id] || 0,
  }));

  res.json({ success: true, data: result });
});
router.get("/budget-vs-actual-summary-yearly", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = new Date().getFullYear();

  // Presupuestos del año actual
  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select("month, limit_amount")
    .eq("user_id", user_id)
    .gte("month", `${year}-01`)
    .lte("month", `${year}-12`);

  if (budgetError) return res.status(500).json({ error: budgetError.message });

  // Gastos del año actual
  const { data: expenses, error: expenseError } = await supabase
    .from("transactions")
    .select("date, amount")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`);

  if (expenseError) return res.status(500).json({ error: expenseError.message });

  const totals = {};

  for (let i = 1; i <= 12; i++) {
    const key = `${year}-${String(i).padStart(2, "0")}`;
    totals[key] = { month: key, budgeted: 0, spent: 0 };
  }

  budgets.forEach((b) => {
    if (totals[b.month]) {
      totals[b.month].budgeted += parseFloat(b.limit_amount);
    }
  });

  expenses.forEach((tx) => {
    const date = new Date(tx.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (totals[key]) {
      totals[key].spent += parseFloat(tx.amount);
    }
  });

  const result = Object.values(totals).sort((a, b) => a.month.localeCompare(b.month));
  res.json({ success: true, data: result });
});

module.exports = router;
