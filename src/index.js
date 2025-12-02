const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas
app.get("/", (req, res) => {
  res.send("API de Presupuesto Personal 🚀");
});

// Aquí se cargarán más rutas
// app.use('/api/transactions', require('./routes/transactions'));

const categoriesRoute = require("./routes/categories");
app.use("/api/categories", categoriesRoute);

const accountsRouter = require("./routes/accounts");
app.use("/api/accounts", accountsRouter);

const transactionsRouter = require("./routes/transactions");
app.use("/api/transactions", transactionsRouter);

const budgetsRouter = require("./routes/budgets");
app.use("/api/budgets", budgetsRouter);

const itemsRouter = require("./routes/items");
app.use("/api/items", itemsRouter);

const itemPricesRouter = require("./routes/itemPrices");
app.use("/api/item-prices", itemPricesRouter);

const goalsRoutes = require("./routes/goals");
app.use("/api/goals", goalsRoutes);

const dashboardRouter = require("./routes/dashboard");
app.use("/api/dashboard", dashboardRouter);

const analyticsRoutes = require("./routes/analytics");
app.use("/api/analytics", analyticsRoutes);

const jobsRouter = require("./routes/jobs");
app.use("/api/jobs", jobsRouter);

const taxesRoutes = require("./routes/taxes");
app.use("/api/taxes", taxesRoutes);

const itemsWithPriceRoutes = require("./routes/itemsWithPrice");
app.use("/api/items-with-price", itemsWithPriceRoutes);

const scenariosRoutes = require("./routes/scenarios");
app.use("/api/scenarios", scenariosRoutes);



app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
