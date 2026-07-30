/**
 * Ingesta de facturas por correo (Fase M5) — port 1:1 de
 * facturapp/facturapp/email_service.py.
 *
 * Contraparte de whatsapp.ts para el canal de correo (SendGrid). Dos
 * responsabilidades puras (la resolución de usuario vive en users.ts,
 * igual que con el teléfono):
 * - Extraer la dirección de un remitente tipo `"Nombre" <correo@dominio>`.
 * - Decodificar y clasificar los adjuntos (XML/PDF) del payload.
 *
 * ⚠️ NOTA (igual que en la versión Python — ver README): SendGrid Inbound
 * Parse real envía `multipart/form-data`, no JSON. Este módulo asume un
 * adaptador/relay que ya normalizó el correo a la forma JSON de abajo — no
 * se construyó un parser de multipart nuevo aquí, porque el sistema de
 * referencia (email_service.py) tampoco lo tiene; hacerlo ahora habría sido
 * inventar comportamiento que no existe en el original.
 */

/** Decodifica base64 a bytes con `atob`, que es estándar web.
 *
 * Antes esto usaba `Buffer.from(content, "base64")`. `Buffer` no existe en
 * el runtime de Supabase Edge Functions (sí en el Deno local, por eso los
 * tests no lo detectaban), e importarlo de `node:buffer` rompe la carga del
 * módulo. Ver la nota equivalente en whatsapp.ts: hexToBytes.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) {
    bytes[i] = binario.charCodeAt(i);
  }
  return bytes;
}

export interface EmailAttachment {
  filename: string;
  content: string; // base64
}

export interface EmailWebhookPayload {
  from: string;
  to: string;
  subject?: string;
  attachments: EmailAttachment[];
}

const EMAIL_IN_BRACKETS_RE = /<([^<>]+)>/;
const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}$/;

/** Extrae la dirección de un remitente tipo `"Nombre" <correo@dominio.com>`.
 * Si no hay `<...>`, asume que `rawFrom` ya es la dirección pura. */
export function extractSenderEmail(rawFrom: string): string {
  const match = EMAIL_IN_BRACKETS_RE.exec(rawFrom);
  const address = match ? match[1] : rawFrom;
  return address.trim().toLowerCase();
}

/** Decodifica los adjuntos base64 y los clasifica por tipo (xml/pdf) según
 * la EXTENSIÓN del filename (no el mime type).
 *
 * Devuelve como máximo un adjunto por tipo: si el correo trae varios del
 * mismo tipo, se queda con el ÚLTIMO (mismo comportamiento que el dict de
 * Python — no es una lista de "todos los adjuntos procesados"). Adjuntos
 * que no decodifican como base64 válido se ignoran silenciosamente.
 */
export function extractAttachments(
  webhook: EmailWebhookPayload,
): Partial<Record<"xml" | "pdf", Uint8Array>> {
  const result: Partial<Record<"xml" | "pdf", Uint8Array>> = {};

  for (const att of webhook.attachments) {
    const name = att.filename.toLowerCase();
    if (!BASE64_RE.test(att.content)) continue;

    let content: Uint8Array;
    try {
      content = base64ToBytes(att.content);
    } catch {
      continue;
    }

    if (name.endsWith(".xml")) {
      result.xml = content;
    } else if (name.endsWith(".pdf")) {
      result.pdf = content;
    }
  }
  return result;
}
