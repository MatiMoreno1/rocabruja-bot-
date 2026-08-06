// server.js — webhook de WhatsApp para Roca Bruja
// Flujo cliente completo + aprobación del organizador + objetos perdidos
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG, SYSTEM_PROMPT, CLAUDE_MODEL } from "./config.js";
import { sendText, sendButtons, sendCtaUrl, markRead } from "./whatsapp.js";

const anthropic = new Anthropic({ apiKey: CONFIG.anthropicKey });
const app = express();
app.use(express.json());

// ============================================================
// ESTADO EN MEMORIA (para producción real, moverlo a una DB)
// ============================================================
// Conversaciones de clientes: phone -> { history:[], phase, msgCount, lastData }
const conversations = new Map();
// Pedidos esperando aprobación: clientPhone -> { data, name }
const pending = new Map();

function getConvo(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { history: [], phase: "activo", msgCount: 0, lastData: {} });
  }
  return conversations.get(phone);
}

// ============================================================
// VERIFICACIÓN DEL WEBHOOK (Meta hace un GET al configurar)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.verifyToken) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================
// RECEPCIÓN DE MENSAJES
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta; procesamos aparte
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return; // puede ser un status (entregado/leído), lo ignoramos
    const from = msg.from; // número de quien escribe (intl, sin +)
    const contactName = entry?.contacts?.[0]?.profile?.name || "";
    markRead(msg.id).catch(() => {});

    // 1) ¿Es el organizador tocando un botón de Aprobar/Rechazar?
    if (from === CONFIG.organizerPhone && msg.type === "interactive") {
      return handleOrganizerDecision(msg);
    }

    // 2) ¿Es un RRPP de la whitelist? → flujo vendedor (no en esta versión)
    if (CONFIG.rrppWhitelist.includes(from)) {
      return sendText(
        from,
        "¡Hola! Estás en el canal de RRPP. La carga de mesas por acá todavía no está activa en esta versión 🙌"
      );
    }

    // 3) Cliente
    return handleClient(from, msg, contactName);
  } catch (e) {
    console.error("Error procesando mensaje:", e);
  }
});

// ============================================================
// FLUJO CLIENTE
// ============================================================
async function handleClient(from, msg, contactName) {
  const convo = getConvo(from);

  // Si un organizador ya tomó la charla, el bot se calla (handoff)
  if (convo.phase === "handoff") return;

  // Texto del cliente (soporta texto y respuestas de botón)
  let userText = "";
  if (msg.type === "text") userText = msg.text.body;
  else if (msg.type === "interactive")
    userText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
  else userText = "[el cliente mandó un adjunto]";

  convo.history.push({ role: "user", content: userText });
  convo.msgCount++;

  // Pedirle a Claude la respuesta + la lógica
  let parsed;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: convo.history,
    });
    const raw = resp.content?.[0]?.text || "";
    parsed = safeParse(raw);
  } catch (e) {
    console.error("Error llamando a Claude:", e);
    await sendText(from, "¡Perdón! Se me trabó un segundo. ¿Me lo repetís? 🙌");
    return;
  }

  const reply = parsed.reply || "¡Contame! ¿Qué buscás para el sábado? 🖤";
  const action = parsed.action || "none";
  const data = parsed.data || {};
  convo.lastData = { ...convo.lastData, ...data };
  convo.history.push({ role: "assistant", content: reply });

  // Enviar la respuesta al cliente
  await sendText(from, reply);

  // En el primer mensaje, sumamos el botón de Entradas anticipadas
  if (convo.msgCount === 1 && action !== "send_planout") {
    await sendCtaUrl(
      from,
      "🎟️ Entradas anticipadas — comprá directo acá 👇",
      "Entradas anticipadas",
      CONFIG.planoutUrl
    );
  }

  // Acciones
  if (action === "send_planout") {
    await sendCtaUrl(
      from,
      "🎟️ Comprá tus entradas anticipadas acá 👇",
      "Entradas anticipadas",
      CONFIG.planoutUrl
    );
  } else if (action === "notify_organizer") {
    await notifyOrganizer(from, contactName, convo.lastData);
    convo.phase = "pendiente"; // esperando OK del organizador
  } else if (action === "objetos_perdidos") {
    await notifyLostItem(from, contactName, convo.lastData);
  }
}

// ============================================================
// AVISO AL ORGANIZADOR (con botones Aprobar/Rechazar)
// ============================================================
async function notifyOrganizer(clientPhone, contactName, d) {
  pending.set(clientPhone, { data: d, name: d.nombre || contactName });
  const resumen =
    `🆕 *Nuevo pedido*\n` +
    `👤 ${d.nombre || contactName || "—"}\n` +
    `🎯 Busca: ${caminoLabel(d.camino)}\n` +
    `📅 ${d.fecha || "—"}  ·  👥 ${d.cuantos || "—"}\n` +
    `📸 IG: ${d.instagram || "—"}\n` +
    `🎂 Edades: ${d.edades || "—"}\n` +
    `📱 Tel: ${d.telefonos || "—"}\n` +
    `¿Lo aprobás?`;
  await sendButtons(CONFIG.organizerPhone, resumen, [
    { id: `approve:${clientPhone}`, title: "✅ Aprobar" },
    { id: `reject:${clientPhone}`, title: "❌ Rechazar" },
  ]);
}

