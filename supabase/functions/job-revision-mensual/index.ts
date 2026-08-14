// Fase M20 — job programado: aviso mensual de facturas que necesitan
// atención, disparado por pg_cron (ver 0011_revision_mensual.sql), NUNCA
// llamado directo desde el navegador ni con un JWT de usuario -- no hay un
// "usuario actual" aquí, recorre TODAS las cuentas con WhatsApp.
//
// Dos corridas al mes (ver la migración):
//   - "actual"   -- últimos días del mes en curso, para corregir a tiempo.
//   - "anterior" -- primeros días del mes siguiente, revisando el mes que
//     se acaba de cerrar (el "corte").
// El `?periodo=` decide cuál calendario usar; ver anioMesAnterior() en
// fecha_mexico.ts para el porqué de la resta de mes.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { facturasQueNecesitanAtencion } from "../_shared/attention.ts";
import { sendWhatsappTemplateMessage } from "../_shared/whatsapp.ts";
import { anioFiscalActual, anioMesAnterior, mesFiscalActual } from "../_shared/fecha_mexico.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Método no soportado", { status: 405, headers: corsHeaders });
  }

  // Mismo patrón que SENDGRID_WEBHOOK_SECRET / WHATSAPP_APP_SECRET: sin este
  // secreto, la URL del job sería invocable por cualquiera que la adivinara
  // y podría gastar la cuota de mensajes de WhatsApp de la cuenta.
  const secreto = Deno.env.get("CRON_JOB_SECRET");
  if (secreto) {
    if (req.headers.get("x-cron-secret") !== secreto) {
      return jsonResponse({ detail: "No autorizado" }, 401);
    }
  } else {
    console.warn("CRON_JOB_SECRET no configurado: se omite la verificación de origen");
  }

  const periodo = new URL(req.url).searchParams.get("periodo") ?? "actual";
  const { anio, mes } = periodo === "anterior"
    ? anioMesAnterior()
    : { anio: anioFiscalActual(), mes: mesFiscalActual() };

  const supabase = getSupabaseClient();
  // Se excluyen las cuentas suspendidas (Fase M23). No es solo cortesía:
  // mandarle a alguien "tienes 3 facturas por revisar" cuando le bloqueamos
  // el acceso para ir a revisarlas es peor que no decirle nada. La suspensión
  // corta la entrada en getCurrentUser y en los canales de ingesta; este es
  // el único camino de SALIDA, y también tiene que respetarla.
  const { data: usuarios, error } = await supabase
    .schema("facturapp").from("users")
    .select("id, whatsapp_phone")
    .not("whatsapp_phone", "is", null)
    .is("suspendida_en", null);
  if (error) {
    console.error("Error listando usuarios para el aviso mensual:", error);
    return jsonResponse({ detail: "Error consultando usuarios" }, 500);
  }

  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
  const templateName = Deno.env.get("WHATSAPP_TEMPLATE_REVISION_MENSUAL") ?? "revision_mensual";
  const dashboardUrl = Deno.env.get("DASHBOARD_URL") ?? "";

  const resultados: Array<Record<string, unknown>> = [];
  let avisados = 0;

  for (const usuario of usuarios ?? []) {
    let pendientes;
    try {
      pendientes = await facturasQueNecesitanAtencion(supabase, usuario.id, anio, mes);
    } catch (exc) {
      console.error(`Error consultando pendientes del usuario ${usuario.id}:`, exc);
      resultados.push({ user_id: usuario.id, error: "no se pudo consultar" });
      continue;
    }
    if (pendientes.length === 0) continue;

    if (!token || !phoneNumberId) {
      // Se cuenta igual en la respuesta -- así se puede ver desde los logs
      // cuántos avisos se están "perdiendo" mientras falte configurar
      // WhatsApp, sin que el job falle por eso.
      resultados.push({ user_id: usuario.id, pendientes: pendientes.length, enviado: false, motivo: "whatsapp_no_configurado" });
      continue;
    }

    try {
      await sendWhatsappTemplateMessage(
        usuario.whatsapp_phone, templateName, "es_MX",
        [String(pendientes.length), dashboardUrl],
        token, phoneNumberId,
      );
      avisados++;
      resultados.push({ user_id: usuario.id, pendientes: pendientes.length, enviado: true });
    } catch (exc) {
      console.error(`Error avisando por WhatsApp al usuario ${usuario.id}:`, exc);
      resultados.push({ user_id: usuario.id, pendientes: pendientes.length, enviado: false, error: String(exc) });
    }
  }

  return jsonResponse({ periodo, anio, mes, usuarios_avisados: avisados, resultados }, 200);
});
