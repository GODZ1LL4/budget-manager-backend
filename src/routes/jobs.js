// backend/src/routes/jobs.js
const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const dayjs = require("dayjs");

// ---------------------------
// Helpers
// ---------------------------
function toISO(d) {
  return d.format("YYYY-MM-DD");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isDeadlockError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("deadlock detected") || msg.includes("40p01");
}

async function insertTransactionsWithRetry({ rows, tries = 3 }) {
  let lastErr = null;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await supabase.from("transactions").insert(rows).select("id");

    if (!res.error) return res;

    lastErr = res.error;

    if (!isDeadlockError(res.error)) {
      return res; // error no-deadlock: no reintentar
    }

    // deadlock: backoff simple
    await sleep(150 * attempt);
  }

  return { data: null, error: lastErr };
}

// ---------------------------
// Recurrence math
// ---------------------------
function clampMonthlyDate({ baseStart, monthCursor }) {
  // baseStart: dayjs(fecha de inicio original, ej 2026-01-30)
  // monthCursor: dayjs apuntando al primer día del mes a calcular
  const anchorDay = baseStart.date(); // ej 30
  const lastDay = monthCursor.daysInMonth(); // 28/29/30/31
  const day = Math.min(anchorDay, lastDay);
  return monthCursor.date(day).startOf("day");
}

function nextMonthlyOccurrence({ start, afterDate }) {
  // primera ocurrencia mensual >= afterDate, anclada al día de start
  let cursor = afterDate.startOf("month");

  while (true) {
    const occ = clampMonthlyDate({ baseStart: start, monthCursor: cursor });
    if (!occ.isBefore(afterDate, "day")) return occ;
    cursor = cursor.add(1, "month").startOf("month");
  }
}

function nextWeeklyOccurrence({ start, afterDate, stepWeeks }) {
  // primera ocurrencia weekly/biweekly >= afterDate, manteniendo:
  // - mismo día de semana que start
  // - misma fase (para biweekly) respecto a start
  const targetDow = start.day(); // 0..6
  let d = afterDate.startOf("day");

  // mover d al próximo targetDow (incluye hoy si coincide)
  const delta = (targetDow - d.day() + 7) % 7;
  d = d.add(delta, "day");

  // ajustar fase para biweekly
  if (stepWeeks === 2) {
    let diffWeeks = d.diff(start, "week");
    if (diffWeeks < 0) diffWeeks = 0;
    if (diffWeeks % 2 !== 0) d = d.add(1, "week");
  }

  return d.startOf("day");
}

function* generateOccurrences({ tx, start, endInclusive, fromDate }) {
  // tx.recurrence: weekly|biweekly|monthly
  // start: dayjs(tx.date)
  // endInclusive: dayjs(min(today, recurrence_end_date?))
  // fromDate: dayjs (primera fecha candidata, inclusive)

  if (tx.recurrence === "monthly") {
    let occ = nextMonthlyOccurrence({ start, afterDate: fromDate });

    while (!occ.isAfter(endInclusive, "day")) {
      yield occ;

      // drift-free: saltar por mes calendario
      const nextMonth = occ.add(1, "month").startOf("month");
      occ = clampMonthlyDate({ baseStart: start, monthCursor: nextMonth });
    }
    return;
  }

  if (tx.recurrence === "weekly") {
    let occ = nextWeeklyOccurrence({ start, afterDate: fromDate, stepWeeks: 1 });

    while (!occ.isAfter(endInclusive, "day")) {
      if (!occ.isBefore(start, "day")) yield occ;
      occ = occ.add(1, "week");
    }
    return;
  }

  if (tx.recurrence === "biweekly") {
    let occ = nextWeeklyOccurrence({ start, afterDate: fromDate, stepWeeks: 2 });

    while (!occ.isAfter(endInclusive, "day")) {
      if (!occ.isBefore(start, "day")) yield occ;
      occ = occ.add(2, "week");
    }
    return;
  }

  // No soportado -> nada
}

