/**
 * Resolución de usuario por canal de ingesta (Fase M4/M5).
 *
 * Port 1:1 de get_or_create_user_by_phone() y get_or_create_user_by_email()
 * en whatsapp_service.py / email_service.py.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { placeholderRfc } from "./accounts.ts";
import { type Hallazgo, revalidarRfcAjeno } from "./validator.ts";
import { sincronizarRfcPrincipal } from "./rfcs.ts";

export interface AppUser {
  id: number;
  rfc: string;
}

function placeholderEmailForPhone(phone: string): string {
  return `wa-${phone}@facturapp.mx`;
}

/** Busca al usuario por teléfono de WhatsApp; si no existe, crea una cuenta
 * mínima (RFC placeholder, sin password utilizable — no habilita login
 * directo, solo permite asociar facturas hasta que el usuario se registre). */
export async function getOrCreateUserByPhone(
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
 *
 * Fase M18: si el remitente NO es el correo propio de ninguna cuenta pero SÍ
 * está en `authorized_senders` (p. ej. el correo de trabajo o del contador
 * del usuario), la factura se atribuye a esa cuenta en vez de crear una
 * nueva. Sin esto, reenviar una factura desde una dirección distinta a la
 * registrada creaba una cuenta fantasma silenciosa que el dueño real nunca
 * revisaba -- la factura se procesaba bien, solo que en el archivo
 * equivocado.
 */
export async function getOrCreateUserByEmail(
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

  const { data: autorizado, error: errorAutorizado } = await supabase
    .schema("facturapp")
    .from("authorized_senders")
    .select("user_id")
    .eq("email", normalizedEmail)
    .maybeSingle();
  if (errorAutorizado) {
    throw new Error(`Error verificando correo autorizado: ${errorAutorizado.message}`);
  }
  if (autorizado) {
    const { data: cuenta, error: errorCuenta } = await supabase
      .schema("facturapp")
      .from("users")
      .select("id, rfc")
      .eq("id", autorizado.user_id)
      .single();
    if (errorCuenta) {
      throw new Error(`Error resolviendo cuenta del correo autorizado: ${errorCuenta.message}`);
    }
    return cuenta as AppUser;
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

export interface UserProfile {
  id: number;
  email: string;
  nombre: string;
  rfc: string;
  plan: string;
  web_token: string | null;
  whatsapp_phone: string | null;
}

const PROFILE_COLS = "id, email, nombre, rfc, plan, web_token, whatsapp_phone";

/** Port 1:1 de `/api/user/profile` (User.to_public() en models.py). */
export async function getUserProfile(
  supabase: SupabaseClient, userId: number,
): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select(PROFILE_COLS)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error consultando perfil: ${error.message}`);
  return (data as UserProfile) ?? null;
}

/** Actualiza el RFC de un usuario (Fase M11).
 *
 * NO existe en Python: `accounts.py` dice que "el usuario debe completar su
 * RFC real desde su perfil", pero ese camino nunca se construyó — el perfil
 * es de solo lectura y por WhatsApp no hay forma de indicarlo. El resultado
 * era que toda cuenta creada por teléfono o correo se quedaba con un RFC
 * sintético (`PEND...`) para siempre, y por tanto TODA factura suya salía
 * marcada `RFC_AJENO: no será deducible`. Un falso positivo del 100% sobre
 * la regla más importante del validador.
 *
 * El RFC ya debe venir validado y normalizado por `validateRfc()`.
 */
export async function updateUserRfc(
  supabase: SupabaseClient, userId: number, rfc: string,
): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .update({ rfc })
    .eq("id", userId)
    .select(PROFILE_COLS)
    .maybeSingle();
  if (error) throw new Error(`Error actualizando RFC: ${error.message}`);
  if (!data) return null;

  // Sin esto, listarRfcs() queda vacío para esta cuenta -- ver la nota en
  // sincronizarRfcPrincipal() (rfcs.ts, Fase M15) para el porqué.
  await sincronizarRfcPrincipal(supabase, userId, rfc);

  return data as UserProfile;
}

export interface UserAuthRow {
  id: number;
  rfc: string;
  hashed_password: string | null;
  /** Sirve para el arranque de contraseña, así que es una credencial más y
   * viaja con el resto. */
  web_token: string | null;
}

const AUTH_COLS = "id, rfc, hashed_password, web_token";

/** Trae lo mínimo para decidir sobre credenciales: si el usuario ya tiene
 * contraseña o no. Se separa de `getUserProfile` a propósito para no pasear
 * el hash por caminos que no lo necesitan. */
export async function getUserAuth(
  supabase: SupabaseClient, userId: number,
): Promise<UserAuthRow | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select(AUTH_COLS)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error consultando credenciales: ${error.message}`);
  return (data as UserAuthRow) ?? null;
}

/** Igual que getUserAuth pero buscando por `web_token`, para el caso de una
 * cuenta que todavía no tiene contraseña y por tanto no puede autenticarse. */
export async function getUserAuthByWebToken(
  supabase: SupabaseClient, token: string,
): Promise<UserAuthRow | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select(AUTH_COLS)
    .eq("web_token", token)
    .maybeSingle();
  if (error) throw new Error(`Error consultando credenciales: ${error.message}`);
  return (data as UserAuthRow) ?? null;
}

