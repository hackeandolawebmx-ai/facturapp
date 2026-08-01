/**
 * RFCs de una cuenta (Fase M14).
 *
 * Una persona física tiene exactamente un RFC, así que varios RFCs en una
 * cuenta siempre significan que se administran las deducciones de más de un
 * contribuyente — típicamente una persona y su empresa.
 *
 * El `tipo` no es informativo, decide el tratamiento: solo las facturas de un
 * RFC de persona **física** pasan por el clasificador y el validador, que
 * implementan deducciones personales (Art. 151 LISR). Las de una **moral** se
 * archivan sin juicio de deducibilidad. Ver 0008_multiples_rfcs.sql para el
 * razonamiento completo.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type TipoContribuyente = "fisica" | "moral";

export interface RfcDeCuenta {
  id: number;
  rfc: string;
  tipo: TipoContribuyente;
  alias: string | null;
  es_principal: boolean;
}

const COLS = "id, rfc, tipo, alias, es_principal";

export async function listarRfcs(
  supabase: SupabaseClient, userId: number,
): Promise<RfcDeCuenta[]> {
  const { data, error } = await supabase
    .schema("facturapp").from("user_rfcs")
    .select(COLS)
    .eq("user_id", userId)
    .order("es_principal", { ascending: false });
  if (error) throw new Error(`Error listando RFCs: ${error.message}`);
  return (data ?? []) as RfcDeCuenta[];
}

/**
 * Encuentra a cuál de los RFCs de la cuenta está dirigida una factura.
 *
 * Devuelve `null` si a ninguno: eso es lo que dispara la advertencia
 * `RFC_AJENO`. La comparación ignora mayúsculas porque los PAC no son
 * consistentes en eso.
 */
export function rfcQueRecibe(
  rfcs: RfcDeCuenta[], receptorRfc: string,
): RfcDeCuenta | null {
  const receptor = (receptorRfc ?? "").trim().toUpperCase();
  if (!receptor) return null;
  return rfcs.find((r) => r.rfc.toUpperCase() === receptor) ?? null;
}

/** Agrega un RFC a la cuenta. Devuelve `null` si ya estaba dado de alta. */
export async function agregarRfc(
  supabase: SupabaseClient, userId: number, rfc: string,
  tipo: TipoContribuyente, alias: string | null,
): Promise<RfcDeCuenta | null> {
  const { data: existente, error: errorConsulta } = await supabase
    .schema("facturapp").from("user_rfcs")
    .select("id")
    .eq("user_id", userId).eq("rfc", rfc)
    .maybeSingle();
  if (errorConsulta) throw new Error(`Error verificando RFC: ${errorConsulta.message}`);
  if (existente) return null;

  const { data, error } = await supabase
    .schema("facturapp").from("user_rfcs")
    .insert({ user_id: userId, rfc, tipo, alias, es_principal: false })
    .select(COLS)
    .single();
  if (error) throw new Error(`Error agregando RFC: ${error.message}`);
  return data as RfcDeCuenta;
}

/**
 * Mantiene sincronizado el RFC PRINCIPAL de la cuenta en `user_rfcs`
 * (Fase M15).
 *
 * `updateUserRfc()` (perfil, M11) y `auth-register` (M7) solo tocan
 * `users.rfc` directamente — nunca escribieron en `user_rfcs`, porque esa
 * tabla no existía cuando se escribieron. El resultado: para CUALQUIER
 * cuenta cuyo RFC se puso o cambió por esos caminos —que son casi todas,
 * ya que son el único flujo que existía antes de M14 y el más simple hoy—
 * `listarRfcs()` devuelve una lista vacía, aunque `users.rfc` tenga un RFC
 * real y válido. Solo se salvó por casualidad la cuenta de prueba de esta
 * migración, porque ya existía con un RFC real en el momento exacto en que
 * corrió el backfill de `0008_multiples_rfcs.sql`.
 *
 * Se detectó al construir el resumen por contribuyente (M15): sin esto, la
 * mayoría de las cuentas reales no tendrían NINGÚN contribuyente que
 * mostrar, pese a tener un RFC perfectamente válido.
 *
 * No se le da alias (queda `null`): a diferencia del backfill original de
 * la migración, que puso el texto literal `"Principal"` como alias —
 * redundante con la etiqueta "Principal" que ya muestra la interfaz vía
 * `es_principal`. No se corrigen las filas viejas, solo se evita repetir el
 * mismo defecto en las nuevas.
 */
export async function sincronizarRfcPrincipal(
  supabase: SupabaseClient, userId: number, rfc: string,
): Promise<void> {
  const { data: existente, error: errorConsulta } = await supabase
    .schema("facturapp").from("user_rfcs")
    .select("id")
    .eq("user_id", userId).eq("es_principal", true)
    .maybeSingle();
  if (errorConsulta) throw new Error(`Error consultando RFC principal: ${errorConsulta.message}`);

  if (existente) {
    const { error } = await supabase
      .schema("facturapp").from("user_rfcs")
      .update({ rfc })
      .eq("id", existente.id);
    if (error) throw new Error(`Error actualizando RFC principal: ${error.message}`);
    return;
  }

  const { error } = await supabase
    .schema("facturapp").from("user_rfcs")
    .insert({ user_id: userId, rfc, tipo: "fisica", alias: null, es_principal: true });
  if (error) throw new Error(`Error creando RFC principal: ${error.message}`);
}

/**
 * Elimina un RFC de la cuenta.
 *
 * El principal no se puede eliminar: es el que vive en `users.rfc` y el que
 * usan por defecto el resto de los endpoints. Quitarlo dejaría la cuenta en
 * un estado incoherente, así que primero habría que designar otro.
 *
 * Las facturas ya archivadas NO se borran: son documentos fiscales, y
 * eliminar un RFC de la interfaz no debe destruir comprobantes. Quedan
 * asociadas a su `usuario_rfc`, accesibles si el RFC se vuelve a dar de alta.
 */
export async function eliminarRfc(
  supabase: SupabaseClient, userId: number, rfcId: number,
): Promise<{ ok: boolean; motivo?: string }> {
  const { data: fila, error: errorConsulta } = await supabase
    .schema("facturapp").from("user_rfcs")
    .select("id, es_principal")
    .eq("id", rfcId).eq("user_id", userId)
    .maybeSingle();
  if (errorConsulta) throw new Error(`Error buscando RFC: ${errorConsulta.message}`);
  if (!fila) return { ok: false, motivo: "no_encontrado" };
  if (fila.es_principal) return { ok: false, motivo: "es_principal" };

  const { error } = await supabase
    .schema("facturapp").from("user_rfcs")
    .delete().eq("id", rfcId);
  if (error) throw new Error(`Error eliminando RFC: ${error.message}`);
  return { ok: true };
}
