/**
 * Ingesta de facturas por WhatsApp (Fase M4) — Meta Cloud API.
 *
 * Port 1:1 de facturapp/facturapp/whatsapp_service.py:
 * - Verificar la firma HMAC del webhook (X-Hub-Signature-256).
 * - Extraer los mensajes con documento adjunto del payload de Meta.
 * - Descargar el adjunto real desde la Graph API (dos pasos: media_id → URL
 *   temporal → bytes).
 * - Enviar la respuesta de vuelta al usuario por WhatsApp.
 *
 * ⚠️ Meta NO manda una URL descargable en el webhook — solo `document.id`
 * (media ID). Hay que resolverlo vía Graph API con el access token, en dos
 * llamadas (ver downloadMediaFromMeta).
 *
 * NOTA: la referencia original (whatsapp_service.py) tenía además un
 * `logger.info(...)` en casi cada línea, agregado para depurar en Railway
 * — no se portó tal cual (era ruido de depuración puntual, no diseño). Se
 * conserva logging razonable en los puntos de decisión reales.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

// ---------------------------------------------------------------------
// Verificación de firma (POST /webhooks/whatsapp)
// ---------------------------------------------------------------------

/** Verifica el header `X-Hub-Signature-256: sha256=<hex>` de Meta.
 *
 * IMPORTANTE: `appSecret` es el App Secret de la app de Meta, NO el
 * "verify token" usado en el handshake GET — son dos secretos distintos.
 *
 * Síncrono (como en Python) — node:crypto expone HMAC-SHA256 de forma
 * síncrona, igual que el módulo `hmac` de Python.
 */
export function verifyWhatsappSignature(
  body: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expectedHex = createHmac("sha256", appSecret).update(body).digest("hex");
  const providedHex = signatureHeader.slice("sha256=".length);

  // Comparación en tiempo constante — timingSafeEqual exige vistas del mismo
  // tamaño; si no coinciden en longitud, ya sabemos que es inválida
  // (comparar tamaños es seguro, no depende del contenido del secreto).
  const expected = hexToBytes(expectedHex);
  const provided = hexToBytes(providedHex);
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Decodifica hex a bytes usando solo APIs estándar.
 *
 * Antes esto usaba `Buffer.from(hex, "hex")`, que parecía funcionar porque
 * el Deno local expone `Buffer` como global — pero NO existe en el runtime
 * de Supabase Edge Functions, y ahí lanzaba ReferenceError. Importarlo de
 * `node:buffer` tampoco sirvió: ese import falla al cargar el módulo, lo
 * que tumba la función completa (incluido el handshake GET) antes de que
 * corra una sola línea nuestra.
 *
 * Devuelve un arreglo vacío si el hex es inválido — el caller lo trata como
 * firma no válida, que es la respuesta correcta para una entrada malformada.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array(0);
    bytes[i] = byte;
  }
  return bytes;
}

// ---------------------------------------------------------------------
// Extracción de mensajes del payload de Meta
// ---------------------------------------------------------------------

export interface ExtractedMessage {
  from: string;
  media_id: string;
  mime_type: string;
  filename: string;
  profile_name: string | null;
}

/** Recorre entry → changes → value → messages y devuelve solo los mensajes
 * de tipo "document" con su remitente y media_id. */
export function extractWhatsappMessages(payload: { entry?: unknown[] }): ExtractedMessage[] {
  const entries = (payload.entry ?? []) as Array<Record<string, unknown>>;
  const results: ExtractedMessage[] = [];

  for (const entry of entries) {
    const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;
    for (const change of changes) {
      const value = (change.value ?? {}) as Record<string, unknown>;
      const contacts = (value.contacts ?? []) as Array<Record<string, unknown>>;
      const profileNames = new Map<string, string | null>();
      for (const c of contacts) {
        const waId = c.wa_id as string | undefined;
        const profile = (c.profile ?? {}) as Record<string, unknown>;
        if (waId) profileNames.set(waId, (profile.name as string) ?? null);
      }

      const messages = (value.messages ?? []) as Array<Record<string, unknown>>;
      for (const msg of messages) {
        if (msg.type !== "document") continue;

        const document = (msg.document ?? {}) as Record<string, unknown>;
        const mediaId = document.id as string | undefined;
        if (!mediaId) continue;

        const phone = (msg.from as string) ?? "";
        results.push({
          from: phone,
          media_id: mediaId,
          mime_type: (document.mime_type as string) ?? "",
          filename: (document.filename as string) || "factura",
          profile_name: profileNames.get(phone) ?? null,
        });
      }
    }
  }
  return results;
}

