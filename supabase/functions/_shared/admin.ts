/**
 * Back-office de operación (Fase M23) — acceso a datos de TODAS las cuentas.
 *
 * Este es el único módulo del sistema que cruza la frontera entre cuentas a
 * propósito. Todo lo demás filtra por `user.id` sin excepción; aquí no, porque
 * el punto es justamente ver el conjunto. Por eso el guard de rol
 * (`getCurrentAdmin` en auth.ts) es lo único que separa esto del resto, y por
 * eso los endpoints que lo usan no hacen nada más antes de comprobarlo.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Fila del listado — refleja la vista `facturapp.admin_usuarios`
 * (migración 0013), que ya trae los agregados por cuenta resueltos. */
export interface CuentaListada {
  id: number;
  email: string;
  nombre: string;
  rfc: string;
  plan: string;
  rol: string;
  whatsapp_phone: string | null;
  created_at: string;
  suspendida_en: string | null;
  suspendida_motivo: string | null;
  tiene_password: boolean;
  rfc_pendiente: boolean;
  num_facturas: number;
  ultima_factura_en: string | null;
}

export interface FiltrosCuentas {
  q?: string;
  /** `activas` | `suspendidas` | undefined (todas) */
  estado?: string;
  limit?: number;
  offset?: number;
}

/** Tope duro de página. Existe para que un `?limit=100000` no intente traerse
 * la base entera en una respuesta; el `max_rows = 1000` de PostgREST
 * (config.toml) ya lo cortaría, pero prefiero un límite explícito y propio a
 * depender de que la config del gateway no cambie. */
const LIMITE_MAX = 200;

export async function listarCuentas(
  supabase: SupabaseClient, filtros: FiltrosCuentas = {},
): Promise<{ cuentas: CuentaListada[]; total: number }> {
  const limit = Math.min(Math.max(filtros.limit ?? 50, 1), LIMITE_MAX);
  const offset = Math.max(filtros.offset ?? 0, 0);

  let query = supabase
    .schema("facturapp").from("admin_usuarios")
    .select("*", { count: "exact" });

  const q = (filtros.q ?? "").trim();
  if (q) {
    // Se busca en los tres campos por los que uno identifica una cuenta al
    // dar soporte: el correo por el que escribió, su nombre, o el RFC que
    // aparece en la factura de la que se queja.
    //
    // Las comas y paréntesis rompen la sintaxis de PostgREST `or=(...)`, así
    // que se quitan del término en vez de escaparse: son irrelevantes para
    // buscar un correo, un nombre o un RFC, y dejarlas pasar convertiría la
    // búsqueda en una forma de inyectar filtros arbitrarios.
    const limpio = q.replace(/[(),*]/g, " ").trim();
    if (limpio) {
      query = query.or(
        `email.ilike.*${limpio}*,nombre.ilike.*${limpio}*,rfc.ilike.*${limpio}*`,
      );
    }
  }

  if (filtros.estado === "suspendidas") query = query.not("suspendida_en", "is", null);
  if (filtros.estado === "activas") query = query.is("suspendida_en", null);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Error listando cuentas: ${error.message}`);
  return { cuentas: (data ?? []) as CuentaListada[], total: count ?? 0 };
}

/** Una cuenta de la vista, por id. `null` si no existe. */
export async function obtenerCuenta(
  supabase: SupabaseClient, userId: number,
): Promise<CuentaListada | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("admin_usuarios")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error consultando la cuenta: ${error.message}`);
  return (data as CuentaListada) ?? null;
}

/** Facturas recientes de una cuenta, para diagnóstico.
 *
 * NO reutiliza `listInvoicesForUser` (invoices_api.ts) a propósito: esa
 * función está acotada por ejercicio fiscal, que es lo correcto para la
 * cédula de deducciones del usuario pero lo contrario de lo que sirve aquí.
 * Al dar soporte uno pregunta "¿qué es lo último que entró?", y el problema
 * puede venir de un año anterior -- filtrarlo por el año en curso escondería
 * justo el caso que se está investigando.
 */
export async function facturasRecientes(
  supabase: SupabaseClient, userId: number, limite = 20,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    // En una sola línea literal a propósito: supabase-js infiere el tipo del
    // resultado parseando este string, y concatenarlo con `+` lo convierte en
    // un `string` cualquiera que ya no puede analizar.
    .select("id, uuid_fiscal, emisor_nombre, receptor_rfc, usuario_rfc, fecha_emision, total, categoria, estatus, origen, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (error) throw new Error(`Error consultando facturas de la cuenta: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

export type ResultadoCambioEstado =
  | { ok: true; suspendida: boolean }
  | { ok: false; motivo: "no_encontrada" | "es_uno_mismo" | "es_admin" };

/**
 * Suspende o reactiva una cuenta.
 *
 * Dos guardas, ambas para que el panel no pueda dejarse a sí mismo sin
 * operador:
 *
 * 1. **No suspenderse a uno mismo.** Sería irreversible desde la interfaz: al
 *    quedar suspendido, `getCurrentAdmin` empieza a devolver `null` y ya no
 *    hay forma de entrar al panel para deshacerlo. Solo se saldría metiendo
 *    mano a la base.
 * 2. **No suspender a otro admin.** Mismo riesgo con más pasos, y además no
 *    hay caso de uso legítimo: si hay que retirarle el acceso a un
 *    administrador, primero se le quita el rol.
 */
export async function cambiarEstadoCuenta(
  supabase: SupabaseClient,
  adminId: number,
  userId: number,
  accion: "suspender" | "reactivar",
  motivo: string | null,
): Promise<ResultadoCambioEstado> {
  if (adminId === userId) return { ok: false, motivo: "es_uno_mismo" };

  const { data: objetivo, error: errorSelect } = await supabase
    .schema("facturapp").from("users")
    .select("id, rol")
    .eq("id", userId)
    .maybeSingle();
  if (errorSelect) throw new Error(`Error buscando la cuenta: ${errorSelect.message}`);
  if (!objetivo) return { ok: false, motivo: "no_encontrada" };
  if ((objetivo as { rol?: string }).rol === "admin") return { ok: false, motivo: "es_admin" };

  const suspender = accion === "suspender";
  const { error: errorUpdate } = await supabase
    .schema("facturapp").from("users")
    .update({
      suspendida_en: suspender ? new Date().toISOString() : null,
      // Al reactivar se limpia el motivo: dejarlo puesto haría que la próxima
      // suspensión heredara la razón de la anterior.
      suspendida_motivo: suspender ? motivo : null,
    })
    .eq("id", userId);
  if (errorUpdate) throw new Error(`Error cambiando el estado: ${errorUpdate.message}`);

  return { ok: true, suspendida: suspender };
}

/** Métricas agregadas. Toda la suma ocurre en Postgres
 * (`facturapp.admin_metricas()`, migración 0013) — ver ahí el porqué. */
export async function obtenerMetricas(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.schema("facturapp").rpc("admin_metricas");
  if (error) throw new Error(`Error calculando métricas: ${error.message}`);
  return (data ?? {}) as Record<string, unknown>;
}
