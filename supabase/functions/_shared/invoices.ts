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
import { SEV_POR_REVISAR, SEV_RECHAZADA, ValidationEngine } from "./validator.ts";
import type { AppUser } from "./users.ts";

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
