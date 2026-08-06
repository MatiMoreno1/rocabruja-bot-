# 🖤 Bot de WhatsApp — Roca Bruja

Bot que atiende a los clientes por WhatsApp, junta los datos del grupo, **avisa al organizador para que apruebe** (botones ✅/❌) y, cuando aprueba, le pasa el **link para escribirle directo**. Incluye el circuito de **objetos perdidos**.

Las respuestas las genera **Claude** con el tono canchero de Roca Bruja.

---

## 🧩 Qué hace (esta versión)

- Recibe al cliente y responde con onda (Claude).
- En el primer mensaje ofrece **Entradas anticipadas** (botón que abre Planout directo).
- Junta los datos del grupo: fecha, nombre y apellido, cuántos son, Instagram de cada uno, edades y **teléfono de cada uno**.
- Cuando tiene todo → le manda al **organizador** un resumen con botones **✅ Aprobar / ❌ Rechazar**.
- Si aprueba → le avisa al cliente que ya está OK y le pasa al organizador el **link wa.me** para escribirle. El bot se pausa en ese chat.
- Si rechaza → le manda un mensaje amable al cliente.
- **Objetos perdidos**: si alguien escribe que perdió algo, junta los datos y se los pasa al organizador con el link para contactarlo.

> Todavía **no** incluye validación de comprobantes ni escritura en la planilla de mesas (queda para la próxima versión).

---

## 📁 Archivos

| Archivo | Qué es |
|---|---|
| `server.js` | El servidor: recibe los WhatsApp, rutea y maneja el flujo. |
| `config.js` | Constantes + el "cerebro" (prompt de Claude con el tono y la lógica). |
| `whatsapp.js` | Funciones para mandar mensajes/botones por la API de WhatsApp. |
| `.env.example` | Modelo de las variables secretas (copialo a `.env`). |
| `package.json` | Dependencias. |

---

## 1) Lo que necesitás antes de arrancar

1. **Número de WhatsApp Business API** (ya lo tenés ✅) dado de alta en una app de Meta (developers.facebook.com).
2. Del panel de Meta → *WhatsApp > API Setup*:
   - **Token** (mejor un *System User Token* permanente, no el temporal de 24 hs).
   - **Phone number ID**.
3. Una **API key de Claude** (console.anthropic.com).
4. El **teléfono del organizador** que aprueba (formato `54911XXXXXXXX`, sin `+` ni espacios).

---

## 2) Configurar las variables

Copiá `.env.example` a `.env` y completá:

```
WHATSAPP_TOKEN=...        # token de Meta
PHONE_NUMBER_ID=...       # Phone number ID de Meta
VERIFY_TOKEN=...          # un texto que inventás vos
ANTHROPIC_API_KEY=...     # tu API key de Claude
ORGANIZER_PHONE=54911XXXXXXXX
RRPP_WHITELIST=54911AAAA,54911BBBB   # opcional por ahora
PLANOUT_URL=https://planout.ar/eventos/es/rb-sabados
```

---

## 3) Probarlo en tu compu (opcional)

```bash
npm install
npm start
```

Levanta en `http://localhost:3000`. Para que Meta te llegue, necesitás exponerlo con algo como **ngrok** (`ngrok http 3000`) y usar esa URL como webhook.

---

## 4) Subirlo (hosting) — 3 opciones

Como todavía no elegiste dónde, te dejo las tres. **Para empezar, Railway es lo más rápido.**

### Opción A — Railway (recomendada para arrancar)
1. Subí esta carpeta a un repo de GitHub.
2. En [railway.app](https://railway.app) → *New Project* → *Deploy from GitHub repo*.
3. En *Variables*, pegá las mismas del `.env`.
4. Railway te da una URL pública (ej. `https://rocabruja-bot.up.railway.app`).
5. Esa URL + `/webhook` es tu webhook.

### Opción B — Render
1. Igual: repo en GitHub.
2. [render.com](https://render.com) → *New* → *Web Service* → conectás el repo.
3. Build: `npm install` · Start: `npm start`.
4. Cargás las variables de entorno.
5. Te da una URL pública `https://...onrender.com`.

### Opción C — VPS propio (DigitalOcean, Hetzner, etc.)
1. Servidor con Node 18+.
2. `git clone`, `npm install`, cargás el `.env`.
3. Corrés con **PM2**: `pm2 start server.js --name rocabruja`.
4. Ponés un dominio + HTTPS (nginx + certbot). Meta exige HTTPS.

---

## 5) Enganchar el webhook en Meta

En la app de Meta → *WhatsApp > Configuration > Webhook*:
- **Callback URL**: `https://TU-URL/webhook`
- **Verify token**: el mismo `VERIFY_TOKEN` que pusiste en el `.env`.
- Suscribite al evento **`messages`**.

Si el token coincide, Meta valida y el bot queda escuchando.

---

## 6) Probar la punta a punta

1. Escribile al número de Roca Bruja desde otro celular.
2. El bot te contesta y te ofrece las entradas anticipadas.
3. Decile que sos un grupo de X y pasale los datos.
4. Al organizador le llega el resumen con los botones ✅/❌.
5. Tocás **Aprobar** → al cliente le llega el OK y al organizador el link para escribirle.

---

## Notas

- **Estado en memoria**: las conversaciones se guardan en memoria (se pierden si el server reinicia). Para producción conviene una base (Redis/Postgres). Te lo puedo sumar cuando quieras.
- **Tono**: se ajusta todo en `config.js` → `SYSTEM_PROMPT`.
- **Modelo de Claude**: `config.js` → `CLAUDE_MODEL`.
