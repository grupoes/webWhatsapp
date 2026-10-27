const cron = require("node-cron");

function ahoraLima() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));

  return {
    dia: parseInt(p.day, 10),
    hora: parseInt(p.hour === "24" ? "0" : p.hour, 10),
    minuto: parseInt(p.minute, 10),
    periodo: `${p.year}-${p.month}`,
  };
}

async function getConfiguracion(baseUrl, apiToken) {
  const r = await fetch(`${baseUrl}/api/facturacion/configuracion`, {
    headers: { "X-Api-Token": apiToken },
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`GET configuracion -> HTTP ${r.status}: ${data.message || "error desconocido"}`);
  }
  return data;
}

async function generar(baseUrl, apiToken, periodo) {
  const r = await fetch(`${baseUrl}/api/facturacion/generar`, {
    method: "POST",
    headers: { "X-Api-Token": apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({ periodo }),
  });
  return r.json();
}

function iniciarCronFacturacion() {
  const baseUrl = (process.env.YUPANA_BASE_URL || "").replace(/\/+$/, "").trim();
  const apiToken = (process.env.CRON_API_TOKEN || "").trim();
  const pollCronExpr = (process.env.POLL_CRON_EXPR || "*/15 * * * *").trim();

  if (!baseUrl || !apiToken) {
    console.error("[cronFacturacion] YUPANA_BASE_URL o CRON_API_TOKEN no definidas en .env");
    return;
  }

  function log(msg) {
    console.log(`[cronFacturacion] ${new Date().toISOString()} - ${msg}`);
  }

  async function tick() {
    const cfg = await getConfiguracion(baseUrl, apiToken);
    if (!cfg.activo) {
      log("Facturación automática inactiva, nada que hacer.");
      return;
    }

    const ahora = ahoraLima();

    if (cfg.ultimo_periodo_generado === ahora.periodo) {
      log(`Período ${ahora.periodo} ya fue generado, nada que hacer.`);
      return;
    }

    const [horaCfg, minCfg] = cfg.hora_generacion.split(":").map(Number);
    const horaCumplida = ahora.hora > horaCfg || (ahora.hora === horaCfg && ahora.minuto >= minCfg);

    if (!cfg.dias_generacion.includes(ahora.dia) || !horaCumplida) {
      log(`Aún no toca generar (hoy es día ${ahora.dia} ${String(ahora.hora).padStart(2, "0")}:${String(ahora.minuto).padStart(2, "0")}, configurado: días [${cfg.dias_generacion.join(",")}] a las ${cfg.hora_generacion}).`);
      return;
    }

    log(`Disparando generación para el período ${ahora.periodo}...`);
    const resultado = await generar(baseUrl, apiToken, ahora.periodo);
    if (!resultado.success) {
      log(`La generación no se completó: ${resultado.message || "sin detalle"}`);
      return;
    }
    log(`Resultado: ${resultado.generados} generados, ${resultado.omitidos} omitidos.`);
  }

  async function tickSeguro() {
    try {
      await tick();
    } catch (err) {
      console.error(`[cronFacturacion] ${new Date().toISOString()} - Error en tick: ${err.message}`);
    }
  }

  console.log(`[cronFacturacion] iniciando, polling con expresión "${pollCronExpr}" contra ${baseUrl}`);
  tickSeguro();
  cron.schedule(pollCronExpr, tickSeguro);
}

module.exports = { iniciarCronFacturacion };
