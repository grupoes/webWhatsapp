// Parches locales para whatsapp-web.js mientras no se publiquen las correcciones oficiales.
//
// 1) Envío de fotos/videos/documentos falla con:
//    "Data passed to getter must include an id property (it's how we memoize) but got undefined"
//    Causa: mediaOptions trae un campo interno __x_id que, al copiarse al mensaje,
//    pisa su id real. Corrección propuesta en wwebjs/whatsapp-web.js PR #201923.
//
// 2) a 4) WhatsApp Web renombró id._serialized a id.$1 (julio 2026). Sin esto,
//    downloadMedia() y otras funciones reciben undefined (p. ej. los stickers y
//    fotos recibidos llegan sin archivo). Corrección oficial: commit 58ddf156.
//
// Se ejecuta en "postinstall" y es idempotente: si un parche ya está aplicado
// (o la librería ya trae la corrección), no hace nada.
const fs = require("fs");
const path = require("path");

const BASE = path.resolve(__dirname, "../node_modules/whatsapp-web.js/src");

const PARCHES = [
  {
    nombre: "envío de media (__x_id)",
    archivo: "util/Injected/Utils.js",
    marca: "delete message.__x_id",
    ancla: "        // Bot's won't reply if canonicalUrl is set (linking)\n",
    antes:
      "        // [parche local PR #201923] __x_id de mediaOptions pisa el id del Msg\n" +
      "        if (message.__x_id) {\n" +
      "            delete message.__x_id;\n" +
      "        }\n",
  },
  {
    nombre: "id $1 en getMessageModel",
    archivo: "util/Injected/Utils.js",
    marca: "msg.id._serialized == null && msg.id.$1 != null",
    ancla: "        delete msg.pendingAckUpdate;\n",
    antes:
      "        // [parche local commit 58ddf156] WhatsApp Web renombró _serialized a $1\n" +
      "        if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {\n" +
      "            msg.id = Object.assign({}, msg.id, { _serialized: msg.id.$1 });\n" +
      "        }\n\n",
  },
  {
    nombre: "id $1 en Chat",
    archivo: "structures/Chat.js",
    marca: "data.id._serialized == null && data.id.$1 != null",
    ancla: "        this.id = data.id;\n",
    reemplazo:
      "        // [parche local commit 58ddf156] WhatsApp Web renombró _serialized a $1\n" +
      "        this.id =\n" +
      "            data.id && data.id._serialized == null && data.id.$1 != null\n" +
      "                ? Object.assign({}, data.id, { _serialized: data.id.$1 })\n" +
      "                : data.id;\n",
  },
  {
    nombre: "id $1 en Message",
    archivo: "structures/Message.js",
    marca: "data.id._serialized == null && data.id.$1 != null",
    ancla: "        this.id = data.id;\n",
    reemplazo:
      "        // [parche local commit 58ddf156] WhatsApp Web renombró _serialized a $1\n" +
      "        this.id =\n" +
      "            data.id && data.id._serialized == null && data.id.$1 != null\n" +
      "                ? Object.assign({}, data.id, { _serialized: data.id.$1 })\n" +
      "                : data.id;\n",
  },
];

for (const p of PARCHES) {
  const archivo = path.join(BASE, p.archivo);
  if (!fs.existsSync(archivo)) {
    console.warn(`[parche] ${p.archivo} no existe (¿whatsapp-web.js instalado?), se omite: ${p.nombre}`);
    continue;
  }

  let codigo = fs.readFileSync(archivo, "utf8");
  if (codigo.includes(p.marca)) {
    console.log(`[parche] Ya aplicado: ${p.nombre}`);
    continue;
  }

  const eol = codigo.includes("\r\n") ? "\r\n" : "\n";
  const conEol = (t) => t.replace(/\n/g, eol);
  const ancla = conEol(p.ancla);
  if (!codigo.includes(ancla)) {
    console.warn(`[parche] No se encontró el punto de inserción, revisa si la librería cambió: ${p.nombre}`);
    continue;
  }

  const nuevo = p.reemplazo ? conEol(p.reemplazo) : conEol(p.antes) + ancla;
  codigo = codigo.replace(ancla, nuevo);
  fs.writeFileSync(archivo, codigo);
  console.log(`[parche] Aplicado: ${p.nombre}`);
}
