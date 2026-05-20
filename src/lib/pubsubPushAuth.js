const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

function getBearerToken(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function getExpectedAudience(req) {
  return (
    process.env.GOOGLE_PLAY_RTND_AUDIENCE ||
    `${req.protocol}://${req.get("host")}${req.baseUrl}${req.path}`
  );
}

async function verifyPubSubPushJwt(req) {
  const expectedServiceAccount = process.env.GOOGLE_PLAY_RTND_SERVICE_ACCOUNT;
  const authHeader = req.get("authorization");
  const bearerToken = getBearerToken(authHeader);

  if (!bearerToken) {
    throw new Error("Falta Authorization Bearer token");
  }

  const expectedAudience = getExpectedAudience(req);
  const response = await fetch(
    `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(bearerToken)}`
  );
  const claims = await response.json().catch(() => null);

  if (!response.ok || !claims) {
    throw new Error("No se pudo validar el JWT de Pub/Sub con Google");
  }

  if (claims.aud !== expectedAudience) {
    throw new Error("El claim aud del JWT no coincide");
  }

  if (
    claims.iss !== "https://accounts.google.com" &&
    claims.iss !== "accounts.google.com"
  ) {
    throw new Error("El issuer del JWT no es valido");
  }

  if (`${claims.email_verified}` !== "true") {
    throw new Error("El JWT de Pub/Sub no tiene email verificado");
  }

  if (expectedServiceAccount && claims.email !== expectedServiceAccount) {
    throw new Error("El JWT no pertenece al service account esperado");
  }

  return {
    bearerToken,
    claims,
    expectedAudience,
  };
}

module.exports = {
  getExpectedAudience,
  verifyPubSubPushJwt,
};
