const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);

const advancedFormat = require("dayjs/plugin/advancedFormat");
dayjs.extend(advancedFormat);

function startOfCurrentMonth() {
  return dayjs().startOf("month");
}

function endOfCurrentMonth() {
  return dayjs().endOf("month");
}

function endOfCurrentYear() {
  return dayjs().endOf("year");
}

function addByRecurrence(d, recurrence) {
  switch (recurrence) {
    case "daily":
      return d.add(1, "day");
    case "weekly":
      return d.add(1, "week");
    case "biweekly":
      return d.add(2, "week");
    case "monthly":
      return d.add(1, "month");
    default:
      return d.add(1, "day"); // fallback
  }
}

/**
 * Expande una regla a fechas concretas dentro de [from..to] (ambos inclusive).
 * Respeta type, exclude_weekends, recurrence.
 * Solo devuelve instancias de "expense"; sin categoría → se ignora.
 */
function expandRuleToRange(rule, from, to) {
  const out = [];
  if (rule.type !== "expense") return out;
  if (!rule.category_id) return out;

  // rango efectivo
  let current = dayjs(rule.start_date);
  const end = rule.end_date ? dayjs(rule.end_date) : to;

  // recortar al rango solicitado
  if (current.isBefore(from)) current = from;
  const hardEnd = end.isAfter(to) ? to : end;

  // si la regla no tiene recurrence (puntual), se toma una sola vez si cae en el rango
  if (!rule.recurrence) {
    // Si hay un rango real (start..end), trátalo como diario
    if (
      rule.start_date &&
      rule.end_date &&
      dayjs(rule.start_date).isBefore(dayjs(rule.end_date))
    ) {
      let cursor = current;
      while (cursor.isSameOrBefore(hardEnd)) {
        if (rule.exclude_weekends) {
          const d = cursor.day();
          if (d === 0 || d === 6) {
            cursor = cursor.add(1, "day");
            continue;
          }
        }
        out.push({
          date: cursor.format("YYYY-MM-DD"),
          amount: Number(rule.amount || 0),
          category_id: rule.category_id,
          category_name: rule.categories?.name || null,
        });
        cursor = cursor.add(1, "day");
      }
      return out;
    }

    // Si no hay rango (evento puntual), una sola instancia si cae en el rango
    if (current.isSameOrBefore(hardEnd)) {
      if (rule.exclude_weekends) {
        const day = current.day();
        if (day === 0 || day === 6) return out;
      }
      out.push({
        date: current.format("YYYY-MM-DD"),
        amount: Number(rule.amount || 0),
        category_id: rule.category_id,
        category_name: rule.categories?.name || null,
      });
    }
    return out;
  }

  // recurrente
  let cursor = current;
  while (cursor.isSameOrBefore(hardEnd)) {
    if (rule.exclude_weekends) {
      const day = cursor.day();
      if (day === 0 || day === 6) {
        cursor = cursor.add(1, "day");
        continue;
      }
    }
    out.push({
      date: cursor.format("YYYY-MM-DD"),
      amount: Number(rule.amount || 0),
      category_id: rule.category_id,
      category_name: rule.categories?.name || null,
    });
    cursor = addByRecurrence(cursor, rule.recurrence);
  }

  return out;
}

/**
 * Agrupa instancias por {month: "YYYY-MM", category_id} sumando amount.
 */
function rollupByMonthAndCategory(instances) {
  const map = new Map();
  for (const it of instances) {
    const month = dayjs(it.date).format("YYYY-MM");
    const key = `${month}::${it.category_id}`;
    const prev = map.get(key) || {
      month,
      category_id: it.category_id,
      category_name: it.category_name,
      amount: 0,
    };
    prev.amount += Number(it.amount || 0);
    map.set(key, prev);
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      (a.category_name || "").localeCompare(b.category_name || "")
  );
}

/**
 * 📌 Crear un nuevo escenario con reglas
 */
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, description, transactions = [] } = req.body;

  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .insert([{ user_id, name, description }])
    .select()
    .single();

  if (scenarioError) {
    console.error("❌ Error al crear escenario:", scenarioError);
    return res.status(500).json({ error: scenarioError.message });
  }

  if (Array.isArray(transactions) && transactions.length > 0) {
    const scenarioTxs = transactions.map((tx) => ({
      ...tx,
      scenario_id: scenario.id,
    }));

    const { error: txError } = await supabase
      .from("scenario_transactions")
      .insert(scenarioTxs);

    if (txError) {
      console.error("❌ Error al insertar transacciones simuladas:", txError);
      return res
        .status(500)
        .json({ error: "Error al guardar transacciones del escenario" });
    }
  }

  res.json({ success: true, data: scenario });
});

