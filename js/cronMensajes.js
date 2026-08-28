const cron = require("node-cron");
const axios = require("axios");
const { MessageMedia } = require("whatsapp-web.js");

function iniciarCron(instances) {
  const schedule = (process.env.CRON_SCHEDULE || "*/30 * * * *").trim();
  const instanceId = (process.env.WHATSAPP_INSTANCE_ID || "yurimaguas").trim();
  const apiUrl = (process.env.URL_API || "").trim();
  const urlBase = (process.env.URL_BASE || "").replace(/\/$/, "").trim();

  if (!apiUrl) {
    console.error("[cron] URL_API no definida en .env");
    return;
  }

  console.log(
    `[cron] Iniciado — instancia: ${instanceId} | schedule: ${schedule}`,
  );

  let isRunning = false;

  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log("[cron] ⏳ Ejecución en progreso, se omite este disparo.");
      return;
    }
    isRunning = true;
    console.log("[cron] Consultando facturas pendientes...");
    try {
      const { data } = await axios.get(apiUrl);

      if (!data.success || !data.data?.length) {
        console.log("[cron] Sin facturas pendientes.");
        return;
      }

      const instance = instances.get(instanceId);
      if (!instance?.client) {
        console.warn(
          `[cron] Instancia '${instanceId}' no disponible o no conectada.`,
        );
        return;
      }

      for (const factura of data.data) {
        let enviado = "NO";
        let caption  = "";

        try {
          const telefono = factura.cliente_telefono;
          if (!telefono) continue;

          const telefonoLimpio = telefono.replace(/[^0-9]/g, "");
          const telefonoCompleto = telefonoLimpio.startsWith("51")
            ? telefonoLimpio
            : `51${telefonoLimpio}`;
          const chatId = `${telefonoCompleto}@c.us`;
          const pdfUrl = `${urlBase}/${factura.pdf_url}`;
          caption = formatearCaption(factura);

          const media = await MessageMedia.fromUrl(pdfUrl, { unsafeMime: true });
          await instance.client.sendMessage(chatId, media, { caption });

          await axios.post(
            `${urlBase}/api/facturacion/enviado-whatsapp/${factura.id}`,
            { enviado_whatsapp: "SI" },
          );

          enviado = "SI";
          console.log(
            `[cron] ✅ Enviado y registrado — ${factura.serie}-${factura.numero} → cliente ${factura.cliente_telefono}`,
          );
        } catch (err) {
          console.error(
            `[cron] ❌ Error con factura ${factura.serie}-${factura.numero}:`,
            err.message,
          );
        }

        await registrarMensaje(factura, caption, enviado, urlBase);
        await esperar(10, 20);
      }
    } catch (err) {
      console.error("[cron] ❌ Error consultando la API:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

async function registrarMensaje(factura, mensaje, enviado, urlBase) {
  try {
    await axios.post(`${urlBase}/api/facturacion/mensajes-whatsapp`, {
      factura_id:       factura.id,
      cliente_id:       factura.cliente_id,
      cliente_telefono: factura.cliente_telefono,
      mensaje,
      enviado,
      fecha_envio:      new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron] ❌ Error registrando mensaje:", err.message);
  }
}

function esperar(minSeg, maxSeg) {
  const ms =
    (Math.floor(Math.random() * (maxSeg - minSeg + 1)) + minSeg) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatearCaption(factura) {
  const meses = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  const [anio, mes] = factura.fecha_emision.split("-");
  const nombreMes = meses[parseInt(mes, 10) - 1];
  const simbolo = factura.moneda === "PEN" ? "S/" : factura.moneda;

  return (
    `🔔 *RECORDATORIO DE PAGO*\n\n` +
    `Estimado(a) ${factura.cliente_razon_social}:\n` +
    `Le recordamos que se encuentra pendiente de pago la Factura Electrónica ` +
    `*${factura.serie}-${factura.numero}*, correspondiente a los servicios de ` +
    `Asesoría Contable del mes de ${nombreMes} ${anio}.\n\n` +
    `💰 Importe pendiente: *${simbolo} ${parseFloat(factura.total).toFixed(2)}*\n\n` +
    `Medios de pago:\n` +
    `🏦 Cuenta BBA – LAYUCIM SAC:\n` +
    `N° 0011-0797-0200243417\n\n` +
    `Agradeceremos realizar la cancelación correspondiente.\n` +
    `Si ya realizó el pago, por favor hacer caso omiso al presente mensaje.\n\n` +
    `GROUP YUPANA – LAYUCIM S.A.C.\n` +
    `Gracias por su confianza.`
  );
}

module.exports = { iniciarCron };
