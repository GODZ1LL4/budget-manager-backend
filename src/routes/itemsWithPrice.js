const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const authenticateUser = require("../middlewares/auth");
const upload = require("../lib/upload"); 

router.get("/", authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  const { data, error } = await supabase
    .from("items_with_price")
    .select("*")
    .eq("user_id", user_id)
    .order("name", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, data });
});


// Exportar precios de artículos seleccionados en CSV
router.post("/export-prices", authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res
      .status(400)
      .json({ error: "Debes enviar un arreglo de IDs de artículos" });
  }

  try {
    // IMPORTANTE: aquí solo usamos columnas que sabemos que existen
    // en la vista items_with_price: id, name, latest_price
    const { data, error } = await supabase
      .from("items_with_price")
      .select("id, name, latest_price")
      .eq("user_id", user_id)
      .in("id", ids);

    if (error) {
      console.error("Supabase error en export-prices:", error);
      return res.status(500).json({ error: error.message });
    }

    // Construir CSV: "id","nombre","ultimo precio","Fecha"
// Construir CSV: "id";"nombre";"ultimo precio";"Fecha"
// Construir CSV: "id";"nombre";"precio";"cantidad"
const header = ['"id"', '"nombre"', '"precio"', '"cantidad"'];

const rows = (data || []).map((item) => {
  const id = item.id ?? "";
  const nombre = (item.name || "").replace(/"/g, '""');
  const precio =
    item.latest_price !== null && item.latest_price !== undefined
      ? String(item.latest_price)
      : "";

  // cantidad vacía (el usuario la llenará en Excel)
  const cantidad = "";

  return [`"${id}"`, `"${nombre}"`, `"${precio}"`, `"${cantidad}"`].join(";");
});

// También aquí usamos ; en el header
const csvContent = [header.join(";"), ...rows].join("\n");

res.setHeader("Content-Type", "text/csv; charset=utf-8");
res.setHeader(
  "Content-Disposition",
  `attachment; filename="precios-articulos-${new Date()
    .toISOString()
    .split("T")[0]}.csv"`
);

return res.status(200).send(csvContent);


  } catch (err) {
    console.error("Error inesperado en export-prices:", err);
    return res
      .status(500)
      .json({ error: "Error al generar el archivo de exportación" });
  }
});

router.post("/import-prices",
  authenticateUser,
  upload.single("file"), // campo "file" en el form-data
  async (req, res) => {
    const user_id = req.user.id;

    if (!req.file) {
      return res
        .status(400)
        .json({ error: "Debes adjuntar un archivo en el campo 'file'" });
    }

    try {
      const csvText = req.file.buffer.toString("utf-8");

      const lines = csvText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length < 2) {
        return res
          .status(400)
          .json({ error: "El archivo no contiene datos para importar" });
      }

      // Primera línea: header
      const header = lines[0].split(";").map((h) => h.replace(/"/g, "").trim());

      // Esperamos exactamente estos nombres (en cualquier orden)
      const idxId = header.indexOf("id");
      const idxPrecio = header.indexOf("ultimo precio");
      const idxFecha = header.indexOf("Fecha");

      if (idxId === -1 || idxPrecio === -1) {
        return res.status(400).json({
          error:
            "El archivo debe contener al menos las columnas 'id' y 'ultimo precio'",
        });
      }

      const rows = lines.slice(1);

      // 1) Parsear filas crudas
      const parsedRows = rows.map((line) => {
        const cols = line.split(";");
        const get = (idx) =>
          idx >= 0 && idx < cols.length
            ? cols[idx].replace(/^"|"$/g, "").trim()
            : "";

        const id = get(idxId);
        const ultimoPrecioStr = get(idxPrecio);
        const fechaStr = idxFecha !== -1 ? get(idxFecha) : "";

        return { id, ultimoPrecioStr, fechaStr, rawLine: line };
      });

      // 2) Validaciones básicas y limpieza
      const errors = [];
      const validRows = [];

      for (const row of parsedRows) {
        if (!row.id) {
          errors.push(
            `Fila inválida (sin id): ${row.rawLine.substring(0, 80)}...`
          );
          continue;
        }

        const price = parseFloat(
          row.ultimoPrecioStr.replace(",", ".") // por si escriben 123,45
        );
        if (Number.isNaN(price) || price <= 0) {
          errors.push(
            `Precio inválido para id=${row.id}: "${row.ultimoPrecioStr}"`
          );
          continue;
        }

        let date = new Date().toISOString().split("T")[0]; // por defecto hoy

        if (row.fechaStr) {
          // asumimos YYYY-MM-DD
          const d = new Date(row.fechaStr);
          if (!Number.isNaN(d.getTime())) {
            date = row.fechaStr;
          } else {
            // si no se puede parsear, podrías:
            // - agregar error y saltar fila
            // - o ignorar y usar hoy; aquí uso hoy pero lo anotamos
            errors.push(
              `Fecha inválida para id=${row.id}: "${row.fechaStr}", se usará fecha actual`
            );
          }
        }

        validRows.push({
          item_id: row.id,
          price,
          date,
        });
      }

      if (validRows.length === 0) {
        return res.status(400).json({
          error: "No hay filas válidas para importar",
          details: errors,
        });
      }

      // 3) Verificar que los IDs pertenecen al usuario
      const uniqueIds = [...new Set(validRows.map((r) => r.item_id))];

      const { data: itemsData, error: itemsError } = await supabase
        .from("items")
        .select("id")
        .eq("user_id", user_id)
        .in("id", uniqueIds);

      if (itemsError) {
        console.error("Error comprobando items:", itemsError);
        return res.status(500).json({ error: itemsError.message });
      }

      const allowedIds = new Set((itemsData || []).map((i) => i.id));

      const rowsForInsert = validRows.filter((r) =>
        allowedIds.has(r.item_id)
      );

      const missingIds = uniqueIds.filter((id) => !allowedIds.has(id));
      if (missingIds.length > 0) {
        errors.push(
          `Algunos IDs no pertenecen a tu usuario o no existen: ${missingIds.join(
            ", "
          )}`
        );
      }

      if (rowsForInsert.length === 0) {
        return res.status(400).json({
          error:
            "No hay filas válidas para importar después de validar los IDs",
          details: errors,
        });
      }

      // 4) Insert masivo en item_prices
      const { error: insertError } = await supabase
        .from("item_prices")
        .insert(rowsForInsert);

      if (insertError) {
        console.error("Error insertando item_prices:", insertError);
        return res.status(500).json({ error: insertError.message });
      }

      return res.status(200).json({
        success: true,
        inserted: rowsForInsert.length,
        errors,
      });
    } catch (err) {
      console.error("Error inesperado en import-prices:", err);
      return res
        .status(500)
        .json({ error: "Error al procesar el archivo de importación" });
    }
  }
);


module.exports = router;