export async function setUserPassword(
  supabase: SupabaseClient, userId: number, hash: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .update({ hashed_password: hash })
    .eq("id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Error guardando contraseña: ${error.message}`);
  return data !== null;
}

/** Recalcula el hallazgo RFC_AJENO y reatribuye `usuario_rfc` en las
 * facturas ya guardadas del usuario, tras cambiar su RFC (Fase M11, Fase
 * M15).
 *
 * Reatribuir `usuario_rfc` es tan importante como recalcular el hallazgo, y
 * hasta M15 no se hacía: una factura ingerida ANTES de que el usuario
 * indicara su RFC quedaba archivada con el RFC sintético `PEND...` en esa
 * columna para siempre, aunque `receptor_rfc` coincidiera con el RFC real
 * que se acaba de confirmar. El hallazgo RFC_AJENO se limpiaba
 * correctamente (se veía "válida" en la tabla), pero cualquier vista que
 * filtrara por `usuario_rfc` — el resumen por contribuyente de M15 — no
 * encontraba esa factura y mostraba el total en cero, aunque sí existiera.
 * Se detectó exactamente así, con datos reales.
 *
 * Solo se reatribuye cuando `receptor_rfc` de la factura coincide con el
 * `nuevoRfc` que se está confirmando — esa es la prueba de que la factura
 * genuinamente pertenece a este RFC. Sin esa condición, cambiar el RFC
 * principal podría robarle a otro contribuyente registrado (p. ej. la
 * empresa) facturas que sí son suyas.
 *
 * Devuelve cuántas facturas cambiaron (por cualquiera de las dos razones).
 */
export async function revalidarFacturasTrasCambioDeRfc(
  supabase: SupabaseClient, userId: number, nuevoRfc: string,
): Promise<number> {
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    .select("id, receptor_rfc, usuario_rfc, estatus, hallazgos")
    .eq("user_id", userId);
  if (error) throw new Error(`Error leyendo facturas para revalidar: ${error.message}`);

  let cambiadas = 0;
  for (const factura of data ?? []) {
    const previos = (factura.hallazgos ?? []) as Hallazgo[];
    const { hallazgos, estatus } = revalidarRfcAjeno(
      previos, factura.receptor_rfc ?? "", nuevoRfc,
    );

    const receptorCoincide =
      (factura.receptor_rfc ?? "").toUpperCase() === nuevoRfc.toUpperCase();
    const nuevoUsuarioRfc = receptorCoincide ? nuevoRfc : factura.usuario_rfc;

    const cambioHallazgos = estatus !== factura.estatus || hallazgos.length !== previos.length;
    const cambioUsuarioRfc = nuevoUsuarioRfc !== factura.usuario_rfc;
    // Solo se escribe si algo cambió: evita reescribir toda la tabla en cada
    // guardado de RFC, que suele ser el mismo valor reconfirmado.
    if (!cambioHallazgos && !cambioUsuarioRfc) continue;

    const patch: Record<string, unknown> = {};
    if (cambioHallazgos) {
      patch.hallazgos = hallazgos;
      patch.estatus = estatus;
    }
    if (cambioUsuarioRfc) {
      patch.usuario_rfc = nuevoUsuarioRfc;
    }

    const { error: updateError } = await supabase
      .schema("facturapp").from("invoices")
      .update(patch)
      .eq("id", factura.id);
    if (updateError) {
      throw new Error(`Error revalidando la factura ${factura.id}: ${updateError.message}`);
    }
    cambiadas++;
  }
  return cambiadas;
}

/** ¿Hay OTRO usuario con este RFC?
 *
 * `auth-register` ya rechaza RFC duplicados, pero la tabla no tiene
 * restricción UNIQUE, así que sin esta comprobación el perfil sería una
 * puerta trasera para crear duplicados. Excluye al propio usuario para que
 * reguardar el mismo RFC no falle.
 */
export async function rfcTomadoPorOtro(
  supabase: SupabaseClient, userId: number, rfc: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select("id")
    .eq("rfc", rfc)
    .neq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Error verificando RFC: ${error.message}`);
  return data !== null;
}

/** Port 1:1 de `_user_by_token()` en main.py — usado por `/api/public/*`.
 * `web_token` es un identificador de dashboard público, NO un mecanismo de
 * autenticación real (ver nota de seguridad en auth.ts). */
export async function getUserByWebToken(
  supabase: SupabaseClient, token: string,
): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select(PROFILE_COLS)
    .eq("web_token", token)
    .maybeSingle();
  if (error) throw new Error(`Error consultando usuario por token: ${error.message}`);
  return (data as UserProfile) ?? null;
}

// --------------------------------------------------------------------------
// Recuperar contraseña (Fase M17)
// --------------------------------------------------------------------------

const RESET_TOKEN_MINUTOS = 30;

/** Genera un token de recuperación de un solo uso, vigente 30 minutos, y lo
 * guarda reemplazando cualquier token anterior de la cuenta (pedir uno nuevo
 * invalida el previo). Separado de `web_token` a propósito — ver
 * 0009_password_reset.sql para el porqué. */
export async function generarResetToken(
  supabase: SupabaseClient, userId: number,
): Promise<string> {
  const token = crypto.randomUUID();
  const expira = new Date(Date.now() + RESET_TOKEN_MINUTOS * 60_000).toISOString();
  const { error } = await supabase
    .schema("facturapp").from("users")
    .update({ reset_token: token, reset_token_expira: expira })
    .eq("id", userId);
  if (error) throw new Error(`Error generando token de recuperación: ${error.message}`);
  return token;
}

/** Busca al usuario por token de recuperación vigente (no vencido). Un token
 * vencido o inexistente devuelve `null` igual que uno inválido -- no hay
 * necesidad de distinguirlos para quien llama. */
export async function getUserAuthByResetToken(
  supabase: SupabaseClient, token: string,
): Promise<UserAuthRow | null> {
  const { data, error } = await supabase
    .schema("facturapp").from("users")
    .select(`${AUTH_COLS}, reset_token_expira`)
    .eq("reset_token", token)
    .maybeSingle();
  if (error) throw new Error(`Error consultando token de recuperación: ${error.message}`);
  if (!data) return null;
  if (!data.reset_token_expira || new Date(data.reset_token_expira) < new Date()) return null;
  return data as UserAuthRow;
}

/** Invalida el token de recuperación tras usarlo -- de un solo uso. */
export async function limpiarResetToken(
  supabase: SupabaseClient, userId: number,
): Promise<void> {
  const { error } = await supabase
    .schema("facturapp").from("users")
    .update({ reset_token: null, reset_token_expira: null })
    .eq("id", userId);
  if (error) throw new Error(`Error limpiando token de recuperación: ${error.message}`);
}