/**
 * 📌 Obtener todos los escenarios del usuario
 */
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("scenarios")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("❌ Error al obtener escenarios:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

/**
 * 📌 Obtener reglas de transacción de un escenario específico
 */
router.get("/:id/rules", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;

  // Verificar propiedad
  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("id")
    .eq("id", scenario_id)
    .eq("user_id", user_id)
    .single();

  if (scenarioError || !scenario) {
    return res.status(404).json({ error: "Escenario no encontrado" });
  }

  const { data: rules, error } = await supabase
    .from("scenario_transactions")
    .select("*")
    .eq("scenario_id", scenario_id);

  if (error) {
    console.error("❌ Error al obtener reglas:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data: rules });
});

router.get("/:id/projection", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;

  // Rango de la vista del calendario
  // FullCalendar envía end EXCLUSIVO → restamos 1 día para manejarlo como inclusivo
  const qStart = req.query.start ? dayjs(req.query.start) : null;
  const qEndRaw = req.query.end ? dayjs(req.query.end) : null;
  const rangeStart = qStart || dayjs().startOf("month");
  const rangeEnd = qEndRaw ? qEndRaw.subtract(1, "day") : dayjs().endOf("month");

  // validar escenario
  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("*")
    .eq("id", scenario_id)
    .eq("user_id", user_id)
    .single();

  if (scenarioError || !scenario) {
    return res.status(404).json({ error: "Escenario no encontrado" });
  }

  // Reglas + nombres
  const { data: rules, error: txError } = await supabase
    .from("scenario_transactions")
    .select("*, categories:category_id(name), accounts:account_id(name)")
    .eq("scenario_id", scenario_id);

  if (txError) {
    console.error("❌ Error al obtener reglas:", txError);
    return res.status(500).json({ error: txError.message });
  }

  const projected = [];
  const isWeekend = (d) => d.day() === 0 || d.day() === 6;

  for (const rule of rules) {
    let start = dayjs(rule.start_date);
    const endRule = rule.end_date ? dayjs(rule.end_date) : rangeEnd;

    // recortar al rango visible
    if (start.isBefore(rangeStart)) start = rangeStart;
    const hardEnd = endRule.isAfter(rangeEnd) ? rangeEnd : endRule;
    if (start.isAfter(hardEnd)) continue;

    const pushInstance = (d) => {
      projected.push({
        id: rule.id,
        instance_id: `${rule.id}-${d.format("YYYYMMDD")}`,
        name: rule.name,
        amount: rule.amount,
        type: rule.type, // ✅ ingresos y gastos para calendario
        date: d.format("YYYY-MM-DD"),
        description: rule.description,
        category_id: rule.category_id,
        account_id: rule.account_id,
        scenario_id: rule.scenario_id,
        isProjected: true,
        category_name: rule.categories?.name || null,
        account_name: rule.accounts?.name || null,
      });
    };

    // Sin recurrence:
    // - si hay rango (start..end) → tratar como diario
    // - si es puntual → 1 sola instancia si cae en el rango
    if (!rule.recurrence) {
      if (rule.start_date && rule.end_date && dayjs(rule.start_date).isBefore(dayjs(rule.end_date))) {
        let c = start;
        while (c.isSameOrBefore(hardEnd)) {
          if (!rule.exclude_weekends || !isWeekend(c)) pushInstance(c);
          c = c.add(1, "day");
        }
      } else {
        if (!rule.exclude_weekends || !isWeekend(start)) pushInstance(start);
      }
      continue;
    }

    // Con recurrence
    let c = start;
    while (c.isSameOrBefore(hardEnd)) {
      if (!rule.exclude_weekends || !isWeekend(c)) pushInstance(c);
      switch (rule.recurrence) {
        case "daily": c = c.add(1, "day"); break;
        case "weekly": c = c.add(1, "week"); break;
        case "biweekly": c = c.add(2, "week"); break;
        case "monthly": c = c.add(1, "month"); break;
        default: c = c.add(1, "day");
      }
    }
  }

  res.json({ success: true, data: projected });
});


router.post("/scenario_transactions", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const {
    scenario_id,
    name,
    amount,
    type,
    start_date,
    end_date,
    recurrence,
    description,
    category_id = null,
    account_id = null,
    exclude_weekends = false,
  } = req.body;

  const { error } = await supabase.from("scenario_transactions").insert([
    {
      scenario_id,
      name,
      amount,
      type,
      start_date,
      end_date,
      recurrence,
      description,
      category_id,
      account_id,
      exclude_weekends,
    },
  ]);

  if (error) {
    console.error("❌ Error al crear transacción:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

router.get("/scenario_transactions/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { data: tx, error } = await supabase
    .from("scenario_transactions")
    .select("*, scenarios!inner(user_id)")
    .eq("id", id)
    .single();

  if (error) {
    console.error("❌ Error al obtener transacción simulada:", error);
    return res.status(500).json({ error: "Error al obtener transacción" });
  }

  if (!tx || tx.scenarios.user_id !== user_id) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  // Limpieza: no devolver info del escenario
  delete tx.scenarios;

  res.json({ success: true, data: tx });
});

router.put("/scenario_transactions/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  // Verificar propiedad primero
  const { data: tx, error: fetchError } = await supabase
    .from("scenario_transactions")
    .select("*, scenarios!inner(user_id)")
    .eq("id", id)
    .single();

  if (fetchError || !tx || tx.scenarios.user_id !== user_id) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  const {
    name,
    amount,
    type,
    start_date,
    end_date,
    recurrence,
    exclude_weekends,
    category_id,
    account_id,
  } = req.body;

  const { error: updateError } = await supabase
    .from("scenario_transactions")
    .update({
      name,
      amount,
      type,
      start_date,
      end_date,
      recurrence,
      exclude_weekends,
      category_id,
      account_id,
    })
    .eq("id", id);

  if (updateError) {
    console.error("❌ Error al actualizar transacción:", updateError);
    return res.status(500).json({ error: "Error al actualizar transacción" });
  }

  res.json({ success: true });
});

router.delete("/scenario_transactions/:id",
  authenticateUser,
  async (req, res) => {
    const user_id = req.user.id;
    const { id } = req.params;

    const { data: tx, error: fetchError } = await supabase
      .from("scenario_transactions")
      .select("*, scenarios!inner(user_id)")
      .eq("id", id)
      .single();

    if (fetchError || !tx || tx.scenarios.user_id !== user_id) {
      return res.status(403).json({ error: "Acceso denegado" });
    }

    const { error: deleteError } = await supabase
      .from("scenario_transactions")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("❌ Error al eliminar transacción:", deleteError);
      return res.status(500).json({ error: "Error al eliminar transacción" });
    }

    res.json({ success: true, message: "Transacción eliminada" });
  }
);

/**
 * ✏️ Actualizar un escenario (nombre/descripcion)
 */
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { name, description } = req.body;

  // 1) Verificar que el escenario es del usuario
  const { data: scenario, error: fetchError } = await supabase
    .from("scenarios")
    .select("id, user_id")
    .eq("id", id)
    .single();

  if (fetchError || !scenario || scenario.user_id !== user_id) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  // 2) Actualizar
  const { data, error: updateError } = await supabase
    .from("scenarios")
    .update({ name, description })
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    console.error("❌ Error al actualizar escenario:", updateError);
    return res.status(500).json({ error: "Error al actualizar escenario" });
  }

  res.json({ success: true, data });
});

