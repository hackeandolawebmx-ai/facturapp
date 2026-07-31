/**
 * `/api/summary`, `/api/invoices`, `/api/invoices/{id}/reclassify` (Fase M7)
 * — port 1:1 de `_summary_for_user()`, `list_invoices()`, `reclassify()` en
 * main.py, y de `Invoice.to_dict()` en models.py.
 *
 * DELIBERADAMENTE separado de `chat.ts` aunque la lógica se parezca: son
 * funciones Python distintas con formas de respuesta distintas.
 * `_summary_for_user()` (usada por `/api/summary` y `/api/public/summary`)
 * incluye `num_facturas`; `tool_get_summary()` de chat.py (portado en
 * chat.ts) NO lo incluye. `list_invoices()` (REST) devuelve el dict
 * COMPLETO de cada factura (`Invoice.to_dict()`: id, hallazgos, raw fields
 * fiscales, etc.); `tool_list_invoices()` de chat.py devuelve solo 6 campos
 * resumidos para que quepan en una respuesta de chat. Y el reclasificador
 * REST identifica la factura por `id` numérico (PK), no por `uuid_fiscal`
 * como el tool de chat — así es como main.py define esa ruta.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { eliminarPdf } from "./pdf_storage.ts";

const YEAR_DEFAULT = 2026;

export interface SummaryResult {
  year: number;
  categorias: Record<string, { total: number; facturas: number }>;
  total_general: number;
  num_facturas: number;
}

/** Port de `_summary_for_user()` en main.py, con filtro por RFC (Fase M14).
 *
 * `rfc` NO es opcional por comodidad: con varios contribuyentes en una
 * cuenta, un resumen sin filtrar sumaría las deducciones de dos personas en
 * un mismo total. Cada quien presenta su propia declaración, así que
 * mezclarlas sería atribuirle a alguien deducciones que no le corresponden.
 * Cuando no se indica, se devuelve todo lo del usuario — el comportamiento
 * anterior, correcto mientras haya un solo RFC.
 */
export async function summaryForUser(
  supabase: SupabaseClient, userId: number, year: number = YEAR_DEFAULT,
  rfc?: string,
): Promise<SummaryResult> {
  let query = supabase
    .schema("facturapp").from("invoices")
    .select("categoria, total")
    .eq("user_id", userId).eq("anio", year);
  if (rfc) query = query.eq("usuario_rfc", rfc);

  const { data, error } = await query;
  if (error) throw new Error(`Error consultando resumen: ${error.message}`);

  const rows = data ?? [];
  const categorias: Record<string, { total: number; facturas: number }> = {};
  let totalGeneral = 0;
  for (const row of rows) {
    const cat = row.categoria || "Sin clasificar";
    const entry = categorias[cat] ?? { total: 0, facturas: 0 };
    entry.total = Math.round((entry.total + (row.total || 0)) * 100) / 100;
    entry.facturas += 1;
    categorias[cat] = entry;
    totalGeneral = Math.round((totalGeneral + (row.total || 0)) * 100) / 100;
  }
  return { year, categorias, total_general: totalGeneral, num_facturas: rows.length };
}

export interface InvoiceDict {
  id: number;
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  receptor_rfc: string;
  fecha_emision: string;
  anio: number;
  subtotal: number;
  iva: number;
  total: number;
  uso_cfdi: string;
  forma_pago: string;
  metodo_pago: string;
  clave_prod_principal: string;
  concepto_descripcion: string;
  categoria: string;
  confianza: number;
  estatus: string;
  hallazgos: unknown[];
  /** Si la factura llegó acompañada de su PDF (Fase M13). No se expone la
   * ruta en Storage: al cliente solo le sirve saber si hay algo que
   * descargar, y publicar rutas internas no aporta nada. */
  tiene_pdf: boolean;
}

/** Port 1:1 de `list_invoices()` (endpoint REST) + `Invoice.to_dict()`. */
export async function listInvoicesForUser(
  supabase: SupabaseClient, userId: number, year: number = YEAR_DEFAULT,
  rfc?: string,
): Promise<{ year: number; invoices: InvoiceDict[] }> {
  let query = supabase
    .schema("facturapp").from("invoices")
    .select(
      "id, uuid_fiscal, emisor_rfc, emisor_nombre, receptor_rfc, fecha_emision, anio, subtotal, iva, total, uso_cfdi, forma_pago, metodo_pago, clave_prod_principal, concepto_descripcion, categoria, confianza, estatus, hallazgos, pdf_path",
    )
    .eq("user_id", userId).eq("anio", year);
  if (rfc) query = query.eq("usuario_rfc", rfc);

  const { data, error } = await query.order("fecha_emision", { ascending: false });
  if (error) throw new Error(`Error consultando facturas: ${error.message}`);

  const invoices = (data ?? []).map((r): InvoiceDict => ({
    id: r.id,
    uuid: r.uuid_fiscal,
    emisor_rfc: r.emisor_rfc,
    emisor_nombre: r.emisor_nombre,
    receptor_rfc: r.receptor_rfc,
    fecha_emision: r.fecha_emision,
    anio: r.anio,
    subtotal: r.subtotal,
    iva: r.iva,
    total: r.total,
    uso_cfdi: r.uso_cfdi,
    forma_pago: r.forma_pago,
    metodo_pago: r.metodo_pago,
    clave_prod_principal: r.clave_prod_principal,
    concepto_descripcion: r.concepto_descripcion,
    categoria: r.categoria,
    confianza: r.confianza,
    estatus: r.estatus,
    hallazgos: r.hallazgos ?? [],
    tiene_pdf: Boolean(r.pdf_path),
  }));
  return { year, invoices };
}

