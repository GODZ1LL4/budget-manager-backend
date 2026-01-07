// routes/goals.js
const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");

// -----------------------
// Helpers
// -----------------------
const ALLOWED_STATUSES = new Set(["active", "paused", "completed", "cancelled"]);

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const computeReservedFromMovements = (movements = []) => {
  let reserved = 0;
  for (const m of movements) {
    const sign = m.type === "deposit" || m.type === "adjust" ? 1 : -1;
    reserved += sign * Number(m.amount);
  }
  return Number(reserved || 0);
};

// =====================================================
// GET /goals -> metas con reserved_amount derivado
// =====================================================
router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data: goals, error: goalsErr } = await supabase
    .from("goals")
    .select(
      "id, user_id, name, target_amount, due_date, created_at, account_id, status, is_priority"
    )
    .eq("user_id", user_id)
    // Orden UX-friendly: prioridad primero, luego por fecha (más cercana), nulls al final
    .order("is_priority", { ascending: false })
    .order("due_date", { ascending: true, nullsFirst: false });

  if (goalsErr) return res.status(500).json({ error: goalsErr.message });

  const goalIds = goals.map((g) => g.id);
  const reservedByGoal = {};

  if (goalIds.length) {
    const { data: movements, error: movErr } = await supabase
      .from("goal_movements")
      .select("goal_id, type, amount")
      .eq("user_id", user_id)
      .in("goal_id", goalIds);

    if (movErr) return res.status(500).json({ error: movErr.message });

    for (const m of movements) {
      const sign = m.type === "deposit" || m.type === "adjust" ? 1 : -1;
      reservedByGoal[m.goal_id] =
        (reservedByGoal[m.goal_id] || 0) + sign * Number(m.amount);
    }
  }

  const enriched = goals.map((g) => ({
    ...g,
    reserved_amount: Number(reservedByGoal[g.id] || 0),
  }));

  res.json({ success: true, data: enriched });
});

// =====================================================
// POST /goals -> crear meta (con account_id opcional)
// =====================================================
router.post("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { name, target_amount, due_date, account_id, is_priority } = req.body;

  if (!name || target_amount == null) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  const target = toNumber(target_amount);
  if (target == null || target <= 0) {
    return res.status(400).json({ error: "target_amount inválido" });
  }

  if (is_priority !== undefined && typeof is_priority !== "boolean") {
    return res.status(400).json({ error: "is_priority debe ser boolean" });
  }

  // Si viene account_id, verificar que esa cuenta sea del usuario
  if (account_id) {
    const { data: acc, error: accErr } = await supabase
      .from("accounts")
      .select("id")
      .eq("id", account_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (accErr) return res.status(500).json({ error: accErr.message });
    if (!acc) return res.status(404).json({ error: "Cuenta no encontrada" });
  }

  const { data, error } = await supabase
    .from("goals")
    .insert([
      {
        user_id,
        name: String(name).trim(),
        target_amount: target,
        due_date: due_date || null,
        account_id: account_id || null,
        status: "active",
        is_priority: is_priority ?? false,
      },
    ])
    .select(
      "id, user_id, name, target_amount, due_date, created_at, account_id, status, is_priority"
    )
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ success: true, data: { ...data, reserved_amount: 0 } });
});

// =====================================================
// PUT /goals/:id -> editar meta (NO permite cambiar account_id)
// =====================================================
router.put("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { name, target_amount, due_date, status, is_priority, account_id } =
    req.body;

  // Buscar meta actual (para bloquear cambios de cuenta)
  const { data: existing, error: exErr } = await supabase
    .from("goals")
    .select("id, user_id, account_id")
    .eq("id", id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (exErr) return res.status(500).json({ error: exErr.message });
  if (!existing) return res.status(404).json({ error: "Meta no encontrada" });

  // Bloquear cambio de cuenta (incluye desasociar)
  if (account_id !== undefined) {
    const incoming = account_id || null;
    const current = existing.account_id || null;
    if (incoming !== current) {
      return res.status(400).json({
        error:
          "No se permite cambiar la cuenta asociada a una meta. Crea una nueva meta si deseas usar otra cuenta.",
      });
    }
  }

  const patch = {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: "name inválido" });
    patch.name = trimmed;
  }

  if (target_amount !== undefined) {
    const t = toNumber(target_amount);
    if (t == null || t <= 0) {
      return res.status(400).json({ error: "target_amount inválido" });
    }
    patch.target_amount = t;
  }

  if (due_date !== undefined) {
    patch.due_date = due_date || null;
  }

  if (status !== undefined) {
    if (!ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ error: "status inválido" });
    }
    patch.status = status;
  }

  if (is_priority !== undefined) {
    if (typeof is_priority !== "boolean") {
      return res.status(400).json({ error: "is_priority debe ser boolean" });
    }
    patch.is_priority = is_priority;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "No hay campos para actualizar" });
  }

  const { data, error } = await supabase
    .from("goals")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user_id)
    .select(
      "id, user_id, name, target_amount, due_date, created_at, account_id, status, is_priority"
    )
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Meta no encontrada" });

  // devolver también reserved_amount actualizado
  const { data: movs, error: mErr } = await supabase
    .from("goal_movements")
    .select("type, amount")
    .eq("user_id", user_id)
    .eq("goal_id", id);

  if (mErr) return res.status(500).json({ error: mErr.message });

  const reserved_amount = computeReservedFromMovements(movs);

  res.json({ success: true, data: { ...data, reserved_amount } });
});

