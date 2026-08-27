const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

const SESSION_PATH = path.resolve(__dirname, "../sesionServicio");
const INSTANCES_FILE = path.resolve(__dirname, "../instances.json");

// Map de instancias activas en memoria
const instances = new Map();

// ─── Persistencia ────────────────────────────────────────────────────────────

function loadInstancesMeta() {
  try {
    if (fs.existsSync(INSTANCES_FILE)) {
      return JSON.parse(fs.readFileSync(INSTANCES_FILE, "utf8"));
    }
  } catch (_) {}
  return [];
}

function saveInstancesMeta() {
  const meta = [];
  for (const [id, inst] of instances.entries()) {
    meta.push({ id, label: inst.label, createdAt: inst.createdAt });
  }
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(meta, null, 2));
}

// ─── Helpers de sesión ───────────────────────────────────────────────────────

function getSessionFolder(id) {
  return path.join(SESSION_PATH, `session-${id}`);
}

// Mata procesos Chrome huérfanos que tengan esta sesión abierta
function killOrphanedBrowser(id) {
  try {
    execSync(
      `powershell -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*session-${id}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore", timeout: 8000 }
    );
    console.log(`[${id}] Procesos Chrome huérfanos terminados`);
  } catch (_) {}
}

// Borra el lock que Chrome usa para detectar instancias duplicadas
function clearSingletonLock(id) {
  const lockFile = path.join(SESSION_PATH, `session-${id}`, "SingletonLock");
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log(`[${id}] SingletonLock eliminado`);
    }
  } catch (_) {}
}

function clearSessionFolder(id) {
  const folder = getSessionFolder(id);
  if (!fs.existsSync(folder)) return;
  try {
    fs.rmSync(folder, { recursive: true, force: true });
    console.log(`[${id}] Sesión eliminada`);
  } catch (e) {
    if (e.code === "EBUSY") {
      // Chrome tiene archivos bloqueados → matarlo y reintentar
      console.log(`[${id}] Sesión ocupada por Chrome, liberando...`);
      killOrphanedBrowser(id);
      setTimeout(() => {
        try {
          fs.rmSync(folder, { recursive: true, force: true });
          console.log(`[${id}] Sesión eliminada (reintento)`);
        } catch (_) {}
      }, 2000);
    }
  }
}

// ─── Crear / inicializar cliente ─────────────────────────────────────────────

function createInstanceState(id, label, createdAt) {
  return {
    client: null,
    status: "initializing",
    qrCode: null,
    messages: [],
    disconnectReason: null,
    loadingPercent: 0,
    label: label || id,
    createdAt: createdAt || new Date().toISOString(),
  };
}

function initializeClient(id) {
  const inst = instances.get(id);
  if (!inst) return;

  // Evitar doble inicialización
  if (inst.client) return;

  inst.status = "initializing";
  inst.qrCode = null;
  inst.disconnectReason = null;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: id,
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  });

  inst.client = client;

  client.on("qr", (qr) => {
    console.log(`[${id}] QR generado - esperando escaneo`);
    qrcode.generate(qr, { small: true });
    inst.status = "qr";
    inst.qrCode = qr;
  });

  client.on("authenticated", () => {
    console.log(`[${id}] Autenticado correctamente`);
    inst.status = "loading";
    inst.qrCode = null;
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`[${id}] Cargando: ${percent}% - ${message}`);
    inst.status = "loading";
    inst.loadingPercent = percent;
  });

  client.on("ready", () => {
    console.log(`[${id}] Cliente listo`);
    inst.status = "ready";
    inst.qrCode = null;
    inst.disconnectReason = null;
  });

  client.on("disconnected", (reason) => {
    console.log(`[${id}] Desconectado: ${reason}`);
    inst.status = "disconnected";
    inst.disconnectReason = reason;
    inst.client = null;
    // Reconectar automáticamente después de 5 segundos
    setTimeout(() => {
      if (instances.has(id)) {
        console.log(`[${id}] Intentando reconectar...`);
        initializeClient(id);
      }
    }, 5000);
  });

  client.on("auth_failure", (msg) => {
    console.error(`[${id}] Error de autenticación: ${msg}`);
    inst.status = "auth_failure";
    inst.client = null;
    // Limpiar sesión corrupta y reiniciar para generar nuevo QR
    setTimeout(() => {
      if (instances.has(id)) {
        console.log(`[${id}] Limpiando sesión fallida y reiniciando...`);
        clearSessionFolder(id);
        initializeClient(id);
      }
    }, 3000);
  });

  client.on("message_create", (message) => {
    if (message.fromMe) return;
    inst.messages.push({
      id: message.id._serialized,
      from: message.from,
      body: message.body,
      timestamp: message.timestamp,
    });
    if (inst.messages.length > 1000) {
      inst.messages = inst.messages.slice(-500);
    }
    if (message.body === "!ping") {
      message.reply("pong");
    }
  });

  // Eliminar lock de Chrome antes de iniciar para evitar "browser already running"
  clearSingletonLock(id);

  client.initialize().catch((error) => {
    console.error(`[${id}] Error al inicializar:`, error.message);
    inst.client = null;

    if (error.message.includes("already running")) {
      // Chrome huérfano detectado (proceso Node anterior fue matado a la fuerza)
      console.log(`[${id}] Chrome huérfano detectado, terminando proceso y reintentando...`);
      inst.status = "initializing";
      killOrphanedBrowser(id);
      clearSingletonLock(id);
      setTimeout(() => {
        if (instances.has(id)) initializeClient(id);
      }, 3000);
    } else {
      inst.status = "disconnected";
      inst.disconnectReason = error.message;
    }
  });
}

// ─── Destruir instancia ───────────────────────────────────────────────────────

async function destroyInstance(id, deleteSession = true) {
  const inst = instances.get(id);
  if (!inst) return;

  if (inst.client) {
    try {
      await inst.client.destroy();
    } catch (_) {}
    inst.client = null;
  }

  instances.delete(id);
  if (deleteSession) clearSessionFolder(id);
  saveInstancesMeta();
}

// ─── Arranque: cargar instancias guardadas ───────────────────────────────────

function bootInstances() {
  const saved = loadInstancesMeta();
  for (const { id, label, createdAt } of saved) {
    instances.set(id, createInstanceState(id, label, createdAt));
    initializeClient(id);
  }
  console.log(`📋 ${saved.length} instancia(s) cargada(s) desde instances.json`);
}

bootInstances();

// ─── Middleware ───────────────────────────────────────────────────────────────

function getInstanceOrFail(req, res) {
  const inst = instances.get(req.params.id);
  if (!inst) {
    res.status(404).json({ error: `Instancia '${req.params.id}' no encontrada` });
    return null;
  }
  return inst;
}

function checkReady(req, res, next) {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: `Instancia '${req.params.id}' no encontrada` });
  if (inst.status !== "ready") {
    return res.status(503).json({
      error: "Instancia no está lista",
      status: inst.status,
      statusMessage: statusMessage(inst),
    });
  }
  next();
}

function statusMessage(inst) {
  switch (inst.status) {
    case "initializing": return "Iniciando cliente...";
    case "qr":           return "Esperando escaneo de QR";
    case "loading":      return `Cargando WhatsApp (${inst.loadingPercent}%)`;
    case "ready":        return "Conectado y listo";
    case "disconnected": return `Desconectado${inst.disconnectReason ? ": " + inst.disconnectReason : ""}`;
    case "auth_failure": return "Error de autenticación - limpiando sesión...";
    default:             return inst.status;
  }
}

// ─── Endpoints: gestión de instancias ────────────────────────────────────────

// Listar todas las instancias
router.get("/instances", (req, res) => {
  const list = [];
  for (const [id, inst] of instances.entries()) {
    list.push({
      id,
      label: inst.label,
      status: inst.status,
      statusMessage: statusMessage(inst),
      createdAt: inst.createdAt,
      hasQr: !!inst.qrCode,
    });
  }
  res.json(list);
});

// Crear nueva instancia
router.post("/instances", (req, res) => {
  const { id, label } = req.body;
  if (!id) return res.status(400).json({ error: "El campo 'id' es requerido" });
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: "El 'id' solo puede contener letras, números, guiones y guiones bajos" });
  }
  if (instances.has(id)) {
    return res.status(409).json({ error: `La instancia '${id}' ya existe` });
  }

  instances.set(id, createInstanceState(id, label, new Date().toISOString()));
  saveInstancesMeta();
  initializeClient(id);

  res.status(201).json({ message: `Instancia '${id}' creada`, id, label: label || id });
});

// Eliminar instancia
router.delete("/instances/:id", async (req, res) => {
  if (!instances.has(req.params.id)) {
    return res.status(404).json({ error: `Instancia '${req.params.id}' no encontrada` });
  }
  await destroyInstance(req.params.id, true);
  res.json({ message: `Instancia '${req.params.id}' eliminada` });
});

// ─── Endpoints: por instancia ─────────────────────────────────────────────────

// Estado + QR como imagen base64
router.get("/instances/:id/status", async (req, res) => {
  const inst = getInstanceOrFail(req, res);
  if (!inst) return;

  let qrImage = null;
  if (inst.qrCode) {
    try {
      qrImage = await QRCode.toDataURL(inst.qrCode);
    } catch (_) {}
  }

  res.json({
    id: req.params.id,
    label: inst.label,
    status: inst.status,
    statusMessage: statusMessage(inst),
    ready: inst.status === "ready",
    hasQr: !!inst.qrCode,
    qrImage,
    createdAt: inst.createdAt,
  });
});

// Enviar mensaje de texto
router.post("/instances/:id/send", checkReady, async (req, res) => {
  const inst = instances.get(req.params.id);
  const { numeroDestino, mensaje } = req.body;

  if (!numeroDestino || !mensaje) {
    return res.status(400).json({ error: "Número de destino y mensaje son requeridos" });
  }

  try {
    let chatId = numeroDestino;
    if (!chatId.includes("@c.us")) {
      chatId = chatId.replace(/[^0-9]/g, "") + "@c.us";
    }
    await inst.client.sendMessage(chatId, mensaje);
    res.json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    res.status(500).json({ error: "Error al enviar mensaje: " + error.message });
  }
});

// Enviar multimedia
router.post("/instances/:id/send-media", checkReady, async (req, res) => {
  const inst = instances.get(req.params.id);
  const { numeroDestino, filePath, caption } = req.body;

  if (!numeroDestino || !filePath) {
    return res.status(400).json({ error: "Número de destino y ruta del archivo son requeridos" });
  }

  try {
    const chatId = numeroDestino.includes("@c.us")
      ? numeroDestino
      : numeroDestino.replace(/[^0-9]/g, "") + "@c.us";
    const media = MessageMedia.fromFilePath(filePath);
    await inst.client.sendMessage(chatId, media, { caption: caption || "" });
    res.json({ success: true, message: "Archivo enviado" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener mensajes recibidos
router.get("/instances/:id/messages", (req, res) => {
  const inst = getInstanceOrFail(req, res);
  if (!inst) return;
  const limit = parseInt(req.query.limit) || 50;
  const messages = inst.messages.slice(-limit);
  res.json({ count: messages.length, messages });
});

// Reiniciar instancia (destruye cliente + limpia sesión → nuevo QR)
router.post("/instances/:id/restart", async (req, res) => {
  const inst = getInstanceOrFail(req, res);
  if (!inst) return;

  if (inst.client) {
    try { await inst.client.destroy(); } catch (_) {}
    inst.client = null;
  }
  inst.status = "initializing";
  inst.qrCode = null;
  inst.messages = [];
  clearSessionFolder(req.params.id);
  initializeClient(req.params.id);

  res.json({ message: `Instancia '${req.params.id}' reiniciada - escanea el nuevo QR` });
});

// Forzar nuevo QR sin eliminar la instancia (útil cuando el QR expiró)
router.post("/instances/:id/new-qr", async (req, res) => {
  const inst = getInstanceOrFail(req, res);
  if (!inst) return;

  if (inst.client) {
    try { await inst.client.destroy(); } catch (_) {}
    inst.client = null;
  }
  inst.status = "initializing";
  inst.qrCode = null;
  clearSessionFolder(req.params.id);
  initializeClient(req.params.id);

  res.json({ message: `Nuevo QR solicitado para '${req.params.id}'` });
});

module.exports = { router, instances };
