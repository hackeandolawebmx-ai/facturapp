/**
 * Ingesta compartida de facturas (Fase M4/M5) — port 1:1 de
 * `_ingest_invoice()` en facturapp/facturapp/main.py.
 *
 * Un solo lugar para parsear + validar + clasificar + guardar, usado tanto
 * por el webhook de WhatsApp (M4) como el de SendGrid (M5) — misma razón
 * que en Python: que la lógica de negocio no viva duplicada en dos sitios.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { classifyInvoice } from "./classifier.ts";
import { CFDIParseError, parseCfdi } from "./parser.ts";
import {
  SEV_ARCHIVADA, type Hallazgo, SEV_POR_REVISAR, SEV_RECHAZADA, ValidationEngine,
} from "./validator.ts";
import type { AppUser } from "./users.ts";
import { listarRfcs, rfcQueRecibe } from "./rfcs.ts";

/** Port de `_anio_de()` en main.py: primeros 4 dígitos de fecha_emision. */
export function anioDeFecha(fechaEmision: string): number {
  const anio = parseInt(fechaEmision.slice(0, 4), 10);
  return Number.isNaN(anio) ? new Date().getUTCFullYear() : anio;
}

export interface IngestResult {
  status_code: number;
  uuid: string | null;
  estatus: string;
  categoria?: string;
  hallazgos: Array<{ codigo: string; severidad: string; mensaje: string; detalle?: string }>;
  /** Id de la fila insertada, para poder asociarle el PDF (Fase M13).
   * Ausente cuando la factura se rechaza y no se guarda nada. */
  invoice_id?: number;
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

/** Resultado para una factura dirigida a un RFC de persona moral (Fase M14).
 *
 * Se archiva sin clasificar ni evaluar deducibilidad. NO es una degradación
 * silenciosa: el hallazgo lo dice explícitamente, para que nadie interprete
 * la ausencia de advertencias como "todo en orden" ni la falta de categoría
 * como un fallo del clasificador.
 *
 * El anti-duplicado sí se aplica: no depende del régimen fiscal y evita
 * guardar dos veces el mismo comprobante.
 */
function archivarSinEvaluar(
  invoice: { uuid: string }, existingUuids: string[],
): { status: string; categoria?: string; hallazgos: Hallazgo[] } {
  if (existingUuids.includes(invoice.uuid)) {
    return {
      status: SEV_RECHAZADA,
      hallazgos: [{
        codigo: "UUID_DUPLICADO",
        severidad: SEV_RECHAZADA,
        mensaje: "Ya tenías registrada esta factura",
      }],
    };
  }
  return {
    status: SEV_ARCHIVADA,
    categoria: undefined,
    hallazgos: [{
      codigo: "PERSONA_MORAL",
      severidad: SEV_ARCHIVADA,
      mensaje:
        "Archivada para tu empresa. No evaluamos deducibilidad de personas " +
        "morales: sus reglas son distintas a las de deducciones personales.",
    }],
  };
}

/** Parsea, valida, clasifica y guarda un CFDI para `user`. Devuelve el mismo
 * shape que `_ingest_invoice()` en Python (status_code + body). */
export async function ingestInvoice(
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

  // ¿A cuál de los RFCs de la cuenta viene dirigida? (Fase M14)
  //
  // De esto depende CÓMO se evalúa, no solo a quién se le atribuye: el
  // clasificador y el validador implementan deducciones personales, así que
  // aplicarlos a una factura de persona moral produciría juicios falsos —
  // marcaría como incorrecto el uso G03, que es el correcto para una empresa.
  const rfcsDeLaCuenta = await listarRfcs(supabase, user.id);
  const rfcReceptor = rfcQueRecibe(rfcsDeLaCuenta, invoice.receptor_rfc ?? "");

  // Sin RFCs dados de alta (cuenta recién creada, RFC todavía `PEND...`) se
  // conserva el comportamiento anterior: validar contra el RFC del usuario.
  const rfcParaValidar = rfcReceptor?.rfc ?? user.rfc;
  const esMoral = rfcReceptor?.tipo === "moral";

  const resultado = esMoral
    ? archivarSinEvaluar(invoice, existingUuids)
    : new ValidationEngine(rfcParaValidar, existingUuids).validate(invoice, fechaPrevia);
  const { confianza } = esMoral ? { confianza: 0 } : classifyInvoice(invoice);

  // El id de la fila insertada se devuelve para poder asociarle después el
  // PDF (Fase M13). Es `undefined` cuando la factura se rechaza y no se
  // guarda nada.
  let invoiceId: number | undefined;

  if (resultado.status !== SEV_RECHAZADA) {
    const { data: creada, error: insertError } = await supabase
      .schema("facturapp")
      .from("invoices")
      .insert({
        user_id: user.id,
        uuid_fiscal: invoice.uuid,
        // El RFC al que se atribuye, no el principal de la cuenta: es lo que
        // permite que el resumen no mezcle contribuyentes (Fase M14).
        usuario_rfc: rfcParaValidar,
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
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`Error guardando factura: ${insertError.message}`);
    invoiceId = creada?.id;
  }

  return {
    status_code: 200,
    uuid: invoice.uuid,
    estatus: resultado.status,
    categoria: resultado.categoria,
    hallazgos: resultado.hallazgos,
    invoice_id: invoiceId,
  };
}
