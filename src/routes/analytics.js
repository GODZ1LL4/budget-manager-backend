//backend/routes/analytics.js
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

router.get(
  "/monthly-income-expense-avg",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const rawYear = parseInt(req.query.year, 10);
    const currentYear = new Date().getFullYear();
    const year =
      Number.isFinite(rawYear) && rawYear >= 2000 && rawYear <= currentYear + 1
        ? rawYear
        : currentYear;

    const { start, end } = getYearRange(year);

    const { data, error } = await supabase
      .from("transactions")
      .select("amount, type, date")
      .eq("user_id", user_id)
      .in("type", ["income", "expense"])
      .gte("date", start)
      .lte("date", end);

    if (error) return res.status(500).json({ error: error.message });

    // Pre-cargar los 12 meses para que el gráfico no "brinque" y sea consistente
    const months = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, "0");
      return `${year}-${mm}`;
    });

    const grouped = {};
    months.forEach((m) => (grouped[m] = { income: 0, expense: 0 }));

    (data || []).forEach((tx) => {
      const month = typeof tx.date === "string" ? tx.date.slice(0, 7) : null;
      if (!month || !grouped[month]) return;

      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      if (tx.type === "income") grouped[month].income += amount;
      else if (tx.type === "expense") grouped[month].expense += amount;
    });

    const result = months.map((month) => {
      const income = Number(grouped[month].income || 0);
      const expense = Number(grouped[month].expense || 0);
      return {
        month,
        income: Number(income.toFixed(2)),
        expense: Number(expense.toFixed(2)),
        balance: Number((income - expense).toFixed(2)),
      };
    });

    res.json({ success: true, data: result });
  }
);

/* ========= GASTO ANUAL POR CATEGORÍA Y VARIACIONES ========= */

