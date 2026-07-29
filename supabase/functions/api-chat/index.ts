// Fase M5.5 — Endpoint /api/chat (autenticado, JWT Bearer).
//
// Port 1:1 de chat_endpoint() en facturapp/facturapp/main.py: valida el
// access token JWT (NO web_token — ver _shared/auth.ts), guarda el mensaje
// del usuario, ejecuta chat() con function calling sobre OpenAI, guarda la
// respuesta, y la devuelve.
//
// A diferencia de whatsapp-webhook/sendgrid-webhook, este NO es un webhook
// público: requiere `Authorization: Bearer <access_token>` real.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { chat, realChatCompletion } from "../_shared/chat.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function handlePost(req: Request): Promise<Response> {
  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const user = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!user) {
    return new Response(JSON.stringify({ detail: "No autenticado o token inválido" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ detail: "JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ detail: "El mensaje es obligatorio" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "user", content: message });

  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";

  let result;
  try {
    result = await chat(
      supabase, user, message,
      (messages, tools) => realChatCompletion(messages, tools, apiKey, model),
    );
  } catch (exc) {
    console.error(`Error inesperado en /api/chat para user ${user.id}:`, exc);
    return new Response(JSON.stringify({ detail: "Error procesando tu mensaje." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "assistant", content: result.response });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method === "POST") {
    return handlePost(req);
  }
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
