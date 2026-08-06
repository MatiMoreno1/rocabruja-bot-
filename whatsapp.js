// whatsapp.js — helpers para hablar con la WhatsApp Business Cloud API
import { CONFIG } from "./config.js";

const API = `https://graph.facebook.com/v20.0/${CONFIG.phoneNumberId}/messages`;

// Argentina: el webhook trae el número con "9" (549...), pero para ENVIAR
// WhatsApp espera el número SIN el 9 (54...). Lo normalizamos.
function normalizeTo(to) {
  if (typeof to === "string" && /^549\d+/.test(to)) return "54" + to.slice(3);
  return to;
}

async function send(payload) {
  if (payload.to) payload = { ...payload, to: normalizeTo(payload.to) };
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("WhatsApp API error:", res.status, err);
  }
  return res;
}

// Mensaje de texto simple
export function sendText(to, body) {
  return send({ to, type: "text", text: { body, preview_url: true } });
}

// Botón de link (CTA URL) — abre una web directo (ej. Planout). Máximo 1.
export function sendCtaUrl(to, bodyText, buttonText, url) {
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: bodyText },
      action: { name: "cta_url", parameters: { display_text: buttonText, url } },
    },
  });
}

// Botones de respuesta (máx 3). buttons = [{ id, title }]
export function sendButtons(to, bodyText, buttons) {
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) }, // WhatsApp limita a 20 chars
        })),
      },
    },
  });
}

// Marca un mensaje como leído (opcional, queda prolijo)
export function markRead(messageId) {
  return send({ status: "read", message_id: messageId });
}
