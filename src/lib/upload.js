// lib/upload.js
const multer = require("multer");

// Usamos memoria (no guardamos el archivo en disco)
const storage = multer.memoryStorage();

const upload = multer({ storage });

module.exports = upload;
