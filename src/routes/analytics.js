const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

/* ========= Helpers comunes ========= */

const getMonthKey = (date) => {
  const d = typeof date === "string" ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const getYearRange = (year) => ({
  start: `${year}-01-01`,
  end: `${year}-12-31`,
});

const getLastNMonthsKeys = (n, fromDate = new Date()) => {
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(fromDate.getFullYear(), fromDate.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  }
  return months;
};

const getMonthDateRange = (year, monthIndex0) => {
  const start = new Date(year, monthIndex0, 1).toISOString().split("T")[0];
  const end = new Date(year, monthIndex0 + 1, 0).toISOString().split("T")[0];
  return { start, end };
};

/* ========= ITEM PRICES ========= */

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

  const result = (data || []).map((entry) => ({
    item_id: entry.item_id,
    item_name: entry.items?.name || "Sin nombre",
    price: entry.price,
    date: entry.date,
  }));

  res.json({ success: true, data: result });
});

/* ========= CATEGORÍAS: RESUMEN Y TENDENCIAS ========= */


router.get("/top-items-by-category", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const category_id = req.query.category_id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const limit = parseInt(req.query.limit, 10) || 10;

  if (!category_id) {
    return res.status(400).json({ error: "Se requiere category_id" });
  }

  const { start, end } = getYearRange(year); // ya lo tienes definido arriba

  try {
    const { data, error } = await supabase
      .from("transaction_items")
      .select(
        `
        item_id,
        quantity,
        unit_price_net,
        line_total_final,
        items!inner (
          name,
          taxes (
            rate,
            is_exempt
          )
        ),
        transactions!inner (
          date,
          type,
          user_id,
          category_id
        )
      `
      )
      .eq("transactions.user_id", user_id)
      .eq("transactions.type", "expense")
      .eq("transactions.category_id", category_id)
      .gte("transactions.date", start)
      .lte("transactions.date", end);

    if (error) return res.status(500).json({ error: error.message });

    const aggregated = {};

    (data || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx || !itemRel) return;

      const itemId = row.item_id;
      const itemName = itemRel.name || "Sin nombre";
      const qty = Number(row.quantity || 0);

      let amount = 0;

      if (row.line_total_final != null) {
        amount = Number(row.line_total_final) || 0;
      } else {
        // fallback igual a /top-items-by-value
        const netPrice = Number(row.unit_price_net || 0);
        const taxRate =
          itemRel.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) {
          priceWithTax = netPrice * (1 + taxRate / 100);
        }

        amount = priceWithTax * qty;
      }

      if (!aggregated[itemId]) {
        aggregated[itemId] = {
          item_id: itemId,
          item_name: itemName,
          total_quantity: 0,
          total_spent: 0,
        };
      }

      aggregated[itemId].total_quantity += qty;
      aggregated[itemId].total_spent += amount;
    });

    const result = Object.values(aggregated)
      .map((row) => ({
        item_id: row.item_id,
        item: row.item_name,
        total_quantity: row.total_quantity,
        total_spent: Number(row.total_spent.toFixed(2)),
      }))
      .sort((a, b) => b.total_spent - a.total_spent)
      .slice(0, limit);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Error calculando top ítems por categoría" });
  }
});

/* ========= PRESUPUESTO VS REAL (MES ACTUAL) ========= */