/**
 * 🗑️ Eliminar un escenario
 * Nota: si no tienes ON DELETE CASCADE, borra primero las reglas asociadas.
 */
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  // 1) Verificar propiedad
  const { data: scenario, error: fetchError } = await supabase
    .from("scenarios")
    .select("id, user_id")
    .eq("id", id)
    .single();

  if (fetchError || !scenario || scenario.user_id !== user_id) {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  const { error: delBudgetsError } = await supabase
    .from("budgets")
    .delete()
    .eq("user_id", user_id)
    .eq("source_scenario_id", id);

  if (delBudgetsError) {
    console.error(
      "❌ Error al eliminar budgets importados del escenario:",
      delBudgetsError
    );
    return res
      .status(500)
      .json({ error: "No se pudieron eliminar presupuestos importados" });
  }

  // 2) Borrar dependencias si NO tienes ON DELETE CASCADE
  const { error: delRulesError } = await supabase
    .from("scenario_transactions")
    .delete()
    .eq("scenario_id", id);

  if (delRulesError) {
    console.error("❌ Error al eliminar reglas del escenario:", delRulesError);
    return res.status(500).json({
      error: "No se pudieron eliminar las transacciones del escenario",
    });
  }

  // 3) Borrar el escenario
  const { error: delScenarioError } = await supabase
    .from("scenarios")
    .delete()
    .eq("id", id);

  if (delScenarioError) {
    console.error("❌ Error al eliminar escenario:", delScenarioError);
    return res.status(500).json({ error: "Error al eliminar escenario" });
  }

  res.json({ success: true, message: "Escenario eliminado" });
});

/**
 * 🔎 Preview de importación a budgets (no escribe en DB)
 * scope = "current" | "all"
 *  - current: mes actual (1..fin de mes actual)
 *  - all: desde hoy hasta 31-dic del año actual
 * Reglas:
 *  - Solo gastos (expense)
 *  - Ignora sin categoría
 *  - No incluye meses anteriores al actual
 */
