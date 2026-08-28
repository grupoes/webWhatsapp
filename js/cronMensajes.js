const cron = require("node-cron");
const axios = require("axios");
const { MessageMedia } = require("whatsapp-web.js");

function iniciarCron(instances) {
  const schedule    = (process.env.CRON_SCHEDULE        || "*/30 * * * *").trim();
  const instanceId  = (process.env.WHATSAPP_INSTANCE_ID || "yurimaguas").trim();
  const apiUrl      = (process.env.URL_API              || "").trim();
  const urlBase     = (process.env.URL_BASE             || "").replace(/\/$/, "").trim();

  if (!apiUrl) {
    console.error("[cron] URL_API no definida en .env");
    return;
  }

  console.log(`[cron] Iniciado — instancia: ${instanceId} | schedule: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log("[cron] Consultando facturas pendientes...");
    try {
      const { data } = await axios.get(apiUrl);

      if (!data.success || !data.data?.length) {
        console.log("[cron] Sin facturas pendientes.");
        return;
      }

      const instance = instances.get(instanceId);
      if (!instance?.client) {
        console.warn(`[cron] Instancia '${instanceId}' no disponible o no conectada.`);
        return;
      }

      for (const factura of data.data) {
        try {
          const telefono = factura.cliente_telefono;
          if (!telefono) continue;

          const telefonoLimpio = telefono.replace(/[^0-9]/g, "");
          const telefonoCompleto = telefonoLimpio.startsWith("51")
            ? telefonoLimpio
            : `51${telefonoLimpio}`;
          const chatId = `${telefonoCompleto}@c.us`;
          const pdfUrl  = `${urlBase}/${factura.pdf_url}`;
          const caption = formatearCaption(factura);

          const media     = await MessageMedia.fromUrl(pdfUrl, { unsafeMime: true });
          const resultado = await instance.client.sendMessage(chatId, media, { caption });

          if (!resultado?.id) {
            throw new Error("El envío no fue exitoso según la respuesta del servidor");
          }

          await axios.post(
            `${urlBase}/api/facturacion/enviado-whatsapp/${factura.id}`,
            { enviado_whatsapp: "SI" }
          );

          console.log(`[cron] ✅ Enviado y registrado — ${factura.serie}-${factura.numero} → cliente ${factura.cliente_telefono}`);
        } catch (err) {
          console.error(`[cron] ❌ Error con factura ${factura.serie}-${factura.numero}:`, err.message);
        }

        await esperar(10, 20);
      }
    } catch (err) {
      console.error("[cron] ❌ Error consultando la API:", err.message);
    }
  });
}

function esperar(minSeg, maxSeg) {
  const ms = (Math.floor(Math.random() * (maxSeg - minSeg + 1)) + minSeg) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatearCaption(factura) {
  const monto = `${factura.moneda} ${parseFloat(factura.total).toFixed(2)}`;
  return (
    `Estimado(a) *${factura.cliente_razon_social}*\n\n` +
    `Su factura *${factura.serie}-${factura.numero}* es por los servicios de ` +
    `asesoría de contabilidad del periodo *${factura.fecha_emision}* ` +
    `con un monto de *${monto}*.\n\n` +
    `Gracias por su confianza.`
  );
}

module.exports = { iniciarCron };