// ---------------------------
// Endpoint
// ---------------------------
router.post("/run-daily-recurring", authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs().startOf("day");

    // 1) Traer plantillas recurrentes del usuario
    const { data: recTxs, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user_id)
      .not("recurrence", "is", null);

    if (error) return res.status(500).json({ error: error.message });

    if (!recTxs || recTxs.length === 0) {
      return res.json({ success: true, insertedCount: 0, detail: [] });
    }

    // 2) Traer instancias existentes de esas plantillas (para last + evitar duplicados)
    const templateIds = recTxs.map((t) => t.id);

    const { data: instances, error: instErr } = await supabase
      .from("transactions")
      .select("id, recurrence_origin_id, date")
      .eq("user_id", user_id)
      .in("recurrence_origin_id", templateIds)
      .order("date", { ascending: false });

    if (instErr) return res.status(500).json({ error: instErr.message });

    // lastByOrigin: fecha más reciente por plantilla
    const lastByOrigin = new Map();
    for (const row of instances || []) {
      if (!row.recurrence_origin_id) continue;
      if (!lastByOrigin.has(row.recurrence_origin_id)) {
        lastByOrigin.set(
          row.recurrence_origin_id,
          dayjs(row.date).startOf("day")
        );
      }
    }

    // existingSet: `${origin}_${date}`
    const existingSet = new Set();
    for (const row of instances || []) {
      if (row.recurrence_origin_id && row.date) {
        existingSet.add(`${row.recurrence_origin_id}_${row.date}`);
      }
    }

    const toInsert = [];
    const detail = [];

    // 3) Generar backfill por plantilla
    for (const tx of recTxs) {
      const start = dayjs(tx.date).startOf("day");
      const end = tx.recurrence_end_date
        ? dayjs(tx.recurrence_end_date).startOf("day")
        : null;

      const endInclusive = end && end.isBefore(today, "day") ? end : today;

      if (start.isAfter(endInclusive, "day")) continue;

      const last = lastByOrigin.get(tx.id) || null;
      const fromDate = last ? last.add(1, "day") : start;

      let generated = 0;

      for (const occ of generateOccurrences({ tx, start, endInclusive, fromDate })) {
        const d = toISO(occ);
        const key = `${tx.id}_${d}`;
        if (existingSet.has(key)) continue;

        existingSet.add(key);

        toInsert.push({
          user_id,
          amount: tx.amount,
          account_id: tx.account_id,
          category_id: tx.category_id,
          type: tx.type,
          description: `[AUTO] ${tx.description || ""}`.trim(),
          date: d,
          recurrence_origin_id: tx.id,
        });

        generated++;
      }

      if (generated > 0) detail.push({ template_id: tx.id, generated });
    }

    if (toInsert.length === 0) {
      return res.json({ success: true, insertedCount: 0, detail });
    }

    // 4) Insertar de manera que reduzca deadlocks:
    //    - agrupar por account_id
    //    - ordenar cuentas
    //    - insertar en chunks
    const byAccount = new Map();
    for (const row of toInsert) {
      const key = row.account_id || "__no_account__";
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(row);
    }

    const orderedAccountKeys = Array.from(byAccount.keys()).sort();

    let insertedTotal = 0;

    for (const accKey of orderedAccountKeys) {
      const rows = byAccount.get(accKey) || [];

      // Orden estable adicional (opcional): por date asc
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      for (const chunk of chunkArray(rows, 50)) {
        const insertRes = await insertTransactionsWithRetry({ rows: chunk, tries: 3 });

        if (insertRes.error) {
          console.error("❌ Error insertando recurrentes:", insertRes.error);
          return res.status(500).json({ error: insertRes.error.message });
        }

        insertedTotal += (insertRes.data || []).length;
      }
    }

    return res.json({
      success: true,
      insertedCount: insertedTotal,
      detail,
    });
  } catch (e) {
    console.error("❌ run-daily-recurring crash:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
