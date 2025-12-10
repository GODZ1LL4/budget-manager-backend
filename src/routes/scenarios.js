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

module.exports = router;