async function getBudgetVsActualRawByCategory(user_id, now = new Date()) {
  const currentMonth = getMonthKey(now);
  const start = `${currentMonth}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

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

  if (budgetError) throw new Error(budgetError.message);

  const { data: expenses, error: txError } = await supabase
    .from("transactions")
    .select("category_id, amount")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", start)
    .lte("date", end);

  if (txError) throw new Error(txError.message);

  const gastosPorCategoria = {};
  (expenses || []).forEach((tx) => {
    const cat = tx.category_id;
    if (!cat) return;
    gastosPorCategoria[cat] =
      (gastosPorCategoria[cat] || 0) + parseFloat(tx.amount);
  });

  // Normalizamos a estructura base { category, limit, spent }
  return (budgets || []).map((b) => ({
    category: b.categories?.name || "Sin categoría",
    limit: parseFloat(b.limit_amount),
    spent: gastosPorCategoria[b.category_id] || 0,
  }));
}

router.get("/budget-vs-actual", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    const raw = await getBudgetVsActualRawByCategory(user_id);
    const result = raw.map((r) => ({
      category: r.category,
      presupuesto: r.limit,
      gastado: r.spent,
    }));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alias con shape diferente, usado por otros componentes
router.get("/spending-vs-budget", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    const raw = await getBudgetVsActualRawByCategory(user_id);
    const result = raw.map((r) => ({
      category: r.category,
      spent: r.spent,
      limit: r.limit,
    }));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ========= SALDOS POR CUENTA ========= */

router.get("/account-balances", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    const { data: accounts, error } = await supabase
      .from("accounts")
      .select("name, current_balance")
      .eq("user_id", user_id);

    if (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }

    const result = (accounts || [])
      .map((acc) => ({
        name: acc.name || "Sin nombre",
        balance: parseFloat(acc.current_balance || 0),
      }))
      .sort((a, b) => b.balance - a.balance);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Error al obtener saldos por cuenta" });
  }
});

/* ========= PROYECCIÓN DE AHORRO SIMPLE ========= */

router.get("/savings-projection", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: txs, error } = await supabase
    .from("transactions")
    .select("amount, type, date")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const byMonth = {};

  (txs || []).forEach((tx) => {
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
    sortedMonths.reduce((sum, m) => sum + m.saving, 0) /
    (sortedMonths.length || 1);

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

/* ========= OVERBUDGET ========= */

router.get("/overbudget-categories", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const currentMonth = getMonthKey(now);
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
  (expenses || []).forEach((tx) => {
    const id = tx.category_id;
    if (!gastoPorCategoria[id]) gastoPorCategoria[id] = 0;
    gastoPorCategoria[id] += parseFloat(tx.amount);
  });

  const sobres = (budgets || [])
    .map((b) => {
      const spent = gastoPorCategoria[b.category_id] || 0;
      const limit = parseFloat(b.limit_amount);
      const over = spent - limit;
      return {
        category: b.categories?.name || `Categoría ${b.category_id}`,
        spent,
        limit,
        over,
      };
    })
    .filter((b) => b.over > 0)
    .sort((a, b) => b.over - a.over)
    .slice(0, 3);

  res.json({ success: true, data: sobres });
});

/* ========= TENDENCIA DE AHORRO Y INGRESO/GASTO MENSUAL ========= */

router.get("/monthly-income-expense-avg",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();
    const { start, end } = getYearRange(year);

    const { data, error } = await supabase
      .from("transactions")
      .select("amount, type, date")
      .eq("user_id", user_id)
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    const grouped = {};
    (data || []).forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      if (!grouped[key]) grouped[key] = { income: 0, expense: 0 };

      const amount = parseFloat(tx.amount);
      if (tx.type === "income") grouped[key].income += amount;
      else if (tx.type === "expense") grouped[key].expense += amount;
    });

    const result = Object.entries(grouped)
      .map(([month, { income, expense }]) => {
        income = Number(income ?? 0);
        expense = Number(expense ?? 0);
        return {
          month,
          income,
          expense,
          balance: income - expense,
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month));

    res.json({ success: true, data: result });
  }
);

/* ========= GASTO ANUAL POR CATEGORÍA Y VARIACIONES ========= */

router.get("/annual-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();
    const { start, end } = getYearRange(year);

    const { data, error } = await supabase
      .from("transactions")
      .select("category_id, amount, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    const result = {};

    (data || []).forEach((tx) => {
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

router.get("/yearly-category-variations",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const year = new Date().getFullYear();
    const { start, end } = getYearRange(year);

    const { data, error } = await supabase
      .from("transactions")
      .select("amount, category_id, date")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    const grouped = {};
    (data || []).forEach((tx) => {
      const [y, m] = tx.date.split("-");
      const key = `${y}-${m}`;
      const cat = tx.category_id;
      if (!grouped[key]) grouped[key] = {};
      if (!grouped[key][cat]) grouped[key][cat] = 0;
      grouped[key][cat] += parseFloat(tx.amount);
    });

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

/* ========= HISTÓRICO BUDGET VS ACTUAL ========= */

router.get("/budget-vs-actual-history", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const now = new Date();
  const months = getLastNMonthsKeys(6, now);
  const startDate = `${months[0]}-01`;

  const { data: budgets, error: budgetErr } = await supabase
    .from("budgets")
    .select("month, category_id, limit_amount, categories(name)")
    .eq("user_id", user_id)
    .gte("month", months[0]);

  if (budgetErr) return res.status(500).json({ error: budgetErr.message });

  const { data: expenses, error: expenseErr } = await supabase
    .from("transactions")
    .select("category_id, amount, date")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", startDate);

  if (expenseErr) return res.status(500).json({ error: expenseErr.message });

  const gastosPorMesCategoria = {};
  (expenses || []).forEach((tx) => {
    const key = getMonthKey(tx.date);
    const cat = tx.category_id;

    if (!gastosPorMesCategoria[key]) gastosPorMesCategoria[key] = {};
    gastosPorMesCategoria[key][cat] =
      (gastosPorMesCategoria[key][cat] || 0) + parseFloat(tx.amount);
  });

  const result = (budgets || []).map((b) => ({
    month: b.month,
    category: b.categories?.name || `Categoría ${b.category_id}`,
    budgeted: parseFloat(b.limit_amount),
    spent: gastosPorMesCategoria[b.month]?.[b.category_id] || 0,
  }));

  res.json({ success: true, data: result });
});

router.get("/budget-vs-actual-summary-yearly",
  authenticateUser,
  async (req, res) => {
    try {
      const user_id = req.user.id;
      const year = new Date().getFullYear();

      const { start, end } = getYearRange(year);
      // p.ej. start = `${year}-01-01`, end = `${year}-12-31`

      // 1) Presupuestos del año actual (por mes)
      const { data: budgets, error: budgetError } = await supabase
        .from("budgets")
        .select("month, limit_amount")
        .eq("user_id", user_id)
        .gte("month", `${year}-01`)
        .lte("month", `${year}-12`);

      if (budgetError) {
        return res.status(500).json({ error: budgetError.message });
      }

      // 2) Gastos del año actual (MISMA lógica que monthly-income-expense-avg)
      const { data: expenses, error: expenseError } = await supabase
        .from("transactions")
        .select("amount, type, date")
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", start)
        .lte("date", end);

      if (expenseError) {
        return res.status(500).json({ error: expenseError.message });
      }

      // 3) Inicializar todos los meses del año con 0
      const totals = {};
      for (let i = 1; i <= 12; i++) {
        const key = `${year}-${String(i).padStart(2, "0")}`;
        totals[key] = {
          month: key,
          budgeted: 0,
          spent: 0,
          diff: 0, // diferencia global del mes
        };
      }

      // 4) Sumar presupuesto mensual
      (budgets || []).forEach((b) => {
        const monthKey = b.month; // viene como YYYY-MM
        if (totals[monthKey]) {
          totals[monthKey].budgeted += parseFloat(b.limit_amount) || 0;
        }
      });

      // 5) Sumar gasto mensual (igual que monthly-income-expense-avg)
      (expenses || []).forEach((tx) => {
        const [y, m] = tx.date.split("-");
        const key = `${y}-${m}`;
        if (!totals[key]) return;

        const amount = parseFloat(tx.amount) || 0;
        totals[key].spent += amount;
      });

      // 6) Calcular diferencia por mes (spent - budgeted)
      const result = Object.values(totals)
        .map((row) => {
          const budgeted = row.budgeted || 0;
          const spent = row.spent || 0;
          const diff = spent - budgeted; // puede ser + o -

          return {
            ...row,
            budgeted,
            spent,
            diff,
          };
        })
        .sort((a, b) => a.month.localeCompare(b.month));

      return res.json({ success: true, data: result });
    } catch (err) {
      console.error(
        "Error en /analytics/budget-vs-actual-summary-yearly:",
        err
      );
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

/* ========= GASTO POR TIPO DE ESTABILIDAD ========= */

router.get("/expense-by-stability-type", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, type, categories ( stability_type )")
    .eq("user_id", user_id)
    .eq("type", "expense");

  if (error) return res.status(500).json({ error: error.message });

  const totals = { fixed: 0, variable: 0, occasional: 0 };

  (data || []).forEach((tx) => {
    const stability = tx.categories?.stability_type || "variable";
    totals[stability] += parseFloat(tx.amount);
  });

  const result = Object.entries(totals).map(([type, total]) => ({
    type,
    total,
  }));

  res.json({ success: true, data: result });
});

router.get("/top-variable-categories", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  // 🔹 Query params
  const {
    stability_types,  // "fixed,variable", "variable", etc. Opcional
    date_from,        // "YYYY-MM-DD". Opcional
    date_to,          // "YYYY-MM-DD". Opcional
    limit,            // número. Opcional, por defecto 10
  } = req.query;

  const topN = Number(limit) > 0 ? Number(limit) : 10;

  // Parsear stability_types si viene como string "fixed,variable"
  let stabilityList = [];
  if (typeof stability_types === "string" && stability_types.trim() !== "") {
    stabilityList = stability_types
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Construir query base
  let query = supabase
    .from("transactions")
    .select("amount, date, category_id, categories ( name, stability_type )")
    .eq("user_id", user_id)
    .eq("type", "expense");

  // 🔹 Filtro por rango de fechas (si viene)
  if (date_from) {
    query = query.gte("date", date_from);
  }
  if (date_to) {
    query = query.lte("date", date_to);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });

  const totals = {};

  (data || []).forEach((tx) => {
    const category = tx.categories?.name;
    const stability = tx.categories?.stability_type;

    if (!category) return;

    // 🔹 Si se especificaron stability_types, filtramos por ellos
    if (stabilityList.length > 0) {
      if (!stability || !stabilityList.includes(stability)) return;
    }
    // Si NO se especificó stability_types → aceptamos cualquier estabilidad

    if (!totals[category]) totals[category] = 0;
    totals[category] += parseFloat(tx.amount) || 0;
  });

  const result = Object.entries(totals)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  res.json({ success: true, data: result });
});

/* ========= METAS ========= */

router.get("/goals-progress", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("goals")
    .select("name, target_amount, current_amount")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || []).map((goal) => {
    const current = parseFloat(goal.current_amount);
    const target = parseFloat(goal.target_amount) || 1;
    const progress = Math.min((current / target) * 100, 100);

    return {
      name: goal.name,
      current,
      target,
      progress,
    };
  });

  res.json({ success: true, data: result });
});

/* ========= PROYECCIONES POR CATEGORÍA (INGRESO / GASTO) ========= */

router.get("/projected-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const now = new Date();

    // 1) Primer día del mes actual
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // 2) Primer día de hace 3 meses (esto incluye justo 3 meses completos ANTES del mes actual)
    //    Ej: hoy diciembre -> startDate = 1 septiembre
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth() - 3,
      1
    )
      .toISOString()
      .split("T")[0];

    // 3) endDate = primer día del mes actual (para excluir total el mes actual)
    //    Ej: hoy diciembre -> endDate = 1 diciembre
    const endDate = currentMonthStart.toISOString().split("T")[0];

    const { data, error } = await supabase
      .from("transactions")
      .select(
        "amount, type, date, category_id, categories(name, stability_type)"
      )
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", startDate)  // >= 1er día de hace 3 meses
      .lt("date", endDate);    // < 1er día del mes actual (excluye el mes actual)

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // 4) Acumulamos gasto MENSUAL por categoría + stability_type + mes
    const monthlyPerCategory = {};

    (data || []).forEach((tx) => {
      const catName = tx.categories?.name || "Sin categoría";
      const stability = tx.categories?.stability_type || "variable";
      const month = tx.date.slice(0, 7); // "YYYY-MM"

      // Ignoramos categorías ocasionales
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

    // 5) Agrupamos por categoría + stability_type y guardamos los totales mensuales
    const byCategory = {};

    Object.values(monthlyPerCategory).forEach((entry) => {
      const key = `${entry.category}__${entry.stability_type}`;

      if (!byCategory[key]) {
        byCategory[key] = {
          category: entry.category,
          stability_type: entry.stability_type,
          monthlyTotals: [],
        };
      }

      byCategory[key].monthlyTotals.push(entry.total);
    });

    // 6) Helper para calcular MEDIANA
    const median = (arr) => {
      if (!arr || arr.length === 0) return 0;

      const sorted = [...arr].sort((a, b) => a - b);
      const n = sorted.length;
      const mid = Math.floor(n / 2);

      if (n % 2 === 1) {
        // longitud impar → valor central
        return sorted[mid];
      } else {
        // longitud par → promedio de los dos centrales
        return (sorted[mid - 1] + sorted[mid]) / 2;
      }
    };

    // 7) Calculamos la proyección mensual (mediana) por categoría + stability_type
    const result = Object.values(byCategory).map((entry) => {
      const projectedMonthly = median(entry.monthlyTotals || []);

      return {
        category: entry.category,
        stability_type: entry.stability_type,
        projected_monthly: parseFloat(projectedMonthly.toFixed(2)),
      };
    });

    res.json({ success: true, data: result });
  }
);


router.get("/projected-income-by-category",
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

    const monthlyPerCategory = {};

    (data || []).forEach((tx) => {
      const catName = tx.categories?.name || "Sin categoría";
      const stability = tx.categories?.stability_type || "variable";
      const month = tx.date.slice(0, 7);

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

/* ========= ESCENARIO SIMULADO (POST) ========= */

router.post("/simulated-scenario", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { income_adjustment, expense_adjustment } = req.body || {};

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

    const monthlyData = {};

    (transactions || []).forEach((tx) => {
      const month = tx.date.slice(0, 7);
      const stability = tx.categories?.stability_type || "variable";
      const type = tx.type;

      if (!monthlyData[month]) monthlyData[month] = { income: {}, expense: {} };
      if (!monthlyData[month][type][stability])
        monthlyData[month][type][stability] = 0;

      monthlyData[month][type][stability] += Number(tx.amount);
    });

    const months = Object.keys(monthlyData);
    const monthsCount = months.length || 1;

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

    let adjustedIncome = avgIncome;
    let adjustedExpense = avgExpense;

    if (income_adjustment) {
      const { amount } = income_adjustment;
      adjustedIncome += amount;
    }

    if (expense_adjustment) {
      const { type, percent_reduction } = expense_adjustment;

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

/* ========= TOP ITEMS, TENDENCIAS Y REPOSICIÓN ========= */

router.get("/top-items", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { start, end } = getYearRange(year);

  const { data, error } = await supabase
    .from("transaction_items")
    .select(
      `
      item_id,
      quantity,
      items!inner (
        name,
        user_id
      ),
      transactions!inner (
        date,
        user_id
      )
    `
    )
    .eq("transactions.user_id", user_id)
    .eq("items.user_id", user_id)
    .gte("transactions.date", start)
    .lte("transactions.date", end);

  if (error) return res.status(500).json({ error: error.message });

  const aggregated = {};

  (data || []).forEach((row) => {
    const itemName = row.items?.name || "Sin nombre";
    const qty = Number(row.quantity || 1);
    aggregated[itemName] = (aggregated[itemName] || 0) + qty;
  });

  const result = Object.entries(aggregated)
    .map(([item, quantity]) => ({ item, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  res.json({ success: true, data: result });
});

router.get("/items-annual-summary", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const limit = parseInt(req.query.limit, 10) || 50; // top 50 por defecto

  const { start, end } = getYearRange(year);

  try {
    const { data, error } = await supabase
      .from("transaction_items")
      .select(
        `
        item_id,
        quantity,
        unit_price_net,
        line_total_final,
        items!inner (
          name,
          taxes (
            rate,
            is_exempt
          )
        ),
        transactions!inner (
          date,
          type,
          user_id
        )
      `
      )
      .eq("transactions.user_id", user_id)
      .eq("transactions.type", "expense")
      .gte("transactions.date", start)
      .lte("transactions.date", end);

    if (error) return res.status(500).json({ error: error.message });

    const aggregated = {};

    (data || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx || !itemRel) return;

      const itemId = row.item_id;
      const itemName = itemRel.name || "Sin nombre";
      const qty = Number(row.quantity || 0);
      if (!itemId || qty <= 0) return;

      let lineAmount = 0;

      if (row.line_total_final != null) {
        lineAmount = Number(row.line_total_final) || 0;
      } else {
        // Fallback: mismo criterio que usas en otros reportes
        const netPrice = Number(row.unit_price_net || 0);
        const taxRate =
          itemRel.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) {
          priceWithTax = netPrice * (1 + taxRate / 100);
        }

        lineAmount = priceWithTax * qty;
      }

      if (!aggregated[itemId]) {
        aggregated[itemId] = {
          item_id: itemId,
          item_name: itemName,
          total_quantity: 0,
          total_spent: 0,
        };
      }

      aggregated[itemId].total_quantity += qty;
      aggregated[itemId].total_spent += lineAmount;
    });

    const result = Object.values(aggregated)
      .map((row) => {
        const totalQty = row.total_quantity || 0;
        const totalSpent = row.total_spent || 0;
        const avgPrice = totalQty > 0 ? totalSpent / totalQty : 0;

        return {
          item_id: row.item_id,
          item: row.item_name,
          total_quantity: Number(totalQty.toFixed(2)),
          total_spent: Number(totalSpent.toFixed(2)),
          avg_price: Number(avgPrice.toFixed(2)),
        };
      })
      .sort((a, b) => b.total_spent - a.total_spent) // orden por gasto
      .slice(0, limit);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Error calculando resumen anual de ítems" });
  }
});

router.get("/item-trend/:item_id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const item_id = req.params.item_id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { start, end } = getYearRange(year);

  const { data, error } = await supabase
    .from("transaction_items")
    .select("unit_price_net, line_total_final, quantity, transactions(date)")
    .eq("transactions.user_id", user_id)
    .eq("item_id", item_id)
    .gte("transactions.date", start)
    .lte("transactions.date", end);

  if (error) return res.status(500).json({ error: error.message });

  const monthly = {};

  (data || []).forEach((item) => {
    const date = new Date(item.transactions?.date);
    const key = getMonthKey(date);

    const qty = item.quantity || 1;
    let total = 0;

    if (item.line_total_final != null) {
      total = Number(item.line_total_final) || 0;
    } else {
      // Fallback: tendencia neta sin ITBIS
      total = Number(item.unit_price_net || 0) * qty;
    }

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

/* ========= COMPARATIVO MENSUAL POR CATEGORÍA ========= */

router.get("/category-monthly-comparison",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();

      const year1Param = parseInt(req.query.year1, 10);
      const month1Param = parseInt(req.query.month1, 10);
      const year2Param = parseInt(req.query.year2, 10);
      const month2Param = parseInt(req.query.month2, 10);

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
        const baseYear = now.getFullYear();
        const baseMonthIndex = now.getMonth();

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

      const { start: start1, end: end1 } = getMonthDateRange(y1, m1Index);
      const { start: start2, end: end2 } = getMonthDateRange(y2, m2Index);

      const { data: tx1, error: err1 } = await supabase
        .from("transactions")
        .select(
          `
          amount,
          category_id,
          categories(name)
        `
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", start1)
        .lte("date", end1);

      if (err1) {
        console.error(err1);
        return res.status(500).json({ error: err1.message });
      }

      const byCat1 = {};
      let totalMonth1 = 0;

      (tx1 || []).forEach((tx) => {
        const catId = tx.category_id || "sin_categoria";
        const catName = tx.categories?.name || "Sin categoría";
        const amt = Number(tx.amount || 0);

        if (!byCat1[catId]) {
          byCat1[catId] = {
            category_id: catId,
            category_name: catName,
            month1_total: 0,
            month2_total: 0,
          };
        }
        byCat1[catId].month1_total += amt;
        totalMonth1 += amt;
      });

      const { data: tx2, error: err2 } = await supabase
        .from("transactions")
        .select(
          `
          amount,
          category_id,
          categories(name)
        `
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", start2)
        .lte("date", end2);

      if (err2) {
        console.error(err2);
        return res.status(500).json({ error: err2.message });
      }

      const byCat2 = {};
      let totalMonth2 = 0;

      (tx2 || []).forEach((tx) => {
        const catId = tx.category_id || "sin_categoria";
        const catName = tx.categories?.name || "Sin categoría";
        const amt = Number(tx.amount || 0);

        if (!byCat2[catId]) {
          byCat2[catId] = {
            category_id: catId,
            category_name: catName,
            month1_total: 0,
            month2_total: 0,
          };
        }
        byCat2[catId].month2_total += amt;
        totalMonth2 += amt;
      });

      const allCatIds = new Set([
        ...Object.keys(byCat1),
        ...Object.keys(byCat2),
      ]);

      const rows = Array.from(allCatIds).map((catId) => {
        const c1 = byCat1[catId];
        const c2 = byCat2[catId];

        const name = c1?.category_name || c2?.category_name || "Sin categoría";

        const m1 = c1?.month1_total || 0;
        const m2 = c2?.month2_total || 0;
        const diff = m2 - m1;

        let diffPercent = 0;
        if (m1 === 0 && m2 > 0) {
          diffPercent = 100;
        } else if (m1 !== 0) {
          diffPercent = (diff / m1) * 100;
        }

        return {
          category_id: catId,
          category_name: name,
          month1_total: Number(m1.toFixed(2)),
          month2_total: Number(m2.toFixed(2)),
          diff: Number(diff.toFixed(2)),
          diff_percent: Number(diffPercent.toFixed(2)),
        };
      });

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

/* ========= COMPARATIVO MENSUAL POR ITEM ========= */

router.get("/item-monthly-comparison", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    const now = new Date();

    const year1Param = parseInt(req.query.year1, 10);
    const month1Param = parseInt(req.query.month1, 10);
    const year2Param = parseInt(req.query.year2, 10);
    const month2Param = parseInt(req.query.month2, 10);

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
      const baseYear = now.getFullYear();
      const baseMonthIndex = now.getMonth();

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

    const { start: start1, end: end1 } = getMonthDateRange(y1, m1Index);
    const { start: start2, end: end2 } = getMonthDateRange(y2, m2Index);

    const { data: items1, error: err1 } = await supabase
      .from("transaction_items")
      .select(
        `
          item_id,
          quantity,
          unit_price_net,
          line_total_final,
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
      .eq("transactions.type", "expense")
      .gte("transactions.date", start1)
      .lte("transactions.date", end1);

    if (err1) {
      console.error(err1);
      return res.status(500).json({ error: err1.message });
    }

    const byItem1 = {};
    let totalMonth1Amount = 0;

    (items1 || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx) return;

      const itemId = row.item_id || "sin_item";
      const itemName = itemRel?.name || "Sin nombre";

      const qty = Number(row.quantity || 0);
      let lineAmount = 0;

      if (row.line_total_final != null) {
        lineAmount = Number(row.line_total_final) || 0;
      } else {
        const netPrice = Number(row.unit_price_net || 0);
        const taxRate =
          itemRel?.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel?.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) {
          priceWithTax = netPrice * (1 + taxRate / 100);
        }

        lineAmount = priceWithTax * qty;
      }

      if (!byItem1[itemId]) {
        byItem1[itemId] = {
          item_id: itemId,
          item_name: itemName,
          month1_qty: 0,
          month2_qty: 0,
          month1_amount: 0,
          month2_amount: 0,
        };
      }

      byItem1[itemId].month1_qty += qty;
      byItem1[itemId].month1_amount += lineAmount;
      totalMonth1Amount += lineAmount;
    });

    const { data: items2, error: err2 } = await supabase
      .from("transaction_items")
      .select(
        `
          item_id,
          quantity,
          unit_price_net,
          line_total_final,
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
      .eq("transactions.type", "expense")
      .gte("transactions.date", start2)
      .lte("transactions.date", end2);

    if (err2) {
      console.error(err2);
      return res.status(500).json({ error: err2.message });
    }

    const byItem2 = {};
    let totalMonth2Amount = 0;

    (items2 || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx) return;

      const itemId = row.item_id || "sin_item";
      const itemName = itemRel?.name || "Sin nombre";

      const qty = Number(row.quantity || 0);
      let lineAmount = 0;

      if (row.line_total_final != null) {
        lineAmount = Number(row.line_total_final) || 0;
      } else {
        const netPrice = Number(row.unit_price_net || 0);
        const taxRate =
          itemRel?.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel?.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) {
          priceWithTax = netPrice * (1 + taxRate / 100);
        }

        lineAmount = priceWithTax * qty;
      }

      if (!byItem2[itemId]) {
        byItem2[itemId] = {
          item_id: itemId,
          item_name: itemName,
          month1_qty: 0,
          month2_qty: 0,
          month1_amount: 0,
          month2_amount: 0,
        };
      }

      byItem2[itemId].month2_qty += qty;
      byItem2[itemId].month2_amount += lineAmount;
      totalMonth2Amount += lineAmount;
    });

    const allItemIds = new Set([
      ...Object.keys(byItem1),
      ...Object.keys(byItem2),
    ]);

    const rows = Array.from(allItemIds).map((itemId) => {
      const i1 = byItem1[itemId];
      const i2 = byItem2[itemId];

      const name = i1?.item_name || i2?.item_name || "Sin nombre";

      const q1 = i1?.month1_qty || 0;
      const q2 = i2?.month2_qty || 0;
      const m1Amt = i1?.month1_amount || 0;
      const m2Amt = i2?.month2_amount || 0;

      const diffAmt = m2Amt - m1Amt;
      const diffQty = q2 - q1;

      return {
        item_id: itemId,
        item_name: name,
        month1_qty: Number(q1.toFixed(2)),
        month2_qty: Number(q2.toFixed(2)),
        month1_amount: Number(m1Amt.toFixed(2)),
        month2_amount: Number(m2Amt.toFixed(2)),
        diff_amount: Number(diffAmt.toFixed(2)),
        diff_qty: Number(diffQty.toFixed(2)),
      };
    });

    rows.sort((a, b) => {
      const da = a.diff_amount || 0;
      const db = b.diff_amount || 0;

      const groupA = da > 0 ? 2 : da === 0 ? 1 : 0;
      const groupB = db > 0 ? 2 : db === 0 ? 1 : 0;

      if (groupA !== groupB) {
        return groupB - groupA;
      }

      if (groupA === 2) {
        return db - da;
      }

      if (groupA === 0) {
        return da - db;
      }

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
});

/* ========= INGRESOS / GASTOS ANUALES POR TIPO DE ESTABILIDAD ========= */

router.get("/yearly-income-expense-by-stability",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    // Permitir override de año por query param ?year=2024, si quieres
    const now = new Date();
    const yearParam = parseInt(req.query.year, 10);
    const year = !isNaN(yearParam) ? yearParam : now.getFullYear();

    const { start, end } = getYearRange(year); // ya definido arriba

    try {
      const { data, error } = await supabase
        .from("transactions")
        .select(`
          amount,
          type,
          date,
          categories ( stability_type )
        `)
        .eq("user_id", user_id)
        .gte("date", start)
        .lte("date", end);

      if (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
      }

      // Totales globales del año
      const total = {
        income: 0,
        expense: 0,
      };

      // Totales por tipo de estabilidad
      const byStability = {
        fixed: { income: 0, expense: 0 },
        variable: { income: 0, expense: 0 },
        occasional: { income: 0, expense: 0 },
      };

      (data || []).forEach((tx) => {
        const txType = tx.type; // "income" | "expense" | "transfer"
        if (txType !== "income" && txType !== "expense") return;

        const amount = parseFloat(tx.amount) || 0;

        // Sumar al total global
        total[txType] += amount;

        // Determinar estabilidad (default "variable" si no viene)
        const stability =
          tx.categories?.stability_type || "variable";

        if (!byStability[stability]) {
          // Por si aparece algún valor raro en BD
          byStability[stability] = { income: 0, expense: 0 };
        }

        byStability[stability][txType] += amount;
      });

      return res.json({
        success: true,
        data: {
          year,
          total: {
            income: Number(total.income.toFixed(2)),
            expense: Number(total.expense.toFixed(2)),
          },
          byStability: Object.fromEntries(
            Object.entries(byStability).map(([key, value]) => [
              key,
              {
                income: Number((value.income || 0).toFixed(2)),
                expense: Number((value.expense || 0).toFixed(2)),
              },
            ])
          ),
        },
      });
    } catch (err) {
      console.error(
        "Error en /analytics/yearly-income-expense-by-stability:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno del servidor" });
    }
  }
);

/* ========= BURN RATE (RITMO DE GASTO DEL MES ACTUAL) ========= */

router.get("/spending-burn-rate-current-month",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();
      const year = now.getFullYear();
      const monthIndex = now.getMonth(); // 0-11
      const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;

      const start = `${monthKey}-01`;
      const today = now.toISOString().split("T")[0];
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      const dayOfMonth = now.getDate();

      // 1) Presupuesto total del mes (suma de todos los budgets de ese mes)
      const { data: budgets, error: budgetError } = await supabase
        .from("budgets")
        .select("limit_amount")
        .eq("user_id", user_id)
        .eq("month", monthKey);

      if (budgetError) {
        console.error(budgetError);
        return res.status(500).json({ error: budgetError.message });
      }

      const budgetTotal = (budgets || []).reduce(
        (sum, b) => sum + (parseFloat(b.limit_amount) || 0),
        0
      );

      // Si no hay presupuesto, devolvemos algo útil pero sin ideal
      if (!budgetTotal || budgetTotal <= 0) {
        return res.json({
          success: true,
          data: {
            month: monthKey,
            today,
            days_in_month: daysInMonth,
            day_of_month: dayOfMonth,
            budget_total: 0,
            ideal_to_date: 0,
            actual_to_date: 0,
            projected_end_of_month: 0,
            variance_to_ideal: 0,
            variance_to_budget_end: 0,
            series: [],
          },
        });
      }

      // 2) Gastos diarios reales del mes hasta hoy
      const { data: expenses, error: expenseError } = await supabase
        .from("transactions")
        .select("amount, date")
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", start)
        .lte("date", today);

      if (expenseError) {
        console.error(expenseError);
        return res.status(500).json({ error: expenseError.message });
      }

      const dailyMap = {};

      (expenses || []).forEach((tx) => {
        const d = tx.date; // "YYYY-MM-DD"
        const amt = parseFloat(tx.amount) || 0;
        if (!dailyMap[d]) dailyMap[d] = 0;
        dailyMap[d] += amt;
      });

      const idealDaily = budgetTotal / daysInMonth;

      let cumulativeIdeal = 0;
      let cumulativeActual = 0;

      const series = [];

      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${monthKey}-${String(day).padStart(2, "0")}`;
        const dailyExpense = dailyMap[dateStr] || 0;

        cumulativeActual += dailyExpense;
        cumulativeIdeal += idealDaily;

        // Para días futuros (después de hoy), no sumamos más gasto real
        if (day > dayOfMonth) {
          // Mantener el acumulado real igual que al día actual
          cumulativeActual = cumulativeActual; // no cambia, solo claridad
        }

        series.push({
          day,
          date: dateStr,
          daily_expense: Number(dailyExpense.toFixed(2)),
          ideal_cumulative: Number(cumulativeIdeal.toFixed(2)),
          actual_cumulative: Number(
            (day <= dayOfMonth ? cumulativeActual : cumulativeActual).toFixed(2)
          ),
        });
      }

      const actualToDate = series[dayOfMonth - 1]?.actual_cumulative || 0;
      const idealToDate = series[dayOfMonth - 1]?.ideal_cumulative || 0;

      const projectedEndOfMonth =
        dayOfMonth > 0
          ? (actualToDate / dayOfMonth) * daysInMonth
          : actualToDate;

      const varianceToIdeal = actualToDate - idealToDate;
      const varianceToBudgetEnd = projectedEndOfMonth - budgetTotal;

      return res.json({
        success: true,
        data: {
          month: monthKey,
          today,
          days_in_month: daysInMonth,
          day_of_month: dayOfMonth,
          budget_total: Number(budgetTotal.toFixed(2)),
          ideal_to_date: Number(idealToDate.toFixed(2)),
          actual_to_date: Number(actualToDate.toFixed(2)),
          projected_end_of_month: Number(projectedEndOfMonth.toFixed(2)),
          variance_to_ideal: Number(varianceToIdeal.toFixed(2)),
          variance_to_budget_end: Number(varianceToBudgetEnd.toFixed(2)),
          series,
        },
      });
    } catch (err) {
      console.error("Error en /analytics/spending-burn-rate-current-month:", err);
      return res
        .status(500)
        .json({ error: "Error interno del servidor (burn rate)" });
    }
  }
);




