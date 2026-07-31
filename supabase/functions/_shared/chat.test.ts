/**
 * Tests del chat conversacional (Fase M5.5) — port 1:1 de
 * facturapp/facturapp/tests/test_chat.py.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { APIError, APIConnectionError, OpenAIError, RateLimitError } from "npm:openai@4";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import {
  buildSystemPrompt, ChatIntent, ChatServiceError, chat, classifyIntent,
  getRecentChatHistory, translateOpenAIError,
} from "./chat.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

function seedInvoice(
  supabase: ReturnType<typeof client>, userId: number, uuid: string,
  total = 1160.0, categoria = "Médicos",
) {
  supabase.tables.invoices.push({
    id: supabase.tables.invoices.length + 1,
    user_id: userId, uuid_fiscal: uuid, usuario_rfc: "DAXX860715XX0",
    emisor_nombre: "Consultorio Dr. X", receptor_rfc: "DAXX860715XX0",
    fecha_emision: "2026-07-12", anio: 2026, total, categoria,
    estatus: "valida", hallazgos: [],
  });
}

// ---- Intención (sin LLM) ----------------------------------------------------

Deno.test("classifyIntent: los 5 casos de test_intent_classification", () => {
  assertEquals(classifyIntent("¿Cuánto llevo en médicos?"), ChatIntent.RESUMEN);
  assertEquals(classifyIntent("Muéstrame mis facturas de marzo"), ChatIntent.LISTAR);
  assertEquals(classifyIntent("Exporta todo a ZIP"), ChatIntent.EXPORTAR);
  assertEquals(classifyIntent("La última reclasifícala a seguros"), ChatIntent.RECLASIFICAR);
  assertEquals(classifyIntent("¿Qué puedo deducir?"), ChatIntent.AYUDA);
});

// ---- Helpers de mock del LLM -------------------------------------------------

// deno-lint-ignore no-explicit-any
function toolCall(name: string, args: Record<string, unknown> = {}): any {
  return { id: "call_1", function: { name, arguments: JSON.stringify(args) } };
}

/** Primera llamada → pide la herramienta; segunda → responde con su resultado.
 * Mismo patrón que _fake_completion_for() en test_chat.py. */
// deno-lint-ignore no-explicit-any
function fakeCompletionFor(toolName: string, args: Record<string, unknown> = {}): any {
  // deno-lint-ignore no-explicit-any
  return async (messages: any[]) => {
    if (!messages.some((m) => m.role === "tool")) {
      return { content: null, tool_calls: [toolCall(toolName, args)] };
    }
    const toolMsg = messages.filter((m) => m.role === "tool").at(-1);
    return { content: "Aquí tienes: " + toolMsg.content, tool_calls: null };
  };
}

// ---- Chat con function calling -----------------------------------------------

Deno.test("chat(): get_summary (test_chat_get_summary)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });
  seedInvoice(supabase, 1, "UUID-A-1", 1160.0);

  const result = await chat(supabase, { id: 1, rfc: "DAXX860715XX0" }, "¿cuánto llevo?", fakeCompletionFor("get_summary"));

  assert(result.tools_used.includes("get_summary"));
  assert(result.response.includes("1160")); // el monto real llega vía la herramienta
});

Deno.test("chat(): list_invoices (test_chat_list_invoices)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 2, rfc: "DAXX860715XX0" });
  seedInvoice(supabase, 2, "UUID-B-1");

  const result = await chat(supabase, { id: 2, rfc: "DAXX860715XX0" }, "mis facturas de julio", fakeCompletionFor("list_invoices"));

  assert(result.tools_used.includes("list_invoices"));
  assert(result.response.includes("UUID-B-1"));
});

Deno.test("chat(): aislamiento de datos entre usuarios (test_data_isolation)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 10, rfc: "DAXX860715XX0" }, { id: 20, rfc: "REBB900110AB1" });
  seedInvoice(supabase, 10, "UUID-ANA", 1000.0);
  seedInvoice(supabase, 20, "UUID-BETO", 9999.0);

  const resAna = await chat(
    supabase, { id: 10, rfc: "DAXX860715XX0" }, "mis facturas",
    fakeCompletionFor("list_invoices"),
  );
  const resBeto = await chat(
    supabase, { id: 20, rfc: "REBB900110AB1" }, "mi resumen",
    fakeCompletionFor("get_summary"),
  );

  assert(resAna.response.includes("UUID-ANA"));
  assert(!resAna.response.includes("UUID-BETO"));
  assert(resBeto.response.includes("9999"));
});

