const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

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
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
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
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
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
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;
    const cat = tx.category_id;

    if (!gastosPorMesCat[key]) gastosPorMesCat[key] = {};
    gastosPorMesCat[key][cat] =
      (gastosPorMesCat[key][cat] || 0) + parseFloat(tx.amount);
  });

  const result = budgets.map((b) => ({
    month: b.month,
    category: b.categories?.name || `Categoría ${b.category_id}`,
    budgeted: parseFloat(b.limit_amount),
    spent: gastosPorMesCat[b.month]?.[b.category_id] || 0,
  }));

  res.json({ success: true, data: result });
});

router.get(
  "/budget-vs-actual-summary-yearly",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();

    // Presupuestos del año actual
    const { data: budgets, error: budgetError } = await supabase
      .from("budgets")
      .select("month, limit_amount")
      .eq("user_id", user_id)
      .gte("month", `${year}-01`)
      .lte("month", `${year}-12`);

    if (budgetError)
      return res.status(500).json({ error: budgetError.message });

    // Gastos del año actual
    const { data: expenses, error: expenseError } = await supabase
      .from("transactions")
      .select("date, amount")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", `${year}-01-01`)
      .lte("date", `${year}-12-31`);

    if (expenseError)
      return res.status(500).json({ error: expenseError.message });

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
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        "0"
      )}`;
      if (totals[key]) {
        totals[key].spent += parseFloat(tx.amount);
      }
    });

    const result = Object.values(totals).sort((a, b) =>
      a.month.localeCompare(b.month)
    );
    res.json({ success: true, data: result });
  }
);

router.get("/realistic-projection", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const startDate = threeMonthsAgo.toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date, category_id, categories ( stability_type )")
    .eq("user_id", user_id)
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  const filtered = data.filter(
    (tx) => tx.categories?.stability_type !== "occasional"
  );

  const grouped = {};

  filtered.forEach((tx) => {
    const month = tx.date.slice(0, 7); // YYYY-MM
    if (!grouped[month]) grouped[month] = { income: 0, expense: 0 };

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") grouped[month].income += amt;
    else grouped[month].expense += amt;
  });

  const sorted = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { income, expense }]) => ({
      month,
      income,
      expense,
      saving: income - expense,
    }));

  const avgIncome =
    sorted.reduce((acc, cur) => acc + cur.income, 0) / sorted.length || 0;
  const avgExpense =
    sorted.reduce((acc, cur) => acc + cur.expense, 0) / sorted.length || 0;

  // Proyectar con tipos de estabilidad aplicados
  const projections = [];
  let [y, m] = sorted.at(-1)?.month.split("-").map(Number) || [
    now.getFullYear(),
    now.getMonth() + 1,
  ];

  for (let i = 1; i <= 6; i++) {
    m++;
    if (m > 12) {
      y++;
      m = 1;
    }
    const label = `${y}-${String(m).padStart(2, "0")}`;

    projections.push({
      month: label,
      income: avgIncome,
      expense: avgExpense,
      saving: avgIncome - avgExpense,
    });
  }

  res.json({ success: true, data: [...sorted, ...projections] });
});

router.get("/expense-by-stability-type", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, categories ( stability_type )")
    .eq("user_id", user_id)
    .eq("type", "expense");

  if (error) return res.status(500).json({ error: error.message });

  const totals = { fixed: 0, variable: 0, occasional: 0 };

  for (const tx of data) {
    const stability = tx.categories?.stability_type || "variable";
    totals[stability] += parseFloat(tx.amount);
  }

  const result = Object.entries(totals).map(([type, total]) => ({
    type,
    total,
  }));

  res.json({ success: true, data: result });
});

router.get("/top-variable-categories", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, category_id, categories ( name, stability_type )")
    .eq("user_id", user_id)
    .eq("type", "expense");

  if (error) return res.status(500).json({ error: error.message });

  const totals = {};

  data.forEach((tx) => {
    const category = tx.categories?.name;
    const type = tx.categories?.stability_type || "variable";

    if (type !== "variable" || !category) return;

    if (!totals[category]) totals[category] = 0;
    totals[category] += parseFloat(tx.amount);
  });

  const result = Object.entries(totals)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5); // top 5

  res.json({ success: true, data: result });
});

router.get("/goals-progress", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("goals")
    .select("name, target_amount, current_amount")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const result = data.map((goal) => {
    const progress = Math.min(
      (parseFloat(goal.current_amount) / parseFloat(goal.target_amount)) * 100,
      100
    );

    return {
      name: goal.name,
      current: parseFloat(goal.current_amount),
      target: parseFloat(goal.target_amount),
      progress,
    };
  });

  res.json({ success: true, data: result });
});

router.get("/saving-real-vs-projected", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: txs, error } = await supabase
    .from("transactions")
    .select("amount, type, date, categories(stability_type)")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};

  txs.forEach((tx) => {
    const key = tx.date.slice(0, 7); // YYYY-MM
    const stability = tx.categories?.stability_type || "variable";

    if (!grouped[key]) {
      grouped[key] = { realIncome: 0, realExpense: 0 };
    }

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") grouped[key].realIncome += amt;
    else if (tx.type === "expense") grouped[key].realExpense += amt;
  });

  const months = Object.keys(grouped).sort();
  const rows = months.map((m) => {
    const income = grouped[m].realIncome;
    const expense = grouped[m].realExpense;
    const saving = income - expense;
    return { month: m, income, expense, saving };
  });

  const avgSaving =
    rows.reduce((sum, row) => sum + row.saving, 0) / rows.length || 0;

  const now = new Date();
  const projections = [];
  let [year, month] = months.at(-1)?.split("-").map(Number) || [
    now.getFullYear(),
    now.getMonth() + 1,
  ];

  for (let i = 1; i <= 6; i++) {
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
    const label = `${year}-${String(month).padStart(2, "0")}`;
    projections.push({
      month: label,
      saving: 0,
      projectedSaving: avgSaving,
    });
  }

  const combined = rows.map((r) => ({
    month: r.month,
    saving: r.saving,
    projectedSaving: avgSaving,
  }));

  res.json({ success: true, data: [...combined, ...projections] });
});

router.get("/scenario-projections", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const startDate = sixMonthsAgo.toISOString().split("T")[0];

  // Traer transacciones recientes con tipo de estabilidad
  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date, categories(stability_type)")
    .eq("user_id", user_id)
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  // Solo categorías fijas o variables
  const filtered = data.filter(
    (tx) =>
      tx.categories &&
      ["fixed", "variable"].includes(tx.categories.stability_type)
  );

  const grouped = {};

  filtered.forEach((tx) => {
    const month = tx.date.slice(0, 7);
    if (!grouped[month]) grouped[month] = { income: 0, expense: 0 };

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") grouped[month].income += amt;
    else if (tx.type === "expense") grouped[month].expense += amt;
  });

  const history = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({
      month,
      income: values.income,
      expense: values.expense,
      saving: values.income - values.expense,
    }));

  const avgIncome =
    history.reduce((sum, h) => sum + h.income, 0) / history.length || 0;
  const avgExpense =
    history.reduce((sum, h) => sum + h.expense, 0) / history.length || 0;

  const scenarios = {
    Conservador: { incomeFactor: 0.95, expenseFactor: 1.05 },
    Neutro: { incomeFactor: 1.0, expenseFactor: 1.0 },
    Optimista: { incomeFactor: 1.05, expenseFactor: 0.95 },
  };

  const projections = [];
  let [year, month] = history.at(-1)?.month.split("-").map(Number) || [
    now.getFullYear(),
    now.getMonth() + 1,
  ];

  for (let i = 1; i <= 6; i++) {
    month++;
    if (month > 12) {
      year++;
      month = 1;
    }
    const label = `${year}-${String(month).padStart(2, "0")}`;

    for (const [scenario, { incomeFactor, expenseFactor }] of Object.entries(
      scenarios
    )) {
      const income = parseFloat((avgIncome * incomeFactor).toFixed(2));
      const expense = parseFloat((avgExpense * expenseFactor).toFixed(2));
      const saving = parseFloat((income - expense).toFixed(2));

      projections.push({
        month: label,
        scenario,
        projected_income: income,
        projected_expense: expense,
        projected_saving: saving,
      });
    }
  }

  res.json({ success: true, data: projections });
});

router.get(
  "/projected-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      .toISOString()
      .split("T")[0];

    const { data, error } = await supabase
      .from("transactions")
      .select(
        "amount, type, date, category_id, categories(name, stability_type)"
      )
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", startDate);

    if (error) return res.status(500).json({ error: error.message });

    const monthlyPerCategory = {};

    data.forEach((tx) => {
      const catName = tx.categories?.name || "Sin categoría";
      const stability = tx.categories?.stability_type || "variable";
      const month = tx.date.slice(0, 7);

      if (stability === "occasional") return;

      const key = `${catName}__${stability}__${month}`;
      if (!monthlyPerCategory[key]) {
        monthlyPerCategory[key] = {
          category: catName,
          stability_type: stability,
          month,
          total: 0,
        };
      }

      monthlyPerCategory[key].total += parseFloat(tx.amount);
    });

    const byCategory = {};

    Object.values(monthlyPerCategory).forEach((entry) => {
      const key = `${entry.category}__${entry.stability_type}`;
      if (!byCategory[key]) {
        byCategory[key] = {
          category: entry.category,
          stability_type: entry.stability_type,
          total: 0,
          months: 0,
        };
      }
      byCategory[key].total += entry.total;
      byCategory[key].months += 1;
    });

    const result = Object.values(byCategory).map((entry) => ({
      category: entry.category,
      stability_type: entry.stability_type,
      projected_monthly: parseFloat((entry.total / entry.months).toFixed(2)),
    }));

    res.json({ success: true, data: result });
  }
);

router.get(
  "/projected-income-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      .toISOString()
      .split("T")[0];

    const { data, error } = await supabase
      .from("transactions")
      .select(
        "amount, type, date, category_id, categories(name, stability_type)"
      )
      .eq("user_id", user_id)
      .eq("type", "income")
      .gte("date", startDate);

    if (error) return res.status(500).json({ error: error.message });

    // Agrupar por mes y categoría
    const monthlyPerCategory = {};

    data.forEach((tx) => {
      const catName = tx.categories?.name || "Sin categoría";
      const stability = tx.categories?.stability_type || "variable";
      const month = tx.date.slice(0, 7); // YYYY-MM

      const key = `${catName}__${stability}__${month}`;
      if (!monthlyPerCategory[key]) {
        monthlyPerCategory[key] = {
          category: catName,
          stability_type: stability,
          month,
          total: 0,
        };
      }

      monthlyPerCategory[key].total += parseFloat(tx.amount);
    });

    // Agrupar por categoría y calcular promedio mensual
    const byCategory = {};

    Object.values(monthlyPerCategory).forEach((entry) => {
      const key = `${entry.category}__${entry.stability_type}`;
      if (!byCategory[key]) {
        byCategory[key] = {
          category: entry.category,
          stability_type: entry.stability_type,
          total: 0,
          months: 0,
        };
      }
      byCategory[key].total += entry.total;
      byCategory[key].months += 1;
    });

    const result = Object.values(byCategory).map((entry) => ({
      category: entry.category,
      stability_type: entry.stability_type,
      projected_monthly: parseFloat((entry.total / entry.months).toFixed(2)),
    }));

    res.json({ success: true, data: result });
  }
);

router.get("/stability-balance-summary", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1)
    .toISOString()
    .split("T")[0];

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, date, categories(stability_type)")
    .eq("user_id", user_id)
    .gte("date", startDate);

  if (error) return res.status(500).json({ error: error.message });

  const monthGrouped = {};

  for (const tx of data) {
    const stability = tx.categories?.stability_type || "variable";
    if (stability === "occasional") continue;

    const month = tx.date.slice(0, 7); // YYYY-MM
    const key = `${stability}__${month}`;

    if (!monthGrouped[key]) {
      monthGrouped[key] = {
        stability_type: stability,
        income: 0,
        expense: 0,
        month,
      };
    }

    const amt = parseFloat(tx.amount);
    if (tx.type === "income") monthGrouped[key].income += amt;
    else if (tx.type === "expense") monthGrouped[key].expense += amt;
  }

  // Reagrupar por estabilidad
  const totals = {};

  Object.values(monthGrouped).forEach(({ stability_type, income, expense }) => {
    if (!totals[stability_type]) {
      totals[stability_type] = {
        stability_type,
        income: 0,
        expense: 0,
        months: 0,
      };
    }
    totals[stability_type].income += income;
    totals[stability_type].expense += expense;
    totals[stability_type].months += 1;
  });

  const result = Object.values(totals).map((e) => ({
    stability_type: e.stability_type,
    income: parseFloat((e.income / e.months).toFixed(2)),
    expense: parseFloat((e.expense / e.months).toFixed(2)),
    balance: parseFloat(((e.income - e.expense) / e.months).toFixed(2)),
  }));

  res.json({ success: true, data: result });
});

router.post("/simulated-scenario", authenticateUser, async (req, res) => {
  const userId = req.user.id; // asumimos autenticación ya implementada
  const { income_adjustment, expense_adjustment } = req.body;

  try {
    const { data: transactions, error } = await supabase
      .from("transactions")
      .select(
        `
        amount,
        type,
        date,
        category_id,
        categories (
          stability_type
        )
      `
      )
      .eq("user_id", userId);

    if (error) throw error;

    // Agrupar por mes + tipo de estabilidad
    const monthlyData = {};

    transactions.forEach((tx) => {
      const month = tx.date.slice(0, 7); // "2025-06"
      const stability = tx.categories?.stability_type || "variable";
      const type = tx.type;

      if (!monthlyData[month]) monthlyData[month] = { income: {}, expense: {} };

      if (!monthlyData[month][type][stability])
        monthlyData[month][type][stability] = 0;

      monthlyData[month][type][stability] += Number(tx.amount);
    });

    const months = Object.keys(monthlyData);
    const monthsCount = months.length;

    // Calcular promedios actuales
    let totalIncome = 0,
      totalExpense = 0;

    months.forEach((month) => {
      const incomeTypes = monthlyData[month].income;
      const expenseTypes = monthlyData[month].expense;

      totalIncome += Object.values(incomeTypes).reduce((a, b) => a + b, 0);
      totalExpense += Object.values(expenseTypes).reduce((a, b) => a + b, 0);
    });

    const avgIncome = totalIncome / monthsCount;
    const avgExpense = totalExpense / monthsCount;

    // Aplicar simulaciones
    let adjustedIncome = avgIncome;
    let adjustedExpense = avgExpense;

    if (income_adjustment) {
      const { type, amount } = income_adjustment;
      adjustedIncome += amount;
    }

    if (expense_adjustment) {
      const { type, percent_reduction } = expense_adjustment;

      // Calcular cuánto del gasto mensual es del tipo indicado
      let totalOfType = 0;

      months.forEach((month) => {
        const expenseTypes = monthlyData[month].expense;
        totalOfType += expenseTypes[type] || 0;
      });

      const avgOfType = totalOfType / monthsCount;
      const reduction = (percent_reduction / 100) * avgOfType;

      adjustedExpense -= reduction;
    }

    const avgSaving = avgIncome - avgExpense;
    const scenarioSaving = adjustedIncome - adjustedExpense;

    return res.json({
      current: {
        avg_income: Number(avgIncome.toFixed(2)),
        avg_expense: Number(avgExpense.toFixed(2)),
        avg_saving: Number(avgSaving.toFixed(2)),
      },
      scenario: {
        avg_income: Number(adjustedIncome.toFixed(2)),
        avg_expense: Number(adjustedExpense.toFixed(2)),
        avg_saving: Number(scenarioSaving.toFixed(2)),
      },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Error generando el escenario simulado" });
  }
});

router.get("/top-items", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const { data, error } = await supabase
    .from("transaction_items")
    .select("item_id, quantity, items(name), transactions(date)")
    .eq("transactions.user_id", user_id)
    .gte("transactions.date", start)
    .lte("transactions.date", end)
    .order("quantity", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const aggregated = {};

  data.forEach((item) => {
    const key = item.items?.name || "Sin nombre";
    aggregated[key] = (aggregated[key] || 0) + (item.quantity || 1);
  });

  const result = Object.entries(aggregated)
    .map(([name, quantity]) => ({ item: name, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  res.json({ success: true, data: result });
});

router.get("/top-items-by-value", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year);
  const month = String(req.query.month).padStart(2, "0");

  if (!year || !month) {
    return res.status(400).json({ error: "Se requiere year y month" });
  }

  const start = `${year}-${month}-01`;
  const end = new Date(year, parseInt(month), 0).toISOString().split("T")[0];

  try {
    const { data, error } = await supabase
      .from("transaction_items")
      .select(
        `
        item_id,
        price,
        quantity,
        items (
          name,
          taxes (
            rate,
            is_exempt
          )
        ),
        transactions (
          date,
          type,
          user_id
        )
      `
      )
      .eq("transactions.user_id", user_id)
      .eq("transactions.type", "expense") // solo gastos
      .gte("transactions.date", start)
      .lte("transactions.date", end);

    if (error) return res.status(500).json({ error: error.message });

    const totals = {};

    (data || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;

      if (!trx) return;

      const itemName = itemRel?.name || "Sin nombre";
      const qty = Number(row.quantity || 1);
      const netPrice = Number(row.price || 0); // precio sin ITBIS

      // Calcular precio con ITBIS
      const taxRate =
        itemRel?.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
      const isExempt = !!itemRel?.taxes?.is_exempt;

      let priceWithTax = netPrice;
      if (!isExempt && taxRate > 0) {
        priceWithTax = netPrice * (1 + taxRate / 100);
      }

      const amount = priceWithTax * qty;

      totals[itemName] = (totals[itemName] || 0) + amount;
    });

    const result = Object.entries(totals)
      .map(([item, total_spent]) => ({
        item,
        total_spent: Number(total_spent.toFixed(2)),
      }))
      .sort((a, b) => b.total_spent - a.total_spent)
      .slice(0, 10);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error calculando top items por valor" });
  }
});

router.get("/item-trend/:item_id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const item_id = req.params.item_id;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const { data, error } = await supabase
    .from("transaction_items")
    .select("price, quantity, transactions(date)")
    .eq("transactions.user_id", user_id)
    .eq("item_id", item_id)
    .gte("transactions.date", start)
    .lte("transactions.date", end);

  if (error) return res.status(500).json({ error: error.message });

  const monthly = {};

  data.forEach((item) => {
    const date = new Date(item.transactions?.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    const total = parseFloat(item.price || 0) * (item.quantity || 1);
    const qty = item.quantity || 1;

    if (!monthly[key]) {
      monthly[key] = { month: key, quantity: 0, total: 0 };
    }

    monthly[key].quantity += qty;
    monthly[key].total += total;
  });

  const result = Object.values(monthly).sort((a, b) =>
    a.month.localeCompare(b.month)
  );

  res.json({ success: true, data: result });
});

router.get("/items-to-restock", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  // Parámetros opcionales
  const months = parseInt(req.query.months, 10) || 6; // ventana de meses hacia atrás
  try {
    const today = new Date();

    // Fecha de inicio: primer día del mes (months - 1) hacia atrás
    const startMonthDate = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1
    );
    const startDate = startMonthDate.toISOString().split("T")[0];

    // Mes siguiente (target de pronóstico)
    const nextMonthDate = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      1
    );
    const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(
      nextMonthDate.getMonth() + 1
    ).padStart(2, "0")}`;
    const nextMonthIndex =
      nextMonthDate.getFullYear() * 12 + (nextMonthDate.getMonth() + 1);

    // Traer líneas de items de transacciones de gasto + categoría + impuesto
    const { data, error } = await supabase
      .from("transaction_items")
      .select(
        `
        item_id,
        quantity,
        price,
        items (
          name,
          taxes (
            rate,
            is_exempt
          )
        ),
        transactions (
          date,
          type,
          user_id,
          categories (
            stability_type
          )
        )
      `
      )
      .eq("transactions.user_id", user_id)
      .eq("transactions.type", "expense")
      .gte("transactions.date", startDate);

    if (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }

    // Helper para gap típico (moda)
    function getTypicalGap(gaps) {
      if (!gaps.length) return null;
      const freq = {};
      gaps.forEach((g) => {
        freq[g] = (freq[g] || 0) + 1;
      });
      let bestGap = null;
      let bestCount = 0;
      for (const [gStr, count] of Object.entries(freq)) {
        const g = Number(gStr);
        if (
          count > bestCount ||
          (count === bestCount && (bestGap == null || g < bestGap))
        ) {
          bestGap = g;
          bestCount = count;
        }
      }
      return bestGap;
    }

    const itemsMap = {};

    (data || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;

      // 1) Excluir categorías "occasional"
      const stability = trx?.categories?.stability_type;
      if (stability === "occasional") return;

      const itemId = row.item_id;
      const name = itemRel?.name || "Sin nombre";
      const qty = Number(row.quantity || 0);
      const netPrice = Number(row.price || 0); // precio sin ITBIS
      const dateStr = trx?.date;

      if (!itemId || !dateStr || qty <= 0) return;

      const date = new Date(dateStr);
      const monthKey = `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;

      // Impuesto del artículo
      const taxRate =
        itemRel?.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
      const isExempt = !!itemRel?.taxes?.is_exempt;

      if (!itemsMap[itemId]) {
        itemsMap[itemId] = {
          item_id: itemId,
          item_name: name,
          perMonthQty: {}, // YYYY-MM -> qty total del item en ese mes
          lastPurchaseDate: dateStr,
          lastMonthKey: monthKey,
          lastNetPrice: netPrice,
          lastTaxRate: taxRate,
          lastIsExempt: isExempt,
        };
      }

      const item = itemsMap[itemId];

      item.perMonthQty[monthKey] = (item.perMonthQty[monthKey] || 0) + qty;

      // última compra (para cantidad y precio)
      if (new Date(item.lastPurchaseDate) < date) {
        item.lastPurchaseDate = dateStr;
        item.lastMonthKey = monthKey;
        item.lastNetPrice = netPrice;
        item.lastTaxRate = taxRate;
        item.lastIsExempt = isExempt;
      }
    });

    const result = [];

    Object.values(itemsMap).forEach((rawItem) => {
      const monthKeys = Object.keys(rawItem.perMonthQty).sort(); // YYYY-MM ascendente
      if (monthKeys.length < 2) {
        // con una sola compra no podemos deducir frecuencia de manera robusta
        return;
      }

      // Convertir a índice numérico: year * 12 + month
      const indices = monthKeys.map((mk) => {
        const [y, m] = mk.split("-").map(Number);
        return y * 12 + m;
      });

      // Gaps entre compras
      const gaps = [];
      for (let i = 1; i < indices.length; i++) {
        const diff = indices[i] - indices[i - 1];
        if (diff > 0) {
          gaps.push(diff);
        }
      }

      const typicalGap = getTypicalGap(gaps);
      if (!typicalGap || typicalGap <= 0) return;

      // Último mes de compra
      const lastMonthKey = rawItem.lastMonthKey;
      const [lastY, lastM] = lastMonthKey.split("-").map(Number);
      const lastIndex = lastY * 12 + lastM;

      const expectedNextIndex = lastIndex + typicalGap;

      // Solo marcamos el item si el mes que viene coincide con el patrón
      if (expectedNextIndex !== nextMonthIndex) {
        return;
      }

      // Cantidad pronosticada = lo que compraste en el último mes de compra
      const lastMonthQty = rawItem.perMonthQty[lastMonthKey] || 0;
      if (lastMonthQty <= 0) return;

      // Precio con ITBIS
      const netPrice = rawItem.lastNetPrice || 0;
      let priceWithTax = netPrice;
      if (!rawItem.lastIsExempt && rawItem.lastTaxRate > 0) {
        priceWithTax = netPrice * (1 + rawItem.lastTaxRate / 100);
      }

      const projectedQty = lastMonthQty;
      const projectedCost = projectedQty * priceWithTax;

      result.push({
        item_id: rawItem.item_id,
        item_name: rawItem.item_name,
        last_purchase_date: rawItem.lastPurchaseDate,
        last_month_key: lastMonthKey,
        gap_months: typicalGap,
        projected_month_key: nextMonthKey,
        projected_next_month_qty: Number(projectedQty.toFixed(2)),
        projected_next_month_cost: Number(projectedCost.toFixed(2)),
      });
    });

    // Ordenar por costo proyectado descendente
    result.sort(
      (a, b) => b.projected_next_month_cost - a.projected_next_month_cost
    );

    return res.json({
      success: true,
      meta: {
        months_considered: months,
        start_date: startDate,
        next_month: nextMonthKey,
        excludes_occasional: true,
        cost_includes_item_tax: true,
      },
      data: result,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Error calculando items a recomprar" });
  }
});

router.get(  "/category-monthly-comparison",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();

      // Parámetros: mes 1 y mes 2
      const year1Param = parseInt(req.query.year1, 10);
      const month1Param = parseInt(req.query.month1, 10); // 1-12
      const year2Param = parseInt(req.query.year2, 10);
      const month2Param = parseInt(req.query.month2, 10); // 1-12

      let y1, m1Index, y2, m2Index;

      const paramsAreValid =
        !isNaN(year1Param) &&
        !isNaN(month1Param) &&
        !isNaN(year2Param) &&
        !isNaN(month2Param) &&
        month1Param >= 1 &&
        month1Param <= 12 &&
        month2Param >= 1 &&
        month2Param <= 12;

      if (paramsAreValid) {
        y1 = year1Param;
        m1Index = month1Param - 1;
        y2 = year2Param;
        m2Index = month2Param - 1;
      } else {
        // Default: mes 1 = mes anterior, mes 2 = mes actual
        const baseYear = now.getFullYear();
        const baseMonthIndex = now.getMonth(); // actual 0-11

        y2 = baseYear;
        m2Index = baseMonthIndex;

        let prevYear = baseYear;
        let prevMonthIndex = baseMonthIndex - 1;
        if (prevMonthIndex < 0) {
          prevMonthIndex = 11;
          prevYear = baseYear - 1;
        }
        y1 = prevYear;
        m1Index = prevMonthIndex;
      }

      const month1Key = `${y1}-${String(m1Index + 1).padStart(2, "0")}`;
      const month2Key = `${y2}-${String(m2Index + 1).padStart(2, "0")}`;

      const start1 = new Date(y1, m1Index, 1).toISOString().split("T")[0];
      const end1 = new Date(y1, m1Index + 1, 0).toISOString().split("T")[0];

      const start2 = new Date(y2, m2Index, 1).toISOString().split("T")[0];
      const end2 = new Date(y2, m2Index + 1, 0).toISOString().split("T")[0];

      // Rango global para una sola query
      const globalStart = start1 < start2 ? start1 : start2;
      const globalEnd = end1 > end2 ? end1 : end2;

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
        .gte("date", globalStart)
        .lte("date", globalEnd);

      if (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
      }

      const byCategory = {};
      let totalMonth1 = 0;
      let totalMonth2 = 0;

      (data || []).forEach((tx) => {
        const dateStr = tx.date;
        if (!dateStr) return;

        const [y, m] = dateStr.split("-");
        const monthKey = `${y}-${m}`;
        const catId = tx.category_id || "sin_categoria";
        const catName = tx.categories?.name || "Sin categoría";
        const amt = Number(tx.amount || 0);

        if (!byCategory[catId]) {
          byCategory[catId] = {
            category_id: catId,
            category_name: catName,
            month1_total: 0,
            month2_total: 0,
          };
        }

        if (monthKey === month1Key) {
          byCategory[catId].month1_total += amt;
          totalMonth1 += amt;
        } else if (monthKey === month2Key) {
          byCategory[catId].month2_total += amt;
          totalMonth2 += amt;
        }
      });

      const rows = Object.values(byCategory).map((row) => {
        const m1 = row.month1_total || 0;
        const m2 = row.month2_total || 0;
        const diff = m2 - m1; // de mes1 a mes2

        let diffPercent = 0;
        if (m1 === 0 && m2 > 0) {
          diffPercent = 100;
        } else if (m1 !== 0) {
          diffPercent = (diff / m1) * 100;
        }

        return {
          category_id: row.category_id,
          category_name: row.category_name,
          month1_total: Number(m1.toFixed(2)),
          month2_total: Number(m2.toFixed(2)),
          diff: Number(diff.toFixed(2)),
          diff_percent: Number(diffPercent.toFixed(2)),
        };
      });

  
      // Ordenar por mayor diferencia (mes2 - mes1)
      rows.sort((a, b) => b.diff - a.diff);

      return res.json({
        success: true,
        meta: {
          month1: month1Key,
          month2: month2Key,
          month1_total: Number(totalMonth1.toFixed(2)),
          month2_total: Number(totalMonth2.toFixed(2)),
        },
        data: rows,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        error: "Error generando comparativo mensual por categoría",
      });
    }
  }
);

router.get(
  "/item-monthly-comparison",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();

      // Parámetros: mes 1 y mes 2
      const year1Param = parseInt(req.query.year1, 10);
      const month1Param = parseInt(req.query.month1, 10); // 1-12
      const year2Param = parseInt(req.query.year2, 10);
      const month2Param = parseInt(req.query.month2, 10); // 1-12

      let y1, m1Index, y2, m2Index;

      const paramsAreValid =
        !isNaN(year1Param) &&
        !isNaN(month1Param) &&
        !isNaN(year2Param) &&
        !isNaN(month2Param) &&
        month1Param >= 1 &&
        month1Param <= 12 &&
        month2Param >= 1 &&
        month2Param <= 12;

      if (paramsAreValid) {
        y1 = year1Param;
        m1Index = month1Param - 1;
        y2 = year2Param;
        m2Index = month2Param - 1;
      } else {
        // Default: mes 1 = mes anterior, mes 2 = mes actual
        const baseYear = now.getFullYear();
        const baseMonthIndex = now.getMonth(); // actual 0-11

        y2 = baseYear;
        m2Index = baseMonthIndex;

        let prevYear = baseYear;
        let prevMonthIndex = baseMonthIndex - 1;
        if (prevMonthIndex < 0) {
          prevMonthIndex = 11;
          prevYear = baseYear - 1;
        }
        y1 = prevYear;
        m1Index = prevMonthIndex;
      }

      const month1Key = `${y1}-${String(m1Index + 1).padStart(2, "0")}`;
      const month2Key = `${y2}-${String(m2Index + 1).padStart(2, "0")}`;

      const start1 = new Date(y1, m1Index, 1).toISOString().split("T")[0];
      const end1 = new Date(y1, m1Index + 1, 0)
        .toISOString()
        .split("T")[0];

      const start2 = new Date(y2, m2Index, 1).toISOString().split("T")[0];
      const end2 = new Date(y2, m2Index + 1, 0)
        .toISOString()
        .split("T")[0];

      // Rango global para una sola query
      const globalStart = start1 < start2 ? start1 : start2;
      const globalEnd = end1 > end2 ? end1 : end2;

      const { data, error } = await supabase
        .from("transaction_items")
        .select(`
          item_id,
          quantity,
          price,
          items (
            name,
            taxes (
              rate,
              is_exempt
            )
          ),
          transactions (
            date,
            type,
            user_id
          )
        `)
        .eq("transactions.user_id", user_id)
        .eq("transactions.type", "expense")
        .gte("transactions.date", globalStart)
        .lte("transactions.date", globalEnd);

      if (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
      }

      const byItem = {};
      let totalMonth1Amount = 0;
      let totalMonth2Amount = 0;

      (data || []).forEach((row) => {
        const trx = row.transactions;
        const itemRel = row.items;
        if (!trx) return;

        const dateStr = trx.date;
        if (!dateStr) return;

        const [y, m] = dateStr.split("-");
        const monthKey = `${y}-${m}`;

        const itemId = row.item_id || "sin_item";
        const itemName = itemRel?.name || "Sin nombre";

        const qty = Number(row.quantity || 0);
        const netPrice = Number(row.price || 0); // sin ITBIS

        // ITBIS del artículo
        const taxRate =
          itemRel?.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel?.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) {
          priceWithTax = netPrice * (1 + taxRate / 100);
        }

        const lineAmount = priceWithTax * qty;

        if (!byItem[itemId]) {
          byItem[itemId] = {
            item_id: itemId,
            item_name: itemName,
            month1_qty: 0,
            month2_qty: 0,
            month1_amount: 0,
            month2_amount: 0,
          };
        }

        if (monthKey === month1Key) {
          byItem[itemId].month1_qty += qty;
          byItem[itemId].month1_amount += lineAmount;
          totalMonth1Amount += lineAmount;
        } else if (monthKey === month2Key) {
          byItem[itemId].month2_qty += qty;
          byItem[itemId].month2_amount += lineAmount;
          totalMonth2Amount += lineAmount;
        }
      });

      const rows = Object.values(byItem).map((row) => {
        const m1Amt = row.month1_amount || 0;
        const m2Amt = row.month2_amount || 0;
        const diffAmt = m2Amt - m1Amt;
      
        const q1 = row.month1_qty || 0;
        const q2 = row.month2_qty || 0;
        const diffQty = q2 - q1; // Mes2 − Mes1 en cantidad
      
        return {
          item_id: row.item_id,
          item_name: row.item_name,
          month1_qty: Number(q1.toFixed(2)),
          month2_qty: Number(q2.toFixed(2)),
          month1_amount: Number(m1Amt.toFixed(2)),
          month2_amount: Number(m2Amt.toFixed(2)),
          diff_amount: Number(diffAmt.toFixed(2)),
          diff_qty: Number(diffQty.toFixed(2)),
        };
      });
      
      // 🔀 ORDENACIÓN CUSTOM
      // 1) Primero los que AUMENTARON el gasto (diff_amount > 0), de mayor a menor
      // 2) Luego los que quedaron IGUAL (diff_amount = 0), orden alfabético por nombre
      // 3) Luego los que DISMINUYERON el gasto (diff_amount < 0), de mayor ahorro a menor
      rows.sort((a, b) => {
        const da = a.diff_amount || 0;
        const db = b.diff_amount || 0;
      
        const groupA = da > 0 ? 2 : da === 0 ? 1 : 0;
        const groupB = db > 0 ? 2 : db === 0 ? 1 : 0;
      
        // Primero por grupo (2: aumentó, 1: igual, 0: disminuyó)
        if (groupA !== groupB) {
          return groupB - groupA; // 2 > 1 > 0
        }
      
        // Dentro del grupo de AUMENTOS: mayor diff_amount primero
        if (groupA === 2) {
          return db - da;
        }
      
        // Dentro del grupo de DISMINUCIONES: más negativo (más ahorro) primero
        if (groupA === 0) {
          return da - db; // -500, -300, -100...
        }
      
        // Dentro del grupo de IGUALES: ordenar por nombre
        return a.item_name.localeCompare(b.item_name);
      });
      
      return res.json({
        success: true,
        meta: {
          month1: month1Key,
          month2: month2Key,
          month1_total_amount: Number(totalMonth1Amount.toFixed(2)),
          month2_total_amount: Number(totalMonth2Amount.toFixed(2)),
        },
        data: rows,
      });
      
      
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        error: "Error generando comparativo mensual por artículo",
      });
    }
  }
);


module.exports = router;
