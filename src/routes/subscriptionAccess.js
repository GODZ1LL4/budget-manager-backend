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
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  let latestSubscription = data;

  try {
    latestSubscription = await refreshStoredSubscriptionAccess(data);
  } catch {}

  const isActive = isSubscriptionEntitled(
    latestSubscription?.status,
    latestSubscription?.expires_at
  );

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