router.get("/expense-by-weekday", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, date")
    .eq("user_id", user_id)
    .eq("type", "expense");

  if (error) return res.status(500).json({ error: error.message });

  const totals = [
    { weekday: 0, label: "Dom", total: 0, count: 0 },
    { weekday: 1, label: "Lun", total: 0, count: 0 },
    { weekday: 2, label: "Mar", total: 0, count: 0 },
    { weekday: 3, label: "Mié", total: 0, count: 0 },
    { weekday: 4, label: "Jue", total: 0, count: 0 },
    { weekday: 5, label: "Vie", total: 0, count: 0 },
    { weekday: 6, label: "Sáb", total: 0, count: 0 },
  ];

  (data || []).forEach((tx) => {
    const d = new Date(tx.date);
    const wd = d.getDay(); // 0 = domingo
    const amt = parseFloat(tx.amount) || 0;

    totals[wd].total += amt;
    totals[wd].count += 1;
  });

  const result = totals.map((t) => ({
    ...t,
    total: Number(t.total.toFixed(2)),
    avg: t.count > 0 ? Number((t.total / t.count).toFixed(2)) : 0,
  }));

  res.json({ success: true, data: result });
});



router.get("/budget-coverage", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { start, end } = getYearRange(year); // ya definido arriba

  try {
    // 1) Presupuestos del año por categoría
    const { data: budgets, error: budgetErr } = await supabase
      .from("budgets")
      .select("category_id, limit_amount, categories(name)")
      .eq("user_id", user_id)
      .gte("month", `${year}-01`)
      .lte("month", `${year}-12`);

    if (budgetErr) {
      console.error(budgetErr);
      return res.status(500).json({ error: budgetErr.message });
    }

    const budgetByCat = {};
    (budgets || []).forEach((b) => {
      const catId = b.category_id;
      if (!catId) return;

      if (!budgetByCat[catId]) {
        budgetByCat[catId] = {
          category_id: catId,
          category_name: b.categories?.name || `Categoría ${catId}`,
          total_budget: 0,
        };
      }
      budgetByCat[catId].total_budget += parseFloat(b.limit_amount) || 0;
    });

    // 2) Gastos del año por categoría
    const { data: expenses, error: expenseErr } = await supabase
      .from("transactions")
      .select("category_id, amount, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (expenseErr) {
      console.error(expenseErr);
      return res.status(500).json({ error: expenseErr.message });
    }

    const expenseByCat = {};
    (expenses || []).forEach((tx) => {
      const catId = tx.category_id;
      if (!catId) return;

      if (!expenseByCat[catId]) {
        expenseByCat[catId] = {
          category_id: catId,
          category_name: tx.categories?.name || `Categoría ${catId}`,
          total_expense: 0,
        };
      }
      expenseByCat[catId].total_expense += parseFloat(tx.amount) || 0;
    });

    const totalExpense = Object.values(expenseByCat).reduce(
      (sum, row) => sum + row.total_expense,
      0
    );

    // 3) Cálculos de cobertura
    let expenseWithBudget = 0;

    const categoriesWithBoth = [];
    const categoriesWithExpenseOnly = [];
    const categoriesWithBudgetOnly = [];

    const allCatIds = new Set([
      ...Object.keys(expenseByCat),
      ...Object.keys(budgetByCat),
    ]);

    allCatIds.forEach((catId) => {
      const exp = expenseByCat[catId];
      const bud = budgetByCat[catId];

      if (exp && bud) {
        expenseWithBudget += exp.total_expense;

        categoriesWithBoth.push({
          category_id: Number(catId),
          category_name: exp.category_name || bud.category_name,
          total_expense: Number(exp.total_expense.toFixed(2)),
          total_budget: Number(bud.total_budget.toFixed(2)),
          diff: Number((exp.total_expense - bud.total_budget).toFixed(2)),
        });
      } else if (exp && !bud) {
        categoriesWithExpenseOnly.push({
          category_id: Number(catId),
          category_name: exp.category_name,
          total_expense: Number(exp.total_expense.toFixed(2)),
        });
      } else if (!exp && bud) {
        categoriesWithBudgetOnly.push({
          category_id: Number(catId),
          category_name: bud.category_name,
          total_budget: Number(bud.total_budget.toFixed(2)),
        });
      }
    });

    categoriesWithBoth.sort((a, b) => b.total_expense - a.total_expense);
    categoriesWithExpenseOnly.sort(
      (a, b) => b.total_expense - a.total_expense
    );
    categoriesWithBudgetOnly.sort(
      (a, b) => b.total_budget - a.total_budget
    );

    const coveragePct =
      totalExpense > 0 ? (expenseWithBudget / totalExpense) * 100 : 0;

    return res.json({
      success: true,
      data: {
        year,
        total_expense: Number(totalExpense.toFixed(2)),
        expense_with_budget: Number(expenseWithBudget.toFixed(2)),
        expense_without_budget: Number(
          (totalExpense - expenseWithBudget).toFixed(2)
        ),
        coverage_pct: Number(coveragePct.toFixed(2)),
        categories_with_both: categoriesWithBoth,
        categories_with_expense_only: categoriesWithExpenseOnly,
        categories_with_budget_only: categoriesWithBudgetOnly,
      },
    });
  } catch (err) {
    console.error("Error en /analytics/budget-coverage:", err);
    return res
      .status(500)
      .json({ error: "Error interno calculando cobertura de presupuestos" });
  }
});

