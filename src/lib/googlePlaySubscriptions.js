const jwt = require("jsonwebtoken");
const supabase = require("./supabase");

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const GOOGLE_PLAY_SUBSCRIPTIONS_V2_BASE_URL =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";

let googleAccessTokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function getGooglePlayConfig() {
  const clientEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_PLAY_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n"
  );
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;

  return {
    clientEmail,
    privateKey,
    packageName,
  };
}

function isGooglePlayConfigured() {
  const config = getGooglePlayConfig();

  return Boolean(
    config.clientEmail && config.privateKey && config.packageName
  );
}

async function getGoogleAccessToken() {
  const now = Date.now();
  if (
    googleAccessTokenCache.accessToken &&
    googleAccessTokenCache.expiresAt > now + 60_000
  ) {
    return googleAccessTokenCache.accessToken;
  }

  const { clientEmail, privateKey } = getGooglePlayConfig();

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Falta configurar GOOGLE_PLAY_CLIENT_EMAIL o GOOGLE_PLAY_PRIVATE_KEY"
    );
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const assertion = jwt.sign(
    {
      iss: clientEmail,
      scope: GOOGLE_PLAY_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp,
    },
    privateKey,
    {
      algorithm: "RS256",
    }
  );

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const json = await response.json();

  if (!response.ok || !json?.access_token) {
    throw new Error(
      json?.error_description ||
        json?.error ||
        "No se pudo obtener access token de Google Play"
    );
  }

  googleAccessTokenCache = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600) * 1000,
  };

  return googleAccessTokenCache.accessToken;
}

async function fetchGooglePlaySubscription({ purchaseToken }) {
  const { packageName } = getGooglePlayConfig();

  if (!packageName) {
    throw new Error("Falta configurar GOOGLE_PLAY_PACKAGE_NAME");
  }

  const accessToken = await getGoogleAccessToken();
  const endpoint =
    `${GOOGLE_PLAY_SUBSCRIPTIONS_V2_BASE_URL}/applications/` +
    `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(purchaseToken)}`;

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const googleMessage =
      json?.error?.message || json?.error?.status || "Google Play devolvio un error";
    const error = new Error(googleMessage);
    error.statusCode = response.status;
    error.googlePayload = json;
    throw error;
  }

  return json;
}

function pickRelevantLineItem(subscription, expectedProductId) {
  const lineItems = Array.isArray(subscription?.lineItems)
    ? subscription.lineItems
    : [];

  if (!lineItems.length) {
    return null;
  }

  if (expectedProductId) {
    const exactMatch = lineItems.find(
      (lineItem) => lineItem?.productId === expectedProductId
    );

    if (exactMatch) {
      return exactMatch;
    }
  }

  return lineItems[0];
}

function mapGoogleStateToLocalStatus(subscriptionState) {
  switch (subscriptionState) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "active";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return "in_grace_period";
    case "SUBSCRIPTION_STATE_CANCELED":
      return "canceled";
    case "SUBSCRIPTION_STATE_PAUSED":
      return "paused";
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "on_hold";
    case "SUBSCRIPTION_STATE_PENDING":
      return "pending";
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return "pending_purchase_canceled";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "expired";
    default:
      return "inactive";
  }
}

function isSubscriptionEntitled(status, expiresAt) {
  if (!expiresAt) {
    return status === "active" || status === "in_grace_period";
  }

  const expiresInFuture = new Date(expiresAt).getTime() > Date.now();

  return expiresInFuture && (
    status === "active" ||
    status === "in_grace_period" ||
    status === "canceled"
  );
}

function normalizeGooglePlaySubscription(subscription, expectedProductId) {
  const lineItem = pickRelevantLineItem(subscription, expectedProductId);
  const subscriptionState = subscription?.subscriptionState || null;
  const expiresAt = lineItem?.expiryTime || null;
  const autoRenewing =
    lineItem?.autoRenewingPlan?.autoRenewEnabled === true;
  const productId = lineItem?.productId || expectedProductId || null;
  const status = mapGoogleStateToLocalStatus(subscriptionState);
  const orderId =
    lineItem?.latestSuccessfulOrderId ||
    subscription?.latestOrderId ||
    null;

  return {
    productId,
    orderId,
    status,
    expiresAt,
    autoRenewing,
    subscriptionState,
    lineItem,
    rawPayload: subscription,
    isEntitled: isSubscriptionEntitled(status, expiresAt),
  };
}

async function upsertSubscriptionRecord({
  userId,
  purchaseToken,
  provider = "google_play",
  normalized,
}) {
  const payload = {
    user_id: userId,
    provider,
    product_id: normalized.productId,
    purchase_token: purchaseToken,
    order_id: normalized.orderId,
    status: normalized.status,
    expires_at: normalized.expiresAt,
    auto_renewing: normalized.autoRenewing,
    raw_payload: normalized.rawPayload,
  };

  const { data, error } = await supabase
    .from("user_subscriptions")
    .upsert([payload], {
      onConflict: "purchase_token",
    })
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function verifyAndStoreGooglePlaySubscription({
  userId,
  productId,
  purchaseToken,
}) {
  const googleSubscription = await fetchGooglePlaySubscription({ purchaseToken });
  const normalized = normalizeGooglePlaySubscription(
    googleSubscription,
    productId
  );

  if (!normalized.productId) {
    throw new Error("Google Play no devolvio productId para la suscripcion");
  }

  const row = await upsertSubscriptionRecord({
    userId,
    purchaseToken,
    normalized,
  });

  return {
    row,
    normalized,
    subscriptionMode: normalized.isEntitled
      ? "premium_active"
      : "premium_inactive",
  };
}

async function refreshStoredSubscriptionAccess(subscriptionRow) {
  if (
    !subscriptionRow?.purchase_token ||
    subscriptionRow?.provider !== "google_play" ||
    !isGooglePlayConfigured()
  ) {
    return subscriptionRow;
  }

  const result = await verifyAndStoreGooglePlaySubscription({
    userId: subscriptionRow.user_id,
    productId: subscriptionRow.product_id,
    purchaseToken: subscriptionRow.purchase_token,
  });

  return result.row || subscriptionRow;
}

module.exports = {
  isGooglePlayConfigured,
  isSubscriptionEntitled,
  refreshStoredSubscriptionAccess,
  upsertSubscriptionRecord,
  verifyAndStoreGooglePlaySubscription,
};