router.get("/:id/budget-import-preview", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;
  const scope = (req.query.scope || "current").toLowerCase();

  // validar escenario
  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("id, user_id")
    .eq("id", scenario_id)
    .eq("user_id", user_id)
    .single();

  if (scenarioError || !scenario) {
    return res.status(404).json({ error: "Escenario no encontrado" });
  }

  // traer reglas con nombres de categoría
  const { data: rules, error: txError } = await supabase
    .from("scenario_transactions")
    .select("*, categories:category_id(name)")
    .eq("scenario_id", scenario_id);

  if (txError) {
    console.error("❌ Error al obtener reglas:", txError);
    return res.status(500).json({ error: txError.message });
  }

  const from = startOfCurrentMonth();
  const to = scope === "all" ? endOfCurrentYear() : endOfCurrentMonth();

  // expandir todas las reglas dentro del rango
  const instances = [];
  for (const rule of rules || []) {
    instances.push(...expandRuleToRange(rule, from, to));
  }

  // agrupar por YYYY-MM + categoría
  const rollup = rollupByMonthAndCategory(instances);

  // si no hay nada, devolvemos vacío
  if (rollup.length === 0) {
    return res.json({
      success: true,
      data: {
        scope,
        from: from.format("YYYY-MM-DD"),
        to: to.format("YYYY-MM-DD"),
        items: [],
        conflicts: [],
      },
    });
  }

  // buscar budgets existentes que colisionen
  const months = Array.from(new Set(rollup.map((r) => r.month)));
  const categoryIds = Array.from(new Set(rollup.map((r) => r.category_id)));

  const { data: existing, error: existingErr } = await supabase
    .from("budgets")
    .select("id, month, category_id, limit_amount")
    .eq("user_id", user_id)
    .in("month", months)
    .in("category_id", categoryIds);

  if (existingErr) {
    console.error("❌ Error al leer budgets existentes:", existingErr);
    return res
      .status(500)
      .json({ error: "No se pudieron leer presupuestos existentes" });
  }

  // mapear conflictos
  const existingMap = new Map(
    existing.map((b) => [`${b.month}::${b.category_id}`, b])
  );
  const conflicts = [];
  for (const r of rollup) {
    const key = `${r.month}::${r.category_id}`;
    if (existingMap.has(key)) {
      const e = existingMap.get(key);
      conflicts.push({
        budget_id: e.id,
        month: r.month,
        category_id: r.category_id,
        category_name: r.category_name,
        current_amount: Number(e.limit_amount || 0),
        new_amount: Number(r.amount || 0),
      });
    }
  }

  res.json({
    success: true,
    data: {
      scope,
      from: from.format("YYYY-MM-DD"),
      to: to.format("YYYY-MM-DD"),
      items: rollup, // [{month, category_id, category_name, amount}]
      conflicts, // [{budget_id, month, category_id, category_name, current_amount, new_amount}]
    },
  });
});

/**
 * ⬇️ Importar a budgets desde un escenario
 * Body: { scope: "current"|"all", selected_keys: string[] }
 *  - selected_keys: array de claves "YYYY-MM::category_id"
 *    Todo lo que esté en selected_keys se inserta/actualiza.
 *    Todo lo demás se cuenta como "skipped".
 */
