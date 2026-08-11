
// ===== supabase/functions/_shared/cors.ts =====
// Fase M1 — Headers CORS compartidos entre Edge Functions.
//
// NOTA: los webhooks de SendGrid/Meta son llamadas servidor-a-servidor, no
// están sujetas a CORS (eso es una restricción de navegador). Este helper
// existe sobre todo por si en el futuro alguna función se llama desde un
// navegador (dashboard, herramienta de pruebas) — es el boilerplate estándar
// que genera `supabase functions new`.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

// ===== supabase/functions/_shared/accounts.ts =====
/**
 * Aprovisionamiento de cuentas mínimas (Fase M4) — port 1:1 de
 * facturapp/facturapp/accounts.py.
 *
 * Lógica compartida entre el webhook de WhatsApp (M4) y el de SendGrid (M5)
 * para crear cuentas cuando un usuario envía una factura antes de haberse
 * registrado formalmente.
 */
import { createHash } from "node:crypto";

/** RFC sintético, único y determinístico (13 caracteres) para cuentas
 * auto-creadas. `seed` puede ser el email o el teléfono del usuario.
 *
 * No pasa por el validador estricto de registro — el usuario debe completar
 * su RFC real desde su perfil antes de usar sus deducciones formalmente.
 *
 * Síncrono (como en Python) — usamos `node:crypto` en vez de Web Crypto
 * (`crypto.subtle`) porque este último es async-only; forzar `await` en
 * cada llamada de esta función determinística no aporta nada.
 */
function placeholderRfc(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf-8").digest("hex").toUpperCase();
  return `PEND${hex.slice(0, 9)}`;
}

// ===== supabase/functions/_shared/parser.ts =====
/**
 * Parser de CFDI 4.0 → objeto plano (Fase M2).
 *
 * Port 1:1 de facturapp/facturapp/parser.py (Fase 1). Usa @libs/xml (JSR)
 * en vez de lxml. Mismo shape de salida, mismos casos de error.
 *
 * DIVERGENCIAS DECLARADAS respecto a la versión Python (ninguna silenciosa):
 *
 * 1. Resolución de namespaces por PREFIJO LITERAL, no por URI.
 *    lxml resuelve `cfdi:Emisor` vía la URI real del namespace
 *    (http://www.sat.gob.mx/cfd/4), sin importar qué prefijo use el
 *    documento (aceptaría <foo:Emisor xmlns:foo="...cfd/4">). Aquí se
 *    matchea literalmente contra los prefijos `cfdi:` y `tfd:` — que son
 *    los únicos que usa CUALQUIER PAC certificado del SAT en la práctica
 *    (son, de facto, un estándar fijo en todo el ecosistema CFDI). Resolver
 *    por URI real requeriría construir un mapa de prefijos a partir de los
 *    atributos `@xmlns:*` en cada nivel del árbol — complejidad adicional
 *    para un caso que no ocurre en la práctica real.
 *
 * 2. Los campos de texto opcionales (emisor_nombre, uso_cfdi, forma_pago,
 *    metodo_pago, clave_prod_principal, concepto_descripcion) son SIEMPRE
 *    `string` (cadena vacía `""` si faltan) — NUNCA `null`/`undefined`.
 *    Esto refleja el comportamiento REAL de parser.py (`emisor.get(...) or
 *    ""`), no la interfaz `string | null` propuesta inicialmente para esta
 *    fase, que no correspondía con lo que la versión Python realmente hace.
 */

import { parse as parseXml } from "jsr:@libs/xml@8/parse";

class CFDIParseError extends Error {
  constructor(message: string, public detalle?: string) {
    super(message);
    this.name = "CFDIParseError";
  }
}

interface ParsedInvoice {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  receptor_rfc: string;
  fecha_emision: string;
  subtotal: number;
  iva: number;
  total: number;
  uso_cfdi: string;
  forma_pago: string;
  metodo_pago: string;
  clave_prod_principal: string;
  concepto_descripcion: string;
  raw_xml: string;
}

// ---------------------------------------------------------------------
// Helpers de bajo nivel (equivalentes a los que ofrece lxml implícitamente)
// ---------------------------------------------------------------------

/** Nodo XML parseado por @libs/xml: attrs como "@Nombre", hijos anidados. */
type XmlNode = Record<string, unknown>;

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0.0;
  const n = Number(value);
  return Number.isNaN(n) ? 0.0 : n;
}

/** Normaliza un valor que puede venir como objeto único o array (cuando hay
 * varios hijos con el mismo nombre) a SIEMPRE un array — equivalente a
 * root.findall() en Python. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Toma el primer elemento si es array, o el objeto tal cual si no lo es —
 * equivalente a root.find() en Python (siempre el PRIMER match). */
function firstOf<T>(value: T | T[] | undefined): T | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function attr(node: XmlNode | undefined, name: string): string {
  if (!node) return "";
  const v = node[`@${name}`];
  return v === undefined || v === null ? "" : String(v);
}

// ---------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------

function parseCfdi(contenido: Uint8Array | string): ParsedInvoice {
  const raw =
    typeof contenido === "string" ? contenido : new TextDecoder("utf-8").decode(contenido);

  let doc: XmlNode;
  try {
    doc = parseXml(raw) as unknown as XmlNode;
  } catch (exc) {
    throw new CFDIParseError(`XML mal formado: ${(exc as Error).message}`, String(exc));
  }

  // Busca la clave de nivel superior cuyo nombre local (después de ":")
  // sea "Comprobante" — equivalente a root.tag.endswith("}Comprobante").
  const rootKey = Object.keys(doc).find((k) => k.split(":").pop() === "Comprobante");
  const root = rootKey ? (doc[rootKey] as XmlNode) : undefined;

  if (!root) {
    throw new CFDIParseError("El nodo raíz no es cfdi:Comprobante");
  }

  const emisor = root["cfdi:Emisor"] as XmlNode | undefined;
  const receptor = root["cfdi:Receptor"] as XmlNode | undefined;
  const conceptos = root["cfdi:Conceptos"] as XmlNode | undefined;
  const concepto = firstOf(conceptos?.["cfdi:Concepto"] as XmlNode | XmlNode[] | undefined);
  const complemento = root["cfdi:Complemento"] as XmlNode | undefined;
  const tfd = complemento?.["tfd:TimbreFiscalDigital"] as XmlNode | undefined;

  if (!tfd) {
    throw new CFDIParseError("Falta el nodo TimbreFiscalDigital (no timbrado)");
  }

  const uuid = attr(tfd, "UUID");
  if (!uuid) {
    throw new CFDIParseError("El TimbreFiscalDigital no contiene UUID");
  }

  if (!emisor || !receptor) {
    throw new CFDIParseError("Faltan nodos Emisor o Receptor");
  }

  // IVA = suma de traslados a nivel comprobante (NO los de dentro de
  // Conceptos/Concepto — mismo alcance que root.findall(...) en Python).
  const impuestos = root["cfdi:Impuestos"] as XmlNode | undefined;
  const traslados = impuestos?.["cfdi:Traslados"] as XmlNode | undefined;
  const trasladoList = asArray(traslados?.["cfdi:Traslado"] as XmlNode | XmlNode[] | undefined);
  let iva = 0.0;
  for (const traslado of trasladoList) {
    iva += toFloat(traslado[`@Importe`]);
  }

  const fecha = attr(root, "Fecha");
  const fechaEmision = fecha ? fecha.split("T")[0] : "";

  return {
    uuid: uuid.toUpperCase(),
    emisor_rfc: attr(emisor, "Rfc").toUpperCase(),
    emisor_nombre: attr(emisor, "Nombre"),
    receptor_rfc: attr(receptor, "Rfc").toUpperCase(),
    fecha_emision: fechaEmision,
    subtotal: toFloat(root["@SubTotal"]),
    iva: Math.round(iva * 100) / 100,
    total: toFloat(root["@Total"]),
    uso_cfdi: attr(receptor, "UsoCFDI"),
    forma_pago: attr(root, "FormaPago"),
    metodo_pago: attr(root, "MetodoPago"),
    clave_prod_principal: attr(concepto, "ClaveProdServ"),
    concepto_descripcion: attr(concepto, "Descripcion"),
    raw_xml: raw,
  };
}

