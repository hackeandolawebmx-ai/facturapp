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
 * SendGrid Inbound Parse real envía `multipart/form-data`, no JSON. Hasta
 * M5 este módulo asumía un adaptador externo que normalizara el correo a la
 * forma JSON de abajo — igual que `email_service.py`, que tampoco lo tiene.
 * El resultado era que el canal de correo no funcionaba de punta a punta en
 * NINGUNA de las dos versiones.
 *
 * La Fase M9 cierra ese hueco: `parseSendgridFormData()` lee el
 * multipart real. Es una divergencia deliberada respecto a Python —
 * funcionalidad que el original no tiene— porque un webhook que no puede
 * recibir lo que su proveedor envía no está terminado, solo declarado.
 * La forma JSON se conserva y se sigue aceptando: es la que usan los tests
 * y cualquier relay existente.
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

/** Clasifica un nombre de archivo por extensión. `null` si no interesa. */
function tipoDeAdjunto(filename: string): "xml" | "pdf" | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".pdf")) return "pdf";
  return null;
}

export interface CorreoRecibido {
  from: string;
  to: string;
  subject: string;
  adjuntos: Partial<Record<"xml" | "pdf", Uint8Array>>;
}

/**
 * Convierte el `multipart/form-data` real de SendGrid Inbound Parse a la
 * forma que consume el webhook (Fase M9).
 *
 * SendGrid manda los campos del correo (`from`, `to`, `subject`) como
 * campos de texto, y cada adjunto como una parte binaria nombrada
 * `attachment1`, `attachment2`, etc.
 *
 * Los adjuntos salen directo como bytes, sin pasar por base64: en multipart
 * ya llegan binarios, y codificarlos solo para volver a decodificarlos sería
 * trabajo de más. Por eso devuelve el mismo shape que `extractAttachments()`
 * y no un `EmailWebhookPayload`.
 *
 * Se recorre TODA la FormData en vez de buscar `attachment1..N` por número:
 * el campo `attachments` que trae la cuenta puede faltar o no coincidir, y
 * confiar en él haría que un adjunto se perdiera en silencio.
 *
 * Misma regla que la variante JSON: máximo un adjunto por tipo, se queda con
 * el ÚLTIMO si llegan varios del mismo.
 */
export async function parseSendgridFormData(form: FormData): Promise<CorreoRecibido> {
  const texto = (clave: string): string => {
    const valor = form.get(clave);
    return typeof valor === "string" ? valor : "";
  };

  const adjuntos: Partial<Record<"xml" | "pdf", Uint8Array>> = {};
  for (const [, valor] of form.entries()) {
    if (typeof valor === "string") continue;
    const tipo = tipoDeAdjunto(valor.name ?? "");
    if (!tipo) continue;
    adjuntos[tipo] = new Uint8Array(await valor.arrayBuffer());
  }

  return {
    from: texto("from"),
    to: texto("to"),
    subject: texto("subject"),
    adjuntos,
  };
}