router.get("/projected-vs-actual-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();

      // 1) Rango de proyección (3 meses completos antes del mes actual)
      const currentMonthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      );
      const startDate = new Date(
        now.getFullYear(),
        now.getMonth() - 3,
        1
      )
        .toISOString()
        .split("T")[0];
      const endDate = currentMonthStart.toISOString().split("T")[0];

      const { data: history, error: histErr } = await supabase
        .from("transactions")
        .select(
          "amount, type, date, category_id, categories(name, stability_type)"
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", startDate)
        .lt("date", endDate);

      if (histErr) {
        console.error(histErr);
        return res.status(500).json({ error: histErr.message });
      }

      // 2) Agrupar por categoría + stability + mes
      const monthlyPerCategory = {};

      (history || []).forEach((tx) => {
        const catName = tx.categories?.name || "Sin categoría";
        const stability = tx.categories?.stability_type || "variable";
        const month = tx.date.slice(0, 7);

        // ignorar ocasionales
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
        monthlyPerCategory[key].total += parseFloat(tx.amount) || 0;
      });

      // 3) Agrupar por categoría+stability y guardar lista de totales mensuales
      const byCategory = {};
      Object.values(monthlyPerCategory).forEach((entry) => {
        const key = `${entry.category}__${entry.stability_type}`;
        if (!byCategory[key]) {
          byCategory[key] = {
            category: entry.category,
            stability_type: entry.stability_type,
            monthlyTotals: [],
          };
        }
        byCategory[key].monthlyTotals.push(entry.total);
      });

      const median = (arr) => {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const n = sorted.length;
        const mid = Math.floor(n / 2);
        if (n % 2 === 1) return sorted[mid];
        return (sorted[mid - 1] + sorted[mid]) / 2;
      };

      const projectedMap = {};
      Object.values(byCategory).forEach((entry) => {
        const projected = median(entry.monthlyTotals);
        const key = `${entry.category}__${entry.stability_type}`;
        projectedMap[key] = {
          category: entry.category,
          stability_type: entry.stability_type,
          projected_monthly: projected,
        };
      });

      // 4) Gasto real del mes actual
      const year = now.getFullYear();
      const monthIndex = now.getMonth();
      const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
      const monthStart = `${monthKey}-01`;
      const today = now.toISOString().split("T")[0];

      const { data: current, error: currErr } = await supabase
        .from("transactions")
        .select(
          "amount, type, date, category_id, categories(name, stability_type)"
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", monthStart)
        .lte("date", today);

      if (currErr) {
        console.error(currErr);
        return res.status(500).json({ error: currErr.message });
      }

      const actualMap = {};
      (current || []).forEach((tx) => {
        const catName = tx.categories?.name || "Sin categoría";
        const stability = tx.categories?.stability_type || "variable";
        const key = `${catName}__${stability}`;

        if (!actualMap[key]) {
          actualMap[key] = {
            category: catName,
            stability_type: stability,
            actual_month_to_date: 0,
          };
        }

        actualMap[key].actual_month_to_date +=
          parseFloat(tx.amount) || 2;
      });

      // 5) Combinar proyección + real
      const allKeys = new Set([
        ...Object.keys(projectedMap),
        ...Object.keys(actualMap),
      ]);

      const rows = [];
      allKeys.forEach((key) => {
        const proj = projectedMap[key];
        const act = actualMap[key];

        const category = proj?.category || act?.category || "Sin categoría";
        const stability_type =
          proj?.stability_type || act?.stability_type || "variable";

        const projected_monthly = proj?.projected_monthly || 0;
        const actual_month_to_date = act?.actual_month_to_date || 0;

        const variance = actual_month_to_date - projected_monthly;
        const variance_pct =
          projected_monthly > 0 ? (variance / projected_monthly) * 100 : null;

        rows.push({
          category,
          stability_type,
          projected_monthly: Number(projected_monthly.toFixed(2)),
          actual_month_to_date: Number(actual_month_to_date.toFixed(2)),
          variance: Number(variance.toFixed(2)),
          variance_pct:
            variance_pct != null ? Number(variance_pct.toFixed(2)) : null,
        });
      });

      rows.sort(
        (a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0)
      );

      const result = rows.slice(0, 15); // top 15 desviaciones

      return res.json({
        success: true,
        meta: { month: monthKey },
        data: result,
      });
    } catch (err) {
      console.error(
        "Error en /analytics/projected-vs-actual-expense-by-category:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno en proyección vs realidad" });
    }
  }
);