Deno.test("chat(): reclassify_invoice actualiza la factura correcta", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });
  seedInvoice(supabase, 1, "UUID-X", 500, "Sin clasificar");

  await chat(
    supabase, { id: 1, rfc: "DAXX860715XX0" }, "reclasifica UUID-X a Médicos",
    fakeCompletionFor("reclassify_invoice", { uuid: "UUID-X", nueva_categoria: "Médicos" }),
  );

  assertEquals(supabase.tables.invoices[0].categoria, "Médicos");
  assertEquals(supabase.tables.invoices[0].confianza, 1.0);
});

Deno.test("chat(): export_package es el mock (status mock_fase4)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });
  seedInvoice(supabase, 1, "UUID-X");

  const result = await chat(
    supabase, { id: 1, rfc: "DAXX860715XX0" }, "exporta",
    fakeCompletionFor("export_package"),
  );
  assert(result.response.includes("mock_fase4"));
});

Deno.test("chat(): sin tool_calls devuelve la respuesta directa", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });

  const result = await chat(
    supabase, { id: 1, rfc: "DAXX860715XX0" }, "hola",
    async () => ({ content: "¡Hola! ¿En qué te ayudo?", tool_calls: null }),
  );
  assertEquals(result.response, "¡Hola! ¿En qué te ayudo?");
  assertEquals(result.tools_used, []);
});

// ---- Manejo de errores de OpenAI (traducción real, con instancias reales) --
//
// Mismo patrón que test_chat.py: construir instancias REALES de las
// excepciones del SDK (no un mock genérico) y verificar que
// translateOpenAIError() las traduce al mensaje correcto.

Deno.test("translateOpenAIError: RateLimitError → mensaje de 'ocupado' (test_chat_completion_translates_rate_limit_error)", () => {
  const exc = new RateLimitError(429, { message: "rate limited" }, "rate limited", {});
  const result = translateOpenAIError(exc);
  assert(result instanceof ChatServiceError);
  assert(result.userMessage.toLowerCase().includes("ocupado"));
});

Deno.test("translateOpenAIError: APIConnectionError → mensaje de 'conectarme' (test_chat_completion_translates_api_error)", () => {
  const exc = new APIConnectionError({ message: "connection failed" });
  const result = translateOpenAIError(exc);
  assert(result instanceof ChatServiceError);
  assert(result.userMessage.toLowerCase().includes("conectarme"));
});

Deno.test("translateOpenAIError: OpenAIError genérico también se traduce (test_chat_completion_translates_generic_openai_error)", () => {
  const exc = new OpenAIError("weird");
  const result = translateOpenAIError(exc);
  assert(result instanceof ChatServiceError);
});

Deno.test("translateOpenAIError: un error NO relacionado con OpenAI se re-lanza tal cual", () => {
  assertThrows(() => translateOpenAIError(new RangeError("no es de OpenAI")), RangeError);
});

Deno.test("chat(): ChatServiceError produce respuesta legible, no se propaga (test_chat_orchestrator_returns_friendly_message_on_openai_failure)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });

  const result = await chat(supabase, { id: 1, rfc: "DAXX860715XX0" }, "hola", async () => {
    throw new ChatServiceError("Tengo problemas para conectarme con el asistente. Intenta más tarde.");
  });

  assert(result.response.toLowerCase().includes("problemas"));
  assertEquals(result.tools_used, []);
});

