
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

import { parse as parseXml } from "@libs/xml/parse";

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

import { classifyInvoice, type ClassificationResult } from "./classifier.ts";
import type { ParsedInvoice } from "./parser.ts";

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

// ===== supabase/functions/_shared/users.ts =====
/**
 * Resolución de usuario por canal de ingesta (Fase M4/M5).
 *
 * Port 1:1 de get_or_create_user_by_phone() y get_or_create_user_by_email()
 * en whatsapp_service.py / email_service.py.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { placeholderRfc } from "./accounts.ts";

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
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyInvoice } from "./classifier.ts";
import { CFDIParseError, parseCfdi } from "./parser.ts";
import { SEV_POR_REVISAR, SEV_RECHAZADA, ValidationEngine } from "./validator.ts";
import type { AppUser } from "./users.ts";

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

// ===== supabase/functions/whatsapp-webhook/index.ts =====
// Fase M4 — Webhook real de WhatsApp (Meta Cloud API).
//
// GET: handshake de verificación (sin cambios desde M1).
// POST: verifica firma HMAC → extrae mensajes con documento → por cada uno:
//   resuelve/crea usuario por teléfono → descarga el adjunto (Graph API,
//   dos pasos) → parsea/valida/clasifica/guarda (ingestInvoice, compartido
//   con el futuro webhook de SendGrid) → responde por WhatsApp.
//
// Siempre responde 200 a Meta, salvo firma inválida (401) — un fallo al
// descargar o enviar un mensaje individual se registra y NO rompe el resto
// del batch (mismo comportamiento que whatsapp_webhook() en main.py).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  downloadMediaFromMeta, extractWhatsappMessages, sendWhatsappMessage,
  verifyWhatsappSignature, whatsappReplyText,
} from "../_shared/whatsapp.ts";

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

async function handleIncoming(req: Request): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  const signature = req.headers.get("X-Hub-Signature-256");
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");

  if (appSecret) {
    if (!verifyWhatsappSignature(bodyBytes, signature, appSecret)) {
      console.warn("Firma de WhatsApp inválida");
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

  const mensajes = extractWhatsappMessages(payload);
  const supabase = getSupabaseClient();
  const whatsappToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

  const resultados: Array<Record<string, unknown>> = [];

  for (const msg of mensajes) {
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
      resultados.push({ from: msg.from, error: "No se pudo descargar el adjunto de WhatsApp" });
      continue;
    }

    let ingestResult;
    try {
      ingestResult = await ingestInvoice(supabase, user, contenido, msg.filename);
    } catch (exc) {
      console.error(`Error procesando factura de ${msg.from}:`, exc);
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
