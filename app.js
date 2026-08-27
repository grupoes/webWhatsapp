require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const app = express();
const port = 3002;

const { router: whatsappRoutes, instances } = require("./routes/api");

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use("/api/whatsapp", whatsappRoutes);

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: "Error interno del servidor", message: err.message });
});

const server = http.createServer(app);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ El puerto ${port} ya está en uso. Cierra el proceso anterior e intenta de nuevo.`);
  } else {
    console.error("❌ Error del servidor:", err.message);
  }
  process.exit(1);
});

server.listen(port, () => {
  console.log(`✅ Servidor en http://localhost:${port}`);
  console.log(`📊 Dashboard en http://localhost:${port}/dashboard`);

  const { iniciarCron } = require("./js/cronMensajes");
  iniciarCron(instances);
});

process.on("SIGINT", () => {
  console.log("\nApagando servidor...");
  server.close(() => process.exit(0));
});

// Evitar que errores async de whatsapp-web.js (ej: EBUSY al limpiar sesión) tumben el servidor
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Error no capturado (servidor sigue activo):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️  Excepción no capturada (servidor sigue activo):", err.message);
});