Deno.test("chat(): un error NO relacionado con OpenAI SÍ se propaga (lo atrapa el endpoint, no chat())", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });

  let threw = false;
  try {
    await chat(supabase, { id: 1, rfc: "DAXX860715XX0" }, "hola", async () => {
      throw new RuntimeErrorLike("boom inesperado");
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

class RuntimeErrorLike extends Error {}

// ---- Historial de conversación (Fase M4b, extensión solo para WhatsApp) ----

Deno.test("chat(): con history, el mensaje previo llega a chatCompletionFn", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });

  // deno-lint-ignore no-explicit-any
  let seenMessages: any[] = [];
  const result = await chat(
    supabase, { id: 1, rfc: "DAXX860715XX0" }, "¿y en marzo?",
    async (messages) => {
      seenMessages = messages;
      return { content: "Respuesta con contexto", tool_calls: null };
    },
    [{ role: "user", content: "mis facturas de febrero" }, { role: "assistant", content: "Tienes 2 facturas." }],
  );

  assertEquals(result.response, "Respuesta con contexto");
  // system, historial (2), mensaje actual
  assertEquals(seenMessages.length, 4);
  assertEquals(seenMessages[1], { role: "user", content: "mis facturas de febrero" });
  assertEquals(seenMessages[3], { role: "user", content: "¿y en marzo?" });
});

Deno.test("chat(): sin history (default), se comporta igual que M5.5 (solo system + mensaje actual)", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });

  // deno-lint-ignore no-explicit-any
  let seenMessages: any[] = [];
  await chat(supabase, { id: 1, rfc: "DAXX860715XX0" }, "hola", async (messages) => {
    seenMessages = messages;
    return { content: "hola!", tool_calls: null };
  });

  assertEquals(seenMessages.length, 2);
});

// ---- getRecentChatHistory ----------------------------------------------------

Deno.test("getRecentChatHistory: devuelve los mensajes en orden cronológico", async () => {
  const supabase = client();
  supabase.tables.chat_messages.push(
    { id: 1, user_id: 1, role: "user", content: "primero", created_at: "2026-07-01T10:00:00Z" },
    { id: 2, user_id: 1, role: "assistant", content: "segundo", created_at: "2026-07-01T10:00:05Z" },
    { id: 3, user_id: 2, role: "user", content: "de otro usuario", created_at: "2026-07-01T10:00:10Z" },
  );

  const history = await getRecentChatHistory(supabase, 1);
  assertEquals(history, [
    { role: "user", content: "primero" },
    { role: "assistant", content: "segundo" },
  ]);
});

// ---- buildSystemPrompt (fecha en el prompt) ---------------------------------
//
// Sin la fecha, el modelo resuelve "este año" adivinando a partir de sus
// datos de entrenamiento. En producción contestó sobre 2023 a un usuario que
// preguntaba por el año en curso, diciendo que no tenía deducciones — una
// respuesta falsa con aspecto de correcta.

Deno.test("buildSystemPrompt: incluye el año en curso", () => {
  const prompt = buildSystemPrompt(new Date("2026-07-30T15:00:00Z"));
  assert(prompt.includes("2026"), "el prompt debe indicar el año en curso");
});

Deno.test("buildSystemPrompt: instruye explícitamente a no suponer la fecha", () => {
  const prompt = buildSystemPrompt(new Date("2026-07-30T15:00:00Z"));
  assert(prompt.includes("NUNCA supongas la fecha"));
});

Deno.test("buildSystemPrompt: conserva las instrucciones base", () => {
  const prompt = buildSystemPrompt(new Date("2026-07-30T15:00:00Z"));
  assert(prompt.includes("FacturasMX"));
  assert(prompt.includes("No inventes cifras"));
});

Deno.test("buildSystemPrompt: usa la zona de México, no UTC", () => {
  // 1 de enero 03:00 UTC = 31 de diciembre 21:00 en México. El año fiscal
  // que corresponde es el que TERMINA, no el que empieza en UTC. Es el
  // momento exacto en que equivocarse sería más costoso.
  const prompt = buildSystemPrompt(new Date("2027-01-01T03:00:00Z"));
  assert(
    prompt.includes("2026"),
    "en Nochevieja UTC el año en México sigue siendo el anterior",
  );
});

Deno.test("buildSystemPrompt: a mediodía de México el año es el corriente", () => {
  const prompt = buildSystemPrompt(new Date("2027-01-01T18:00:00Z"));
  assert(prompt.includes("2027"));
});
