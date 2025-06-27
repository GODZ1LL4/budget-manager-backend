const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const dayjs = require("dayjs");

router.post("/run-daily-recurring", authenticateUser, async (req, res) => {
  const today = dayjs().format("YYYY-MM-DD");
  const user_id = req.user.id;

  const { data: recTxs, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", user_id)
    .not("recurrence", "is", null);

  if (error) return res.status(500).json({ error: error.message });

  const toInsert = [];

  for (const tx of recTxs) {
    const start = dayjs(tx.date);
    const end = tx.recurrence_end_date ? dayjs(tx.recurrence_end_date) : null;

    const matchesToday = (() => {
      if (start.isAfter(today)) return false;
      if (end && dayjs(today).isAfter(end)) return false;

      if (tx.recurrence === "daily") return true;
      if (tx.recurrence === "weekly") return start.day() === dayjs(today).day();
      if (tx.recurrence === "biweekly") {
        const diffWeeks = dayjs(today).diff(start, "week");
        return diffWeeks % 2 === 0 && start.day() === dayjs(today).day();
      }
      if (tx.recurrence === "monthly")
        return start.date() === dayjs(today).date();
      return false;
    })();

    if (!matchesToday) continue;

    const { data: existing } = await supabase
      .from("transactions")
      .select("id")
      .eq("user_id", user_id)
      .eq("recurrence_origin_id", tx.id)
      .eq("date", today);

    if (existing?.length) continue;

    toInsert.push({
      user_id,
      amount: tx.amount,
      account_id: tx.account_id,
      category_id: tx.category_id,
      type: tx.type,
      description: `[AUTO] ${tx.description || ""}`.trim(),
      date: today,
      recurrence_origin_id: tx.id,
    });
  }

  if (toInsert.length > 0) {
    const insertRes = await supabase
      .from("transactions")
      .insert(toInsert)
      .select(); // Esto permite que insertRes.data tenga los registros insertados

    if (insertRes.error) {
      return res.status(500).json({ error: insertRes.error.message });
    }

    res.json({ success: true, insertedCount: insertRes.data.length });
  } else {
    res.json({ success: true, insertedCount: 0 });
  }
});

module.exports = router;
