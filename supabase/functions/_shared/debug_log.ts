/**
 * Logging de diagnóstico a `facturapp.debug_logs` (Fase M4b).
 *
 * Adoptado del patrón probado en producción de WHATSAPP_BOT_ARCHITECTURE.md
 * (bot de otro proyecto en el mismo Supabase) — persiste eventos clave del
 * webhook (firma inválida, errores de Meta/OpenAI) en una tabla en vez de
 * depender solo de `supabase functions logs`, que rota rápido.
 *
 * No existe equivalente en el sistema Python original — es una mejora de
 * observabilidad para el canal de WhatsApp, no un port. Nunca debe
 * interrumpir el flujo del webhook: un fallo al escribir el log se traga y
 * se reporta por console.error, no se relanza.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function logDebug(
  supabase: SupabaseClient,
  message: string,
  payload?: unknown,
): Promise<void> {
  try {
    await supabase
      .schema("facturapp")
      .from("debug_logs")
      .insert({ message, payload: payload ?? null });
  } catch (exc) {
    console.error("No se pudo escribir en debug_logs:", exc);
  }
}
