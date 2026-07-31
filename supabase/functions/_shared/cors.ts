// Fase M1 — Headers CORS compartidos entre Edge Functions.
//
// Los webhooks de SendGrid/Meta son llamadas servidor-a-servidor y no están
// sujetas a CORS (es una restricción de navegador). Pero desde M11 sí hay un
// consumidor real desde el navegador: el dashboard, que vive en un origen
// distinto (hosting estático) porque Supabase no permite servir HTML desde
// una Edge Function — ver web/README.md.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  // Sin esto, el preflight de PATCH falla y el dashboard no puede guardar el
  // RFC desde otro origen. GET y POST se libran en algunos casos por ser
  // métodos "simples", pero PATCH nunca: siempre exige preflight, y el
  // navegador rechaza la petición si el método no aparece aquí.
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