router.post("/:id/import-to-budgets", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;
  const scope = (req.body.scope || "current").toLowerCase();
  const selectedKeys = Array.isArray(req.body.selected_keys)
    ? req.body.selected_keys
    : [];

  // validar escenario
  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("id, user_id")
    .eq("id", scenario_id)
    .eq("user_id", user_id)
    .single();

  if (scenarioError || !scenario) {
    return res.status(404).json({ error: "Escenario no encontrado" });
  }

  // traer reglas con nombres de categoría
  const { data: rules, error: txError } = await supabase
    .from("scenario_transactions")
    .select("*, categories:category_id(name)")
    .eq("scenario_id", scenario_id);

  if (txError) {
    console.error("❌ Error al obtener reglas:", txError);
    return res.status(500).json({ error: txError.message });
  }

  const from = startOfCurrentMonth();
  const to = scope === "all" ? endOfCurrentYear() : endOfCurrentMonth();

  // expandir→agrupar
  const instances = [];
  for (const rule of rules || []) {
    instances.push(...expandRuleToRange(rule, from, to));
  }
  const rollup = rollupByMonthAndCategory(instances);
  const totalCandidates = rollup.length;

  if (totalCandidates === 0) {
    return res.json({
      success: true,
      data: { inserted: 0, updated: 0, skipped: 0, total: 0, selected: 0 },
    });
  }

  // set de claves seleccionadas (YYYY-MM::category_id)
  const selectedSet = new Set(selectedKeys);

  // buscar budgets existentes solo para las combinaciones detectadas
  const months = Array.from(new Set(rollup.map((r) => r.month)));
  const categoryIds = Array.from(new Set(rollup.map((r) => r.category_id)));

  const { data: existing, error: existingErr } = await supabase
    .from("budgets")
    .select("id, month, category_id, limit_amount")
    .eq("user_id", user_id)
    .in("month", months)
    .in("category_id", categoryIds);

  if (existingErr) {
    console.error("❌ Error al leer budgets existentes:", existingErr);
    return res
      .status(500)
      .json({ error: "No se pudieron leer presupuestos existentes" });
  }

  const existingMap = new Map(
    existing.map((b) => [`${b.month}::${b.category_id}`, b])
  );

  const toInsert = [];
  const toUpdate = [];

  let selectedCount = 0;
  let skipped = 0;

  for (const r of rollup) {
    const key = `${r.month}::${r.category_id}`;

    // si no está marcado → se omite
    if (!selectedSet.has(key)) {
      skipped++;
      continue;
    }

    selectedCount++;

    const exists = existingMap.get(key);
    if (!exists) {
      // nuevo presupuesto
      toInsert.push({
        user_id,
        month: r.month,
        category_id: r.category_id,
        limit_amount: r.amount,
        source_scenario_id: scenario_id,
      });
    } else {
      // reemplazar presupuesto existente
      toUpdate.push({
        id: exists.id,
        limit_amount: r.amount,
      });
    }
  }

  let inserted = 0;
  let updated = 0;

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from("budgets").insert(toInsert);
    if (insErr) {
      console.error("❌ Error al insertar budgets:", insErr);
      return res.status(500).json({ error: "Error al insertar presupuestos" });
    }
    inserted = toInsert.length;
  }

  if (toUpdate.length > 0) {
    const invalid = toUpdate.filter(
      (u) => !u.id || typeof u.limit_amount === "undefined"
    );
    if (invalid.length) {
      console.error("Updates inválidos:", invalid);
      return res.status(500).json({
        error: "Update inválido: faltan campos obligatorios en algunos budgets",
      });
    }

    try {
      const results = await Promise.all(
        toUpdate.map((u) =>
          supabase
            .from("budgets")
            .update({
              limit_amount: u.limit_amount,
              source_scenario_id: scenario_id,
            })
            .eq("id", u.id)
        )
      );
      for (const r of results) {
        if (r.error) throw r.error;
      }
      updated = toUpdate.length;
    } catch (e) {
      console.error("❌ Error al actualizar budgets:", e);
      return res.status(500).json({
        error: e.message || "Error al actualizar presupuestos existentes",
      });
    }
  }

  // skipped ya cuenta lo no seleccionado
  res.json({
    success: true,
    data: {
      inserted,
      updated,
      skipped,
      total: totalCandidates,
      selected: selectedCount,
    },
  });
});

// =========================
// ADVANCED FORECAST -> SCENARIO
// Preview + Register
// =========================

