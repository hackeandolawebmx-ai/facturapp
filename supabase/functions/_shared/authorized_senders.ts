/**
 * Correos autorizados de una cuenta (Fase M18).
 *
 * Las facturas por correo se atribuyen por el remitente EXACTO
 * (`getOrCreateUserByEmail`, en users.ts). Sin esto, reenviar una factura
 * desde una dirección distinta a la registrada crea o usa una cuenta
 * DIFERENTE en silencio -- la factura se procesa bien, pero en un archivo
 * que el dueño real nunca revisa. Ver 0010_correos_autorizados.sql para el
 * detalle completo.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface CorreoAutorizado {
  id: number;
  email: string;
  alias: string | null;
}

const COLS = "id, email, alias";

export async function listarCorreosAutorizados(
  supabase: SupabaseClient, userId: number,
): Promise<CorreoAutorizado[]> {
  const { data, error } = await supabase
    .schema("facturapp").from("authorized_senders")
    .select(COLS)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Error listando correos autorizados: ${error.message}`);
  return (data ?? []) as CorreoAutorizado[];
}

export type AgregarCorreoResultado =
  | { ok: true; correo: CorreoAutorizado }
  | { ok: false; motivo: "ya_registrado" };

/** Agrega un correo autorizado a la cuenta.
 *
 * `ya_registrado` cubre TANTO un correo ya autorizado en esta u otra cuenta
 * COMO el propio correo de una cuenta existente (`users.email`) -- en ambos
 * casos, agregarlo aquí sería ambiguo sobre a quién pertenece.
 */
export async function agregarCorreoAutorizado(
  supabase: SupabaseClient, userId: number, email: string, alias: string | null,
): Promise<AgregarCorreoResultado> {
  const normalizado = email.trim().toLowerCase();

  const { data: cuentaExistente, error: errorCuenta } = await supabase
    .schema("facturapp").from("users")
    .select("id")
    .eq("email", normalizado)
    .maybeSingle();
  if (errorCuenta) throw new Error(`Error verificando correo: ${errorCuenta.message}`);
  if (cuentaExistente) return { ok: false, motivo: "ya_registrado" };

  const { data: yaAutorizado, error: errorConsulta } = await supabase
    .schema("facturapp").from("authorized_senders")
    .select("id")
    .eq("email", normalizado)
    .maybeSingle();
  if (errorConsulta) throw new Error(`Error verificando correo: ${errorConsulta.message}`);
  if (yaAutorizado) return { ok: false, motivo: "ya_registrado" };

  const { data, error } = await supabase
    .schema("facturapp").from("authorized_senders")
    .insert({ user_id: userId, email: normalizado, alias: alias || null })
    .select(COLS)
    .single();
  if (error) throw new Error(`Error agregando correo autorizado: ${error.message}`);
  return { ok: true, correo: data as CorreoAutorizado };
}

export async function eliminarCorreoAutorizado(
  supabase: SupabaseClient, userId: number, id: number,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("facturapp").from("authorized_senders")
    .delete()
    .eq("id", id).eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Error eliminando correo autorizado: ${error.message}`);
  return data !== null;
}
