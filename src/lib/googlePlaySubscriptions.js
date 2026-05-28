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

function createSubscriptionError(message, { statusCode, stage, details } = {}) {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  if (stage) error.stage = stage;
  if (details) error.details = details;
  return error;
}

function stripWrappingQuotes(value) {
  const trimmed = String(value || "").trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function tryParseServiceAccountJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryDecodeBase64(value) {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");

    if (!decoded.trim().startsWith("{")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function normalizePrivateKey(value) {
  const raw = stripWrappingQuotes(value);

  if (!raw) {
    return "";
  }

  const rawJson = tryParseServiceAccountJson(raw);
  if (rawJson?.private_key) {
    return normalizePrivateKey(rawJson.private_key);
  }

  const decodedJson = tryDecodeBase64(raw);
  if (decodedJson) {
    const parsedDecodedJson = tryParseServiceAccountJson(decodedJson);
    if (parsedDecodedJson?.private_key) {
      return normalizePrivateKey(parsedDecodedJson.private_key);
    }
  }

  return raw.replace(/\\n/g, "\n").trim();
}

function getGooglePlayConfig() {
  const serviceAccountJson = tryParseServiceAccountJson(
    stripWrappingQuotes(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "")
  );
  const decodedServiceAccountJson = tryDecodeBase64(
    stripWrappingQuotes(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64 || "")
  );
  const serviceAccountFromBase64 = decodedServiceAccountJson
    ? tryParseServiceAccountJson(decodedServiceAccountJson)
    : null;
  const serviceAccount = serviceAccountJson || serviceAccountFromBase64 || {};
  const clientEmail =
    process.env.GOOGLE_PLAY_CLIENT_EMAIL || serviceAccount.client_email;
  const privateKey = normalizePrivateKey(
    process.env.GOOGLE_PLAY_PRIVATE_KEY || serviceAccount.private_key
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
    throw createSubscriptionError(
      "Falta configurar GOOGLE_PLAY_CLIENT_EMAIL o GOOGLE_PLAY_PRIVATE_KEY",
      { stage: "google_oauth_config" }
    );
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  let assertion;

  try {
    assertion = jwt.sign(
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
  } catch (error) {
    throw createSubscriptionError(
      error?.message || "No se pudo firmar el JWT de Google Play",
      {
        stage: "google_oauth_signing",
        details: {
          hasClientEmail: Boolean(clientEmail),
          privateKeyStartsCorrectly: privateKey.startsWith(
            "-----BEGIN PRIVATE KEY-----"
          ),
          privateKeyEndsCorrectly: privateKey
            .trim()
            .endsWith("-----END PRIVATE KEY-----"),
        },
      }
    );
  }

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
    throw createSubscriptionError(
      json?.error_description ||
        json?.error ||
        "No se pudo obtener access token de Google Play",
      {
        statusCode: response.status,
        stage: "google_oauth_token",
        details: json,
      }
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
    throw createSubscriptionError("Falta configurar GOOGLE_PLAY_PACKAGE_NAME", {
      stage: "google_play_config",
    });
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
    throw createSubscriptionError(googleMessage, {
      statusCode: response.status,
      stage: "google_play_subscription_lookup",
      details: json,
    });
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
    throw createSubscriptionError(error.message, {
      stage: "supabase_subscription_upsert",
      details: {
        code: error.code,
        details: error.details,
        hint: error.hint,
        message: error.message,
      },
    });
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
    throw createSubscriptionError(
      "Google Play no devolvio productId para la suscripcion",
      { stage: "google_play_subscription_normalize" }
    );
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
