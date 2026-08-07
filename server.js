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
    console.log("📩 Webhook POST recibido:", JSON.stringify(req.body).slice(0, 300));
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return; // puede ser un status (entregado/leído), lo ignoramos
    console.log("💬 Mensaje de", msg.from, "tipo", msg.type);
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
    `🎂 Edades: ${d.edad_min || "—"} a ${d.edad_max || "—"}\n` +
    `📸 IG: ${d.instagram || "—"}\n` +
    `📱 WhatsApp: ${d.whatsapp || "—"}\n` +
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

// Suscribe la app a la cuenta de WhatsApp (WABA). Visitar una sola vez:
//   /subscribe?waba=TU_WABA_ID
app.get("/subscribe", async (req, res) => {
  const waba = req.query.waba;
  if (!waba) return res.status(400).send("Falta ?waba=TU_WABA_ID");
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${waba}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.whatsappToken}` },
    });
    const body = await r.text();
    res.status(r.status).type("application/json").send(body);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

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

// ============================================================
// PANEL DE CONTROL — /panel?key=TU_CLAVE
// Ver conversaciones en vivo, pausar el bot y responder a mano.
// (El estado está en memoria: se reinicia si el bot reinicia.)
// ============================================================
function checkKey(req, res) {
  const key = req.query.key || req.body?.key;
  if (key !== CONFIG.panelKey) {
    res.status(401).send("Clave incorrecta");
    return false;
  }
  return true;
}

function lastOf(history, role) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === role) return history[i].content;
  }
  return "";
}

// Datos en JSON para el panel
app.get("/panel/data", (req, res) => {
  if (!checkKey(req, res)) return;
  const convs = [...conversations.entries()].map(([phone, c]) => ({
    phone,
    phase: c.phase,
    msgCount: c.msgCount,
    busca: c.lastData?.camino || "",
    nombre: c.lastData?.nombre || "",
    ultimoCliente: lastOf(c.history, "user"),
    ultimoBot: lastOf(c.history, "assistant"),
  }));
  const pend = [...pending.entries()].map(([phone, p]) => ({ phone, name: p.name, data: p.data }));
  res.json({ conversations: convs.reverse(), pending: pend });
});

// Acciones: pausar / reanudar el bot, o enviar un mensaje a mano
app.post("/panel/action", async (req, res) => {
  if (!checkKey(req, res)) return;
  const { action, phone, text } = req.body || {};
  if (!phone) return res.status(400).json({ error: "falta phone" });
  const convo = getConvo(phone);
  if (action === "pause") convo.phase = "handoff";
  else if (action === "resume") convo.phase = "activo";
  else if (action === "send") {
    if (!text) return res.status(400).json({ error: "falta text" });
    convo.phase = "handoff"; // al responder a mano, el bot se pausa en ese chat
    convo.history.push({ role: "assistant", content: text });
    await sendText(phone, text);
  }
  res.json({ ok: true, phase: convo.phase });
});

// La página del panel
app.get("/panel", (req, res) => {
  const key = req.query.key || "";
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel · Roca Bruja Bot</title>
<style>
:root{--navy:#1A2B3A;--green:#16a34a;--red:#dc2626;--muted:#6b7280;--border:#e5e7eb;--bg:#f8fafc;--wa:#e7ffdb}
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}
body{background:var(--bg);color:#1f2937;font-size:14px}
.hdr{background:var(--navy);color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center}
.hdr h1{font-size:18px}.hdr .sub{font-size:12px;color:#c7d2dd}
.wrap{max-width:1000px;margin:0 auto;padding:18px}
.card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
h2{font-size:15px;color:var(--navy);margin-bottom:10px}
.conv{border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.phone{font-weight:700;color:var(--navy)}
.badge{font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:10px}
.b-bot{background:#dcfce7;color:#166534}.b-hand{background:#fef9c3;color:#854d0e}.b-close{background:#fee2e2;color:#991b1b}
.msg{background:#f1f5f9;border-radius:8px;padding:7px 10px;margin:6px 0;font-size:13px;white-space:pre-wrap}
.msg.cli{background:#eef2ff}.msg.bot{background:var(--wa)}
.lbl{font-size:10px;text-transform:uppercase;color:var(--muted);font-weight:700}
input,button{font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid var(--border)}
button{cursor:pointer;font-weight:600;border:none}
.btn-p{background:#fef9c3;color:#854d0e}.btn-r{background:#dcfce7;color:#166534}.btn-s{background:var(--navy);color:#fff}
.reply{display:flex;gap:8px;margin-top:8px}.reply input{flex:1}
.pend{background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px;margin-bottom:10px}
.empty{color:var(--muted);font-style:italic;padding:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px}
</style></head><body>
<div class="hdr"><div><h1>🖤 Panel · Roca Bruja Bot</h1><div class="sub"><span class="dot"></span>En vivo · se actualiza solo cada 8s</div></div></div>
<div class="wrap">
<div class="card"><h2>⏳ Esperando aprobación</h2><div id="pending"><div class="empty">Cargando…</div></div></div>
<div class="card"><h2>💬 Conversaciones</h2><div id="convs"><div class="empty">Cargando…</div></div></div>
</div>
<script>
const KEY = ${JSON.stringify(key)};
async function load(){
  try{
    const r = await fetch('/panel/data?key='+encodeURIComponent(KEY));
    if(!r.ok){document.getElementById('convs').innerHTML='<div class="empty">Clave incorrecta. Usá /panel?key=TU_CLAVE</div>';return;}
    const d = await r.json();
    renderPending(d.pending); renderConvs(d.conversations);
  }catch(e){}
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function renderPending(p){
  const el=document.getElementById('pending');
  if(!p.length){el.innerHTML='<div class="empty">Nada pendiente ahora.</div>';return;}
  el.innerHTML=p.map(x=>'<div class="pend"><b>'+esc(x.name||x.phone)+'</b> · '+esc(x.phone)+'<br>🎯 '+esc(x.data.camino||'-')+' · 📅 '+esc(x.data.fecha||'-')+' · 👥 '+esc(x.data.cuantos||'-')+'<br>🎂 '+esc(x.data.edad_min||'-')+' a '+esc(x.data.edad_max||'-')+' · 📸 '+esc(x.data.instagram||'-')+' · 📱 '+esc(x.data.whatsapp||'-')+'</div>').join('');
}
function badge(ph){if(ph==='handoff')return '<span class="badge b-hand">Persona</span>';if(ph==='cerrado')return '<span class="badge b-close">Cerrado</span>';return '<span class="badge b-bot">Bot</span>';}
function renderConvs(c){
  const el=document.getElementById('convs');
  if(!c.length){el.innerHTML='<div class="empty">Todavía no hay conversaciones (se borran si el bot reinicia).</div>';return;}
  el.innerHTML=c.map(x=>{
    const pauseBtn = x.phase==='handoff' ? '<button class="btn-r" onclick="act(\\''+x.phone+'\\',\\'resume\\')">▶ Reanudar bot</button>' : '<button class="btn-p" onclick="act(\\''+x.phone+'\\',\\'pause\\')">⏸ Pausar bot</button>';
    return '<div class="conv"><div class="row"><span class="phone">'+esc(x.nombre||'')+' '+esc(x.phone)+'</span><span>'+badge(x.phase)+' '+pauseBtn+'</span></div>'+
    (x.busca?'<div class="lbl">Busca: '+esc(x.busca)+'</div>':'')+
    (x.ultimoCliente?'<div class="msg cli"><b>Cliente:</b> '+esc(x.ultimoCliente)+'</div>':'')+
    (x.ultimoBot?'<div class="msg bot"><b>Bot:</b> '+esc(x.ultimoBot)+'</div>':'')+
    '<div class="reply"><input id="i_'+x.phone+'" placeholder="Escribir como Roca Bruja…"><button class="btn-s" onclick="send(\\''+x.phone+'\\')">Enviar</button></div></div>';
  }).join('');
}
async function act(phone,action){
  await fetch('/panel/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,phone,action})});
  load();
}
async function send(phone){
  const inp=document.getElementById('i_'+phone); const text=inp.value.trim(); if(!text)return;
  inp.value='';
  await fetch('/panel/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,phone,action:'send',text})});
  load();
}
load(); setInterval(load,8000);
</script>
</body></html>`);
});

app.listen(CONFIG.port, () => console.log(`🚀 Bot escuchando en puerto ${CONFIG.port}`));
