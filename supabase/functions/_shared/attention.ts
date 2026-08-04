/**
 * Facturas que necesitan atención del usuario (Fase M20).
 *
 * "Necesita atención" = tiene un hallazgo real, no solo un estatus informativo.
 * `archivada` (persona moral) queda fuera a propósito: no es un problema, es
 * "fuera del alcance de lo que evaluamos" -- avisar de esas facturas cada mes
 * entrenaría al usuario a ignorar el aviso, porque la mayoría de los meses
 * NO tiene nada que hacer con ellas.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const ESTATUS_ATENCION = ["advertencia", "por_revisar", "rechazada"] as const;

export interface FacturaAtencion {
  id: number;
  emisor_nombre: string;
  fecha_emision: string;
  estatus: string;
  total: number;
  hallazgos: Array<{ mensaje: string }>;
}

/** Facturas de `userId` emitidas en `anio`/`mes` cuyo estatus pide revisión.
 *
 * Filtra por `fecha_emision` (la fecha fiscal del CFDI), no por `created_at`
 * (cuándo se archivó): el punto es "¿qué facturas DE ESTE MES tienen un
 * problema?", no "¿qué llegó este mes?" -- una factura de julio ingerida
 * tarde en agosto sigue siendo del corte de julio.
 */
export async function facturasQueNecesitanAtencion(
  supabase: SupabaseClient, userId: number, anio: number, mes: number, rfc?: string,
): Promise<FacturaAtencion[]> {
  const mesStr = String(mes).padStart(2, "0");
  let query = supabase
    .schema("facturapp").from("invoices")
    .select("id, emisor_nombre, fecha_emision, estatus, total, hallazgos")
    .eq("user_id", userId)
    .like("fecha_emision", `${anio}-${mesStr}%`)
    .in("estatus", ESTATUS_ATENCION);
  if (rfc) query = query.eq("usuario_rfc", rfc);

  const { data, error } = await query.order("fecha_emision", { ascending: true });
  if (error) throw new Error(`Error consultando facturas con atención pendiente: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    emisor_nombre: r.emisor_nombre,
    fecha_emision: r.fecha_emision,
    estatus: r.estatus,
    total: r.total,
    hallazgos: r.hallazgos ?? [],
  }));
}
