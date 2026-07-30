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

/** Compara dos cadenas en tiempo constante.
 *
 * Una comparación normal (`===`) sale en el primer byte distinto, lo que
 * filtra por temporización cuántos caracteres del secreto se acertaron y
 * permite descubrirlo carácter por carácter. Se implementa a mano en vez de
 * usar `timingSafeEqual` de `node:crypto` para no depender de la capa de
 * compatibilidad con Node — mismo criterio adoptado tras el incidente de
 * `Buffer` (ver la nota en whatsapp.ts).
 */
function igualEnTiempoConstante(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diferencia = 0;
  for (let i = 0; i < bytesA.length; i++) diferencia |= bytesA[i] ^ bytesB[i];
  return diferencia === 0;
}

/**
 * Verifica que la petición venga de SendGrid, mediante un secreto compartido
 * (Fase M10).
 *
 * IMPORTANTE: SendGrid Inbound Parse **no firma sus peticiones**. A
 * diferencia de Meta (HMAC en `X-Hub-Signature-256`), aquí no hay nada
 * criptográfico que verificar contra el cuerpo. El Event Webhook de SendGrid
 * sí tiene firma ECDSA, pero Inbound Parse no — así que un secreto
 * compartido configurado en la URL de destino es la única opción real.
 *
 * Se aceptan dos formas, y el orden importa:
 *
 * 1. **Basic auth** (`https://facturapp:<secreto>@host/...` en la config de
 *    Inbound Parse). Preferida: las credenciales viajan en el header
 *    `Authorization`, fuera de la URL.
 * 2. **Query param** (`?secret=<secreto>`). Funciona, pero Supabase registra
 *    la URL completa en los logs de invocación, así que el secreto queda
 *    escrito en ellos. Se admite por compatibilidad con relays que no puedan
 *    mandar headers; no es la opción recomendada.
 *
 * Limitación honesta: esto autentica el ORIGEN, no el contenido. Quien tenga
 * el secreto puede mandar el correo que quiera. Es estrictamente mejor que
 * no tener nada —que es donde estaba— pero no equivale a la firma HMAC de
 * WhatsApp, que además garantiza que el cuerpo no fue alterado.
 */
export function verificarOrigenSendgrid(
  req: Request,
  secretoEsperado: string,
): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    try {
      const decodificado = atob(auth.slice("Basic ".length));
      // Formato "usuario:contraseña" — el usuario da igual, solo importa el
      // secreto. Se parte en el PRIMER ":" por si el secreto contiene otros.
      const separador = decodificado.indexOf(":");
      const secreto = separador === -1 ? decodificado : decodificado.slice(separador + 1);
      if (igualEnTiempoConstante(secreto, secretoEsperado)) return true;
    } catch {
      // Basic mal formado: se ignora y se intenta con el query param.
    }
  }

  const enQuery = new URL(req.url).searchParams.get("secret");
  return enQuery !== null && igualEnTiempoConstante(enQuery, secretoEsperado);
}

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