router.get("/:id/advanced-forecast/preview", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;

  try {
    // 1) Validar escenario
    const { data: scenario, error: scenErr } = await supabase
      .from("scenarios")
      .select("id,user_id")
      .eq("id", scenario_id)
      .eq("user_id", user_id)
      .single();

    if (scenErr || !scenario) {
      return res.status(404).json({ error: "Escenario no encontrado" });
    }

    // 2) Rango calendario (end exclusivo)
    const start = req.query.start;
    const endExcl = req.query.end;
    if (!start || !endExcl) {
      return res.status(400).json({ error: "start y end son requeridos" });
    }
    const rangeStart = start;
    const rangeEnd = toISODate(addDaysObj(endExcl, -1)); // inclusive

    // 3) Params (sin fechas)
    const months = clampInt(req.query.months, 12, 1, 36);
    const minOccurrences = clampInt(req.query.min_occurrences, 3, 2, 50);

    const includeOccasional =
      String(req.query.include_occasional ?? "false") === "true";
    const includeNoise = String(req.query.include_noise ?? "true") === "true";

    const minIntervalDays = clampInt(req.query.min_interval_days, 3, 1, 365);
    const maxIntervalDays = clampInt(req.query.max_interval_days, 70, minIntervalDays, 3650);

    const maxCoefVariation = Number.isFinite(Number(req.query.max_coef_variation))
      ? Number(req.query.max_coef_variation)
      : 0.6;

    const account_id = req.query.account_id || null;

    // 4) Histórico: termina el día antes del rango (sin leakage dentro del rango)
    const historyTo = toISODate(addDaysObj(rangeStart, -1));
    const historyFromObj = new Date(rangeStart);
    historyFromObj.setMonth(historyFromObj.getMonth() - months);
    const historyFrom = toISODate(historyFromObj);

    // 5) Leer histórico (expenses)
    const { data: txData, error: txErr } = await supabase
      .from("transactions")
      .select(`
        id, amount, date, category_id, description,
        categories:categories!transactions_category_id_fkey ( name, stability_type )
      `)
      .eq("user_id", user_id)
      .eq("type", "expense")
      .gte("date", historyFrom)
      .lte("date", historyTo);

    if (txErr) return res.status(500).json({ error: txErr.message });

    const rows = (txData || [])
      .map((tx) => ({
        id: tx.id,
        date: tx.date,
        amount: Number(tx.amount) || 0,
        category_id: tx.category_id,
        category_name: tx.categories?.name || "Sin categoría",
        category_stability: tx.categories?.stability_type || "variable",
        description: tx.description || "",
        norm: normalizeText(tx.description || ""),
      }))
      .filter((r) => r.amount > 0 && !!r.category_id);

    const filtered = rows.filter((r) =>
      includeOccasional ? true : r.category_stability !== "occasional"
    );

    // 6) Construir patrones recurrentes por (category + similitud descripción)
    const { recurringPatterns, noiseByCategory } = buildAdvancedPatterns({
      rows: filtered,
      minOccurrences,
      minIntervalDays,
      maxIntervalDays,
      maxCoefVariation,
      includeNoise,
      history_from: historyFrom,
      history_to: historyTo,
      range_from: rangeStart,
      range_to: rangeEnd,
    });

    // 7) Expandir a instancias dentro del rango (por categoría/patrón)
    const projected = [];

    // 7.1 Recurrentes: continuar secuencia (NO reinicia por calendario)
    for (const p of recurringPatterns) {
      const interval = Math.max(1, Math.round(p.median_interval_days || 0));
      const amount = Number(p.median_amount) || 0;
      if (!interval || amount <= 0 || !p.last_date) continue;

      const gap = diffInDays(p.last_date, rangeStart);
      const n = gap > 0 ? Math.ceil(gap / interval) : 1;
      let next = addDays(p.last_date, n * interval);

      while (new Date(next) <= new Date(rangeEnd)) {
        projected.push({
          instance_key: `adv::${scenario_id}::${p.pattern_key}::${next}`,
          name: p.display_name,
          amount: Number(amount.toFixed(2)),
          type: "expense",
          date: next,
          category_id: p.category_id,
          category_name: p.category_name,
          account_id,
          isProjected: true,
          source: "advanced_forecast",
        });

        next = addDays(next, interval);
      }
    }

    // 7.2 Eventuales (noise) por categoría:
    // Para escenarios/presupuesto es mejor NO “untar por día”,
    // sino crear N eventos discretos. Aquí lo hacemos simple:
    // expected_count ≈ (rangeDays/historyDays) * count, con monto mediano.
    if (includeNoise) {
      for (const n of noiseByCategory) {
        const count = n.expected_count || 0;
        const amt = Number(n.median_amount) || 0;
        if (count <= 0 || amt <= 0) continue;

        const dates = spreadDates(rangeStart, rangeEnd, count);
        dates.forEach((d, idx) => {
          projected.push({
            instance_key: `adv::${scenario_id}::noise::${n.category_id}::${d}::${idx}`,
            name: `${n.category_name} (eventual)`,
            amount: Number(amt.toFixed(2)),
            type: "expense",
            date: d,
            category_id: n.category_id,
            category_name: n.category_name,
            account_id,
            isProjected: true,
            source: "advanced_forecast",
          });
        });
      }
    }

    return res.json({
      success: true,
      data: projected,
      meta: {
        range_from: rangeStart,
        range_to: rangeEnd,
        history_from: historyFrom,
        history_to: historyTo,
        recurring_patterns_count: recurringPatterns.length,
        noise_categories_count: noiseByCategory.length,
      },
    });
  } catch (err) {
    console.error("Error preview advanced-forecast:", err);
    return res.status(500).json({ error: "Error interno generando preview" });
  }
});

