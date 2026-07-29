// Fase M1 — Headers CORS compartidos entre Edge Functions.
//
// NOTA: los webhooks de SendGrid/Meta son llamadas servidor-a-servidor, no
// están sujetas a CORS (eso es una restricción de navegador). Este helper
// existe sobre todo por si en el futuro alguna función se llama desde un
// navegador (dashboard, herramienta de pruebas) — es el boilerplate estándar
// que genera `supabase functions new`.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

/**
 * Headers de toda respuesta JSON (Fase M7).
 *
 * El `charset=utf-8` es explícito a propósito. JSON es UTF-8 por defecto
 * según RFC 8259, pero no todos los clientes lo asumen: sin el charset en
 * el header, un cliente que caiga en el default de HTTP/1.1 (ISO-8859-1)
 * decodifica mal cualquier acento. Se detectó al probar el deploy de M7
 * contra el endpoint de chat, donde "categorías" llegaba como
 * "categorÃ­as". Toda la app responde en español, así que esto no es un
 * caso de borde.
 */
export const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};