router.get("/unusual-expenses", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const now = new Date();

  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const currentStart = `${monthKey}-01`;

  try {
    // 1) Histórico antes del mes actual
    const { data: history, error: histErr } = await supabase
      .from("transactions")
      .select("id, amount, category_id, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .lt("date", currentStart);

    if (histErr) {
      console.error(histErr);
      return res.status(500).json({ error: histErr.message });
    }

    const statsByCat = {};
    (history || []).forEach((tx) => {
      const catId = tx.category_id;
      if (!catId) return;
      const amt = parseFloat(tx.amount) || 0;

      if (!statsByCat[catId]) {
        statsByCat[catId] = {
          category_id: catId,
          category_name: tx.categories?.name || `Categoría ${catId}`,
          count: 0,
          sum: 0,
          sumSq: 0,
        };
      }

      const s = statsByCat[catId];
      s.count += 1;
      s.sum += amt;
      s.sumSq += amt * amt;
    });

    Object.values(statsByCat).forEach((s) => {
      if (s.count > 0) {
        s.mean = s.sum / s.count;
        const variance = s.sumSq / s.count - s.mean * s.mean;
        s.std_dev = Math.sqrt(Math.max(variance, 0));
      } else {
        s.mean = 0;
        s.std_dev = 0;
      }
    });

    // 2) Transacciones del mes actual
    const today = now.toISOString().split("T")[0];
    const { data: current, error: currErr } = await supabase
      .from("transactions")
      .select("id, amount, date, description, category_id, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", currentStart)
      .lte("date", today);

    if (currErr) {
      console.error(currErr);
      return res.status(500).json({ error: currErr.message });
    }

    const unusual = [];
    const zThreshold = 2; // >= 2 desviaciones estándar

    (current || []).forEach((tx) => {
      const catId = tx.category_id;
      const stats = statsByCat[catId];
      if (!stats) return;
      if (!stats.std_dev || stats.std_dev <= 0 || stats.count < 5) return;

      const amt = parseFloat(tx.amount) || 0;
      const z = (amt - stats.mean) / stats.std_dev;
      if (z >= zThreshold) {
        unusual.push({
          id: tx.id,
          date: tx.date,
          amount: amt,
          category: tx.categories?.name || stats.category_name,
          description: tx.description || "",
          z_score: Number(z.toFixed(2)),
          mean: Number(stats.mean.toFixed(2)),
          std_dev: Number(stats.std_dev.toFixed(2)),
        });
      }
    });

    unusual.sort((a, b) => b.z_score - a.z_score);

    return res.json({ success: true, data: unusual });
  } catch (err) {
    console.error("Error en /analytics/unusual-expenses:", err);
    return res
      .status(500)
      .json({ error: "Error interno detectando gastos atípicos" });
  }
});

