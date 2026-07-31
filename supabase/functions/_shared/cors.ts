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
  // Sin esto, el preflight de PATCH/DELETE falla y el dashboard no puede
  // completar la petición desde otro origen. GET y POST se libran en algunos
  // casos por ser métodos "simples", pero PATCH y DELETE nunca: siempre
  // exigen preflight, y el navegador rechaza la petición si el método no
  // aparece aquí — aunque el servidor la habría aceptado.
  //
  // DELETE faltó aquí desde que api-user-rfcs lo empezó a usar (Fase M14):
  // el botón "Quitar" de un contribuyente probablemente nunca funcionó desde
  // el navegador, porque el preflight lo rechazaba antes de que la petición
  // real saliera siquiera — un fallo que solo se ve en la consola del
  // navegador, nunca en los logs del servidor. Se detectó al agregar otro
  // endpoint DELETE (borrar factura, Fase M15) y revisar este archivo.
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