router.get(
  "/annual-expense-by-category",
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

router.get("/yearly-category-variations", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const rawYear = req.query.year;
  const parsedYear = rawYear != null ? Number(rawYear) : new Date().getFullYear();

  if (!Number.isFinite(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
    return res.status(400).json({ error: "Parámetro year inválido." });
  }

  const year = parsedYear;
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

  res.json({ success: true, data: perCategory, year });
});


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

// GET /api/analytics/budget-vs-actual-summary-yearly?year=2026&view=monthly
// GET /api/analytics/budget-vs-actual-summary-yearly?year=2026&view=categories
router.get(
  "/budget-vs-actual-summary-yearly",
  authenticateUser,
  async (req, res) => {
    try {
      const user_id = req.user.id;

      const rawYear = parseInt(req.query.year, 10);
      const currentYear = new Date().getFullYear();
      const year =
        Number.isFinite(rawYear) &&
        rawYear >= 2000 &&
        rawYear <= currentYear + 1
          ? rawYear
          : currentYear;

      const view = String(req.query.view || "monthly"); // "monthly" | "categories"

      const { start, end } = getYearRange(year);

      // 1) Presupuestos del año (por mes y categoría)
      const { data: budgets, error: budgetError } = await supabase
        .from("budgets")
        .select("month, limit_amount, category_id, categories(name, type)")
        .eq("user_id", user_id)
        .gte("month", `${year}-01`)
        .lte("month", `${year}-12`);

      if (budgetError)
        return res.status(500).json({ error: budgetError.message });

      // 2) Gastos del año (por categoría y fecha)
      const { data: expenses, error: expenseError } = await supabase
        .from("transactions")
        .select("amount, date, category_id, categories(name)")
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", start)
        .lte("date", end);

      if (expenseError)
        return res.status(500).json({ error: expenseError.message });

      // Helpers
      const toMonthKey = (isoDate) =>
        typeof isoDate === "string" ? isoDate.slice(0, 7) : null;

      // ---------------------------
      // VIEW: MONTHLY (12 meses)
      // ---------------------------
      if (view === "monthly") {
        const totals = {};
        for (let i = 1; i <= 12; i++) {
          const key = `${year}-${String(i).padStart(2, "0")}`;
          totals[key] = { month: key, budgeted: 0, spent: 0, diff: 0 };
        }

        (budgets || []).forEach((b) => {
          // Si existieran budgets de income, los ignoramos (en tu app budgets parecen ser de gasto)
          if (b.categories?.type && b.categories.type !== "expense") return;

          const monthKey = b.month; // YYYY-MM
          if (!totals[monthKey]) return;
          totals[monthKey].budgeted += parseFloat(b.limit_amount) || 0;
        });

        (expenses || []).forEach((tx) => {
          const monthKey = toMonthKey(tx.date);
          if (!monthKey || !totals[monthKey]) return;
          totals[monthKey].spent += parseFloat(tx.amount) || 0;
        });

        const result = Object.values(totals)
          .map((row) => {
            const budgeted = row.budgeted || 0;
            const spent = row.spent || 0;
            const diff = spent - budgeted;
            return {
              month: row.month,
              budgeted: Number(budgeted.toFixed(2)),
              spent: Number(spent.toFixed(2)),
              diff: Number(diff.toFixed(2)),
            };
          })
          .sort((a, b) => a.month.localeCompare(b.month));

        return res.json({ success: true, data: result, meta: { year, view } });
      }

      // ---------------------------
      // VIEW: CATEGORIES (anual)
      // ---------------------------
      if (view === "categories") {
        const budgetByCat = {};
        (budgets || []).forEach((b) => {
          if (!b?.category_id) return;
          if (b.categories?.type && b.categories.type !== "expense") return;

          const id = b.category_id;
          if (!budgetByCat[id]) {
            budgetByCat[id] = {
              category_id: id,
              category: b.categories?.name || "Sin categoría",
              budgeted: 0,
            };
          }
          budgetByCat[id].budgeted += parseFloat(b.limit_amount) || 0;
        });

        const spentByCat = {};
        (expenses || []).forEach((tx) => {
          if (!tx?.category_id) return;
          const id = tx.category_id;

          if (!spentByCat[id]) {
            spentByCat[id] = {
              category_id: id,
              category: tx.categories?.name || "Sin categoría",
              spent: 0,
            };
          }
          spentByCat[id].spent += parseFloat(tx.amount) || 0;
        });

        const allIds = new Set([
          ...Object.keys(budgetByCat),
          ...Object.keys(spentByCat),
        ]);

        let rows = Array.from(allIds).map((id) => {
          const b = budgetByCat[id];
          const s = spentByCat[id];
          const budgeted = b?.budgeted || 0;
          const spent = s?.spent || 0;

          return {
            category_id: id,
            category: b?.category || s?.category || "Sin categoría",
            budgeted: Number(budgeted.toFixed(2)),
            spent: Number(spent.toFixed(2)),
            diff: Number((spent - budgeted).toFixed(2)),
          };
        });

        // Orden por gasto para que sea útil
        rows.sort((a, b) => b.spent - a.spent);

        // (Recomendación práctica) limitar a Top 12 + "Otros" para que el chart no se vuelva ilegible
        const LIMIT = 12; // o 15 si quieres, pero el punto es "Otros" clickeable

        if (rows.length > LIMIT) {
          const top = rows.slice(0, LIMIT);
          const rest = rows.slice(LIMIT);

          const other = rest.reduce(
            (acc, r) => {
              acc.budgeted += Number(r.budgeted) || 0;
              acc.spent += Number(r.spent) || 0;
              return acc;
            },
            { category_id: "others", category: "Otros", budgeted: 0, spent: 0 }
          );

          other.budgeted = Number(other.budgeted.toFixed(2));
          other.spent = Number(other.spent.toFixed(2));
          other.diff = Number((other.spent - other.budgeted).toFixed(2));

          // ✅ IMPORTANTE: desglose ordenado (por gasto desc)
          const othersBreakdown = rest
            .map((r) => ({
              category_id: r.category_id,
              category: r.category,
              budgeted: Number((Number(r.budgeted) || 0).toFixed(2)),
              spent: Number((Number(r.spent) || 0).toFixed(2)),
              diff: Number(
                (Number(r.spent || 0) - Number(r.budgeted || 0)).toFixed(2)
              ),
            }))
            .sort((a, b) => b.spent - a.spent);

          rows = [...top, other];

          return res.json({
            success: true,
            data: rows,
            meta: {
              year,
              view,
              limit: LIMIT,
              others_breakdown: othersBreakdown,
            },
          });
        }

        // si no hay "otros"
        return res.json({
          success: true,
          data: rows,
          meta: { year, view, limit: LIMIT },
        });
      }

      // view inválido
      return res
        .status(400)
        .json({ error: "view inválido. Usa 'monthly' o 'categories'." });
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
    stability_types, // "fixed,variable", "variable", etc. Opcional
    date_from, // "YYYY-MM-DD". Opcional
    date_to, // "YYYY-MM-DD". Opcional
    limit, // número. Opcional, por defecto 10
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

  try {
    // 1) Metas (puedes filtrar solo activas/pausadas)
    const { data: goals, error: gErr } = await supabase
      .from("goals")
      .select("id, name, target_amount, status")
      .eq("user_id", user_id)
      .in("status", ["active", "paused"]);

    if (gErr) return res.status(500).json({ error: gErr.message });

    const goalIds = (goals || []).map((g) => g.id);

    // Si no hay metas
    if (!goalIds.length) {
      return res.json({ success: true, data: [] });
    }

    // 2) Movimientos de esas metas
    const { data: movements, error: mErr } = await supabase
      .from("goal_movements")
      .select("goal_id, type, amount")
      .eq("user_id", user_id)
      .in("goal_id", goalIds);

    if (mErr) return res.status(500).json({ error: mErr.message });

    // 3) Reserved net por meta
    const reservedByGoal = {};
    for (const m of movements || []) {
      const amt = Number(m.amount) || 0;

      // Ajusta aquí si tienes más tipos
      const sign =
        m.type === "deposit" || m.type === "adjust"
          ? 1
          : m.type === "withdraw" || m.type === "auto_withdraw"
          ? -1
          : 0;

      reservedByGoal[m.goal_id] = (reservedByGoal[m.goal_id] || 0) + sign * amt;
    }

    // 4) Respuesta
    const result = (goals || []).map((g) => {
      const current = Number(reservedByGoal[g.id] || 0);
      const target = Number(g.target_amount || 0);

      const progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;

      return {
        id: g.id,
        name: g.name || "Meta",
        current: Number(current.toFixed(2)),
        target: Number(target.toFixed(2)),
        progress: Number(progress.toFixed(1)),
        status: g.status,
      };
    });

    // Opcional: ordena más útil (más prioridad: más progreso, o target grande, etc.)
    result.sort((a, b) => b.progress - a.progress);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Error goals-progress:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ========= PROYECCIONES POR CATEGORÍA (INGRESO / GASTO) ========= */

router.get(
  "/projected-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    const now = new Date();

    // 1) Primer día del mes actual
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // 2) Primer día de hace 3 meses (esto incluye justo 3 meses completos ANTES del mes actual)
    //    Ej: hoy diciembre -> startDate = 1 septiembre
    const startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1)
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
      .gte("date", startDate) // >= 1er día de hace 3 meses
      .lt("date", endDate); // < 1er día del mes actual (excluye el mes actual)

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

router.get(
  "/category-monthly-comparison",
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

router.get(
  "/yearly-income-expense-by-stability",
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
        .select(
          `
          amount,
          type,
          date,
          categories ( stability_type )
        `
        )
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
        const stability = tx.categories?.stability_type || "variable";

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
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

/* ========= BURN RATE (RITMO DE GASTO DEL MES ACTUAL) ========= */

router.get(
  "/spending-burn-rate-current-month",
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
      console.error(
        "Error en /analytics/spending-burn-rate-current-month:",
        err
      );
      return res
        .status(500)
        .json({ error: "Error interno del servidor (burn rate)" });
    }
  }
);

function weekdayFromISODate(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [yS, mS, dS] = String(dateStr).split("-");
  const y = Number(yS);
  const m = Number(mS);
  const d = Number(dS);
  if (!y || !m || !d) return null;

  // Sakamoto algorithm -> 0=Sunday..6=Saturday
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let yy = y;
  if (m < 3) yy -= 1;
  return (
    (yy +
      Math.floor(yy / 4) -
      Math.floor(yy / 100) +
      Math.floor(yy / 400) +
      t[m - 1] +
      d) %
    7
  );
}

// BACKEND
// GET /api/analytics/expense-by-weekday?year=2026
// Devuelve: total, count, avg_txn (ticket promedio) y avg_day (promedio por día calendario)

router.get("/expense-by-weekday", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const rawYear = parseInt(req.query.year, 10);
  const currentYear = new Date().getFullYear();
  const year =
    Number.isFinite(rawYear) && rawYear >= 2000 && rawYear <= currentYear + 1
      ? rawYear
      : currentYear;

  const { start, end } = getYearRange(year);

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, date")
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", start)
    .lte("date", end);

  if (error) return res.status(500).json({ error: error.message });

  const totals = [
    { weekday: 0, label: "Dom", total: 0, count: 0, days_in_period: 0 },
    { weekday: 1, label: "Lun", total: 0, count: 0, days_in_period: 0 },
    { weekday: 2, label: "Mar", total: 0, count: 0, days_in_period: 0 },
    { weekday: 3, label: "Mié", total: 0, count: 0, days_in_period: 0 },
    { weekday: 4, label: "Jue", total: 0, count: 0, days_in_period: 0 },
    { weekday: 5, label: "Vie", total: 0, count: 0, days_in_period: 0 },
    { weekday: 6, label: "Sáb", total: 0, count: 0, days_in_period: 0 },
  ];

  // Contar cuántas veces aparece cada día de semana en el rango del año
  // (promedio por día calendario, no por transacción)
  const toISO = (d) => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  // start/end vienen como YYYY-MM-DD; iteramos seguro usando UTC
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  for (
    let d = new Date(startDate);
    d <= endDate;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const iso = toISO(d);
    const wd = weekdayFromISODate(iso); // 0..6, estable
    if (wd == null) continue;
    totals[wd].days_in_period += 1;
  }

  // Agregar transacciones
  (data || []).forEach((tx) => {
    const wd = weekdayFromISODate(tx.date); // ✅ estable, sin timezone
    if (wd == null) return;

    const amt = parseFloat(tx.amount);
    if (!Number.isFinite(amt) || amt <= 0) return;

    totals[wd].total += amt;
    totals[wd].count += 1;
  });

  const result = totals.map((t) => {
    const avgTxn = t.count > 0 ? t.total / t.count : 0;
    const avgDay = t.days_in_period > 0 ? t.total / t.days_in_period : 0;

    return {
      weekday: t.weekday,
      label: t.label,
      total: Number(t.total.toFixed(2)),
      count: t.count,
      avg_txn: Number(avgTxn.toFixed(2)),
      avg_day: Number(avgDay.toFixed(2)),
      days_in_period: t.days_in_period, // por si lo quieres mostrar
    };
  });

  return res.json({ success: true, data: result });
});

// GET /api/analytics/budget-coverage?year=2026
// Cobertura mensual REAL:
// Un gasto está cubierto SOLO si existe un presupuesto
// para la misma categoría en el mismo mes (YYYY-MM)

router.get("/budget-coverage", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const rawYear = parseInt(req.query.year, 10);
  const currentYear = new Date().getFullYear();
  const year =
    Number.isFinite(rawYear) && rawYear >= 2000 && rawYear <= currentYear + 1
      ? rawYear
      : currentYear;

  const { start, end } = getYearRange(year); // { start: "YYYY-01-01", end: "YYYY-12-31" }

  try {
    /* ------------------------------------------------------------------
     * 1) Presupuestos del año (clave: category_id + month)
     * ------------------------------------------------------------------ */
    const { data: budgets, error: budgetErr } = await supabase
      .from("budgets")
      .select("category_id, month, categories(type)")
      .eq("user_id", user_id)
      .gte("month", `${year}-01`)
      .lte("month", `${year}-12`);

    if (budgetErr) {
      console.error("budgetErr:", budgetErr);
      return res.status(500).json({ error: budgetErr.message });
    }

    // Set de presupuestos válidos (solo categorías expense)
    const budgetKeySet = new Set();
    (budgets || []).forEach((b) => {
      if (!b?.category_id || !b?.month) return;
      if (b.categories?.type !== "expense") return;
      budgetKeySet.add(`${b.category_id}|${b.month}`);
    });

    /* ------------------------------------------------------------------
     * 2) Gastos del año
     * ------------------------------------------------------------------ */
    const { data: expenses, error: expenseErr } = await supabase
      .from("transactions")
      .select("category_id, amount, date, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (expenseErr) {
      console.error("expenseErr:", expenseErr);
      return res.status(500).json({ error: expenseErr.message });
    }

    /* ------------------------------------------------------------------
     * 3) Agregaciones
     * ------------------------------------------------------------------ */
    const monthFromDate = (d) =>
      typeof d === "string" && d.length >= 7 ? d.slice(0, 7) : null;

    const monthlyAgg = {}; // month -> { covered, uncovered, total }
    const unbudgetedByCategory = {}; // catId -> { category_id, category_name, uncovered_total }
    const unbudgetedByMonth = {}; // month -> uncovered_total

    let totalExpense = 0;
    let totalCovered = 0;
    let totalUncovered = 0;

    (expenses || []).forEach((tx) => {
      const month = monthFromDate(tx.date);
      if (!month) return;

      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const catId = tx.category_id || "__uncategorized__";
      const catName = tx.category_id
        ? tx.categories?.name || "Categoría"
        : "Sin categoría";

      const key = `${catId}|${month}`;
      const isCovered = budgetKeySet.has(key);

      if (!monthlyAgg[month]) {
        monthlyAgg[month] = { covered: 0, uncovered: 0, total: 0 };
      }

      monthlyAgg[month].total += amount;
      totalExpense += amount;

      if (isCovered) {
        monthlyAgg[month].covered += amount;
        totalCovered += amount;
      } else {
        monthlyAgg[month].uncovered += amount;
        totalUncovered += amount;

        if (!unbudgetedByCategory[catId]) {
          unbudgetedByCategory[catId] = {
            category_id: catId,
            category_name: catName,
            uncovered_total: 0,
          };
        }
        unbudgetedByCategory[catId].uncovered_total += amount;

        unbudgetedByMonth[month] = (unbudgetedByMonth[month] || 0) + amount;
      }
    });

    /* ------------------------------------------------------------------
     * 4) Construir meses del año (siempre 12)
     * ------------------------------------------------------------------ */
    const months = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, "0");
      return `${year}-${mm}`;
    });

    const monthly = months.map((m) => {
      const row = monthlyAgg[m] || { covered: 0, uncovered: 0, total: 0 };
      const coveragePct = row.total > 0 ? (row.covered / row.total) * 100 : 0;

      return {
        month: m,
        covered: Number(row.covered.toFixed(2)),
        uncovered: Number(row.uncovered.toFixed(2)),
        total: Number(row.total.toFixed(2)),
        coverage_pct: Number(coveragePct.toFixed(2)),
      };
    });

    const topUnbudgetedCategories = Object.values(unbudgetedByCategory)
      .sort((a, b) => b.uncovered_total - a.uncovered_total)
      .slice(0, 10)
      .map((x) => ({
        category_id: x.category_id,
        category_name: x.category_name,
        uncovered_total: Number(x.uncovered_total.toFixed(2)),
      }));

    const topUnbudgetedMonths = Object.entries(unbudgetedByMonth)
      .map(([month, uncovered_total]) => ({ month, uncovered_total }))
      .sort((a, b) => b.uncovered_total - a.uncovered_total)
      .slice(0, 6)
      .map((x) => ({
        month: x.month,
        uncovered_total: Number(x.uncovered_total.toFixed(2)),
      }));

    const totalCoveragePct =
      totalExpense > 0 ? (totalCovered / totalExpense) * 100 : 0;

    /* ------------------------------------------------------------------
     * 5) Response
     * ------------------------------------------------------------------ */
    return res.json({
      success: true,
      data: {
        year,
        range: { start, end },
        totals: {
          total_expense: Number(totalExpense.toFixed(2)),
          covered: Number(totalCovered.toFixed(2)),
          uncovered: Number(totalUncovered.toFixed(2)),
          coverage_pct: Number(totalCoveragePct.toFixed(2)),
        },
        monthly,
        top_unbudgeted_categories: topUnbudgetedCategories,
        top_unbudgeted_months: topUnbudgetedMonths,
      },
    });
  } catch (err) {
    console.error("Error en /budget-coverage:", err);
    return res.status(500).json({
      error: "Error interno calculando cobertura mensual de presupuestos",
    });
  }
});

// BACKEND
// GET /analytics/budget-coverage/details?year=2025&month=2025-06
// Devuelve detalle del mes: gasto cubierto vs sin presupuesto + top categorías sin presupuesto + (opcional) transacciones sin presupuesto