// ===== supabase/functions/_shared/validator.ts =====
/**
 * Motor de validación — 5 reglas CFDI para deducciones (Fase M3).
 *
 * Port 1:1 de facturapp/facturapp/validator.py.
 *
 * NOTA sobre "7 reglas": el sistema completo tiene 7 códigos de hallazgo,
 * pero solo 5 viven dentro del motor de validación — las otras 2
 * (XML_MAL_FORMADO, PDF_SIN_XML) ocurren antes/fuera de este módulo (en el
 * parser y en el handler del webhook, respectivamente). Igual que en
 * Python: ValidationEngine.validate() solo corre 5 reglas.
 *
 * DIVERGENCIAS DECLARADAS respecto al spec original de esta fase:
 * 1. `hallazgos` es `Hallazgo[]` (objetos {codigo, severidad, mensaje}),
 *    NO `string[]`. El campo `mensaje` es lo que el usuario final lee en
 *    las respuestas de los webhooks — perderlo habría sido una regresión.
 * 2. `validate()` NO es async — no hay ninguna operación asíncrona real
 *    (Python tampoco la tiene). UUID_DUPLICADO sigue recibiendo el set de
 *    UUIDs ya resuelto como dato plano, igual que en Python — quien llame
 *    a esto (el webhook handler, en M4) resuelve la consulta a BD antes.
 */


const SEV_VALIDA = "valida";
const SEV_ADVERTENCIA = "advertencia";
const SEV_POR_REVISAR = "por_revisar";
const SEV_RECHAZADA = "rechazada";

type Severidad =
  | typeof SEV_VALIDA
  | typeof SEV_ADVERTENCIA
  | typeof SEV_POR_REVISAR
  | typeof SEV_RECHAZADA;

const PRIORIDAD: Record<Severidad, number> = {
  [SEV_VALIDA]: 0,
  [SEV_POR_REVISAR]: 1,
  [SEV_ADVERTENCIA]: 2,
  [SEV_RECHAZADA]: 3,
};

// Categorías donde el SAT exige pago electrónico.
const CATEGORIAS_PAGO_ELECTRONICO = new Set(["Médicos", "Colegiaturas", "Seguros GMM"]);
// Usos de CFDI genéricos que no permiten deducir.
const USOS_GENERICOS = new Set(["G03", "S01"]);
// Prefijos de ClaveProdServ que "parecen deducibles".
const PREFIJOS_DEDUCIBLES = ["62", "84", "51", "23", "85"];
// Palabras que evidencian un emisor del ramo médico.
const KEYWORDS_MEDICO = [
  "medic", "médic", "doctor", "dr.", "dra.", "dental", "dentista",
  "psic", "hospital", "clinic", "clínic", "consultorio", "salud",
];

interface Hallazgo {
  codigo: string;
  severidad: Severidad;
  mensaje: string;
}

interface ValidationResult {
  status: Severidad;
  categoria: string;
  hallazgos: Hallazgo[];
}

/** Los tests de Python (y los de acá) usan tanto ParsedInvoice completos
 * como dicts/objetos sueltos con solo algunos campos — igual que Python,
 * que recibe cualquier dict. Por eso Partial, no ParsedInvoice a secas. */
type InvoiceLike = Partial<ParsedInvoice>;

interface ValidateContext {
  fechaPrevia?: string | null;
}

class ValidationEngine {
  private userRfc: string;
  private existingUuids: Set<string>;
  private classify: (inv: InvoiceLike) => ClassificationResult;

  constructor(
    userRfc: string,
    existingUuids: string[] = [],
    classify: (inv: InvoiceLike) => ClassificationResult = classifyInvoice,
  ) {
    this.userRfc = userRfc.toUpperCase();
    this.existingUuids = new Set(existingUuids.map((u) => u.toUpperCase()));
    this.classify = classify;
  }

  // ---- Reglas individuales ------------------------------------------------

  private reglaUuidDuplicado(inv: InvoiceLike, ctx: ValidateContext): Hallazgo | null {
    if (this.existingUuids.has((inv.uuid ?? "").toUpperCase())) {
      const fecha = ctx.fechaPrevia || inv.fecha_emision || "";
      return {
        codigo: "UUID_DUPLICADO",
        severidad: SEV_RECHAZADA,
        mensaje: `Ya tenías registrada esta factura (recibida el ${fecha})`,
      };
    }
    return null;
  }

  private reglaRfcAjeno(inv: InvoiceLike): Hallazgo | null {
    if ((inv.receptor_rfc ?? "").toUpperCase() !== this.userRfc) {
      return {
        codigo: "RFC_AJENO",
        severidad: SEV_ADVERTENCIA,
        mensaje: `Factura emitida a RFC ${inv.receptor_rfc ?? ""}; no será deducible`,
      };
    }
    return null;
  }

