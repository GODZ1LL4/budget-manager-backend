const jwt = require("jsonwebtoken");
require("dotenv").config();

const authenticateUser = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No se proporcionó token de autenticación" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);

    // `sub` contiene el user_id en Supabase
    req.user = {
      id: decoded.sub,
      email: decoded.email, // útil si lo necesitas
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
};

module.exports = authenticateUser;