router.get("/category-month-heatmap", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const { start, end } = getYearRange(year);

  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("amount, date, category_id, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }

    const byCatMonth = {};

    (data || []).forEach((tx) => {
      const catId = tx.category_id;
      if (!catId) return;

      const catName = tx.categories?.name || `Categoría ${catId}`;
      const month = tx.date.slice(0, 7); // YYYY-MM
      const key = `${catId}__${month}`;

      if (!byCatMonth[key]) {
        byCatMonth[key] = {
          category_id: catId,
          category_name: catName,
          month,
          amount: 0,
        };
      }
      byCatMonth[key].amount += parseFloat(tx.amount) || 0;
    });

    const rows = Object.values(byCatMonth).map((r) => ({
      category_id: r.category_id,
      category_name: r.category_name,
      month: r.month,
      amount: Number(r.amount.toFixed(2)),
    }));

    return res.json({ success: true, data: rows, meta: { year } });
  } catch (err) {
    console.error("Error en /analytics/category-month-heatmap:", err);
    return res
      .status(500)
      .json({ error: "Error interno generando heatmap de categorías" });
  }
});


// ========== DETECTOR DE GASTOS REPETITIVOS (NO MARCADOS) ==========
router.get("/recurring-expense-patterns",  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const monthsBack = parseInt(req.query.months, 10) || 6;
      const now = new Date();
      const fromDateObj = new Date(
        now.getFullYear(),
        now.getMonth() - (monthsBack - 1),
        1
      );
      const fromDate = fromDateObj.toISOString().split("T")[0];

      const { data, error } = await supabase
        .from("transactions")
        .select(
          `
          id,
          amount,
          date,
          category_id,
          description,
          categories ( name )
        `
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", fromDate);

      if (error) {
        console.error("🔥 Error en recurring-expense-patterns:", error);
        return res.status(500).json({ error: error.message });
      }

      const txs = data || [];

      // Helpers
      const normDesc = (s) =>
        (s || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .slice(0, 80); // limitar un poco

      const daysBetween = (d1, d2) => {
        const t1 = new Date(d1).getTime();
        const t2 = new Date(d2).getTime();
        return Math.abs((t2 - t1) / (1000 * 60 * 60 * 24));
      };

      const median = (arr) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length - 1) / 2;
        if (sorted.length % 2 === 1) {
          return sorted[Math.floor(mid)];
        } else {
          const m1 = sorted[Math.floor(mid)];
          const m2 = sorted[Math.floor(mid) + 1];
          return (m1 + m2) / 2;
        }
      };

      const stdDev = (arr, mean) => {
        if (!arr.length) return 0;
        const m = mean ?? arr.reduce((s, v) => s + v, 0) / arr.length;
        const variance =
          arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length;
        return Math.sqrt(variance);
      };

      // 1) Agrupamos por categoría + descripción normalizada
      const groups = {};
      txs.forEach((tx) => {
        const catId = tx.category_id || "sin_categoria";
        const catName = tx.categories?.name || "Sin categoría";
        const descKey = normDesc(tx.description) || "sin_descripcion";

        const key = `${catId}__${descKey}`;

        if (!groups[key]) {
          groups[key] = {
            category_id: catId,
            category_name: catName,
            description_key: descKey,
            transactions: [],
          };
        }
        groups[key].transactions.push({
          date: tx.date,
          amount: Number(tx.amount) || 0,
        });
      });

      const patterns = [];

      Object.values(groups).forEach((g) => {
        const txList = g.transactions;
        if (txList.length < 3) return; // mínimo 3 ocurrencias

        // Orden por fecha ascendente
        txList.sort((a, b) => a.date.localeCompare(b.date));

        const intervals = [];
        for (let i = 1; i < txList.length; i++) {
          const d = daysBetween(txList[i - 1].date, txList[i].date);
          intervals.push(d);
        }

        if (intervals.length < 2) return;

        const medianInterval = median(intervals);
        const meanInterval =
          intervals.reduce((s, v) => s + v, 0) / intervals.length;
        const sd = stdDev(intervals, meanInterval);
        const coefVar = meanInterval > 0 ? sd / meanInterval : 1;

        // Regla simple para "recurrente"
        // - intervalo mediano entre 3 y 60 días
        // - coeficiente de variación relativamente bajo
        if (medianInterval < 3 || medianInterval > 60) return;
        if (coefVar > 0.5) return;

        // Etiqueta de frecuencia aproximada
        let frequency = "irregular";
        if (medianInterval >= 3 && medianInterval <= 10) {
          frequency = "semanal";
        } else if (medianInterval > 10 && medianInterval <= 20) {
          frequency = "quincenal";
        } else if (medianInterval > 20 && medianInterval <= 40) {
          frequency = "mensual";
        } else if (medianInterval > 40 && medianInterval <= 60) {
          frequency = "bimestral";
        }

        const totalAmount = txList.reduce((s, t) => s + t.amount, 0);
        const avgAmount = totalAmount / txList.length;

        patterns.push({
          category_id: g.category_id,
          category_name: g.category_name,
          description_key: g.description_key,
          occurrences: txList.length,
          median_interval_days: Number(medianInterval.toFixed(2)),
          mean_interval_days: Number(meanInterval.toFixed(2)),
          std_dev_interval_days: Number(sd.toFixed(2)),
          coef_variation: Number(coefVar.toFixed(2)),
          frequency_label: frequency,
          avg_amount: Number(avgAmount.toFixed(2)),
          first_date: txList[0].date,
          last_date: txList[txList.length - 1].date,
        });
      });

      // Ordenar: más frecuentes y más recientes primero
      patterns.sort((a, b) => {
        if (b.occurrences !== a.occurrences) {
          return b.occurrences - a.occurrences;
        }
        return b.last_date.localeCompare(a.last_date);
      });

      return res.json({ success: true, data: patterns });
    } catch (err) {
      console.error("🔥 Error inesperado en recurring-expense-patterns:", err);
      return res
        .status(500)
        .json({ error: "Error interno en recurring-expense-patterns" });
    }
  }
);