router.get("/budget-coverage/details", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const rawYear = parseInt(req.query.year, 10);
  const currentYear = new Date().getFullYear();
  const year =
    Number.isFinite(rawYear) && rawYear >= 2000 && rawYear <= currentYear + 1
      ? rawYear
      : currentYear;

  const month = String(req.query.month || "").trim(); // "YYYY-MM"
  const isValidMonth =
    /^\d{4}-\d{2}$/.test(month) && month.startsWith(`${year}-`);
  if (!isValidMonth) {
    return res.status(400).json({
      error:
        "Parámetro 'month' inválido. Debe ser YYYY-MM y coincidir con el year.",
    });
  }

  // Rango robusto: [month-01, nextMonth-01)
  const dateFrom = `${month}-01`;

  const [yy, mm] = month.split("-").map((x) => parseInt(x, 10));
  const nextYear = mm === 12 ? yy + 1 : yy;
  const nextMonth = mm === 12 ? 1 : mm + 1;
  const dateTo = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  try {
    // 1) Budgets del mes (solo expense)
    const { data: budgets, error: budgetErr } = await supabase
      .from("budgets")
      .select("category_id, month, categories(type)")
      .eq("user_id", user_id)
      .eq("month", month);

    if (budgetErr) {
      console.error("budgetErr:", budgetErr);
      return res.status(500).json({ error: budgetErr.message });
    }

    const budgetCatSet = new Set();
    (budgets || []).forEach((b) => {
      if (!b?.category_id) return;
      if (b.categories?.type !== "expense") return;
      budgetCatSet.add(b.category_id);
    });

    // 2) Gastos del mes: date >= dateFrom AND date < dateTo
    const { data: expenses, error: expenseErr } = await supabase
      .from("transactions")
      .select("id, category_id, amount, date, description, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", dateFrom)
      .lt("date", dateTo) // 👈 clave
      .order("date", { ascending: false });

    if (expenseErr) {
      console.error("expenseErr:", expenseErr);
      return res.status(500).json({ error: expenseErr.message });
    }

    let total = 0;
    let covered = 0;
    let uncovered = 0;

    const uncoveredByCategory = {};
    const uncoveredTx = [];

    (expenses || []).forEach((tx) => {
      const amount = parseFloat(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      total += amount;

      const catId = tx.category_id || "__uncategorized__";
      const catName = tx.category_id
        ? tx.categories?.name || "Categoría"
        : "Sin categoría";

      const isCovered = tx.category_id
        ? budgetCatSet.has(tx.category_id)
        : false;

      if (isCovered) {
        covered += amount;
      } else {
        uncovered += amount;

        if (!uncoveredByCategory[catId]) {
          uncoveredByCategory[catId] = {
            category_id: catId,
            category_name: catName,
            uncovered_total: 0,
          };
        }
        uncoveredByCategory[catId].uncovered_total += amount;

        uncoveredTx.push({
          id: tx.id,
          date: tx.date,
          description: tx.description || "",
          amount: Number(amount.toFixed(2)),
          category_id: catId,
          category_name: catName,
        });
      }
    });

    const coveragePct = total > 0 ? (covered / total) * 100 : 0;

    const topUnbudgetedCategories = Object.values(uncoveredByCategory)
      .sort((a, b) => b.uncovered_total - a.uncovered_total)
      .slice(0, 20)
      .map((x) => ({
        category_id: x.category_id,
        category_name: x.category_name,
        uncovered_total: Number(x.uncovered_total.toFixed(2)),
      }));

    const txLimit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    return res.json({
      success: true,
      data: {
        year,
        month,
        range: { dateFrom, dateTo }, // dateTo es exclusivo
        totals: {
          total: Number(total.toFixed(2)),
          covered: Number(covered.toFixed(2)),
          uncovered: Number(uncovered.toFixed(2)),
          coverage_pct: Number(coveragePct.toFixed(2)),
        },
        top_unbudgeted_categories: topUnbudgetedCategories,
        uncovered_transactions: uncoveredTx.slice(0, txLimit),
      },
    });
  } catch (err) {
    console.error("Error en /budget-coverage/details:", err);
    return res
      .status(500)
      .json({ error: "Error interno calculando detalle del mes" });
  }
});