router.post("/:id/advanced-forecast/register", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const scenario_id = req.params.id;

  try {
    // 1) Validar escenario
    const { data: scenario, error: scenErr } = await supabase
      .from("scenarios")
      .select("id,user_id")
      .eq("id", scenario_id)
      .eq("user_id", user_id)
      .single();

    if (scenErr || !scenario) {
      return res.status(404).json({ error: "Escenario no encontrado" });
    }

    const { start, end, params = {}, account_id = null, mode = "replace" } = req.body || {};
    if (!start || !end) {
      return res.status(400).json({ error: "start y end son requeridos" });
    }

    // end viene inclusivo aquí (tu decides en frontend)
    const rangeStart = start;
    const rangeEnd = end;

    // 2) Si mode=replace: borrar registros anteriores del forecast avanzado en ese rango
    if (mode === "replace") {
      const { error: delErr } = await supabase
        .from("scenario_transactions")
        .delete()
        .eq("scenario_id", scenario_id)
        .gte("start_date", rangeStart)
        .lte("start_date", rangeEnd)
        .ilike("description", "%[ADV_FORECAST]%");

      if (delErr) {
        console.error("Delete previous ADV_FORECAST failed:", delErr);
        return res.status(500).json({ error: delErr.message });
      }
    }

    // 3) Llamar internamente el preview para obtener instancias
    // (aquí lo hacemos llamando a una función común; evita hacer HTTP interno)
    const preview = await computeAdvancedForecastInstances({
      supabase,
      user_id,
      scenario_id,
      rangeStart,
      rangeEnd,
      account_id,
      params,
    });

    const instances = preview.instances || [];
    if (instances.length === 0) {
      return res.json({ success: true, inserted: 0, data: [], meta: preview.meta });
    }

    // 4) Insertar como scenario_transactions puntuales
    const rowsToInsert = instances.map((ev) => ({
      scenario_id,
      name: ev.name,
      amount: ev.amount,
      type: "expense",
      start_date: ev.date,
      end_date: null,
      recurrence: null,
      exclude_weekends: false,
      category_id: ev.category_id,
      account_id: ev.account_id,
      description: `[ADV_FORECAST] ${preview.meta.history_from}→${preview.meta.history_to}`,
    }));

    const { data: inserted, error: insErr } = await supabase
      .from("scenario_transactions")
      .insert(rowsToInsert)
      .select("id, name, amount, type, start_date, category_id, account_id");

    if (insErr) {
      console.error("Insert scenario_transactions failed:", insErr);
      return res.status(500).json({ error: insErr.message });
    }

    return res.json({
      success: true,
      inserted: inserted?.length || 0,
      data: inserted || [],
      meta: preview.meta,
    });
  } catch (err) {
    console.error("Error register advanced-forecast:", err);
    return res.status(500).json({ error: "Error interno registrando forecast" });
  }
});

/* =========================
   Common compute function
   (mismo motor que preview)
========================= */

async function computeAdvancedForecastInstances({
  supabase,
  user_id,
  scenario_id,
  rangeStart,
  rangeEnd,
  account_id,
  params,
}) {
  const months = clampInt(params.months, 12, 1, 36);
  const minOccurrences = clampInt(params.min_occurrences, 3, 2, 50);

  const includeOccasional = Boolean(params.include_occasional);
  const includeNoise = params.include_noise !== false; // default true

  const minIntervalDays = clampInt(params.min_interval_days, 3, 1, 365);
  const maxIntervalDays = clampInt(params.max_interval_days, 70, minIntervalDays, 3650);

  const maxCoefVariation = Number.isFinite(Number(params.max_coef_variation))
    ? Number(params.max_coef_variation)
    : 0.6;

  const historyTo = toISODate(addDaysObj(rangeStart, -1));
  const historyFromObj = new Date(rangeStart);
  historyFromObj.setMonth(historyFromObj.getMonth() - months);
  const historyFrom = toISODate(historyFromObj);

  const { data: txData, error: txErr } = await supabase
    .from("transactions")
    .select(`
      id, amount, date, category_id, description,
      categories:categories!transactions_category_id_fkey ( name, stability_type )
    `)
    .eq("user_id", user_id)
    .eq("type", "expense")
    .gte("date", historyFrom)
    .lte("date", historyTo);

  if (txErr) throw new Error(txErr.message);

  const rows = (txData || [])
    .map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: Number(tx.amount) || 0,
      category_id: tx.category_id,
      category_name: tx.categories?.name || "Sin categoría",
      category_stability: tx.categories?.stability_type || "variable",
      description: tx.description || "",
      norm: normalizeText(tx.description || ""),
    }))
    .filter((r) => r.amount > 0 && !!r.category_id);

  const filtered = rows.filter((r) =>
    includeOccasional ? true : r.category_stability !== "occasional"
  );

  const { recurringPatterns, noiseByCategory } = buildAdvancedPatterns({
    rows: filtered,
    minOccurrences,
    minIntervalDays,
    maxIntervalDays,
    maxCoefVariation,
    includeNoise,
    history_from: historyFrom,
    history_to: historyTo,
    range_from: rangeStart,
    range_to: rangeEnd,
  });

  const instances = [];

  for (const p of recurringPatterns) {
    const interval = Math.max(1, Math.round(p.median_interval_days || 0));
    const amount = Number(p.median_amount) || 0;
    if (!interval || amount <= 0 || !p.last_date) continue;

    const gap = diffInDays(p.last_date, rangeStart);
    const n = gap > 0 ? Math.ceil(gap / interval) : 1;
    let next = addDays(p.last_date, n * interval);

    while (new Date(next) <= new Date(rangeEnd)) {
      instances.push({
        name: p.display_name,
        amount: Number(amount.toFixed(2)),
        date: next,
        category_id: p.category_id,
        category_name: p.category_name,
        account_id,
      });
      next = addDays(next, interval);
    }
  }

  if (includeNoise) {
    for (const n of noiseByCategory) {
      const count = n.expected_count || 0;
      const amt = Number(n.median_amount) || 0;
      if (count <= 0 || amt <= 0) continue;

      const dates = spreadDates(rangeStart, rangeEnd, count);
      dates.forEach((d) => {
        instances.push({
          name: `${n.category_name} (eventual)`,
          amount: Number(amt.toFixed(2)),
          date: d,
          category_id: n.category_id,
          category_name: n.category_name,
          account_id,
        });
      });
    }
  }

  return {
    instances,
    meta: {
      range_from: rangeStart,
      range_to: rangeEnd,
      history_from: historyFrom,
      history_to: historyTo,
      recurring_patterns_count: recurringPatterns.length,
      noise_categories_count: noiseByCategory.length,
    },
  };
}

