const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");

function getAdminGrantToken() {
  return String(process.env.ADMIN_MANUAL_GRANT_TOKEN || "").trim();
}

function isAuthorized(req) {
  const expectedToken = getAdminGrantToken();
  const providedToken = String(
    req.headers["x-admin-token"] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      ""
  ).trim();

  if (!expectedToken || !providedToken) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(providedToken);

  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function addDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function normalizeExpiresAt({ expiresAt, days }) {
  if (expiresAt === null || expiresAt === "") {
    return null;
  }

  if (expiresAt) {
    const parsed = new Date(expiresAt);

    if (Number.isNaN(parsed.getTime())) {
      throw new Error("expiresAt no es una fecha valida");
    }

    return parsed.toISOString();
  }

  if (days !== undefined && days !== null && days !== "") {
    const numericDays = Number(days);

    if (!Number.isFinite(numericDays) || numericDays <= 0) {
      throw new Error("days debe ser un numero mayor que cero");
    }

    return addDays(numericDays);
  }

  return null;
}

async function findUserId({ email, userId }) {
  if (userId) {
    return userId;
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    throw new Error("email o userId es obligatorio");
  }

  const { data: publicUser } = await supabase
    .from("users")
    .select("id")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (publicUser?.id) {
    return publicUser.id;
  }

  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) {
    throw new Error(error.message || "No se pudo buscar el usuario");
  }

  const authUser = data?.users?.find(
    (user) => String(user.email || "").toLowerCase() === normalizedEmail
  );

  if (!authUser?.id) {
    throw new Error("No se encontro una cuenta con ese correo");
  }

  return authUser.id;
}

router.use((req, res, next) => {
  if (!getAdminGrantToken()) {
    return res.status(503).json({
      error: "ADMIN_MANUAL_GRANT_TOKEN no esta configurado",
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Token de administracion invalido" });
  }

  next();
});

router.post("/grant-premium", async (req, res) => {
  try {
    const userId = await findUserId({
      email: req.body?.email,
      userId: req.body?.userId,
    });
    const expiresAt = normalizeExpiresAt({
      expiresAt: req.body?.expiresAt,
      days: req.body?.days,
    });
    const reason =
      String(req.body?.reason || "").trim() || "manual_premium_grant";
    const purchaseToken = `manual:${userId}:${Date.now()}`;

    const { data, error } = await supabase
      .from("user_subscriptions")
      .insert([
        {
          user_id: userId,
          provider: "manual_grant",
          product_id: "manual_premium",
          purchase_token: purchaseToken,
          order_id: null,
          status: "active",
          expires_at: expiresAt,
          auto_renewing: false,
          raw_payload: {
            reason,
            grantedBy: "admin",
            grantedAt: new Date().toISOString(),
          },
        },
      ])
      .select()
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      success: true,
      data: {
        mode: "premium_active",
        subscription: data,
      },
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message || "No se pudo conceder Premium",
    });
  }
});

router.post("/revoke-premium", async (req, res) => {
  try {
    const userId = await findUserId({
      email: req.body?.email,
      userId: req.body?.userId,
    });

    const { data, error } = await supabase
      .from("user_subscriptions")
      .update({
        status: "revoked",
        expires_at: new Date().toISOString(),
        auto_renewing: false,
      })
      .eq("user_id", userId)
      .eq("provider", "manual_grant")
      .eq("status", "active")
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      success: true,
      data: {
        revoked: data?.length || 0,
      },
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message || "No se pudo revocar Premium",
    });
  }
});

module.exports = router;