// ========== INTERVALO ENTRE GASTOS POR CATEGORÍA ==========
router.get("/expense-intervals-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const monthsBack = parseInt(req.query.months, 10) || 12;
      const now = new Date();
      const fromDateObj = new Date(
        now.getFullYear(),
        now.getMonth() - (monthsBack - 1),
        1
      );
      const fromDate = fromDateObj.toISOString().split("T")[0];

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
        .gte("date", fromDate);

      if (error) {
        console.error("🔥 Error en expense-intervals-by-category:", error);
        return res.status(500).json({ error: error.message });
      }

      const txs = data || [];

      const daysBetween = (d1, d2) => {
        const t1 = new Date(d1).getTime();
        const t2 = new Date(d2).getTime();
        return Math.abs((t2 - t1) / (1000 * 60 * 60 * 24));
      };

      const median = (arr) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length - 1) / 2;
        if (sorted.length % 2 === 1) {
          return sorted[Math.floor(mid)];
        } else {
          const m1 = sorted[Math.floor(mid)];
          const m2 = sorted[Math.floor(mid) + 1];
          return (m1 + m2) / 2;
        }
      };

      // Agrupar por categoría
      const byCategory = {};

      txs.forEach((tx) => {
        const catId = tx.category_id || "sin_categoria";
        const catName = tx.categories?.name || "Sin categoría";

        if (!byCategory[catId]) {
          byCategory[catId] = {
            category_id: catId,
            category_name: catName,
            transactions: [],
          };
        }

        byCategory[catId].transactions.push({
          date: tx.date,
          amount: Number(tx.amount) || 0,
        });
      });

      const result = [];

      Object.values(byCategory).forEach((cat) => {
        const list = cat.transactions;
        if (list.length < 2) return; // se necesita al menos 2 para tener intervalo

        // Ordenar por fecha
        list.sort((a, b) => a.date.localeCompare(b.date));

        const intervals = [];
        let totalAmount = 0;
        list.forEach((tx) => {
          totalAmount += tx.amount;
        });

        for (let i = 1; i < list.length; i++) {
          const d = daysBetween(list[i - 1].date, list[i].date);
          intervals.push(d);
        }

        const count = list.length;
        const avgInterval =
          intervals.reduce((s, v) => s + v, 0) / intervals.length;
        const medInterval = median(intervals);
        const minInterval = Math.min(...intervals);
        const maxInterval = Math.max(...intervals);

        result.push({
          category_id: cat.category_id,
          category_name: cat.category_name,
          transactions_count: count,
          avg_interval_days: Number(avgInterval.toFixed(2)),
          median_interval_days: Number(medInterval.toFixed(2)),
          min_interval_days: Number(minInterval.toFixed(2)),
          max_interval_days: Number(maxInterval.toFixed(2)),
          first_date: list[0].date,
          last_date: list[list.length - 1].date,
          total_spent: Number(totalAmount.toFixed(2)),
        });
      });

      // Ordenar: de menor intervalo promedio a mayor (para ver "más frecuentes" primero)
      result.sort((a, b) => a.avg_interval_days - b.avg_interval_days);

      return res.json({ success: true, data: result });
    } catch (err) {
      console.error(
        "🔥 Error inesperado en /analytics/expense-intervals-by-category:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno en expense-intervals-by-category" });
    }
  }
);