export interface ExtractedTextMessage {
  from: string;
  text: string;
  profile_name: string | null;
}

/** Recorre el mismo payload que extractWhatsappMessages(), pero se queda
 * con los mensajes de tipo "text" (cuerpo no vacío) en vez de "document".
 *
 * NO existe en whatsapp_service.py — el sistema Python original solo
 * procesa documentos adjuntos (facturas), nunca texto conversacional por
 * WhatsApp. Esto es una extensión nueva (Fase M4b) que habilita chat vía
 * WhatsApp reusando el mismo `chat()` de `_shared/chat.ts` (Fase M5.5),
 * adoptando el patrón probado en WHATSAPP_BOT_ARCHITECTURE.md. */
export function extractWhatsappTextMessages(payload: { entry?: unknown[] }): ExtractedTextMessage[] {
  const entries = (payload.entry ?? []) as Array<Record<string, unknown>>;
  const results: ExtractedTextMessage[] = [];

  for (const entry of entries) {
    const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;
    for (const change of changes) {
      const value = (change.value ?? {}) as Record<string, unknown>;
      const contacts = (value.contacts ?? []) as Array<Record<string, unknown>>;
      const profileNames = new Map<string, string | null>();
      for (const c of contacts) {
        const waId = c.wa_id as string | undefined;
        const profile = (c.profile ?? {}) as Record<string, unknown>;
        if (waId) profileNames.set(waId, (profile.name as string) ?? null);
      }

      const messages = (value.messages ?? []) as Array<Record<string, unknown>>;
      for (const msg of messages) {
        if (msg.type !== "text") continue;

        const textObj = (msg.text ?? {}) as Record<string, unknown>;
        const body = ((textObj.body as string) ?? "").trim();
        if (!body) continue;

        const phone = (msg.from as string) ?? "";
        results.push({ from: phone, text: body, profile_name: profileNames.get(phone) ?? null });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------
// Graph API: descargar media (dos pasos) y enviar mensajes
// ---------------------------------------------------------------------

/** Descarga el contenido de un adjunto de WhatsApp.
 *
 * Meta requiere DOS llamadas: (1) resolver el media_id a una URL temporal
 * de descarga, (2) descargar esa URL — ambas con el mismo Bearer token.
 */
export async function downloadMediaFromMeta(
  mediaId: string,
  token: string,
): Promise<{ content: Uint8Array; mimeType: string }> {
  const headers = { Authorization: `Bearer ${token}` };

  const metaResp = await fetch(`${GRAPH_API_BASE}/${mediaId}`, { headers });
  if (!metaResp.ok) {
    throw new Error(`Graph API (resolver media): ${metaResp.status} ${metaResp.statusText}`);
  }
  const mediaInfo = await metaResp.json();

  const contentResp = await fetch(mediaInfo.url, { headers });
  if (!contentResp.ok) {
    throw new Error(`Graph API (descargar media): ${contentResp.status} ${contentResp.statusText}`);
  }
  const content = new Uint8Array(await contentResp.arrayBuffer());
  return { content, mimeType: mediaInfo.mime_type ?? "" };
}

/** Envía un mensaje de texto de vuelta al usuario vía Graph API. */
export async function sendWhatsappMessage(
  phone: string,
  message: string,
  token: string,
  phoneNumberId: string,
): Promise<unknown> {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Graph API (enviar mensaje): ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
}

// ---------------------------------------------------------------------
// Traducción de resultado de ingesta → mensaje de WhatsApp
// ---------------------------------------------------------------------

export interface IngestResultLike {
  estatus?: string;
  categoria?: string;
  hallazgos?: Array<{ mensaje: string }>;
}

/** Port 1:1 de _whatsapp_reply_text() en main.py — mismo mapeo exacto. */
export function whatsappReplyText(body: IngestResultLike): string {
  const estatus = body.estatus;
  const hallazgos = body.hallazgos ?? [];
  const primerMensaje = hallazgos.length > 0 ? hallazgos[0].mensaje : "";

  if (estatus === "valida") {
    return `✅ Factura recibida y clasificada como ${body.categoria}. ¡Gracias!`;
  }
  if (estatus === "advertencia") {
    return `⚠️ Factura recibida, pero: ${primerMensaje}`;
  }
  if (estatus === "rechazada") {
    return `❌ No pudimos procesar tu factura: ${primerMensaje}`;
  }
  if (estatus === "por_revisar") {
    return "📄 Recibimos tu PDF, pero necesitamos el XML para poder deducir esta factura.";
  }
  return "Recibimos tu mensaje, pero no encontramos ninguna factura válida.";
}
