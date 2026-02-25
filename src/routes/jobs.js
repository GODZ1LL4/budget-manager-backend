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

function isUniqueViolation(err) {
  return (
    err?.code === "23505" ||
    String(err?.message || "").toLowerCase().includes("duplicate key")
  );
}

/**
 * Idempotent upsert for recurring instances.
 * Requires UNIQUE constraint:
 *   alter table public.transactions
 *   add constraint ux_transactions_recurrence_instance
 *   unique (user_id, recurrence_origin_id, date);
 */
async function upsertTransactionsWithRetry({ rows, tries = 3 }) {
  let lastErr = null;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await supabase
      .from("transactions")
      .upsert(rows, {
        onConflict: "user_id,recurrence_origin_id,date",
        ignoreDuplicates: true,
      })
      .select("id");

    if (!res.error) return res;

    lastErr = res.error;

    // If a unique violation still happens for any reason, treat as "already inserted".
    if (isUniqueViolation(res.error)) {
      return { data: [], error: null, skipped: rows.length };
    }

    if (!isDeadlockError(res.error)) return res;

    await sleep(150 * attempt);
  }

  return { data: null, error: lastErr };
}

// ---------------------------
// Recurrence math
// ---------------------------
function clampMonthlyDate({ baseStart, monthCursor }) {
  const anchorDay = baseStart.date();
  const lastDay = monthCursor.daysInMonth();
  const day = Math.min(anchorDay, lastDay);
  return monthCursor.date(day).startOf("day");
}

function nextMonthlyOccurrence({ start, afterDate }) {
  let cursor = afterDate.startOf("month");
  while (true) {
    const occ = clampMonthlyDate({ baseStart: start, monthCursor: cursor });
    if (!occ.isBefore(afterDate, "day")) return occ;
    cursor = cursor.add(1, "month").startOf("month");
  }
}

function nextWeeklyOccurrence({ start, afterDate, stepWeeks }) {
  const targetDow = start.day(); // 0..6
  let d = afterDate.startOf("day");

  // move to next targetDow (includes today if matches)
  const delta = (targetDow - d.day() + 7) % 7;
  d = d.add(delta, "day");

  // align phase for biweekly
  if (stepWeeks === 2) {
    let diffWeeks = d.diff(start, "week");
    if (diffWeeks < 0) diffWeeks = 0;
    if (diffWeeks % 2 !== 0) d = d.add(1, "week");
  }

  return d.startOf("day");
}

function* generateOccurrences({ tx, start, endInclusive, fromDate }) {
  if (tx.recurrence === "monthly") {
    let occ = nextMonthlyOccurrence({ start, afterDate: fromDate });
    while (!occ.isAfter(endInclusive, "day")) {
      yield occ;
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
}

// ---------------------------
// Endpoint
// ---------------------------
router.post("/run-daily-recurring", authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs().startOf("day");

    // 1) Fetch recurring templates
    const { data: recTxs, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user_id)
      .not("recurrence", "is", null);

    if (error) return res.status(500).json({ error: error.message });

    if (!recTxs || recTxs.length === 0) {
      return res.json({
        success: true,
        insertedCount: 0,
        skippedCount: 0,
        detail: [],
        message: "✅ No hay transacciones recurrentes configuradas.",
      });
    }

    // 2) Fetch existing instances for those templates
    const templateIds = recTxs.map((t) => t.id);

    const { data: instances, error: instErr } = await supabase
      .from("transactions")
      .select("id, recurrence_origin_id, date")
      .eq("user_id", user_id)
      .in("recurrence_origin_id", templateIds)
      .order("date", { ascending: false });

    if (instErr) return res.status(500).json({ error: instErr.message });

    // lastByOrigin: most recent instance date per template
    const lastByOrigin = new Map();
    for (const row of instances || []) {
      if (!row.recurrence_origin_id) continue;
      if (!lastByOrigin.has(row.recurrence_origin_id)) {
        lastByOrigin.set(row.recurrence_origin_id, dayjs(row.date).startOf("day"));
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

    // 3) Generate occurrences per template
    for (const tx of recTxs) {
      const start = dayjs(tx.date).startOf("day");

      // ✅ FIX: treat the template day as already "covered"
      // prevents inserting an [AUTO] instance on the same date as the original template tx
      existingSet.add(`${tx.id}_${toISO(start)}`);

      const end = tx.recurrence_end_date ? dayjs(tx.recurrence_end_date).startOf("day") : null;
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
      return res.json({
        success: true,
        insertedCount: 0,
        skippedCount: 0,
        detail,
        message: "✅ Job ejecutado, sin nuevas transacciones hoy.",
      });
    }

    // 4) Upsert idempotently, ordered to reduce deadlocks
    const byAccount = new Map();
    for (const row of toInsert) {
      const key = row.account_id || "__no_account__";
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(row);
    }

    const orderedAccountKeys = Array.from(byAccount.keys()).sort();

    let insertedTotal = 0;
    let skippedTotal = 0;

    for (const accKey of orderedAccountKeys) {
      const rows = byAccount.get(accKey) || [];
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      for (const chunk of chunkArray(rows, 50)) {
        const upsertRes = await upsertTransactionsWithRetry({ rows: chunk, tries: 3 });

        if (upsertRes.error) {
          console.error("❌ Error upsert recurrentes:", upsertRes.error);
          return res.status(500).json({
            error: "No se pudieron registrar las transacciones recurrentes. Intenta de nuevo.",
          });
        }

        insertedTotal += (upsertRes.data || []).length;
        skippedTotal += upsertRes.skipped || 0;
      }
    }

    const message =
      insertedTotal > 0
        ? `✅ Se registraron ${insertedTotal} transacciones recurrentes.`
        : skippedTotal > 0
        ? "✅ El job ya se había ejecutado hoy (no hubo cambios)."
        : "✅ Job ejecutado, sin nuevas transacciones hoy.";

    return res.json({
      success: true,
      insertedCount: insertedTotal,
      skippedCount: skippedTotal,
      message,
      detail,
    });
  } catch (e) {
    console.error("❌ run-daily-recurring crash:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;