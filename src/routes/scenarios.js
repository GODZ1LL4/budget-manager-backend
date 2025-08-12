const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);

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
      return res.status(500).json({ error: "Error al guardar transacciones del escenario" });
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

  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("*")
    .eq("id", scenario_id)
    .eq("user_id", user_id)
    .single();

  if (scenarioError || !scenario) {
    return res.status(404).json({ error: "Escenario no encontrado" });
  }

  // 👇 Traemos las “reglas” con join a categorías y cuentas para tener sus nombres
  const { data: rules, error: txError } = await supabase
    .from("scenario_transactions")
    .select("*, categories:category_id(name), accounts:account_id(name)")
    .eq("scenario_id", scenario_id);

  if (txError) {
    console.error("❌ Error al obtener reglas:", txError);
    return res.status(500).json({ error: txError.message });
  }

  const dayjs = require("dayjs");
  const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
  dayjs.extend(isSameOrBefore);

  const today = dayjs().startOf("month");
  const endOfMonth = today.endOf("month");
  const projected = [];

  for (const rule of rules) {
    let current = dayjs(rule.start_date);
    const end = rule.end_date ? dayjs(rule.end_date) : endOfMonth;

    while (current.isSameOrBefore(end) && current.isSameOrBefore(endOfMonth)) {
      if (rule.exclude_weekends) {
        const day = current.day();
        if (day === 0 || day === 6) {
          current = current.add(1, "day");
          continue;
        }
      }

      projected.push({
        id: rule.id, // id real de la regla
        instance_id: `${rule.id}-${current.format("YYYYMMDD")}`, // id único por instancia
        name: rule.name,
        amount: rule.amount,
        type: rule.type,
        date: current.format("YYYY-MM-DD"),
        description: rule.description,
        category_id: rule.category_id,
        account_id: rule.account_id,
        scenario_id: rule.scenario_id,
        isProjected: true,

        // ✅ nombres enriquecidos para el frontend
        category_name: rule.categories?.name || null,
        account_name: rule.accounts?.name || null,
      });

      switch (rule.recurrence) {
        case "daily":
          current = current.add(1, "day");
          break;
        case "weekly":
          current = current.add(1, "week");
          break;
        case "biweekly":
          current = current.add(2, "week");
          break;
        case "monthly":
          current = current.add(1, "month");
          break;
        default:
          current = current.add(1, "day");
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

router.delete("/scenario_transactions/:id", authenticateUser, async (req, res) => {
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
});

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

  // 2) Borrar dependencias si NO tienes ON DELETE CASCADE
  const { error: delRulesError } = await supabase
    .from("scenario_transactions")
    .delete()
    .eq("scenario_id", id);

  if (delRulesError) {
    console.error("❌ Error al eliminar reglas del escenario:", delRulesError);
    return res.status(500).json({ error: "No se pudieron eliminar las transacciones del escenario" });
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


module.exports = router;