router.get(
  "/projected-vs-actual-expense-by-category",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      const now = new Date();

      // 1) Rango de proyección (3 meses completos antes del mes actual)
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1)
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

        actualMap[key].actual_month_to_date += parseFloat(tx.amount) || 2;
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
router.get(
  "/recurring-expense-patterns",
  authenticateUser,
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
        (s || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80); // limitar un poco

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
router.get(
  "/expense-intervals-by-category",
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
  if (medianDays <= 9) return "semanal";
  if (medianDays <= 20) return "quincenal";
  if (medianDays <= 40) return "mensual";
  if (medianDays <= 70) return "bimestral";
  return "irregular";
}

/**
 * GET /analytics/recurring-item-patterns
 * ✅ Agrupa por item_id (NO por descripción)
 * ✅ Consolida por día: (item_id + date) sumando quantity y amount
 *    => cada día cuenta como 1 “evento real de compra” para intervalos/occurrences
 */
router.get("/recurring-item-patterns", authenticateUser, async (req, res) => {
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
            categories ( name )
          ),
          items!inner ( name )
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

    // 3) Agrupar por item_id y consolidar por día (item_id + date)
    //    groups[itemId] = { dailyMap: { [date]: { date, quantity, amount, last_descKey, last_categoryName } }, ... }
    const groups = {};

    for (const row of rows) {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx || !itemRel) continue;

      const itemId = row.item_id;
      if (!itemId) continue;

      const date = trx.date;
      if (!date) continue;

      const itemName = itemRel.name || "Sin nombre";
      const categoryName = trx.categories?.name || null;
      const descKey = normalizeDescriptionKey(trx.description);

      const qty = Number(row.quantity || 0);

      // Monto de la línea (final si existe, si no net*qty)
      let lineAmount = 0;
      if (row.line_total_final != null) {
        lineAmount = Number(row.line_total_final) || 0;
      } else {
        const netPrice = Number(row.unit_price_net || 0);
        lineAmount = netPrice * qty;
      }

      if (!groups[itemId]) {
        groups[itemId] = {
          item_id: itemId,
          item_name: itemName,
          dailyMap: {}, // date => { date, quantity, amount, last_descKey, last_categoryName }
          last_seen_date: date,
          last_description_key: descKey,
          last_category_name: categoryName,
        };
      }

      // Consolidación por día
      if (!groups[itemId].dailyMap[date]) {
        groups[itemId].dailyMap[date] = {
          date,
          quantity: 0,
          amount: 0,
          last_descKey: descKey,
          last_categoryName: categoryName,
        };
      }

      groups[itemId].dailyMap[date].quantity += qty;
      groups[itemId].dailyMap[date].amount += lineAmount;

      // Guardar "último concepto" y "última categoría" del día (por si hay varias transacciones ese mismo día)
      groups[itemId].dailyMap[date].last_descKey = descKey;
      groups[itemId].dailyMap[date].last_categoryName = categoryName;

      // Mantener "último concepto" global (más reciente por fecha)
      if (date >= (groups[itemId].last_seen_date || "")) {
        groups[itemId].last_seen_date = date;
        groups[itemId].last_description_key = descKey;
        groups[itemId].last_category_name = categoryName;
      }
    }

    // 4) Calcular métricas por ítem usando los "días consolidados"
    const results = [];

    Object.values(groups).forEach((group) => {
      const entries = Object.values(group.dailyMap || {});
      if (!entries || entries.length < minOccurrences) return;

      // Ordenar por fecha ascendente
      entries.sort((a, b) => a.date.localeCompare(b.date));

      const dates = entries.map((e) => e.date);

      // Intervalos en días entre "días con compra" consecutivos
      const intervals = [];
      for (let i = 1; i < dates.length; i++) {
        const diff = diffInDays(dates[i - 1], dates[i]);
        if (diff > 0) intervals.push(diff);
      }

      // Si solo hay 1 día o fechas inválidas no hay patrón
      if (intervals.length === 0) return;

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

      // Promedios por "evento diario"
      const avgQty = totalQty / entries.length;
      const avgAmount = totalAmount / entries.length;

      const lastEntry = entries[entries.length - 1];
      const lastDate = lastEntry?.date || null;
      const lastAmount = lastEntry?.amount || 0;

      const frequencyLabel = mapIntervalToFrequencyLabel(medianInterval);

      results.push({
        item_id: group.item_id,
        item_name: group.item_name,

        // ✅ contexto: lo más reciente (no afecta agrupación)
        category_name: group.last_category_name || null,
        description_key: group.last_description_key || null,

        // ✅ occurrences ahora = # de días con compra (evento real)
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
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      if (a.median_interval_days !== b.median_interval_days)
        return a.median_interval_days - b.median_interval_days;
      return b.avg_amount - a.avg_amount;
    });

    return res.json({ success: true, data: results });
  } catch (err) {
    console.error(
      "Error inesperado en /analytics/recurring-item-patterns:",
      err
    );
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/**
 * ===== Endpoint =====
 * GET /analytics/expense-forecast
 *
 * ✅ Ahora soporta:
 * - types=expense               (default)
 * - types=expense,income        (flujo)
 * - include_balance=true        (solo recomendado con flujo)
 *
 * Respuesta:
 *  meta: incluye types + include_balance
 *  summary: total_income, total_expense, net_projected y balance (si aplica)
 *  data: cada fila incluye tx_type: "expense"|"income"
 */
function parseISODateOnly(iso) {
  const [y, m, d] = String(iso || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)); // ✅ date-only en UTC
}

router.get("/expense-forecast", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    // =========================
    // Params base
    // =========================
    const months = Math.max(
      1,
      Math.min(36, parseInt(req.query.months ?? "12", 10) || 12)
    );
    const minOccurrences = Math.max(
      2,
      parseInt(req.query.min_occurrences ?? "3", 10) || 3
    );
    const limit = Math.max(
      1,
      Math.min(50, parseInt(req.query.limit ?? "15", 10) || 15)
    );

    const includeOccasional =
      String(req.query.include_occasional ?? "false") === "true";

    // incluir “ruido” (no-recurrentes) por categoría
    const includeNoise = String(req.query.include_noise ?? "true") === "true";

    const minIntervalDays = Math.max(
      1,
      parseInt(req.query.min_interval_days ?? "3", 10) || 3
    );
    const maxIntervalDays = Math.max(
      minIntervalDays,
      parseInt(req.query.max_interval_days ?? "70", 10) || 70
    );

    const maxCoefVariation = Number.isFinite(
      Number(req.query.max_coef_variation)
    )
      ? Number(req.query.max_coef_variation)
      : 0.6;

    // =========================
    // ✅ NUEVO: types + balance
    // =========================
    const types = String(req.query.types || "expense")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowed = new Set(["expense", "income"]);
    const safeTypes = types.filter((t) => allowed.has(t));
    if (safeTypes.length === 0) safeTypes.push("expense");

    const includeBalance =
      String(req.query.include_balance ?? "false") === "true";

    // =========================
    // Fechas (date_from/date_to)
    // =========================
    const rawFrom = (req.query.date_from || "").trim();
    const rawTo = (req.query.date_to || "").trim();

    let dateFromObj;
    let dateToObj;

    if (!rawFrom && !rawTo) {
      // Mes actual completo
      dateFromObj = firstDayOfMonth(new Date());
      dateToObj = lastDayOfMonth(new Date());
    } else if (rawFrom && !rawTo) {
      // Si solo viene from: DESDE ese día hasta fin de ese mes
      const base = parseISODateOnly(rawFrom);
      if (!base || Number.isNaN(base.getTime())) {
        return res
          .status(400)
          .json({ error: "date_from inválida (YYYY-MM-DD)" });
      }
      dateFromObj = base;
      dateToObj = lastDayOfMonth(base);
    } else if (!rawFrom && rawTo) {
      // Si solo viene to: mes completo de ese "to"
      const base = parseISODateOnly(rawTo);
      if (!base || Number.isNaN(base.getTime())) {
        return res.status(400).json({ error: "date_to inválida (YYYY-MM-DD)" });
      }
      dateFromObj = firstDayOfMonth(base);
      dateToObj = base; // respeta el día exacto
    } else {
      // ambos vienen
      const f = parseISODateOnly(rawFrom);
      const t = parseISODateOnly(rawTo);
      if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
        return res
          .status(400)
          .json({ error: "date_from/date_to inválidas (YYYY-MM-DD)" });
      }
      if (f > t) {
        return res
          .status(400)
          .json({ error: "date_from no puede ser mayor que date_to" });
      }
      dateFromObj = f;
      dateToObj = t;
    }

    const date_from = toISODate(dateFromObj);
    const date_to = toISODate(dateToObj);

    // =========================
    // Historial: últimos N meses hacia atrás desde date_from
    // ✅ NOTA: history_to = date_from (tal como lo tenías)
    // =========================
    const historyToObj = new Date(dateFromObj); // ya viene UTC

    const historyFromObj = new Date(dateFromObj);
    historyFromObj.setUTCDate(1); // ✅ siempre día 1 sin drift
    historyFromObj.setUTCMonth(historyFromObj.getUTCMonth() - months);

    const history_from = toISODate(historyFromObj);
    const history_to = toISODate(historyToObj);

    // =========================
    // Traer transacciones históricas (expenses/income)
    // =========================
    const { data, error } = await supabase
      .from("transactions")
      .select(
        `
        id,
        amount,
        date,
        type,
        category_id,
        description,
        categories:categories!transactions_category_id_fkey (
          name,
          stability_type
        )
      `
      )
      .eq("user_id", user_id)
      .in("type", safeTypes)
      .gte("date", history_from)
      .lte("date", history_to);

    if (error) {
      console.error("Error supabase /analytics/expense-forecast:", error);
      return res.status(500).json({ error: error.message });
    }

    // =========================
    // Normalización base
    // =========================
    const rawTxs = (data || [])
      .map((tx) => ({
        id: tx.id,
        date: tx.date,
        amount: Number(tx.amount) || 0,
        tx_type: tx.type, // ✅ income|expense
        category_id: tx.category_id,
        category_name: tx.categories?.name || "Sin categoría",
        category_stability: tx.categories?.stability_type || "variable",
        description: tx.description || "",
      }))
      .filter((tx) => tx.amount > 0 && !!tx.date && !!tx.tx_type);

    // filtrar ocasionales si el usuario no los incluye
    const txs = rawTxs.filter((tx) =>
      includeOccasional ? true : tx.category_stability !== "occasional"
    );

    // Normalizar descripción
    const txsNorm = txs.map((tx) => ({
      ...tx,
      norm: normalizeText(tx.description),
    }));

    // =========================
    // Agrupar por (tx_type + category) y clusters por similitud
    // =========================
    const byCategory = {};
    for (const tx of txsNorm) {
      const catKey = `${tx.tx_type}::${String(tx.category_id || "sin_cat")}`;
      if (!byCategory[catKey]) byCategory[catKey] = [];
      byCategory[catKey].push(tx);
    }

    const SIM_THRESHOLD = 0.45; // ajustable
    const clusters = []; // { tx_type, category_id, category_name, rep_norm, rep_grams, entries: [.] }

    for (const catKey of Object.keys(byCategory)) {
      const list = byCategory[catKey];

      const catClusters = [];
      for (const tx of list) {
        const grams = trigrams(tx.norm || "");
        let bestIdx = -1;
        let bestScore = 0;

        for (let i = 0; i < catClusters.length; i++) {
          const score = jaccard(grams, catClusters[i].rep_grams);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }

        if (bestIdx >= 0 && bestScore >= SIM_THRESHOLD) {
          catClusters[bestIdx].entries.push(tx);
          if (
            (tx.norm || "").length >
            (catClusters[bestIdx].rep_norm || "").length
          ) {
            catClusters[bestIdx].rep_norm = tx.norm;
            catClusters[bestIdx].rep_grams = grams;
          }
        } else {
          catClusters.push({
            tx_type: tx.tx_type, // ✅
            category_id: tx.category_id,
            category_name: tx.category_name,
            rep_norm: tx.norm,
            rep_grams: grams,
            entries: [tx],
          });
        }
      }

      clusters.push(...catClusters);
    }

    // =========================
    // Calcular patrones recurrentes por cluster
    // =========================
    const recurringPatterns = [];
    const recurringTxIds = new Set();

    for (const c of clusters) {
      const entries = c.entries;
      if (!entries || entries.length < minOccurrences) continue;

      entries.sort((a, b) => a.date.localeCompare(b.date));

      const intervals = [];
      for (let i = 1; i < entries.length; i++) {
        const d = diffInDays(entries[i - 1].date, entries[i].date);
        if (d > 0) intervals.push(d);
      }
      if (intervals.length < 2) continue;

      const medInterval = median(intervals);
      const mu = mean(intervals);
      const sd = stdDev(intervals);
      const coefVar = mu > 0 ? sd / mu : 999;

      if (medInterval < minIntervalDays || medInterval > maxIntervalDays)
        continue;
      if (coefVar > maxCoefVariation) continue;

      const amounts = entries
        .map((e) => e.amount)
        .filter((a) => Number.isFinite(a) && a > 0);

      const medAmount = median(amounts);
      if (!Number.isFinite(medAmount) || medAmount <= 0) continue;

      const last = entries[entries.length - 1];
      const lastDate = last.date;

      // Simular ocurrencias esperadas dentro del rango
      let next = addDays(lastDate, Math.round(medInterval));
      let expectedCount = 0;

      while (new Date(next) <= new Date(date_to)) {
        if (new Date(next) >= new Date(date_from)) expectedCount++;
        next = addDays(next, Math.round(medInterval));
      }

      if (expectedCount <= 0) continue;

      const projected = expectedCount * medAmount;

      // marcar tx usadas por patrones recurrentes (para excluirlas del ruido)
      for (const e of entries) recurringTxIds.add(e.id);

      recurringPatterns.push({
        tx_type: c.tx_type, // ✅ income|expense
        type: "recurring",
        category: c.category_name,
        pattern: `${c.tx_type === "income" ? "Ingreso" : "Gasto"} · ${
          c.category_name
        } · ${c.rep_norm || "sin descripcion"}`.trim(),
        projection: Number(projected.toFixed(2)),
        expected_count: expectedCount,
        median_interval_days: Number(medInterval.toFixed(1)),
        median_amount: Number(medAmount.toFixed(2)),
        last_date: lastDate,

        // debug columns
        proj_a: null,
        proj_b: null,
      });
    }

    // =========================
    // “Ruido” (no recurrentes) por (tx_type + categoría)
    // PROJECTION = MIN(projB, projA)
    // =========================
    let noisePatterns = [];
    if (includeNoise) {
      const historyDays = Math.max(1, diffInDays(history_from, history_to) + 1);
      const targetDays = Math.max(1, diffInDays(date_from, date_to) + 1);

      const noiseByCat = {}; // key: tx_type::category_id

      for (const tx of txsNorm) {
        if (recurringTxIds.has(tx.id)) continue;

        const catKey = `${tx.tx_type}::${String(tx.category_id || "sin_cat")}`;
        if (!noiseByCat[catKey]) {
          noiseByCat[catKey] = {
            tx_type: tx.tx_type, // ✅
            category_id: tx.category_id,
            category_name: tx.category_name,
            amounts: [],
            total: 0,
            count: 0,
          };
        }

        noiseByCat[catKey].amounts.push(tx.amount);
        noiseByCat[catKey].total += tx.amount;
        noiseByCat[catKey].count += 1;
      }

      noisePatterns = Object.values(noiseByCat)
        .map((c) => {
          if (c.count < 3) return null;

          const medAmount = median(c.amounts);

          // A: rate por día
          const meanPerDay = c.total / historyDays;
          const projectedA = meanPerDay * targetDays;

          // expected_count por densidad histórica
          const expectedCountRaw = (c.count / historyDays) * targetDays;
          const expectedCount =
            expectedCountRaw >= 0.75 ? Math.round(expectedCountRaw) : 0;

          // B: ocurrencias * ticket típico
          const projectedB =
            expectedCount > 0 ? expectedCount * (Number(medAmount) || 0) : 0;

          // PROJECTION: no exceder el rate histórico
          const projection = Math.min(projectedB, projectedA);

          if (!Number.isFinite(projection) || projection <= 0) return null;

          return {
            tx_type: c.tx_type, // ✅
            type: "event",
            category: c.category_name,
            pattern: `${c.tx_type === "income" ? "Ingreso" : "Gasto"} · ${
              c.category_name
            } · movimientos eventuales`,
            projection: Number(projection.toFixed(2)),
            expected_count: expectedCount,
            median_interval_days: null,
            median_amount: Number((Number(medAmount) || 0).toFixed(2)),
            last_date: null,

            // debug columns
            proj_a: Number(projectedA.toFixed(2)),
            proj_b: Number(projectedB.toFixed(2)),
          };
        })
        .filter(Boolean);
    }

    // =========================
    // Mezclar + ordenar + limitar
    // =========================
    const combined = [...recurringPatterns, ...noisePatterns];
    combined.sort((a, b) => (b.projection || 0) - (a.projection || 0));
    const top = combined.slice(0, limit);

    // =========================
    // Summary ampliado
    // =========================
    const total_projected = top.reduce((s, r) => s + (r.projection || 0), 0);

    const total_expense = top
      .filter((r) => r.tx_type === "expense")
      .reduce((s, r) => s + (r.projection || 0), 0);

    const total_income = top
      .filter((r) => r.tx_type === "income")
      .reduce((s, r) => s + (r.projection || 0), 0);

    const net_projected = total_income - total_expense;

    const transactions_expected = top.reduce(
      (s, r) => s + (r.expected_count || 0),
      0
    );

    // =========================
    // ✅ Balance (available) desde account_balances_extended
    // =========================
    let balance = null;
    if (includeBalance) {
      const { data: acc, error: balErr } = await supabase
        .from("account_balances_extended")
        .select("current_balance, reserved_total, available_balance")
        .eq("user_id", user_id);

      if (balErr) {
        console.error("balance extended error:", balErr);
      } else {
        const totals = (acc || []).reduce(
          (a, r) => {
            a.current += Number(r.current_balance || 0);
            a.reserved += Number(r.reserved_total || 0);
            a.available += Number(r.available_balance || 0);
            return a;
          },
          { current: 0, reserved: 0, available: 0 }
        );

        balance = {
          total_current: Number(totals.current.toFixed(2)),
          total_reserved: Number(totals.reserved.toFixed(2)),
          total_available: Number(totals.available.toFixed(2)),
        };
      }
    }

    return res.json({
      success: true,
      meta: {
        date_from,
        date_to,
        history_from,
        history_to,
        months,
        min_occurrences: minOccurrences,
        include_occasional: includeOccasional,
        include_noise: includeNoise,
        types: safeTypes,
        include_balance: includeBalance,
      },
      summary: {
        total_projected: Number(total_projected.toFixed(2)),
        total_income: Number(total_income.toFixed(2)),
        total_expense: Number(total_expense.toFixed(2)),
        net_projected: Number(net_projected.toFixed(2)),
        transactions_expected,
        ...(balance ? { balance } : {}),
      },
      data: top,
    });
  } catch (err) {
    console.error("Error en /analytics/expense-forecast:", {
      message: err?.message,
      cause: err?.cause,
      stack: err?.stack,
    });
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = {
  clampInt,
  toISODate,
  addDays,
  diffInDays,
  mean,
  median,
  stdDev,
  normalizeText,
  trigrams,
  jaccard,
};

function clampInt(v, def, min, max) {
  const n = parseInt(v ?? "", 10);
  const x = Number.isFinite(n) ? n : def;
  return Math.max(min, Math.min(max, x));
}

function toISODate(d) {
  return new Date(d).toISOString().split("T")[0];
}

function addDays(dateStr, days) {
  const base = parseISODateOnly(dateStr);
  base.setUTCDate(base.getUTCDate() + days);
  return toISODate(base);
}


function diffInDays(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}

function mean(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdDev(arr) {
  if (!arr?.length) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(raw) {
  const s = stripAccents(String(raw || "").toLowerCase())
    .replace(/[_|/\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  const stop = new Set([
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "y",
    "o",
    "para",
    "por",
    "con",
    "un",
    "una",
    "unos",
    "unas",
    "mi",
    "mis",
    "tu",
    "tus",
    "su",
    "sus",
    "en",
    "a",
    "al",
    "se",
    "me",
    "te",
    "que",
    "como",
  ]);

  const tokens = s.split(" ").filter((t) => t.length >= 2 && !stop.has(t));
  return tokens.slice(0, 6).join(" ");
}

function trigrams(s) {
  const t = `  ${s}  `;
  const grams = new Set();
  for (let i = 0; i < t.length - 2; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

router.get("/item-expense-forecast", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    // =========================
    // Params
    // =========================
    const months = Math.max(
      1,
      Math.min(36, parseInt(req.query.months ?? "12", 10) || 12)
    );

    const minOccurrences = Math.max(
      2,
      parseInt(req.query.min_occurrences ?? "3", 10) || 3
    );

    const limit = Math.max(
      1,
      Math.min(50, parseInt(req.query.limit ?? "15", 10) || 15)
    );

    const includeNoise = String(req.query.include_noise ?? "true") === "true";

    const minIntervalDays = Math.max(
      1,
      parseInt(req.query.min_interval_days ?? "3", 10) || 3
    );

    const maxIntervalDays = Math.max(
      minIntervalDays,
      parseInt(req.query.max_interval_days ?? "70", 10) || 70
    );

    const maxCoefVariation = Number.isFinite(Number(req.query.max_coef_variation))
      ? Number(req.query.max_coef_variation)
      : 0.6;

    // =========================
    // Fechas (igual patrón que /expense-forecast)
    // =========================
    const rawFrom = (req.query.date_from || "").trim();
    const rawTo = (req.query.date_to || "").trim();

    let dateFromObj;
    let dateToObj;

    if (!rawFrom && !rawTo) {
      dateFromObj = firstDayOfMonth(new Date());
      dateToObj = lastDayOfMonth(new Date());
    } else if (rawFrom && !rawTo) {
      const base = parseISODateOnly(rawFrom);
      if (!base || Number.isNaN(base.getTime())) {
        return res.status(400).json({ error: "date_from inválida (YYYY-MM-DD)" });
      }
      dateFromObj = base;
      dateToObj = lastDayOfMonth(base);
    } else if (!rawFrom && rawTo) {
      const base = parseISODateOnly(rawTo);
      if (!base || Number.isNaN(base.getTime())) {
        return res.status(400).json({ error: "date_to inválida (YYYY-MM-DD)" });
      }
      dateFromObj = firstDayOfMonth(base);
      dateToObj = base;
    } else {
      const f = parseISODateOnly(rawFrom);
      const t = parseISODateOnly(rawTo);
      if (!f || !t || Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
        return res
          .status(400)
          .json({ error: "date_from/date_to inválidas (YYYY-MM-DD)" });
      }
      if (f > t) return res.status(400).json({ error: "date_from no puede ser mayor que date_to" });
      dateFromObj = f;
      dateToObj = t;
    }

    const date_from = toISODate(dateFromObj);
    const date_to = toISODate(dateToObj);

    // Historial: últimos N meses hacia atrás desde date_from
    const historyToObj = new Date(dateFromObj);
    const historyFromObj = new Date(dateFromObj);
    historyFromObj.setUTCDate(1);
    historyFromObj.setUTCMonth(historyFromObj.getUTCMonth() - months);

    const history_from = toISODate(historyFromObj);
    const history_to = toISODate(historyToObj);

    const historyDays = Math.max(1, diffInDays(history_from, history_to) || 1);
    const targetDays = Math.max(1, diffInDays(date_from, date_to) + 1);

    // =========================
    // Data: transaction_items + joins (solo expense)
    // =========================
    const { data, error } = await supabase
      .from("transaction_items")
      .select(`
        item_id,
        quantity,
        unit_price_net,
        line_total_final,
        items!inner (
          name,
          user_id,
          taxes ( rate, is_exempt )
        ),
        transactions!inner (
          date,
          type,
          user_id
        )
      `)
      .eq("transactions.user_id", user_id)
      .eq("items.user_id", user_id)
      .eq("transactions.type", "expense")
      .gte("transactions.date", history_from)
      .lte("transactions.date", history_to);

    if (error) {
      console.error("Error supabase /analytics/item-expense-forecast:", error);
      return res.status(500).json({ error: error.message });
    }

    // =========================
    // Agrupar por item + por día
    // =========================
    const eventsByItem = {}; // itemId -> date -> { qty, amount }
    const itemNameMap = {};

    (data || []).forEach((row) => {
      const trx = row.transactions;
      const itemRel = row.items;
      if (!trx || !itemRel) return;

      const itemId = row.item_id;
      const day = trx.date;

      const qty = Number(row.quantity || 0);
      if (!itemId || !day || qty <= 0) return;

      itemNameMap[itemId] = itemRel.name || "Sin nombre";

      // monto final con fallback
      let lineAmount = 0;
      if (row.line_total_final != null) {
        lineAmount = Number(row.line_total_final) || 0;
      } else {
        const netPrice = Number(row.unit_price_net || 0);
        const taxRate = itemRel.taxes?.rate != null ? Number(itemRel.taxes.rate) : 0;
        const isExempt = !!itemRel.taxes?.is_exempt;

        let priceWithTax = netPrice;
        if (!isExempt && taxRate > 0) priceWithTax = netPrice * (1 + taxRate / 100);

        lineAmount = priceWithTax * qty;
      }

      if (!eventsByItem[itemId]) eventsByItem[itemId] = {};
      if (!eventsByItem[itemId][day]) eventsByItem[itemId][day] = { qty: 0, amount: 0 };

      eventsByItem[itemId][day].qty += qty;
      eventsByItem[itemId][day].amount += lineAmount;
    });

    // =========================
    // Helpers: discreto vs continuo
    // =========================
    const qtyEps = 0.02;
    const nearInt = (x) => Math.abs(x - Math.round(x)) <= qtyEps;

    // =========================
    // Recency hybrid thresholds
    // =========================
    const HARD_DROP_DAYS = 90; // >90 => excluir completamente (muerto)
    // expiry dinámico:
    // quincenal(14) -> max(3*14=42,45)=45
    // mensual(30) -> max(90,45)=90
    const expiryDaysFor = (medianIntervalDays) => {
      const mi = Math.max(1, Math.round(Number(medianIntervalDays) || 1));
      return Math.max(3 * mi, 45);
    };

    // =========================
    // Construir patrones
    // =========================
    const recurring = [];
    const noise = [];

    for (const itemId of Object.keys(eventsByItem)) {
      const byDate = eventsByItem[itemId];
      const dates = Object.keys(byDate).sort();
      if (dates.length < 2) continue;

      const entries = dates.map((d) => ({
        date: d,
        quantity: byDate[d].qty,
        amount: byDate[d].amount,
      }));

      // intervalos
      const intervals = [];
      for (let i = 1; i < entries.length; i++) {
        const delta = diffInDays(entries[i - 1].date, entries[i].date);
        if (Number.isFinite(delta) && delta > 0) intervals.push(delta);
      }
      if (intervals.length === 0) continue;

      const medianInterval = median(intervals);
      const meanInterval = mean(intervals);
      const stdInterval = stdDev(intervals);
      const cv = meanInterval > 0 ? stdInterval / meanInterval : 999;

      const amounts = entries.map((e) => Number(e.amount) || 0).filter((x) => x > 0);
      const qtys = entries.map((e) => Number(e.quantity) || 0).filter((x) => x > 0);
      if (amounts.length === 0 || qtys.length === 0) continue;

      const medAmount = median(amounts);
      const avgQty = mean(qtys);
      const medianQty = median(qtys);

      // discreto/continuo
      const nearIntRatio = qtys.length > 0 ? qtys.filter(nearInt).length / qtys.length : 0;
      const isDiscrete = nearIntRatio >= 0.8;

      const typicalQty = isDiscrete
        ? Math.max(1, Math.round(medianQty))
        : (Number(avgQty) || 0);

      const lastDate = entries[entries.length - 1].date;

      // recency / expiry
      const daysSinceLast = diffInDays(lastDate, date_from); // lastDate antes del rango => positivo
      const expiryDays = expiryDaysFor(medianInterval);

      const isHardExpired = daysSinceLast > HARD_DROP_DAYS;
      const isSoftExpired = daysSinceLast > expiryDays && !isHardExpired;

      const baseRow = {
        item_id: itemId,
        item_name: itemNameMap[itemId] || "Sin nombre",
        occurrences: entries.length,

        median_interval_days: Number(medianInterval.toFixed(1)),
        mean_interval_days: Number(meanInterval.toFixed(1)),
        std_dev_interval_days: Number(stdInterval.toFixed(1)),

        avg_quantity: Number(avgQty.toFixed(2)),
        median_amount: Number((Number(medAmount) || 0).toFixed(2)),
        last_date: lastDate,

        // para UI/debug
        is_discrete: isDiscrete,
        near_int_ratio: Number(nearIntRatio.toFixed(2)),
        typical_quantity: isDiscrete
          ? Number(typicalQty.toFixed(0))
          : Number(typicalQty.toFixed(2)),

        days_since_last: Number.isFinite(daysSinceLast) ? daysSinceLast : null,
        expiry_days: expiryDays,
        recency_status: isHardExpired ? "hard_expired" : isSoftExpired ? "soft_expired" : "fresh",
      };

      // Si está MUY viejo: excluir del reporte por completo
      if (isHardExpired) {
        continue;
      }

      // candidato recurrente por métricas
      const isRecurringCandidate =
        entries.length >= minOccurrences &&
        medianInterval >= minIntervalDays &&
        medianInterval <= maxIntervalDays &&
        cv <= maxCoefVariation;

      // si está soft-expired, NO puede ser recurrente
      const finalIsRecurring = isRecurringCandidate && !isSoftExpired;

      if (finalIsRecurring) {
        // recurrente real
        const interval = Math.max(1, Math.round(medianInterval));
        const amountPerEvent = Number(medAmount) || 0;
        if (amountPerEvent <= 0) continue;

        const gap = diffInDays(lastDate, date_from);
        const n = gap > 0 ? Math.ceil(gap / interval) : 1;
        let next = addDays(lastDate, n * interval);

        let expectedCount = 0;
        let projection = 0;

        while (new Date(next) <= new Date(date_to)) {
          expectedCount += 1;
          projection += amountPerEvent;
          next = addDays(next, interval);
        }

        if (projection > 0) {
          const expectedQuantity = expectedCount * (Number(typicalQty) || 0);

          recurring.push({
            ...baseRow,
            type: "recurring",
            expected_count: expectedCount,
            expected_quantity: isDiscrete
              ? Number(expectedQuantity.toFixed(0))
              : Number(expectedQuantity.toFixed(2)),
            projection: Number(projection.toFixed(2)),
          });
        }
      } else {
        // evento / noise (incluye soft-expired como "ruido", si include_noise)
        if (!includeNoise) continue;

        // para noise pedimos un mínimo de señal
        if (entries.length < 3) continue;

        const total = amounts.reduce((s, v) => s + v, 0);
        const meanPerDay = total / historyDays;
        const projectedA = meanPerDay * targetDays;

        const expectedCountRaw = (entries.length / historyDays) * targetDays;
        const expectedCount = expectedCountRaw >= 0.75 ? Math.round(expectedCountRaw) : 0;

        const projectedB = expectedCount > 0 ? expectedCount * (Number(medAmount) || 0) : 0;

        const projection = Math.min(projectedA, projectedB);

        // si es soft-expired, limitamos agresivo para que no domine el top
        // (alguien que no compra desde hace 2 meses no debería "prometer" mucho)
        const softExpiryPenalty = isSoftExpired ? 0.35 : 1.0;
        const finalProjection = projection * softExpiryPenalty;

        if (Number.isFinite(finalProjection) && finalProjection > 0) {
          const expectedQuantity = expectedCount * (Number(typicalQty) || 0);

          noise.push({
            ...baseRow,
            type: "event",
            expected_count: expectedCount,
            expected_quantity: isDiscrete
              ? Number(expectedQuantity.toFixed(0))
              : Number(expectedQuantity.toFixed(2)),
            projection: Number(finalProjection.toFixed(2)),
          });
        }
      }
    }

    const combined = [...recurring, ...noise]
      .sort((a, b) => (b.projection || 0) - (a.projection || 0))
      .slice(0, limit);

    const total_projected = combined.reduce((s, r) => s + (r.projection || 0), 0);
    const quantity_expected = combined.reduce((s, r) => {
      const q = Number(r.expected_quantity);
      return s + (Number.isFinite(q) ? q : 0);
    }, 0);

    return res.json({
      success: true,
      meta: {
        date_from,
        date_to,
        history_from,
        history_to,
        months,
        min_occurrences: minOccurrences,
        include_noise: includeNoise,
        min_interval_days: minIntervalDays,
        max_interval_days: maxIntervalDays,
        max_coef_variation: maxCoefVariation,
        expiry_rule: {
          hard_drop_days: HARD_DROP_DAYS,
          expiry_days: "max(3*median_interval_days, 45)",
          soft_expired_behavior: "degrade_to_event (penalized)",
          hard_expired_behavior: "excluded",
        },
      },
      summary: {
        total_projected: Number(total_projected.toFixed(2)),
        total_expense: Number(total_projected.toFixed(2)),
        quantity_expected: Number(quantity_expected.toFixed(2)),
      },
      data: combined,
    });
  } catch (err) {
    console.error("Error en /analytics/item-expense-forecast:", {
      message: err?.message,
      cause: err?.cause,
      stack: err?.stack,
    });
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});




// GET /analytics/advanced-burn-rate-current-month
// - Fechas internas: primer y último día del mes actual
// - Acepta parámetros (months, min_occurrences, include_noise, include_occasional, etc.)
// - Expected = continúa la secuencia histórica (NO se reinicia en el día 1)
//   => primer evento esperado dentro del mes = primer múltiplo de intervalo desde last_date que caiga >= date_from

router.get(
  "/advanced-burn-rate-current-month",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;

    try {
      // =========================
      // 1) Mes actual (interno)
      // =========================
      const now = new Date();
      const year = now.getFullYear();
      const monthIndex = now.getMonth(); // 0-11
      const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;

      const dateFromObj = new Date(year, monthIndex, 1);
      const dateToObj = new Date(year, monthIndex + 1, 0);

      const date_from = toISODate(dateFromObj); // YYYY-MM-DD
      const date_to = toISODate(dateToObj); // YYYY-MM-DD

      const today = toISODate(now);
      const day_of_month = now.getDate();
      const days_in_month = dateToObj.getDate();

      // =========================
      // 2) Params (editables) - excepto fechas
      // =========================
      const months = clampInt(req.query.months, 12, 1, 36);
      const minOccurrences = clampInt(req.query.min_occurrences, 3, 2, 50);

      const includeOccasional =
        String(req.query.include_occasional ?? "false") === "true";
      const includeNoise = String(req.query.include_noise ?? "true") === "true";

      const minIntervalDays = clampInt(req.query.min_interval_days, 3, 1, 365);
      const maxIntervalDays = clampInt(
        req.query.max_interval_days,
        70,
        minIntervalDays,
        3650
      );

      const maxCoefVariation = Number.isFinite(
        Number(req.query.max_coef_variation)
      )
        ? Number(req.query.max_coef_variation)
        : 0.6;

      // =========================
      // 3) Ventana histórica (N meses atrás) TERMINA antes del mes actual
      //    Para evitar leakage, cortamos en el día anterior a date_from.
      // =========================
      const historyToObj = new Date(dateFromObj);
      historyToObj.setDate(historyToObj.getDate() - 1); // último día mes anterior

      const historyFromObj = new Date(dateFromObj);
      historyFromObj.setMonth(historyFromObj.getMonth() - months);

      const history_from = toISODate(historyFromObj);
      const history_to = toISODate(historyToObj);

      // =========================
      // 4) Traer transacciones históricas (expenses)
      // =========================
      const { data, error } = await supabase
        .from("transactions")
        .select(
          `
          id,
          amount,
          date,
          category_id,
          description,
          categories:categories!transactions_category_id_fkey (
            name,
            stability_type
          )
        `
        )
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", history_from)
        .lte("date", history_to);

      if (error) {
        console.error("Error supabase /advanced-burn-rate:", error);
        return res.status(500).json({ error: error.message });
      }

      const rawTxs = (data || [])
        .map((tx) => ({
          id: tx.id,
          date: tx.date,
          amount: Number(tx.amount) || 0,
          category_id: tx.category_id,
          category_name: tx.categories?.name || "Sin categoría",
          category_stability: tx.categories?.stability_type || "variable",
          description: tx.description || "",
        }))
        .filter((tx) => tx.amount > 0 && !!tx.date);

      // filtrar ocasionales si no se incluyen
      const txs = rawTxs.filter((tx) =>
        includeOccasional ? true : tx.category_stability !== "occasional"
      );

      // normalizar descripción
      const txsNorm = txs.map((tx) => ({
        ...tx,
        norm: normalizeText(tx.description),
      }));

      // =========================
      // 5) Clustering por categoría + similitud de descripción
      // =========================
      const byCategory = {};
      for (const tx of txsNorm) {
        const catKey = String(tx.category_id || "sin_cat");
        if (!byCategory[catKey]) byCategory[catKey] = [];
        byCategory[catKey].push(tx);
      }

      const SIM_THRESHOLD = 0.45;
      const clusters = []; // { category_id, category_name, rep_norm, rep_grams, entries: [] }

      for (const catKey of Object.keys(byCategory)) {
        const list = byCategory[catKey];
        const catClusters = [];

        for (const tx of list) {
          const grams = trigrams(tx.norm || "");
          let bestIdx = -1;
          let bestScore = 0;

          for (let i = 0; i < catClusters.length; i++) {
            const score = jaccard(grams, catClusters[i].rep_grams);
            if (score > bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }

          if (bestIdx >= 0 && bestScore >= SIM_THRESHOLD) {
            catClusters[bestIdx].entries.push(tx);
            // Mantener representante más "informativo"
            if (
              (tx.norm || "").length >
              (catClusters[bestIdx].rep_norm || "").length
            ) {
              catClusters[bestIdx].rep_norm = tx.norm;
              catClusters[bestIdx].rep_grams = grams;
            }
          } else {
            catClusters.push({
              category_id: tx.category_id,
              category_name: tx.category_name,
              rep_norm: tx.norm,
              rep_grams: grams,
              entries: [tx],
            });
          }
        }

        clusters.push(...catClusters);
      }

      // =========================
      // 6) Detectar patrones recurrentes
      // =========================
      const recurringPatterns = [];
      const recurringTxIds = new Set();

      for (const c of clusters) {
        const entries = c.entries;
        if (!entries || entries.length < minOccurrences) continue;

        entries.sort((a, b) => a.date.localeCompare(b.date));

        const intervals = [];
        for (let i = 1; i < entries.length; i++) {
          const d = diffInDays(entries[i - 1].date, entries[i].date);
          if (d > 0) intervals.push(d);
        }
        if (intervals.length < 2) continue;

        const medInterval = median(intervals);
        const mu = mean(intervals);
        const sd = stdDev(intervals);
        const coefVar = mu > 0 ? sd / mu : 999;

        if (medInterval < minIntervalDays || medInterval > maxIntervalDays)
          continue;
        if (coefVar > maxCoefVariation) continue;

        const amounts = entries
          .map((e) => e.amount)
          .filter((a) => Number.isFinite(a) && a > 0);

        const medAmount = median(amounts);
        if (!Number.isFinite(medAmount) || medAmount <= 0) continue;

        const last = entries[entries.length - 1];
        const lastDate = last.date;

        for (const e of entries) recurringTxIds.add(e.id);

        recurringPatterns.push({
          type: "recurring",
          category: c.category_name,
          pattern: `${c.category_name} · ${
            c.rep_norm || "sin descripcion"
          }`.trim(),
          median_interval_days: Number(medInterval.toFixed(1)),
          median_amount: Number(medAmount.toFixed(2)),
          last_date: lastDate,
        });
      }

      // =========================
      // 7) “Eventos / ruido” (no recurrentes) -> total mensual estimado
      // =========================
      let noisePatterns = [];
      if (includeNoise) {
        const historyDays = Math.max(
          1,
          diffInDays(history_from, history_to) + 1
        );
        const targetDays = Math.max(1, diffInDays(date_from, date_to) + 1);

        const noiseByCat = {};
        for (const tx of txsNorm) {
          if (recurringTxIds.has(tx.id)) continue;

          const catKey = String(tx.category_id || "sin_cat");
          if (!noiseByCat[catKey]) {
            noiseByCat[catKey] = {
              category_id: tx.category_id,
              category_name: tx.category_name,
              amounts: [],
              total: 0,
              count: 0,
            };
          }
          noiseByCat[catKey].amounts.push(tx.amount);
          noiseByCat[catKey].total += tx.amount;
          noiseByCat[catKey].count += 1;
        }

        noisePatterns = Object.values(noiseByCat)
          .map((c) => {
            if (c.count < 3) return null;

            const medAmount = median(c.amounts);
            const meanPerDay = c.total / historyDays;
            const projectedA = meanPerDay * targetDays;

            const expectedCountRaw = (c.count / historyDays) * targetDays;
            const expectedCount =
              expectedCountRaw >= 0.75 ? Math.round(expectedCountRaw) : 0;

            const projectedB =
              expectedCount > 0 ? expectedCount * (Number(medAmount) || 0) : 0;

            const projection = Math.min(projectedB, projectedA);
            if (!Number.isFinite(projection) || projection <= 0) return null;

            return {
              type: "event",
              category: c.category_name,
              pattern: `${c.category_name} · gastos eventuales`,
              projection: Number(projection.toFixed(2)),
            };
          })
          .filter(Boolean);
      }

      // =========================
      // 8) Construir expectedDaily para el mes (YYYY-MM-DD)
      //    - Recurrentes: seguir secuencia histórica (NO reinicio día 1)
      //    - Eventos: distribución uniforme (suave)
      // =========================
      const expectedDaily = {};
      for (let day = 1; day <= days_in_month; day++) {
        const d = `${monthKey}-${String(day).padStart(2, "0")}`;
        expectedDaily[d] = 0;
      }

      // 8.1 Recurrentes -> continuar secuencia
      //     Primer evento dentro del mes = last_date + n*interval donde sea >= date_from
      for (const p of recurringPatterns) {
        const interval = Math.max(1, Math.round(p.median_interval_days || 0));
        const amount = Number(p.median_amount) || 0;
        if (!interval || amount <= 0 || !p.last_date) continue;

        const gap = diffInDays(p.last_date, date_from);

        // Si last_date está antes del mes: alineamos a la secuencia para que el primer "next" caiga dentro del mes.
        // Si last_date es >= date_from (raro aquí porque histórico se corta antes), empezamos en el siguiente.
        const n = gap > 0 ? Math.ceil(gap / interval) : 1;

        let next = addDays(p.last_date, n * interval);

        while (new Date(next) <= new Date(date_to)) {
          if (expectedDaily[next] != null) expectedDaily[next] += amount;
          next = addDays(next, interval);
        }
      }

      // 8.2 Eventos -> distribución uniforme diaria
      const totalNoise = (noisePatterns || []).reduce(
        (s, r) => s + (Number(r.projection) || 0),
        0
      );
      const noiseDaily = days_in_month > 0 ? totalNoise / days_in_month : 0;

      if (noiseDaily > 0) {
        for (let day = 1; day <= days_in_month; day++) {
          const d = `${monthKey}-${String(day).padStart(2, "0")}`;
          expectedDaily[d] += noiseDaily;
        }
      }

      // =========================
      // 9) Gastos reales del mes hasta HOY
      // =========================
      const { data: expenses, error: expenseError } = await supabase
        .from("transactions")
        .select("amount, date")
        .eq("user_id", user_id)
        .eq("type", "expense")
        .gte("date", date_from)
        .lte("date", today);

      if (expenseError) {
        console.error(expenseError);
        return res.status(500).json({ error: expenseError.message });
      }

      const actualDailyMap = {};
      (expenses || []).forEach((tx) => {
        const d = tx.date;
        const amt = Number(tx.amount) || 0;
        if (!actualDailyMap[d]) actualDailyMap[d] = 0;
        actualDailyMap[d] += amt;
      });

      // =========================
      // 10) Series acumuladas (expected vs actual)
      // =========================
      let cumulativeExpected = 0;
      let cumulativeActual = 0;

      const series = [];

      for (let day = 1; day <= days_in_month; day++) {
        const dateStr = `${monthKey}-${String(day).padStart(2, "0")}`;

        const exp = expectedDaily[dateStr] || 0;
        cumulativeExpected += exp;

        const act = actualDailyMap[dateStr] || 0;
        if (day <= day_of_month) cumulativeActual += act;

        series.push({
          day,
          date: dateStr,
          expected_daily: Number(exp.toFixed(2)),
          expected_cumulative: Number(cumulativeExpected.toFixed(2)),
          actual_cumulative: Number(cumulativeActual.toFixed(2)),
        });
      }

      const expected_total =
        series[days_in_month - 1]?.expected_cumulative || 0;
      const expected_to_date =
        series[day_of_month - 1]?.expected_cumulative || 0;
      const actual_to_date = series[day_of_month - 1]?.actual_cumulative || 0;

      const projected_end_of_month =
        day_of_month > 0 ? (actual_to_date / day_of_month) * days_in_month : 0;

      const variance_to_expected = actual_to_date - expected_to_date;
      const variance_to_expected_end = projected_end_of_month - expected_total;

      return res.json({
        success: true,
        data: {
          month: monthKey,
          today,
          days_in_month,
          day_of_month,

          expected_total: Number(expected_total.toFixed(2)),
          expected_to_date: Number(expected_to_date.toFixed(2)),
          actual_to_date: Number(actual_to_date.toFixed(2)),

          projected_end_of_month: Number(projected_end_of_month.toFixed(2)),
          variance_to_expected: Number(variance_to_expected.toFixed(2)),
          variance_to_expected_end: Number(variance_to_expected_end.toFixed(2)),

          params_used: {
            months,
            min_occurrences: minOccurrences,
            include_occasional: includeOccasional,
            include_noise: includeNoise,
            min_interval_days: minIntervalDays,
            max_interval_days: maxIntervalDays,
            max_coef_variation: maxCoefVariation,
          },

          meta: {
            date_from,
            date_to,
            history_from,
            history_to,
            recurring_patterns_count: recurringPatterns.length,
            noise_month_total: Number(totalNoise.toFixed(2)),
          },

          series,
        },
      });
    } catch (err) {
      console.error(
        "Error en /analytics/advanced-burn-rate-current-month:",
        err
      );
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

/**
 * GET /analytics/income-vs-expense-monthly?months=6
 * Devuelve ingresos vs gastos agregados por mes calendario
 */
router.get("/income-vs-expense-monthly", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const monthsParam = parseInt(req.query.months, 10);
  const months =
    Number.isNaN(monthsParam) || monthsParam <= 0 ? 6 : monthsParam;

  try {
    // 1) Mes inicial (YYYY-MM-01)
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const startDate = start.toISOString().split("T")[0];

    // 2) Traer transacciones
    const { data, error } = await supabase
      .from("transactions")
      .select("date, type, amount")
      .eq("user_id", user_id)
      .gte("date", startDate);

    if (error) {
      console.error("Error income-vs-expense-monthly:", error);
      return res.status(500).json({ error: error.message });
    }

    // 3) Inicializar meses vacíos
    const map = {};
    for (let i = 0; i < months; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}`;
      map[key] = {
        month: key,
        income: 0,
        expense: 0,
      };
    }

    // 4) Agregar montos
    (data || []).forEach((tx) => {
      if (!tx.date || !tx.amount) return;
      const monthKey = tx.date.slice(0, 7); // YYYY-MM (sin Date, sin TZ)
      if (!map[monthKey]) return;

      const amt = Number(tx.amount) || 0;
      if (tx.type === "income") map[monthKey].income += amt;
      if (tx.type === "expense") map[monthKey].expense += amt;
    });

    // 5) Resultado final
    const result = Object.values(map).map((m) => ({
      month: m.month,
      income: Number(m.income.toFixed(2)),
      expense: Number(m.expense.toFixed(2)),
    }));

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Error inesperado income-vs-expense-monthly:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ✅ Cobertura real (robusta): cubierto hasta el límite, exceso y sin presupuesto
router.get("/budget-coverage-robust", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  // Año opcional: ?year=2025
  const rawYear = parseInt(req.query.year, 10);
  const nowYear = new Date().getFullYear();
  const year =
    Number.isFinite(rawYear) && rawYear >= 2000 && rawYear <= nowYear + 1
      ? rawYear
      : nowYear;

  const { start, end } = getYearRange(year);

  try {
    // 1) Presupuestos del año (por mes/categoría)
    const { data: budgets, error: budgetErr } = await supabase
      .from("budgets")
      .select("month, category_id, limit_amount, categories(name, type)")
      .eq("user_id", user_id)
      .gte("month", `${year}-01`)
      .lte("month", `${year}-12`);

    if (budgetErr) {
      console.error(budgetErr);
      return res.status(500).json({ error: budgetErr.message });
    }

    // 2) Gastos del año (por fecha/categoría)
    const { data: expenses, error: expenseErr } = await supabase
      .from("transactions")
      .select("amount, date, category_id, categories(name)")
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", start)
      .lte("date", end);

    if (expenseErr) {
      console.error(expenseErr);
      return res.status(500).json({ error: expenseErr.message });
    }

    const monthKeyFromDate = (iso) =>
      typeof iso === "string" && iso.length >= 7 ? iso.slice(0, 7) : null;

    // catNameMap: id -> nombre
    const catNameMap = {};

    // budgetsByMonth[YYYY-MM][catId] = total presupuesto
    const budgetsByMonth = {};
    (budgets || []).forEach((b) => {
      if (!b?.category_id) return;
      // Solo presupuesto de categorías expense (si aplica)
      if (b.categories?.type && b.categories.type !== "expense") return;

      const m = b.month; // YYYY-MM
      if (!m) return;

      if (!budgetsByMonth[m]) budgetsByMonth[m] = {};
      budgetsByMonth[m][b.category_id] =
        (budgetsByMonth[m][b.category_id] || 0) +
        (parseFloat(b.limit_amount) || 0);

      if (!catNameMap[b.category_id]) {
        catNameMap[b.category_id] = b.categories?.name || "Sin categoría";
      }
    });

    // expensesByMonth[YYYY-MM][catId] = total gasto
    const expensesByMonth = {};
    (expenses || []).forEach((tx) => {
      if (!tx?.category_id) return;
      const m = monthKeyFromDate(tx.date);
      if (!m) return;

      if (!expensesByMonth[m]) expensesByMonth[m] = {};
      expensesByMonth[m][tx.category_id] =
        (expensesByMonth[m][tx.category_id] || 0) +
        (parseFloat(tx.amount) || 0);

      if (!catNameMap[tx.category_id]) {
        catNameMap[tx.category_id] = tx.categories?.name || "Sin categoría";
      }
    });

    // Acumuladores anuales
    let totalExpenseYear = 0;
    let totalCoveredYear = 0;
    let totalOverBudgetYear = 0;
    let totalWithoutBudgetYear = 0;

    // Ranking anual
    const overByCategory = {}; // catId -> exceso anual
    const withoutByCategory = {}; // catId -> sin presupuesto anual

    // ✅ detalle por mes para modal
    const month_details = {};

    // ✅ meses del año garantizados
    const months = [];

    for (let i = 1; i <= 12; i++) {
      const m = `${year}-${String(i).padStart(2, "0")}`;

      const expCats = expensesByMonth[m] || {};
      const budCats = budgetsByMonth[m] || {};

      let monthTotalExpense = 0;
      let monthCovered = 0;
      let monthOver = 0;
      let monthWithout = 0;

      const allCatIds = new Set([
        ...Object.keys(expCats),
        ...Object.keys(budCats),
      ]);

      // ✅ detalle para modal
      const monthDetail = {
        month: m,
        totals: {
          expense_total: 0,
          covered: 0,
          over_budget: 0,
          without_budget: 0,
          uncovered_total: 0,
          coverage_pct: 0,
        },
        without_budget_categories: [],
        over_budget_categories: [],
        categories_summary: [], // por categoría (para top 15)
      };

      allCatIds.forEach((catId) => {
        const exp = Number(expCats[catId] || 0);
        const bud = Number(budCats[catId] || 0);

        if (exp <= 0 && bud <= 0) return;

        const name = catNameMap[catId] || "Sin categoría";

        // total gasto del mes solo suma el gasto
        monthTotalExpense += exp;

        if (bud > 0) {
          const covered = Math.min(exp, bud);
          const over = Math.max(exp - bud, 0);

          monthCovered += covered;
          monthOver += over;

          if (over > 0) {
            overByCategory[catId] = (overByCategory[catId] || 0) + over;

            monthDetail.over_budget_categories.push({
              category_id: catId,
              category_name: name,
              budgeted: Number(bud.toFixed(2)),
              spent: Number(exp.toFixed(2)),
              over_budget: Number(over.toFixed(2)),
            });
          }

          monthDetail.categories_summary.push({
            category_id: catId,
            category_name: name,
            budgeted: Number(bud.toFixed(2)),
            spent: Number(exp.toFixed(2)),
            diff: Number((exp - bud).toFixed(2)),
            covered: Number(covered.toFixed(2)),
            over_budget: Number(over.toFixed(2)),
            without_budget: 0,
          });
        } else {
          // sin presupuesto en ese mes
          if (exp > 0) {
            monthWithout += exp;

            withoutByCategory[catId] = (withoutByCategory[catId] || 0) + exp;

            monthDetail.without_budget_categories.push({
              category_id: catId,
              category_name: name,
              spent: Number(exp.toFixed(2)),
            });

            monthDetail.categories_summary.push({
              category_id: catId,
              category_name: name,
              budgeted: 0,
              spent: Number(exp.toFixed(2)),
              diff: Number(exp.toFixed(2)),
              covered: 0,
              over_budget: 0,
              without_budget: Number(exp.toFixed(2)),
            });
          }
        }
      });

      // Totales anuales
      totalExpenseYear += monthTotalExpense;
      totalCoveredYear += monthCovered;
      totalOverBudgetYear += monthOver;
      totalWithoutBudgetYear += monthWithout;

      const uncoveredTotalMonth = monthOver + monthWithout;
      const coveragePctMonth =
        monthTotalExpense > 0 ? (monthCovered / monthTotalExpense) * 100 : 0;

      // ✅ fila mensual para el chart
      months.push({
        month: m,
        expense_total: Number(monthTotalExpense.toFixed(2)),
        covered: Number(monthCovered.toFixed(2)),
        over_budget: Number(monthOver.toFixed(2)),
        without_budget: Number(monthWithout.toFixed(2)),
        uncovered_total: Number(uncoveredTotalMonth.toFixed(2)),
        coverage_pct: Number(coveragePctMonth.toFixed(2)),
      });

      // ✅ ordenar detalle para modal
      monthDetail.without_budget_categories.sort((a, b) => b.spent - a.spent);
      monthDetail.over_budget_categories.sort(
        (a, b) => b.over_budget - a.over_budget
      );
      monthDetail.categories_summary.sort((a, b) => b.spent - a.spent);

      // ✅ totales del mes (desde el detalle)
      const expSum = monthDetail.categories_summary.reduce(
        (s, r) => s + (Number(r.spent) || 0),
        0
      );
      const coveredSum = monthDetail.categories_summary.reduce(
        (s, r) => s + (Number(r.covered) || 0),
        0
      );
      const overSum = monthDetail.categories_summary.reduce(
        (s, r) => s + (Number(r.over_budget) || 0),
        0
      );
      const withoutSum = monthDetail.categories_summary.reduce(
        (s, r) => s + (Number(r.without_budget) || 0),
        0
      );

      monthDetail.totals.expense_total = Number(expSum.toFixed(2));
      monthDetail.totals.covered = Number(coveredSum.toFixed(2));
      monthDetail.totals.over_budget = Number(overSum.toFixed(2));
      monthDetail.totals.without_budget = Number(withoutSum.toFixed(2));
      monthDetail.totals.uncovered_total = Number(
        (overSum + withoutSum).toFixed(2)
      );
      monthDetail.totals.coverage_pct =
        expSum > 0 ? Number(((coveredSum / expSum) * 100).toFixed(2)) : 0;

      month_details[m] = monthDetail;
    }

    // ✅ Top categorías anual
    const topOver = Object.entries(overByCategory)
      .map(([category_id, amount]) => ({
        category_id,
        category_name: catNameMap[category_id] || "Sin categoría",
        total_over_budget: Number(Number(amount).toFixed(2)),
      }))
      .sort((a, b) => b.total_over_budget - a.total_over_budget)
      .slice(0, 5);

    const topWithout = Object.entries(withoutByCategory)
      .map(([category_id, amount]) => ({
        category_id,
        category_name: catNameMap[category_id] || "Sin categoría",
        total_without_budget: Number(Number(amount).toFixed(2)),
      }))
      .sort((a, b) => b.total_without_budget - a.total_without_budget)
      .slice(0, 5);

    // ✅ meses con más no-cubierto (exceso + sin presupuesto)
    const topUncoveredMonths = [...months]
      .sort((a, b) => b.uncovered_total - a.uncovered_total)
      .slice(0, 5)
      .map((m) => ({ month: m.month, uncovered_total: m.uncovered_total }));

    const coveragePctYear =
      totalExpenseYear > 0 ? (totalCoveredYear / totalExpenseYear) * 100 : 0;

    return res.json({
      success: true,
      data: {
        year,
        totals: {
          expense_total: Number(totalExpenseYear.toFixed(2)),
          covered: Number(totalCoveredYear.toFixed(2)),
          over_budget: Number(totalOverBudgetYear.toFixed(2)),
          without_budget: Number(totalWithoutBudgetYear.toFixed(2)),
          uncovered_total: Number(
            (totalOverBudgetYear + totalWithoutBudgetYear).toFixed(2)
          ),
          coverage_pct: Number(coveragePctYear.toFixed(2)),
        },
        months, // para el chart
        month_details, // ✅ para el modal por mes
        top_categories_over_budget: topOver,
        top_categories_without_budget: topWithout,
        top_uncovered_months: topUncoveredMonths,
      },
    });
  } catch (err) {
    console.error("Error en /analytics/budget-coverage-robust:", err);
    return res
      .status(500)
      .json({ error: "Error interno calculando cobertura robusta" });
  }
});



module.exports = router;