/** Devuelve el XML original de una factura del usuario (Fase M13).
 *
 * El XML **es** el comprobante fiscal; el PDF es solo su representación
 * impresa. Se guardaba desde M4 en `raw_xml` pero no había forma de
 * recuperarlo: el archivo estaba completo y a la vez inaccesible.
 *
 * Filtra por `user_id` además de por `id`, como todo lo demás: sin eso, un
 * id ajeno bastaría para leer la factura de otra persona.
 *
 * Devuelve `null` si la factura no existe, no es del usuario, o se guardó sin
 * XML — este último caso existe porque `raw_xml` es nullable.
 */
export async function getInvoiceXml(
  supabase: SupabaseClient, userId: number, invoiceId: number,
): Promise<{ uuid: string; xml: string } | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    .select("uuid_fiscal, raw_xml")
    .eq("id", invoiceId).eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error leyendo el XML: ${error.message}`);
  if (!data || !data.raw_xml) return null;
  return { uuid: data.uuid_fiscal, xml: data.raw_xml };
}

/** Devuelve la ruta en Storage del PDF de una factura del usuario, o `null`
 * si la factura no existe, no es suya, o llegó sin PDF (Fase M13). */
export async function getInvoicePdfPath(
  supabase: SupabaseClient, userId: number, invoiceId: number,
): Promise<{ uuid: string; pdfPath: string } | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    .select("uuid_fiscal, pdf_path")
    .eq("id", invoiceId).eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error leyendo la ruta del PDF: ${error.message}`);
  if (!data || !data.pdf_path) return null;
  return { uuid: data.uuid_fiscal, pdfPath: data.pdf_path };
}

/** Elimina una factura del usuario, junto con su PDF si tiene uno (Fase M15).
 *
 * NO existe en Python — se agregó a petición explícita para poder corregir
 * desde el dashboard casos como una factura ingerida antes de dar de alta el
 * RFC correcto (queda con un hallazgo `RFC_AJENO` obsoleto que no se
 * recalcula solo), o simplemente una factura de prueba.
 *
 * Filtra por `user_id` además de por `id`, igual que el resto de las
 * operaciones sobre una factura puntual: sin eso, un id ajeno bastaría para
 * borrar la factura de otra persona.
 *
 * El PDF se borra ANTES que la fila: si el borrado del PDF falla, la fila
 * sigue existiendo con un `pdf_path` que ya no resuelve a nada — un estado
 * inconsistente pero detectable (el endpoint de descarga ya maneja "el
 * archivo no está" con un 500 explícito). Si en cambio se borrara la fila
 * primero y luego fallara el PDF, quedaría huérfano en Storage sin ningún
 * registro que lo referencie — imposible de encontrar después para limpiarlo.
 *
 * Nunca borra el XML por separado: es la misma fila, así que desaparece con
 * ella. No hay "borrar el PDF pero conservar el XML" — si el usuario quiere
 * borrar la factura, se borra completa.
 */
export async function deleteInvoiceById(
  supabase: SupabaseClient, userId: number, invoiceId: number,
): Promise<{ id: number; uuid: string } | null> {
  const { data: inv, error: selectError } = await supabase
    .schema("facturapp").from("invoices")
    .select("id, uuid_fiscal, pdf_path")
    .eq("id", invoiceId).eq("user_id", userId)
    .maybeSingle();
  if (selectError) throw new Error(`Error buscando factura: ${selectError.message}`);
  if (!inv) return null;

  if (inv.pdf_path) {
    await eliminarPdf(supabase, inv.pdf_path);
  }

  const { error: deleteError } = await supabase
    .schema("facturapp").from("invoices")
    .delete().eq("id", invoiceId);
  if (deleteError) throw new Error(`Error eliminando factura: ${deleteError.message}`);

  return { id: invoiceId, uuid: inv.uuid_fiscal };
}

/** Port 1:1 de `reclassify()` en main.py — identifica la factura por `id`
 * numérico (PK), NO por `uuid_fiscal` (a diferencia de
 * `toolReclassifyInvoice` en chat.ts). Devuelve `null` si la factura no
 * existe o no pertenece al usuario (equivalente al 404 de Python). */
export async function reclassifyInvoiceById(
  supabase: SupabaseClient, userId: number, invoiceId: number, nuevaCategoria: string,
): Promise<{ id: number; categoria: string } | null> {
  const { data: inv, error: selectError } = await supabase
    .schema("facturapp").from("invoices")
    .select("id")
    .eq("id", invoiceId).eq("user_id", userId)
    .maybeSingle();
  if (selectError) throw new Error(`Error buscando factura: ${selectError.message}`);
  if (!inv) return null;

  const { error: updateError } = await supabase
    .schema("facturapp").from("invoices")
    .update({ categoria: nuevaCategoria, confianza: 1.0 })
    .eq("id", invoiceId);
  if (updateError) throw new Error(`Error actualizando factura: ${updateError.message}`);

  return { id: invoiceId, categoria: nuevaCategoria };
}
