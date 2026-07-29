/**
 * Resolución de usuario por canal de ingesta (Fase M4/M5).
 *
 * Port 1:1 de get_or_create_user_by_phone() y get_or_create_user_by_email()
 * en whatsapp_service.py / email_service.py.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { placeholderRfc } from "./accounts.ts";

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