// ============================================================
// AVISO DE OBJETO PERDIDO (con link para escribirle directo)
// ============================================================
async function notifyLostItem(clientPhone, contactName, d) {
  const link = `https://wa.me/${clientPhone}`;
  const aviso =
    `🎒 *Objeto perdido — contactar:*\n` +
    `👤 ${d.nombre || contactName || "—"}  ·  📅 ${d.fecha || "—"}\n` +
    `🎒 ${d.objeto || "—"}  ·  📍 ${d.sector || "—"}\n` +
    `👉 Escribile: ${link}`;
  await sendText(CONFIG.organizerPhone, aviso);
  await sendText(
    clientPhone,
    "¡Listo! Ya pasé los datos al equipo. En un rato te escriben para ayudarte con eso 🙌"
  );
}

// ============================================================
// DECISIÓN DEL ORGANIZADOR (tocó un botón)
// ============================================================
async function handleOrganizerDecision(msg) {
  const id = msg.interactive?.button_reply?.id || "";
  const [decision, clientPhone] = id.split(":");
  if (!clientPhone) return;

  const req = pending.get(clientPhone);
  const convo = getConvo(clientPhone);

  if (decision === "approve") {
    const nombre = req?.name ? ` ${req.name}` : "";
    await sendText(
      clientPhone,
      `¡Buenísimo${nombre}! Ya está todo OK para avanzar ✅\nEn un ratito te escribe un organizador para cerrar todo a medida (combos, mesa o lo que busques) 🙌`
    );
    // Link para que el organizador le escriba DESDE SU número
    await sendText(
      CONFIG.organizerPhone,
      `✅ Aprobado. Escribile vos derecho 👉 https://wa.me/${clientPhone}`
    );
    convo.phase = "handoff"; // el bot deja de responder este chat
  } else if (decision === "reject") {
    await sendText(
      clientPhone,
      "¡Gracias por escribir! Por esta fecha no vamos a poder avanzar 🙏 Cualquier cosa quedamos en contacto para la próxima 🖤"
    );
    convo.phase = "cerrado";
  }
  pending.delete(clientPhone);
}

// ============================================================
// HELPERS
// ============================================================
function caminoLabel(c) {
  return (
    { combos: "combos", consumo: "entradas con consumo", mesa: "mesa / punto de consumo" }[c] ||
    "—"
  );
}

// Parsea el JSON de Claude aunque venga con ```json ... ```
function safeParse(raw) {
  let s = raw.trim();
  if (s.startsWith("```")) s = s.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // Si no es JSON válido, mandamos el texto tal cual como respuesta
    return { reply: raw, action: "none", data: {} };
  }
}

app.get("/", (_req, res) => res.send("Roca Bruja bot ✅"));

// Política de privacidad (requisito de Meta para activar la app)
app.get("/privacy", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de Privacidad · Roca Bruja</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1f2937}h1{color:#1A2B3A}h2{color:#1A2B3A;margin-top:28px}small{color:#6b7280}</style>
</head><body>
<h1>Política de Privacidad — Roca Bruja</h1>
<small>Última actualización: agosto 2026</small>
<p>Roca Bruja ("nosotros") opera un canal de atención por WhatsApp para responder consultas, gestionar reservas de entradas, combos y mesas, y coordinar con nuestro equipo. Esta política explica qué datos tratamos y cómo.</p>
<h2>Qué datos recopilamos</h2>
<p>Cuando nos escribís por WhatsApp podemos recibir: tu número de teléfono, tu nombre, y la información que nos compartís voluntariamente en la conversación (por ejemplo fecha del evento, cantidad de personas, Instagram, edades y datos de contacto del grupo). Si reportás un objeto perdido, los datos que nos des para ayudarte a recuperarlo.</p>
<h2>Para qué usamos tus datos</h2>
<p>Usamos esos datos únicamente para atenderte: responder tu consulta, coordinar tu reserva o compra, ponerte en contacto con un organizador y brindarte soporte. No vendemos ni cedemos tus datos a terceros con fines publicitarios.</p>
<h2>Con quién los compartimos</h2>
<p>La conversación se procesa a través de la plataforma de WhatsApp Business (Meta) y de servicios técnicos que hacen funcionar el asistente. Nuestro equipo de organizadores puede acceder a los datos necesarios para cerrar tu reserva.</p>
<h2>Conservación</h2>
<p>Conservamos los datos el tiempo necesario para atenderte y cumplir obligaciones legales o contables. Podés pedirnos que eliminemos tu información.</p>
<h2>Tus derechos</h2>
<p>Podés solicitar acceder, corregir o eliminar tus datos escribiéndonos por el mismo WhatsApp o al correo de contacto de Roca Bruja.</p>
<h2>Contacto</h2>
<p>Ante cualquier consulta sobre privacidad, escribinos por nuestro canal de WhatsApp de Roca Bruja.</p>
</body></html>`);
});

app.listen(CONFIG.port, () => console.log(`🚀 Bot escuchando en puerto ${CONFIG.port}`));