// Helpers locales para este reporte (déjalos donde ya los pusiste)
function diffInDays(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const ms = b - a;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = arr.reduce((acc, v) => acc + v, 0);
  return s / arr.length;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
  if (!arr || arr.length === 0) return 0;
  const m = mean(arr);
  const variance =
    arr.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function normalizeDescriptionKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function mapIntervalToFrequencyLabel(medianDays) {
  if (!Number.isFinite(medianDays) || medianDays <= 0) return "irregular";

  if (medianDays <= 9) return "semanal";      // ~ 7 días
  if (medianDays <= 20) return "quincenal";   // ~ 15 días
  if (medianDays <= 40) return "mensual";     // ~ 30 días
  if (medianDays <= 70) return "bimestral";   // ~ 60 días

  return "irregular";
}

/**
 * GET /analytics/recurring-item-patterns
 */
router.get("/recurring-item-patterns",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const monthsParam = parseInt(req.query.months, 10);
    const months =
      Number.isNaN(monthsParam) || monthsParam <= 0 ? 6 : monthsParam;

    const minOccParam = parseInt(req.query.min_occurrences, 10);
    const minOccurrences =
      Number.isNaN(minOccParam) || minOccParam <= 0 ? 3 : minOccParam;

    try {
      // 1) Fecha desde: primer día de hace "months" meses
      const now = new Date();
      const fromDate = new Date(
        now.getFullYear(),
        now.getMonth() - (months - 1),
        1
      );
      const dateFrom = fromDate.toISOString().split("T")[0];

      // 2) Traer transaction_items + transactions + items (+ categoría vía transactions)
      const { data, error } = await supabase
        .from("transaction_items")
        .select(
          `
          item_id,
          quantity,
          line_total_final,
          unit_price_net,
          transactions!inner (
            id,
            user_id,
            date,
            type,
            description,
            category_id,
            categories (
              name
            )
          ),
          items!inner (
            name
          )
        `
        )
        .eq("transactions.user_id", user_id)
        .eq("transactions.type", "expense")
        .gte("transactions.date", dateFrom);

      if (error) {
        console.error(
          "Error en /analytics/recurring-item-patterns (Supabase):",
          error
        );
        return res.status(500).json({ error: error.message });
      }

      const rows = data || [];

      // 3) Agrupar por (item_id, description_key)
      const groups = {};

      for (const row of rows) {
        const trx = row.transactions;
        const itemRel = row.items;
        if (!trx || !itemRel) continue;

        const itemId = row.item_id;
        if (!itemId) continue;

        const itemName = itemRel.name || "Sin nombre";
        const categoryName = trx.categories?.name || null; // 👈 ahora viene de transactions
        const descKey = normalizeDescriptionKey(trx.description);

        const date = trx.date;
        if (!date) continue;

        const qty = Number(row.quantity || 0);

        // Calcular monto de la línea
        let lineAmount = 0;
        if (row.line_total_final != null) {
          lineAmount = Number(row.line_total_final) || 0;
        } else {
          const netPrice = Number(row.unit_price_net || 0);
          lineAmount = netPrice * qty;
        }

        const groupKey = `${itemId}::${descKey || ""}`;

        if (!groups[groupKey]) {
          groups[groupKey] = {
            item_id: itemId,
            item_name: itemName,
            category_name: categoryName,
            description_key: descKey,
            entries: [], // { date, quantity, amount }
          };
        }

        groups[groupKey].entries.push({
          date,
          quantity: qty,
          amount: lineAmount,
        });
      }

      // 4) Calcular métricas por grupo
      const results = [];

      Object.values(groups).forEach((group) => {
        const entries = group.entries;
        if (!entries || entries.length < minOccurrences) {
          return; // no cumple mínimo de ocurrencias
        }

        // Ordenar por fecha ascendente
        entries.sort((a, b) => a.date.localeCompare(b.date));

        const dates = entries.map((e) => e.date);

        // Intervalos en días entre compras consecutivas
        const intervals = [];
        for (let i = 1; i < dates.length; i++) {
          const dPrev = dates[i - 1];
          const dCurr = dates[i];
          const diff = diffInDays(dPrev, dCurr);
          if (diff > 0) intervals.push(diff);
        }

        if (intervals.length === 0) {
          return; // no hay al menos 2 fechas válidas
        }

        const medianInterval = median(intervals);
        const meanInterval = mean(intervals);
        const stdInterval = stdDev(intervals);

        const totalQty = entries.reduce(
          (sum, e) => sum + (Number(e.quantity) || 0),
          0
        );
        const totalAmount = entries.reduce(
          (sum, e) => sum + (Number(e.amount) || 0),
          0
        );

        const avgQty =
          entries.length > 0 ? totalQty / entries.length : 0;
        const avgAmount =
          entries.length > 0 ? totalAmount / entries.length : 0;

        const lastEntry = entries[entries.length - 1];
        const lastDate = lastEntry?.date || null;
        const lastAmount = lastEntry?.amount || 0;

        const frequencyLabel = mapIntervalToFrequencyLabel(
          medianInterval
        );

        results.push({
          item_id: group.item_id,
          item_name: group.item_name,
          category_name: group.category_name,
          description_key: group.description_key,
          occurrences: entries.length,
          median_interval_days: Number(medianInterval.toFixed(1)),
          mean_interval_days: Number(meanInterval.toFixed(1)),
          std_dev_interval_days: Number(stdInterval.toFixed(1)),
          avg_quantity: Number(avgQty.toFixed(2)),
          avg_amount: Number(avgAmount.toFixed(2)),
          last_date: lastDate,
          last_amount: Number(lastAmount.toFixed(2)),
          frequency_label: frequencyLabel,
        });
      });

      // 5) Ordenar resultados (más interesantes arriba)
      results.sort((a, b) => {
        if (b.occurrences !== a.occurrences) {
          return b.occurrences - a.occurrences;
        }
        if (a.median_interval_days !== b.median_interval_days) {
          return a.median_interval_days - b.median_interval_days;
        }
        return b.avg_amount - a.avg_amount;
      });

      return res.json({ success: true, data: results });
    } catch (err) {
      console.error(
        "Error inesperado en /analytics/recurring-item-patterns:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno del servidor" });
    }
  }
);


module.exports = router;