// =====================================================
// POST /goals/:id/deposit -> aportar / reservar (o tracking)
// Reglas:
// - amount > 0
// - Si goal tiene account_id: amount <= available_balance
// - Si NO tiene account_id: se permite (tracking), no afecta cuentas
// =====================================================
router.post("/:id/deposit", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { amount, note, movement_date } = req.body;

  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) {
    return res.status(400).json({ error: "amount inválido" });
  }

  // Obtener goal
  const { data: goal, error: gErr } = await supabase
    .from("goals")
    .select("id, user_id, account_id, status")
    .eq("id", id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!goal) return res.status(404).json({ error: "Meta no encontrada" });

  // (Opcional) solo permitir si activa/pausada
  const allowedStatus = new Set(["active", "paused"]);
  if (goal.status && !allowedStatus.has(goal.status)) {
    return res.status(400).json({ error: "La meta no está disponible para aportes" });
  }

  // Si tiene cuenta, valida contra disponible
  if (goal.account_id) {
    const { data: acc, error: aErr } = await supabase
      .from("account_balances_extended")
      .select("id, available_balance")
      .eq("id", goal.account_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (aErr) return res.status(500).json({ error: aErr.message });
    if (!acc) return res.status(404).json({ error: "Cuenta no encontrada" });

    if (a > Number(acc.available_balance)) {
      return res.status(400).json({ error: "Saldo disponible insuficiente para reservar" });
    }
  }
  // Si NO tiene cuenta: tracking => no se valida contra balances

  const insertRow = {
    user_id,
    goal_id: goal.id,
    account_id: goal.account_id || null, // <- null si no hay cuenta
    type: "deposit",
    amount: a,
    linked_transaction_id: null,
  };
  if (note) insertRow.note = note;
  if (movement_date) insertRow.movement_date = movement_date;

  const { data: mv, error: mvErr } = await supabase
    .from("goal_movements")
    .insert([insertRow])
    .select()
    .single();

  if (mvErr) return res.status(500).json({ error: mvErr.message });

  res.status(201).json({ success: true, data: mv });
});




// =====================================================
// POST /goals/:id/withdraw -> liberar reserva manual (o tracking)
// Reglas:
// - amount > 0
// - reserved_net(meta) >= amount (y reserved_net > 0)
// - Si no tiene cuenta: igualmente válido (tracking)
// =====================================================
router.post("/:id/withdraw", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;
  const { amount, note, movement_date } = req.body;

  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) {
    return res.status(400).json({ error: "amount inválido" });
  }

  const { data: goal, error: gErr } = await supabase
    .from("goals")
    .select("id, user_id, account_id, status")
    .eq("id", id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!goal) return res.status(404).json({ error: "Meta no encontrada" });

  const allowedStatus = new Set(["active", "paused"]);
  if (goal.status && !allowedStatus.has(goal.status)) {
    return res.status(400).json({ error: "No puedes retirar de una meta no activa" });
  }

  // Calcular reserved neto desde movements
  const { data: movs, error: mErr } = await supabase
    .from("goal_movements")
    .select("type, amount")
    .eq("user_id", user_id)
    .eq("goal_id", goal.id);

  if (mErr) return res.status(500).json({ error: mErr.message });

  let reserved = 0;
  for (const m of movs || []) {
    const type = m.type;
    const amt = Number(m.amount) || 0;

    if (type === "deposit" || type === "adjust") reserved += amt;
    else if (type === "withdraw" || type === "auto_withdraw") reserved -= amt;
  }

  if (Math.abs(reserved) < 0.000001) reserved = 0;

  if (reserved <= 0) {
    return res.status(400).json({ error: "No hay monto reservado en esta meta." });
  }
  if (a > reserved) {
    return res.status(400).json({ error: "No puedes retirar más de lo reservado" });
  }

  const insertRow = {
    user_id,
    goal_id: goal.id,
    account_id: goal.account_id || null, // <- null si tracking
    type: "withdraw",
    amount: a,
    linked_transaction_id: null,
  };
  if (note) insertRow.note = note;
  if (movement_date) insertRow.movement_date = movement_date;

  const { data: mv, error: mvErr } = await supabase
    .from("goal_movements")
    .insert([insertRow])
    .select()
    .single();

  if (mvErr) return res.status(500).json({ error: mvErr.message });

  return res.status(201).json({ success: true, data: mv });
});


// =====================================================
// GET /goals/:id/movements -> historial
// =====================================================
router.get("/:id/movements", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { data: goal, error: gErr } = await supabase
    .from("goals")
    .select("id")
    .eq("id", id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!goal) return res.status(404).json({ error: "Meta no encontrada" });

  const { data, error } = await supabase
    .from("goal_movements")
    .select(
      "id, type, amount, movement_date, note, linked_transaction_id, created_at"
    )
    .eq("user_id", user_id)
    .eq("goal_id", id)
    .order("movement_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});

// =====================================================
// DELETE /goals/:id -> eliminar meta (y movimientos por cascade)
// (Opcional: puedes preferir "cancelar" en vez de borrar)
// =====================================================
router.delete("/:id", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { id } = req.params;

  const { error } = await supabase
    .from("goals")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: "Meta eliminada" });
});

module.exports = router;
