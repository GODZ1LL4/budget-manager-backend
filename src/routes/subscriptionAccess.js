const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const {
  isSubscriptionEntitled,
  refreshStoredSubscriptionAccess,
} = require("../lib/googlePlaySubscriptions");

router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", user_id)
    .order("updated_at", { ascending: false })
    .limit(10);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const rows = Array.isArray(data) ? data : [];
  const refreshedRows = [];

  for (const row of rows) {
    try {
      refreshedRows.push(await refreshStoredSubscriptionAccess(row));
    } catch {
      refreshedRows.push(row);
    }
  }

  const activeSubscription = refreshedRows.find((row) =>
    isSubscriptionEntitled(row?.status, row?.expires_at)
  );
  const latestSubscription = activeSubscription || refreshedRows[0] || null;
  const isActive = Boolean(activeSubscription);

  return res.json({
    success: true,
    data: {
      mode: isActive ? "premium_active" : "premium_inactive",
      provider: latestSubscription?.provider || null,
      product_id: latestSubscription?.product_id || null,
      expires_at: latestSubscription?.expires_at || null,
      status: latestSubscription?.status || "inactive",
    },
  });
});

module.exports = router;