  private reglaPagoEfectivo(inv: InvoiceLike, categoria: string): Hallazgo | null {
    if (inv.forma_pago === "01" && CATEGORIAS_PAGO_ELECTRONICO.has(categoria)) {
      return {
        codigo: "PAGO_EFECTIVO",
        severidad: SEV_ADVERTENCIA,
        mensaje:
          "Pagada en efectivo: SAT no acepta como deducible. Pide refacturación con pago electrónico",
      };
    }
    return null;
  }

  private reglaUsoCfdiIncorrecto(inv: InvoiceLike): Hallazgo | null {
    const clave = inv.clave_prod_principal ?? "";
    const pareceDeducible = PREFIJOS_DEDUCIBLES.some((p) => clave.startsWith(p));
    if (inv.uso_cfdi !== undefined && USOS_GENERICOS.has(inv.uso_cfdi) && pareceDeducible) {
      return {
        codigo: "USO_CFDI_INCORRECTO",
        severidad: SEV_ADVERTENCIA,
        mensaje: "Uso de CFDI incorrecto (esperado D02); pide corrección al emisor",
      };
    }
    return null;
  }

  private reglaEmisorSinEspecialidad(inv: InvoiceLike, categoria: string): Hallazgo | null {
    if (categoria === "Médicos") {
      const nombre = (inv.emisor_nombre ?? "").toLowerCase();
      if (!KEYWORDS_MEDICO.some((k) => nombre.includes(k))) {
        return {
          codigo: "EMISOR_SIN_ESPECIALIDAD",
          severidad: SEV_POR_REVISAR,
          mensaje: "El SAT exige que el emisor sea profesional colegiado; verifica que tenga cédula",
        };
      }
    }
    return null;
  }

  // ---- Orquestación --------------------------------------------------------

  validate(invoice: InvoiceLike, fechaPrevia: string | null = null): ValidationResult {
    const { categoria } = this.classify(invoice);
    const ctx: ValidateContext = { fechaPrevia };

    const checks: Array<() => Hallazgo | null> = [
      () => this.reglaUuidDuplicado(invoice, ctx),
      () => this.reglaRfcAjeno(invoice),
      () => this.reglaPagoEfectivo(invoice, categoria),
      () => this.reglaUsoCfdiIncorrecto(invoice),
      () => this.reglaEmisorSinEspecialidad(invoice, categoria),
    ];

    const hallazgos: Hallazgo[] = [];
    for (const check of checks) {
      const h = check();
      if (h) hallazgos.push(h);
    }

    let status: Severidad = SEV_VALIDA;
    for (const h of hallazgos) {
      if (PRIORIDAD[h.severidad] > PRIORIDAD[status]) status = h.severidad;
    }

    return { status, categoria, hallazgos };
  }
}

// ===== supabase/functions/_shared/classifier.ts =====
/**
 * Clasificador determinístico de facturas → categoría de deducción (Fase M3).
 *
 * Port 1:1 de facturapp/facturapp/classifier.py.
 *
 * DIVERGENCIA DECLARADA respecto al spec original de esta fase: NO existe
 * ninguna tabla `deduction_rules` en el sistema actual — classifier.py es
 * una lista de reglas EN MEMORIA, matcheando (uso_cfdi exacto + prefijo de
 * clave_prod_principal) combinados. El mismo prefijo puede mapear a
 * categorías distintas según el uso_cfdi (p. ej. "84" → Colegiaturas con
 * D02/D10, pero Seguros GMM con D07) — una tabla keyed solo por producto
 * no puede representar esto sin perder información. Se porta tal cual:
 * lista en memoria, no tabla Postgres.
 */

const SIN_CLASIFICAR = "Sin clasificar";

interface Rule {
  usoCfdi: string;
  claveProdPrefix: string;
  categoria: string;
}

// Mismo orden que Python — el primer match gana.
const RULES: Rule[] = [
  { usoCfdi: "D02", claveProdPrefix: "62", categoria: "Médicos" },
  { usoCfdi: "D02", claveProdPrefix: "85", categoria: "Médicos" },
  { usoCfdi: "D01", claveProdPrefix: "62", categoria: "Médicos" },
  { usoCfdi: "D02", claveProdPrefix: "84", categoria: "Colegiaturas" },
  { usoCfdi: "D10", claveProdPrefix: "84", categoria: "Colegiaturas" },
  { usoCfdi: "D02", claveProdPrefix: "51", categoria: "Seguros GMM" },
  { usoCfdi: "D07", claveProdPrefix: "84", categoria: "Seguros GMM" },
  { usoCfdi: "D02", claveProdPrefix: "23", categoria: "Hipoteca" },
  { usoCfdi: "D05", claveProdPrefix: "23", categoria: "Hipoteca" },
];

interface ClassificationResult {
  categoria: string;
  origen: "regla" | "ninguno";
  confianza: number;
}

interface ClassifiableInvoice {
  uso_cfdi?: string;
  clave_prod_principal?: string;
}

/** Devuelve (categoria, origen, confianza) — mismo shape que Classifier.classify()
 * en Python (ahí es una tupla; aquí un objeto, más explícito en TS). */
function classifyInvoice(invoice: ClassifiableInvoice): ClassificationResult {
  const uso = invoice.uso_cfdi ?? "";
  const clave = invoice.clave_prod_principal ?? "";
  for (const rule of RULES) {
    if (uso === rule.usoCfdi && clave.startsWith(rule.claveProdPrefix)) {
      return { categoria: rule.categoria, origen: "regla", confianza: 0.95 };
    }
  }
  return { categoria: SIN_CLASIFICAR, origen: "ninguno", confianza: 0.0 };
}

