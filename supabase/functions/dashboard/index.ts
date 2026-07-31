// Fase M11 — Dashboard web. Sirve la página HTML; los datos los pide el
// navegador a los endpoints autenticados (api-user-profile, api-summary,
// api-invoices).
//
// Esta función NO valida credenciales: solo entrega HTML público, igual que
// cualquier página de login. La autenticación ocurre después, en las
// llamadas que hace la página a la API, cada una con su Bearer.
//
// Sustituye a `/a/{token}` de Python, que abría el archivo fiscal completo a
// quien tuviera el enlace. Ver pagina.ts para las tres divergencias
// respecto al template original.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { PAGINA_HTML } from "./pagina.ts";

serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return new Response("Método no soportado", { status: 405, headers: corsHeaders });
  }

  return new Response(PAGINA_HTML, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      // Sin caché: la página es pequeña y así un despliegue nuevo llega de
      // inmediato, sin usuarios atrapados en una versión vieja del JS que
      // hable con una API que ya cambió.
      "Cache-Control": "no-store",
      // La página no incrusta contenido de terceros ni debe ser incrustada.
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
});