/* =========================
   Pattern builder (core)
   - clustering category + description similarity
   - detect recurrence by interval stats
   - compute noise by category (expected_count + median_amount)
========================= */

function buildAdvancedPatterns({
  rows,
  minOccurrences,
  minIntervalDays,
  maxIntervalDays,
  maxCoefVariation,
  includeNoise,
  history_from,
  history_to,
  range_from,
  range_to,
}) {
  const SIM_THRESHOLD = 0.45;

  // group by category
  const byCategory = {};
  for (const r of rows) {
    const k = String(r.category_id);
    if (!byCategory[k]) byCategory[k] = [];
    byCategory[k].push(r);
  }

  // clusters per category
  const clusters = [];
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
        if ((tx.norm || "").length > (catClusters[bestIdx].rep_norm || "").length) {
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

    if (medInterval < minIntervalDays || medInterval > maxIntervalDays) continue;
    if (coefVar > maxCoefVariation) continue;

    const amounts = entries.map((e) => e.amount).filter((a) => Number.isFinite(a) && a > 0);
    const medAmount = median(amounts);
    if (!Number.isFinite(medAmount) || medAmount <= 0) continue;

    const lastDate = entries[entries.length - 1].date;
    entries.forEach((e) => recurringTxIds.add(e.id));

    const rep = c.rep_norm || "";
    const pattern_key = `${c.category_id}::${rep}`; // estable dentro del histórico
    const display_name = rep ? `${c.category_name} · ${rep}` : c.category_name;

    recurringPatterns.push({
      category_id: c.category_id,
      category_name: c.category_name,
      pattern_key,
      display_name,
      median_interval_days: Number(medInterval.toFixed(1)),
      median_amount: Number(medAmount.toFixed(2)),
      last_date: lastDate,
    });
  }

  const noiseByCategory = [];
  if (includeNoise) {
    const historyDays = Math.max(1, diffInDays(history_from, history_to) + 1);
    const rangeDays = Math.max(1, diffInDays(range_from, range_to) + 1);

    const byCat = {};
    for (const tx of rows) {
      if (recurringTxIds.has(tx.id)) continue;
      const k = String(tx.category_id);
      if (!byCat[k]) {
        byCat[k] = { category_id: tx.category_id, category_name: tx.category_name, total: 0, count: 0, amounts: [] };
      }
      byCat[k].total += tx.amount;
      byCat[k].count += 1;
      byCat[k].amounts.push(tx.amount);
    }

    for (const c of Object.values(byCat)) {
      if (c.count < 3) continue;

      const expectedCountRaw = (c.count / historyDays) * rangeDays;
      const expected_count = expectedCountRaw >= 0.75 ? Math.round(expectedCountRaw) : 0;
      if (expected_count <= 0) continue;

      const medAmount = median(c.amounts);
      if (!Number.isFinite(medAmount) || medAmount <= 0) continue;

      noiseByCategory.push({
        category_id: c.category_id,
        category_name: c.category_name,
        expected_count,
        median_amount: Number(medAmount.toFixed(2)),
      });
    }
  }

  return { recurringPatterns, noiseByCategory };
}

/* =========================
   Utils
========================= */

function clampInt(v, def, min, max) {
  const n = parseInt(v ?? "", 10);
  const x = Number.isFinite(n) ? n : def;
  return Math.max(min, Math.min(max, x));
}

function toISODate(d) {
  return new Date(d).toISOString().split("T")[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function addDaysObj(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d;
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
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    "de","del","la","el","los","las","y","o","para","por","con","un","una","unos","unas",
    "mi","mis","tu","tus","su","sus","en","a","al","se","me","te","que","como",
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

// Fechas “espaciadas” (determinista) dentro del rango para eventos/noise
function spreadDates(start, end, count) {
  const days = Math.max(1, diffInDays(start, end) + 1);
  const step = days / (count + 1);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const offset = Math.round(step * i);
    out.push(addDays(start, offset));
  }
  // clamp si cae fuera por redondeos
  return out.map((d) => {
    if (new Date(d) < new Date(start)) return start;
    if (new Date(d) > new Date(end)) return end;
    return d;
  });
}


module.exports = router;