// ===== supabase/functions/_shared/whatsapp.ts =====
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
function verifyWhatsappSignature(
  body: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expectedHex = createHmac("sha256", appSecret).update(body).digest("hex");
  const providedHex = signatureHeader.slice("sha256=".length);

  // Comparación en tiempo constante — timingSafeEqual exige buffers del
  // mismo tamaño; si no coinciden en longitud, ya sabemos que es inválida
  // (comparar tamaños es seguro, no depende del contenido del secreto).
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------
// Extracción de mensajes del payload de Meta
// ---------------------------------------------------------------------

interface ExtractedMessage {
  from: string;
  media_id: string;
  mime_type: string;
  filename: string;
  profile_name: string | null;
}

/** Recorre entry → changes → value → messages y devuelve solo los mensajes
 * de tipo "document" con su remitente y media_id. */
function extractWhatsappMessages(payload: { entry?: unknown[] }): ExtractedMessage[] {
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

interface ExtractedTextMessage {
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
function extractWhatsappTextMessages(payload: { entry?: unknown[] }): ExtractedTextMessage[] {
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
async function downloadMediaFromMeta(
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
async function sendWhatsappMessage(
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

interface IngestResultLike {
  estatus?: string;
  categoria?: string;
  hallazgos?: Array<{ mensaje: string }>;
}

/** Port 1:1 de _whatsapp_reply_text() en main.py — mismo mapeo exacto. */
function whatsappReplyText(body: IngestResultLike): string {
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

// ===== supabase/functions/_shared/whatsapp_commands.ts =====
/**
 * Comandos rápidos de WhatsApp, sin IA (Fase M4b).
 *
 * Corre ANTES de llamar a OpenAI — ahorra latencia y costo en los mensajes
 * más comunes (saludo, ayuda). Patrón adoptado de
 * WHATSAPP_BOT_ARCHITECTURE.md (`interceptQuickCommand` del bot probado en
 * producción de otro proyecto en el mismo Supabase). No existe en el
 * sistema Python original — es parte de la extensión de chat vía WhatsApp
 * (ver whatsapp.ts: extractWhatsappTextMessages).
 *
 * Deliberadamente conservador: solo intercepta mensajes cortos que
 * coinciden EXACTO con un saludo o pedido de ayuda, para no interceptar por
 * error una pregunta real ("hola, cuánto llevo en médicos" debe llegar a
 * OpenAI, no cortarse en el saludo).
 */

const GREETING = /^(hola|buenas|hey|buen[oa]s?\s*d[ií]as?|buenas\s*tardes|buenas\s*noches)[\s!.]*$/i;
const HELP = /^(ayuda|help|comandos?|qu[eé]\s*puedes\s*hacer)[\s?!.]*$/i;

const GREETING_REPLY =
  "¡Hola! 🧾 Soy el asistente de Facturino. Mándame el XML de una factura " +
  "para registrarla, o pregúntame cosas como \"¿cuánto llevo en médicos?\" " +
  "o \"mis facturas de este mes\". Escribe *ayuda* para ver todo lo que puedo hacer.";

const HELP_REPLY =
  "Puedo ayudarte a:\n" +
  "• Registrar una factura (envía el XML como documento)\n" +
  "• Darte tu resumen de deducciones (\"¿cuánto llevo?\")\n" +
  "• Listar tus facturas (\"mis facturas de julio\")\n" +
  "• Reclasificar una factura (\"cambia esa factura a médicos\")\n" +
  "• Explicarte qué es deducible (\"¿qué puedo deducir?\")";

/** Devuelve la respuesta del comando rápido, o `null` si el mensaje debe
 * pasar a chat() con OpenAI. */
function interceptQuickCommand(text: string): string | null {
  const trimmed = text.trim();
  if (GREETING.test(trimmed)) return GREETING_REPLY;
  if (HELP.test(trimmed)) return HELP_REPLY;
  return null;
}

// ===== supabase/functions/_shared/users.ts =====
/**
 * Resolución de usuario por canal de ingesta (Fase M4/M5).
 *
 * Port 1:1 de get_or_create_user_by_phone() y get_or_create_user_by_email()
 * en whatsapp_service.py / email_service.py.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface AppUser {
  id: number;
  rfc: string;
}

function placeholderEmailForPhone(phone: string): string {
  return `wa-${phone}@facturapp.mx`;
}

/** Busca al usuario por teléfono de WhatsApp; si no existe, crea una cuenta
 * mínima (RFC placeholder, sin password utilizable — no habilita login
 * directo, solo permite asociar facturas hasta que el usuario se registre). */
async function getOrCreateUserByPhone(
  supabase: SupabaseClient,
  phone: string,
  profileName: string | null,
): Promise<AppUser> {
  const trimmedPhone = phone.trim();

  const { data: existing, error: selectError } = await supabase
    .schema("facturapp")
    .from("users")
    .select("id, rfc")
    .eq("whatsapp_phone", trimmedPhone)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Error buscando usuario por teléfono: ${selectError.message}`);
  }
  if (existing) {
    return existing as AppUser;
  }

  const { data: created, error: insertError } = await supabase
    .schema("facturapp")
    .from("users")
    .insert({
      email: placeholderEmailForPhone(trimmedPhone),
      nombre: profileName || trimmedPhone,
      rfc: placeholderRfc(trimmedPhone),
      web_token: crypto.randomUUID(),
      whatsapp_phone: trimmedPhone,
      // hashed_password: NULL — la migración 0001 lo permite nullable
      // explícitamente para cuentas auto-creadas (ver 0001_initial_schema.sql).
    })
    .select("id, rfc")
    .single();

  if (insertError || !created) {
    throw new Error(`Error creando usuario por teléfono: ${insertError?.message}`);
  }
  return created as AppUser;
}

/** Busca al usuario por email; si no existe, crea una cuenta mínima.
 *
 * La cuenta auto-creada recibe un `web_token` aleatorio y ningún password
 * utilizable — no habilita login directo, solo permite asociar facturas al
 * correo hasta que el usuario complete su registro real.
 *
 * NOTA: a diferencia de getOrCreateUserByPhone, esta función NO recibe un
 * `nombre` — igual que en Python, siempre se deriva de la parte local del
 * email (`email.split("@")[0]`). SendGrid no manda un "profile name" como
 * sí lo hace el payload de contactos de WhatsApp.
 */
async function getOrCreateUserByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<AppUser> {
  const normalizedEmail = email.trim().toLowerCase();

  const { data: existing, error: selectError } = await supabase
    .schema("facturapp")
    .from("users")
    .select("id, rfc")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Error buscando usuario por email: ${selectError.message}`);
  }
  if (existing) {
    return existing as AppUser;
  }

  const { data: created, error: insertError } = await supabase
    .schema("facturapp")
    .from("users")
    .insert({
      email: normalizedEmail,
      nombre: normalizedEmail.split("@")[0],
      rfc: placeholderRfc(normalizedEmail),
      web_token: crypto.randomUUID(),
      // hashed_password: NULL — igual que en getOrCreateUserByPhone.
    })
    .select("id, rfc")
    .single();

  if (insertError || !created) {
    throw new Error(`Error creando usuario por email: ${insertError?.message}`);
  }
  return created as AppUser;
}

// ===== supabase/functions/_shared/invoices.ts =====
/**
 * Ingesta compartida de facturas (Fase M4/M5) — port 1:1 de
 * `_ingest_invoice()` en facturapp/facturapp/main.py.
 *
 * Un solo lugar para parsear + validar + clasificar + guardar, usado tanto
 * por el webhook de WhatsApp (M4) como el de SendGrid (M5) — misma razón
 * que en Python: que la lógica de negocio no viva duplicada en dos sitios.
 */

/** Port de `_anio_de()` en main.py: primeros 4 dígitos de fecha_emision. */
function anioDeFecha(fechaEmision: string): number {
  const anio = parseInt(fechaEmision.slice(0, 4), 10);
  return Number.isNaN(anio) ? new Date().getUTCFullYear() : anio;
}

interface IngestResult {
  status_code: number;
  uuid: string | null;
  estatus: string;
  categoria?: string;
  hallazgos: Array<{ codigo: string; severidad: string; mensaje: string; detalle?: string }>;
}

/** UUIDs de facturas existentes DE ESTE usuario (aislamiento). */
async function getExistingUuids(supabase: SupabaseClient, userId: number): Promise<string[]> {
  const { data, error } = await supabase
    .schema("facturapp")
    .from("invoices")
    .select("uuid_fiscal")
    .eq("user_id", userId);
  if (error) throw new Error(`Error consultando UUIDs existentes: ${error.message}`);
  return (data ?? []).map((row) => row.uuid_fiscal as string);
}

/** Fecha de una factura previa con el mismo UUID (para el mensaje de
 * UUID_DUPLICADO) — igual que la consulta `previa` en Python. */
async function getFechaPrevia(
  supabase: SupabaseClient,
  userId: number,
  uuid: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("facturapp")
    .from("invoices")
    .select("fecha_emision")
    .eq("user_id", userId)
    .eq("uuid_fiscal", uuid)
    .maybeSingle();
  if (error) throw new Error(`Error consultando factura previa: ${error.message}`);
  return data ? (data.fecha_emision as string) : null;
}

/** Parsea, valida, clasifica y guarda un CFDI para `user`. Devuelve el mismo
 * shape que `_ingest_invoice()` en Python (status_code + body). */
async function ingestInvoice(
  supabase: SupabaseClient,
  user: AppUser & { id: number },
  contenido: Uint8Array,
  filename: string,
): Promise<IngestResult> {
  const nombre = (filename || "").toLowerCase();
  const esPdf =
    nombre.endsWith(".pdf") ||
    (contenido.length >= 5 && new TextDecoder().decode(contenido.slice(0, 5)) === "%PDF-");

  if (esPdf) {
    return {
      status_code: 202,
      uuid: null,
      estatus: SEV_POR_REVISAR,
      hallazgos: [{
        codigo: "PDF_SIN_XML",
        severidad: SEV_POR_REVISAR,
        mensaje: "Solo recibimos el PDF. Necesitas el XML para deducir; pídelo al emisor",
      }],
    };
  }

  let invoice;
  try {
    invoice = parseCfdi(contenido);
  } catch (exc) {
    if (exc instanceof CFDIParseError) {
      return {
        status_code: 422,
        uuid: null,
        estatus: SEV_RECHAZADA,
        hallazgos: [{
          codigo: "XML_MAL_FORMADO",
          severidad: SEV_RECHAZADA,
          mensaje: "XML inválido o no es CFDI 4.0. Pídelo de nuevo al emisor",
          detalle: exc.message,
        }],
      };
    }
    throw exc;
  }

  const existingUuids = await getExistingUuids(supabase, user.id);
  const fechaPrevia = await getFechaPrevia(supabase, user.id, invoice.uuid);

  const engine = new ValidationEngine(user.rfc, existingUuids);
  const resultado = engine.validate(invoice, fechaPrevia);
  const { confianza } = classifyInvoice(invoice);

  if (resultado.status !== SEV_RECHAZADA) {
    const { error: insertError } = await supabase
      .schema("facturapp")
      .from("invoices")
      .insert({
        user_id: user.id,
        uuid_fiscal: invoice.uuid,
        usuario_rfc: user.rfc,
        emisor_rfc: invoice.emisor_rfc,
        emisor_nombre: invoice.emisor_nombre,
        receptor_rfc: invoice.receptor_rfc,
        fecha_emision: invoice.fecha_emision,
        anio: anioDeFecha(invoice.fecha_emision),
        subtotal: invoice.subtotal,
        iva: invoice.iva,
        total: invoice.total,
        uso_cfdi: invoice.uso_cfdi,
        forma_pago: invoice.forma_pago,
        metodo_pago: invoice.metodo_pago,
        clave_prod_principal: invoice.clave_prod_principal,
        concepto_descripcion: invoice.concepto_descripcion,
        categoria: resultado.categoria,
        confianza,
        estatus: resultado.status,
        hallazgos: resultado.hallazgos,
        raw_xml: invoice.raw_xml,
      });
    if (insertError) throw new Error(`Error guardando factura: ${insertError.message}`);
  }

  return {
    status_code: 200,
    uuid: invoice.uuid,
    estatus: resultado.status,
    categoria: resultado.categoria,
    hallazgos: resultado.hallazgos,
  };
}

// ===== supabase/functions/_shared/debug_log.ts =====
/**
 * Logging de diagnóstico a `facturapp.debug_logs` (Fase M4b).
 *
 * Adoptado del patrón probado en producción de WHATSAPP_BOT_ARCHITECTURE.md
 * (bot de otro proyecto en el mismo Supabase) — persiste eventos clave del
 * webhook (firma inválida, errores de Meta/OpenAI) en una tabla en vez de
 * depender solo de `supabase functions logs`, que rota rápido.
 *
 * No existe equivalente en el sistema Python original — es una mejora de
 * observabilidad para el canal de WhatsApp, no un port. Nunca debe
 * interrumpir el flujo del webhook: un fallo al escribir el log se traga y
 * se reporta por console.error, no se relanza.
 */

async function logDebug(
  supabase: SupabaseClient,
  message: string,
  payload?: unknown,
): Promise<void> {
  try {
    await supabase
      .schema("facturapp")
      .from("debug_logs")
      .insert({ message, payload: payload ?? null });
  } catch (exc) {
    console.error("No se pudo escribir en debug_logs:", exc);
  }
}

// ===== supabase/functions/_shared/chat.ts =====
/**
 * Chat conversacional con OpenAI (function calling) — Fase M5.5.
 *
 * Port 1:1 de facturapp/facturapp/chat.py.
 *
 * DIVERGENCIAS DECLARADAS respecto al spec original de esta fase:
 *
 * 1. NO se pasa historial de conversación a OpenAI. Se revisó `chat.py`
 *    línea por línea: cada llamada a `chat()` construye un `messages` nuevo
 *    con solo `[system, user_message]` — no consulta `chat_messages` para
 *    dar contexto. El spec asumía que "la versión Python ya hace esto" —
 *    no es así; se porta la ausencia de historial tal cual, no la versión
 *    "recomendada" que el spec sugería como alternativa.
 * 2. NO existe `execute_intent()`. El entry point real es `chat()`, que
 *    llama a OpenAI directo con function calling — no hay un paso previo
 *    de clasificar intención que condicione la llamada. `classify_intent`/
 *    `ChatIntent` SÍ existen en Python, pero son código huérfano: nunca se
 *    invocan desde `chat()` ni desde el endpoint. Se portan de todos modos
 *    (Python los testea por separado) pero NO se usan para orquestar nada.
 * 3. `reclassify_invoice` recibe `uuid` (string, `uuid_fiscal`), no un
 *    `invoice_id` numérico como proponía el spec — así es como Python
 *    identifica la factura.
 * 4. `export_package` es un MOCK real en Python (`export.py` devuelve
 *    `{formato, archivos, status: "mock_fase4"}`, sin generar ningún ZIP).
 *    Se porta el mock tal cual — construir un ZIP real ahora sería
 *    adelantar la Fase 4, no portar el sistema actual.
 * 5. La forma de la respuesta es `{response: string, tools_used: string[]}`
 *    — no `{response, metadata: {intent, function_called}}` como sugería
 *    el spec; ese campo `metadata` no existe en `ChatResponse` de Python.
 *
 * EXTENSIÓN (Fase M4b, NO en Python): `chat()` acepta un parámetro `history`
 * opcional para el canal de WhatsApp (ver whatsapp-webhook/index.ts), que
 * SÍ inyecta los últimos mensajes de `chat_messages` para dar continuidad a
 * la conversación — patrón adoptado de WHATSAPP_BOT_ARCHITECTURE.md. El
 * endpoint `/api/chat` (M5.5, port fiel de Python) sigue sin pasar historial
 * — simplemente no usa este parámetro, preservando la paridad 1:1 original.
 */
import OpenAI, { APIError, OpenAIError, RateLimitError } from "npm:openai@4";

// --------------------------------------------------------------------------
// Clasificación de intención (huérfana en Python — se porta igual, sin uso)
// --------------------------------------------------------------------------

const ChatIntent = {
  RESUMEN: "obtener_resumen",
  LISTAR: "listar_facturas",
  RECLASIFICAR: "reclasificar",
  EXPORTAR: "exportar",
  AYUDA: "solicitar_ayuda",
} as const;

const INTENT_KEYWORDS: Array<[string, string[]]> = [
  [ChatIntent.RECLASIFICAR, ["reclasif", "cambia", "corrige", "es de", "muévela", "muevela"]],
  [ChatIntent.EXPORTAR, ["exporta", "descarga", "zip", "excel", "paquete"]],
  [ChatIntent.LISTAR, ["factura", "lista", "muestra", "enséñame", "ensename", "ver mis", "de marzo", "de julio"]],
  [ChatIntent.RESUMEN, ["cuánto", "cuanto", "resumen", "total", "llevo", "cédula", "cedula", "deducible"]],
  [ChatIntent.AYUDA, ["qué puedo", "que puedo", "ayuda", "cómo", "como", "deducir", "explica"]],
];

/** Detecta la intención principal por palabras clave (determinístico).
 * NO se usa para orquestar chat() — ver nota de divergencia #2 arriba. */
function classifyIntent(message: string): string {
  const text = message.toLowerCase();
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return intent;
  }
  return ChatIntent.AYUDA;
}

// --------------------------------------------------------------------------
// Herramientas (function calling) — esquema OpenAI, idéntico a Python
// --------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_summary",
      description: "Obtiene totales de deducciones por categoría del usuario.",
      parameters: {
        type: "object",
        properties: { year: { type: "integer" }, categoria: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_invoices",
      description: "Lista facturas del usuario con filtros opcionales.",
      parameters: {
        type: "object",
        properties: {
          year: { type: "integer" }, month: { type: "integer" }, categoria: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reclassify_invoice",
      description: "Reclasifica una factura del usuario a otra categoría.",
      parameters: {
        type: "object",
        properties: { uuid: { type: "string" }, nueva_categoria: { type: "string" } },
        required: ["uuid", "nueva_categoria"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_package",
      description: "Genera un paquete ZIP de exportación del año.",
      parameters: { type: "object", properties: { year: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_deductions",
      description: "Explica las categorías de deducción disponibles.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const CATEGORIAS_INFO: Record<string, string> = {
  "Médicos": "Gastos médicos, dentales y hospitalarios con pago electrónico y emisor colegiado.",
  "Colegiaturas": "Colegiaturas de nivel preescolar a bachillerato, con tope anual por nivel.",
  "Seguros GMM": "Primas de seguros de gastos médicos mayores.",
  "Hipoteca": "Intereses reales de créditos hipotecarios (constancia anual del banco).",
};

const YEAR_DEFAULT = 2026;

// --------------------------------------------------------------------------
// Ejecución de herramientas (SIEMPRE filtra por user.id)
// --------------------------------------------------------------------------

async function toolGetSummary(
  supabase: SupabaseClient, user: AuthenticatedUser, year?: number, categoria?: string,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  let query = supabase.schema("facturapp").from("invoices")
    .select("categoria, total").eq("user_id", user.id).eq("anio", y);
  if (categoria) query = query.eq("categoria", categoria);

  const { data, error } = await query;
  if (error) throw new Error(`Error consultando resumen: ${error.message}`);

  const cedula: Record<string, { total: number; facturas: number }> = {};
  let totalGeneral = 0;
  for (const row of data ?? []) {
    const cat = row.categoria || "Sin clasificar";
    const entry = cedula[cat] ?? { total: 0, facturas: 0 };
    entry.total = Math.round((entry.total + (row.total || 0)) * 100) / 100;
    entry.facturas += 1;
    cedula[cat] = entry;
    totalGeneral = Math.round((totalGeneral + (row.total || 0)) * 100) / 100;
  }
  return { year: y, categorias: cedula, total_general: totalGeneral };
}

async function toolListInvoices(
  supabase: SupabaseClient, user: AuthenticatedUser,
  year?: number, month?: number, categoria?: string,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  let query = supabase.schema("facturapp").from("invoices")
    .select("uuid_fiscal, emisor_nombre, fecha_emision, categoria, total, estatus")
    .eq("user_id", user.id).eq("anio", y);
  if (categoria) query = query.eq("categoria", categoria);
  query = query.order("fecha_emision", { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(`Error consultando facturas: ${error.message}`);

  let rows = data ?? [];
  if (month) {
    const mm = String(month).padStart(2, "0");
    rows = rows.filter((r) => (r.fecha_emision ?? "").slice(5, 7) === mm);
  }

  return {
    year: y,
    count: rows.length,
    invoices: rows.map((r) => ({
      uuid: r.uuid_fiscal, emisor: r.emisor_nombre, fecha: r.fecha_emision,
      categoria: r.categoria, total: r.total, estatus: r.estatus,
    })),
  };
}

async function toolReclassifyInvoice(
  supabase: SupabaseClient, user: AuthenticatedUser, uuid: string, nuevaCategoria: string,
): Promise<unknown> {
  const { data: inv, error: selectError } = await supabase
    .schema("facturapp").from("invoices")
    .select("id, categoria")
    .eq("user_id", user.id).eq("uuid_fiscal", uuid.toUpperCase())
    .maybeSingle();

  if (selectError) throw new Error(`Error buscando factura: ${selectError.message}`);
  if (!inv) return { ok: false, mensaje: "No encontré esa factura en tu archivo." };

  const anterior = inv.categoria;
  const { error: updateError } = await supabase
    .schema("facturapp").from("invoices")
    .update({ categoria: nuevaCategoria, confianza: 1.0 })
    .eq("id", inv.id);

  if (updateError) throw new Error(`Error actualizando factura: ${updateError.message}`);
  return { ok: true, uuid, de: anterior, a: nuevaCategoria };
}

/** MOCK — igual que export_zip() en export.py. No genera ningún ZIP real
 * (eso es Fase 4 del sistema original; no adelantarlo aquí). */
async function toolExportPackage(
  supabase: SupabaseClient, user: AuthenticatedUser, year?: number,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    .select("id").eq("user_id", user.id).eq("anio", y);
  if (error) throw new Error(`Error consultando facturas para exportar: ${error.message}`);
  return { formato: "zip", archivos: (data ?? []).length, status: "mock_fase4" };
}

function toolExplainDeductions(): unknown {
  return { categorias: CATEGORIAS_INFO };
}

async function executeTool(
  name: string, supabase: SupabaseClient, user: AuthenticatedUser, args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_summary":
      return toolGetSummary(supabase, user, args.year as number | undefined, args.categoria as string | undefined);
    case "list_invoices":
      return toolListInvoices(
        supabase, user,
        args.year as number | undefined, args.month as number | undefined, args.categoria as string | undefined,
      );
    case "reclassify_invoice":
      return toolReclassifyInvoice(supabase, user, (args.uuid as string) ?? "", (args.nueva_categoria as string) ?? "");
    case "export_package":
      return toolExportPackage(supabase, user, args.year as number | undefined);
    case "explain_deductions":
      return toolExplainDeductions();
    default:
      return { error: `herramienta desconocida: ${name}` };
  }
}

// --------------------------------------------------------------------------
// LLM (OpenAI) — aislado para poder mockearlo en tests
// --------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "Eres el asistente de Facturino, una plataforma mexicana de deducciones " +
  "fiscales (CFDI 4.0). Responde SIEMPRE en español, claro y accionable. " +
  "Usa las herramientas disponibles para consultar los datos reales del " +
  "usuario antes de responder con montos o listas. No inventes cifras.";

class ChatServiceError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
  }
}

// deno-lint-ignore no-explicit-any
type LlmMessage = { content: string | null; tool_calls?: any[] | null };

/** Traduce un error de OpenAI a ChatServiceError (mensaje legible + log).
 * Función pura y separada de la llamada de red para poder testearla con
 * instancias reales de error construidas a mano — mismo patrón que
 * test_chat.py, que monkeypatchea `_get_client` en vez de mockear HTTP. */
function translateOpenAIError(exc: unknown): ChatServiceError {
  if (exc instanceof RateLimitError) {
    console.warn("OpenAI rate limit:", exc.message);
    return new ChatServiceError("Estoy un poco ocupado en este momento. Intenta de nuevo en unos segundos.");
  }
  if (exc instanceof APIError) {
    console.error("OpenAI APIError:", exc.message);
    return new ChatServiceError("Tengo problemas para conectarme con el asistente. Intenta más tarde.");
  }
  if (exc instanceof OpenAIError) {
    console.error("OpenAI error inesperado:", exc.message);
    return new ChatServiceError("Algo salió mal procesando tu mensaje. Intenta de nuevo.");
  }
  throw exc;
}

/** Llama a OpenAI de verdad. Los tests de orquestación inyectan un mock vía
 * el parámetro `chatCompletionFn` de chat() (no se monkeypatchea un módulo
 * — no aplica en ESM; es inyección de dependencia, mismo patrón que
 * ValidationEngine.classify en validator.ts, Fase M3). La traducción de
 * errores (translateOpenAIError) sí se testea aislada y directamente. */
async function realChatCompletion(
  // deno-lint-ignore no-explicit-any
  messages: any[], tools: any[], apiKey: string, model: string,
): Promise<LlmMessage> {
  const client = new OpenAI({ apiKey });
  try {
    const resp = await client.chat.completions.create({
      model, messages, tools, tool_choice: "auto",
    });
    return resp.choices[0].message;
  } catch (exc) {
    throw translateOpenAIError(exc);
  }
}

// --------------------------------------------------------------------------
// Orquestador
// --------------------------------------------------------------------------

interface ChatResult {
  response: string;
  tools_used: string[];
}

type ChatCompletionFn = (
  // deno-lint-ignore no-explicit-any
  messages: any[], tools: any[],
) => Promise<LlmMessage>;

interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const HISTORY_LIMIT = 20;

/** Lee los últimos N mensajes de `chat_messages` para un usuario, en orden
 * cronológico (más viejo primero, como espera `chat()`). Extensión Fase
 * M4b para el canal de WhatsApp — ver nota de divergencia arriba. */
async function getRecentChatHistory(
  supabase: SupabaseClient, userId: number,
): Promise<ChatHistoryMessage[]> {
  const { data, error } = await supabase
    .schema("facturapp").from("chat_messages")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(`Error consultando historial de chat: ${error.message}`);
  return ((data ?? []) as ChatHistoryMessage[]).reverse();
}

/** Port 1:1 de chat() en chat.py — sin `history`, se comporta exactamente
 * igual que la versión original (NO pasa historial, ver divergencia #1).
 * `history` es una extensión Fase M4b usada solo por el canal de WhatsApp. */
async function chat(
  supabase: SupabaseClient,
  user: AuthenticatedUser,
  message: string,
  chatCompletionFn: ChatCompletionFn,
  history: ChatHistoryMessage[] = [],
): Promise<ChatResult> {
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];
  const toolsUsed: string[] = [];

  try {
    const first = await chatCompletionFn(messages, TOOLS);
    const toolCalls = first.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      return { response: first.content ?? "", tools_used: toolsUsed };
    }

    messages.push({
      role: "assistant",
      content: first.content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await executeTool(name, supabase, user, args);
      toolsUsed.push(name);
      messages.push({
        role: "tool", tool_call_id: tc.id, content: JSON.stringify(result),
      });
    }

    const final = await chatCompletionFn(messages, TOOLS);
    return { response: final.content ?? "", tools_used: toolsUsed };
  } catch (exc) {
    if (exc instanceof ChatServiceError) {
      return { response: exc.userMessage, tools_used: [] };
    }
    throw exc;
  }
}

// ===== supabase/functions/whatsapp-webhook/index.ts =====
// Fase M4 — Webhook real de WhatsApp (Meta Cloud API).
// Fase M4b — se agrega chat conversacional (texto) reusando chat.ts (M5.5).
//
// GET: handshake de verificación (sin cambios desde M1).
// POST: verifica firma HMAC → extrae mensajes:
//   - "document" → resuelve/crea usuario por teléfono → descarga el
//     adjunto (Graph API, dos pasos) → parsea/valida/clasifica/guarda
//     (ingestInvoice, compartido con sendgrid-webhook) → responde.
//   - "text" → resuelve/crea usuario por teléfono → comando rápido (sin IA)
//     o chat() con historial de chat_messages → guarda el turno → responde.
//
// Siempre responde 200 a Meta, salvo firma inválida (401) — un fallo al
// procesar un mensaje individual se registra (console + debug_logs) y NO
// rompe el resto del batch (mismo comportamiento que whatsapp_webhook() en
// main.py para documentos; el manejo de texto es una extensión M4b sin
// equivalente en Python — ver chat.ts y whatsapp.ts para el detalle de la
// divergencia).
//
// El patrón de esta fase (comandos rápidos antes de IA, log a debug_logs,
// historial de conversación, dispatch por tipo de mensaje) está adoptado
// de WHATSAPP_BOT_ARCHITECTURE.md — arquitectura ya probada en producción
// en otro proyecto sobre el mismo Supabase.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY vienen inyectadas automáticamente
// en runtime por Supabase — no requieren `supabase secrets set`.
function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function handleVerification(url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

  if (mode === "subscribe" && token === verifyToken) {
    return new Response(challenge, { status: 200, headers: corsHeaders });
  }
  return new Response("Verificación fallida", { status: 403, headers: corsHeaders });
}

async function handleTextMessage(
  // deno-lint-ignore no-explicit-any
  supabase: any, msg: { from: string; text: string; profile_name: string | null },
  whatsappToken: string, phoneNumberId: string,
): Promise<Record<string, unknown>> {
  const user = await getOrCreateUserByPhone(supabase, msg.from, msg.profile_name);

  const quickReply = interceptQuickCommand(msg.text);
  if (quickReply !== null) {
    await logDebug(supabase, "whatsapp: comando rápido", { from: msg.from, text: msg.text });
    await sendWhatsappMessage(msg.from, quickReply, whatsappToken, phoneNumberId);
    return { from: msg.from, tipo: "comando_rapido" };
  }

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "user", content: msg.text });

  const history = await getRecentChatHistory(supabase, user.id);
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";

  const result = await chat(
    supabase, user, msg.text,
    (messages, tools) => realChatCompletion(messages, tools, apiKey, model),
    history,
  );

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "assistant", content: result.response });

  await logDebug(supabase, "whatsapp: chat respondido", {
    from: msg.from, tools_used: result.tools_used,
  });

  await sendWhatsappMessage(msg.from, result.response, whatsappToken, phoneNumberId);
  return { from: msg.from, tipo: "chat", tools_used: result.tools_used };
}

async function handleIncoming(req: Request): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  const signature = req.headers.get("X-Hub-Signature-256");
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");
  const supabase = getSupabaseClient();

  if (appSecret) {
    if (!verifyWhatsappSignature(bodyBytes, signature, appSecret)) {
      console.warn("Firma de WhatsApp inválida");
      await logDebug(supabase, "whatsapp: firma inválida", { signature });
      return new Response(JSON.stringify({ detail: "Firma inválida" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    console.warn("WHATSAPP_APP_SECRET no configurado: se omite verificación de firma");
  }

  let payload: { entry?: unknown[] };
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return new Response(JSON.stringify({ detail: "JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const documentos = extractWhatsappMessages(payload);
  const textos = extractWhatsappTextMessages(payload);
  const whatsappToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

  const resultados: Array<Record<string, unknown>> = [];

  for (const msg of documentos) {
    let user;
    try {
      user = await getOrCreateUserByPhone(supabase, msg.from, msg.profile_name);
    } catch (exc) {
      console.error(`Error resolviendo usuario para ${msg.from}:`, exc);
      resultados.push({ from: msg.from, error: "No se pudo resolver el usuario" });
      continue;
    }

    let contenido: Uint8Array;
    try {
      const media = await downloadMediaFromMeta(msg.media_id, whatsappToken);
      contenido = media.content;
    } catch (exc) {
      console.error(`Error descargando adjunto de WhatsApp (media_id=${msg.media_id}):`, exc);
      await logDebug(supabase, "whatsapp: error descargando adjunto", { from: msg.from, error: String(exc) });
      resultados.push({ from: msg.from, error: "No se pudo descargar el adjunto de WhatsApp" });
      continue;
    }

    let ingestResult;
    try {
      ingestResult = await ingestInvoice(supabase, user, contenido, msg.filename);
    } catch (exc) {
      console.error(`Error procesando factura de ${msg.from}:`, exc);
      await logDebug(supabase, "whatsapp: error procesando factura", { from: msg.from, error: String(exc) });
      resultados.push({ from: msg.from, error: "No se pudo procesar la factura" });
      continue;
    }

    resultados.push({ from: msg.from, ...ingestResult });

    try {
      await sendWhatsappMessage(
        msg.from, whatsappReplyText(ingestResult), whatsappToken, phoneNumberId,
      );
    } catch (exc) {
      console.error(`No se pudo enviar la respuesta de WhatsApp a ${msg.from}:`, exc);
    }
  }

  for (const msg of textos) {
    try {
      resultados.push(await handleTextMessage(supabase, msg, whatsappToken, phoneNumberId));
    } catch (exc) {
      console.error(`Error procesando mensaje de texto de ${msg.from}:`, exc);
      await logDebug(supabase, "whatsapp: error en chat", { from: msg.from, error: String(exc) });
      resultados.push({ from: msg.from, error: "No se pudo procesar tu mensaje" });
    }
  }

  return new Response(JSON.stringify({ resultados }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    return handleVerification(url);
  }

  if (req.method === "POST") {
    return handleIncoming(req);
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});

type AuthenticatedUser = AppUser;
