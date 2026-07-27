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
