const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const {
  isGooglePlayConfigured,
  upsertSubscriptionRecord,
  verifyAndStoreGooglePlaySubscription,
} = require("../lib/googlePlaySubscriptions");
const { verifyPubSubPushJwt } = require("../lib/pubsubPushAuth");

router.post("/google-play/rtdn", async (req, res) => {
  const expectedRtdnToken = process.env.GOOGLE_PLAY_RTND_TOKEN;
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const message = req.body?.message;
  const encodedData = message?.data;
  const providedRtdnToken =
    req.query?.token || req.headers["x-rtdn-token"] || null;

  if (expectedRtdnToken && providedRtdnToken !== expectedRtdnToken) {
    return res.status(401).json({ error: "RTDN token invalido" });
  }

  try {
    await verifyPubSubPushJwt(req);
  } catch (authError) {
    return res.status(401).json({
      error: authError.message || "JWT de Pub/Sub invalido",
    });
  }

  if (!encodedData) {
    return res.status(400).json({ error: "message.data es obligatorio" });
  }

  let developerNotification;

  try {
    const decoded = Buffer.from(encodedData, "base64").toString("utf8");
    developerNotification = JSON.parse(decoded);
  } catch {
    return res.status(400).json({ error: "message.data no es un JSON valido" });
  }

  if (packageName && developerNotification?.packageName !== packageName) {
    return res.status(400).json({
      error: "packageName no coincide con GOOGLE_PLAY_PACKAGE_NAME",
    });
  }

  if (developerNotification?.testNotification) {
    return res.json({ success: true, processed: false, type: "test" });
  }

  const purchaseToken =
    developerNotification?.subscriptionNotification?.purchaseToken ||
    developerNotification?.voidedPurchaseNotification?.purchaseToken ||
    null;

  if (!purchaseToken) {
    return res.json({
      success: true,
      processed: false,
      reason: "No hay purchaseToken en la notificacion",
    });
  }

  const { data: existingSubscription, error } = await supabase
    .from("user_subscriptions")
    .select("*")
    .eq("purchase_token", purchaseToken)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  if (!existingSubscription?.user_id) {
    return res.status(202).json({
      success: true,
      processed: false,
      reason: "purchaseToken aun no esta asociado a un usuario local",
    });
  }

  try {
    if (developerNotification?.subscriptionNotification) {
      if (!isGooglePlayConfigured()) {
        return res.status(500).json({
          error: "Google Play no esta configurado en el backend",
        });
      }

      const result = await verifyAndStoreGooglePlaySubscription({
        userId: existingSubscription.user_id,
        productId: existingSubscription.product_id,
        purchaseToken,
      });

      return res.json({
        success: true,
        processed: true,
        source: "subscriptionNotification",
        subscriptionMode: result.subscriptionMode,
      });
    }

    if (developerNotification?.voidedPurchaseNotification?.productType === 1) {
      await upsertSubscriptionRecord({
        userId: existingSubscription.user_id,
        purchaseToken,
        normalized: {
          productId: existingSubscription.product_id,
          orderId:
            developerNotification?.voidedPurchaseNotification?.orderId ||
            existingSubscription.order_id ||
            null,
          status: "revoked",
          expiresAt: new Date(
            Number(developerNotification?.eventTimeMillis || Date.now())
          ).toISOString(),
          autoRenewing: false,
          rawPayload: developerNotification,
        },
      });

      return res.json({
        success: true,
        processed: true,
        source: "voidedPurchaseNotification",
        subscriptionMode: "premium_inactive",
      });
    }

    return res.json({
      success: true,
      processed: false,
      reason: "Tipo de RTDN no manejado",
    });
  } catch (rtndError) {
    return res.status(rtndError.statusCode || 500).json({
      error: rtndError.message || "No se pudo procesar la RTDN",
      stage: rtndError.stage || null,
      details: rtndError.details || rtndError.googlePayload || null,
    });
  }
});

router.post("/google-play/confirm", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const {
    productId,
    purchaseToken,
    productType = "subs",
  } = req.body;

  if (!productId || !purchaseToken) {
    return res.status(400).json({
      error: "productId y purchaseToken son obligatorios",
    });
  }

  if (productType !== "subs") {
    return res.status(400).json({
      error:
        "El backend actual valida Premium como suscripcion de Google Play. Configura VITE_GOOGLE_PLAY_BILLING_PRODUCT_TYPE=subs.",
    });
  }

  if (!isGooglePlayConfigured()) {
    return res.status(500).json({
      error:
        "Google Play no esta configurado en el backend. Falta client email, private key o package name.",
    });
  }

  try {
    const result = await verifyAndStoreGooglePlaySubscription({
      userId: user_id,
      productId,
      purchaseToken,
    });

    return res.json({
      success: true,
      data: {
        subscriptionMode: result.subscriptionMode,
        subscription: result.row,
        googleState: result.normalized.subscriptionState,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "No se pudo validar la suscripcion en Google Play",
      stage: error.stage || null,
      details: error.details || error.googlePayload || null,
    });
  }
});

module.exports = router;
