/**
 * Chat conversacional con OpenAI (function calling) — Fase M5.5.
 *
 * Port 1:1 de facturapp/facturapp/chat.py.
 *
 * DIVERGENCIAS DECLARADAS respecto al spec original de esta fase:
 *
 * 1. NO se pasa historial de conversación a OpenAI. Se revisó `chat.py`
 *    línea por línea: cada llamada a `chat()` construye un `messages` nuevo
 *    con solo `[system, user_message]` — no consulta `chat_messages` para
 *    dar contexto. El spec asumía que "la versión Python ya hace esto" —
 *    no es así; se porta la ausencia de historial tal cual, no la versión
 *    "recomendada" que el spec sugería como alternativa.
 * 2. NO existe `execute_intent()`. El entry point real es `chat()`, que
 *    llama a OpenAI directo con function calling — no hay un paso previo
 *    de clasificar intención que condicione la llamada. `classify_intent`/
 *    `ChatIntent` SÍ existen en Python, pero son código huérfano: nunca se
 *    invocan desde `chat()` ni desde el endpoint. Se portan de todos modos
 *    (Python los testea por separado) pero NO se usan para orquestar nada.
 * 3. `reclassify_invoice` recibe `uuid` (string, `uuid_fiscal`), no un
 *    `invoice_id` numérico como proponía el spec — así es como Python
 *    identifica la factura.
 * 4. `export_package` es un MOCK real en Python (`export.py` devuelve
 *    `{formato, archivos, status: "mock_fase4"}`, sin generar ningún ZIP).
 *    Se porta el mock tal cual — construir un ZIP real ahora sería
 *    adelantar la Fase 4, no portar el sistema actual.
 * 5. La forma de la respuesta es `{response: string, tools_used: string[]}`
 *    — no `{response, metadata: {intent, function_called}}` como sugería
 *    el spec; ese campo `metadata` no existe en `ChatResponse` de Python.
 *
 * EXTENSIÓN (Fase M4b, NO en Python): `chat()` acepta un parámetro `history`
 * opcional para el canal de WhatsApp (ver whatsapp-webhook/index.ts), que
 * SÍ inyecta los últimos mensajes de `chat_messages` para dar continuidad a
 * la conversación — patrón adoptado de WHATSAPP_BOT_ARCHITECTURE.md. El
 * endpoint `/api/chat` (M5.5, port fiel de Python) sigue sin pasar historial
 * — simplemente no usa este parámetro, preservando la paridad 1:1 original.
 */
import OpenAI, { APIError, OpenAIError, RateLimitError } from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedUser } from "./auth.ts";

// --------------------------------------------------------------------------
// Clasificación de intención (huérfana en Python — se porta igual, sin uso)
// --------------------------------------------------------------------------

export const ChatIntent = {
  RESUMEN: "obtener_resumen",
  LISTAR: "listar_facturas",
  RECLASIFICAR: "reclasificar",
  EXPORTAR: "exportar",
  AYUDA: "solicitar_ayuda",
} as const;

const INTENT_KEYWORDS: Array<[string, string[]]> = [
  [ChatIntent.RECLASIFICAR, ["reclasif", "cambia", "corrige", "es de", "muévela", "muevela"]],
  [ChatIntent.EXPORTAR, ["exporta", "descarga", "zip", "excel", "paquete"]],
  [ChatIntent.LISTAR, ["factura", "lista", "muestra", "enséñame", "ensename", "ver mis", "de marzo", "de julio"]],
  [ChatIntent.RESUMEN, ["cuánto", "cuanto", "resumen", "total", "llevo", "cédula", "cedula", "deducible"]],
  [ChatIntent.AYUDA, ["qué puedo", "que puedo", "ayuda", "cómo", "como", "deducir", "explica"]],
];

/** Detecta la intención principal por palabras clave (determinístico).
 * NO se usa para orquestar chat() — ver nota de divergencia #2 arriba. */
export function classifyIntent(message: string): string {
  const text = message.toLowerCase();
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return intent;
  }
  return ChatIntent.AYUDA;
}

// --------------------------------------------------------------------------
// Herramientas (function calling) — esquema OpenAI, idéntico a Python
// --------------------------------------------------------------------------

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_summary",
      description: "Obtiene totales de deducciones por categoría del usuario.",
      parameters: {
        type: "object",
        properties: { year: { type: "integer" }, categoria: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_invoices",
      description: "Lista facturas del usuario con filtros opcionales.",
      parameters: {
        type: "object",
        properties: {
          year: { type: "integer" }, month: { type: "integer" }, categoria: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reclassify_invoice",
      description: "Reclasifica una factura del usuario a otra categoría.",
      parameters: {
        type: "object",
        properties: { uuid: { type: "string" }, nueva_categoria: { type: "string" } },
        required: ["uuid", "nueva_categoria"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_package",
      description: "Genera un paquete ZIP de exportación del año.",
      parameters: { type: "object", properties: { year: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_deductions",
      description: "Explica las categorías de deducción disponibles.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const CATEGORIAS_INFO: Record<string, string> = {
  "Médicos": "Gastos médicos, dentales y hospitalarios con pago electrónico y emisor colegiado.",
  "Colegiaturas": "Colegiaturas de nivel preescolar a bachillerato, con tope anual por nivel.",
  "Seguros GMM": "Primas de seguros de gastos médicos mayores.",
  "Hipoteca": "Intereses reales de créditos hipotecarios (constancia anual del banco).",
};

const YEAR_DEFAULT = 2026;

// --------------------------------------------------------------------------
// Ejecución de herramientas (SIEMPRE filtra por user.id)
// --------------------------------------------------------------------------

async function toolGetSummary(
  supabase: SupabaseClient, user: AuthenticatedUser, year?: number, categoria?: string,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  let query = supabase.schema("facturapp").from("invoices")
    .select("categoria, total").eq("user_id", user.id).eq("anio", y);
  if (categoria) query = query.eq("categoria", categoria);

  const { data, error } = await query;
  if (error) throw new Error(`Error consultando resumen: ${error.message}`);

  const cedula: Record<string, { total: number; facturas: number }> = {};
  let totalGeneral = 0;
  for (const row of data ?? []) {
    const cat = row.categoria || "Sin clasificar";
    const entry = cedula[cat] ?? { total: 0, facturas: 0 };
    entry.total = Math.round((entry.total + (row.total || 0)) * 100) / 100;
    entry.facturas += 1;
    cedula[cat] = entry;
    totalGeneral = Math.round((totalGeneral + (row.total || 0)) * 100) / 100;
  }
  return { year: y, categorias: cedula, total_general: totalGeneral };
}

async function toolListInvoices(
  supabase: SupabaseClient, user: AuthenticatedUser,
  year?: number, month?: number, categoria?: string,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  let query = supabase.schema("facturapp").from("invoices")
    .select("uuid_fiscal, emisor_nombre, fecha_emision, categoria, total, estatus")
    .eq("user_id", user.id).eq("anio", y);
  if (categoria) query = query.eq("categoria", categoria);
  query = query.order("fecha_emision", { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(`Error consultando facturas: ${error.message}`);

  let rows = data ?? [];
  if (month) {
    const mm = String(month).padStart(2, "0");
    rows = rows.filter((r) => (r.fecha_emision ?? "").slice(5, 7) === mm);
  }

  return {
    year: y,
    count: rows.length,
    invoices: rows.map((r) => ({
      uuid: r.uuid_fiscal, emisor: r.emisor_nombre, fecha: r.fecha_emision,
      categoria: r.categoria, total: r.total, estatus: r.estatus,
    })),
  };
}

async function toolReclassifyInvoice(
  supabase: SupabaseClient, user: AuthenticatedUser, uuid: string, nuevaCategoria: string,
): Promise<unknown> {
  const { data: inv, error: selectError } = await supabase
    .schema("facturapp").from("invoices")
    .select("id, categoria")
    .eq("user_id", user.id).eq("uuid_fiscal", uuid.toUpperCase())
    .maybeSingle();

  if (selectError) throw new Error(`Error buscando factura: ${selectError.message}`);
  if (!inv) return { ok: false, mensaje: "No encontré esa factura en tu archivo." };

  const anterior = inv.categoria;
  const { error: updateError } = await supabase
    .schema("facturapp").from("invoices")
    .update({ categoria: nuevaCategoria, confianza: 1.0 })
    .eq("id", inv.id);

  if (updateError) throw new Error(`Error actualizando factura: ${updateError.message}`);
  return { ok: true, uuid, de: anterior, a: nuevaCategoria };
}

/** MOCK — igual que export_zip() en export.py. No genera ningún ZIP real
 * (eso es Fase 4 del sistema original; no adelantarlo aquí). */
async function toolExportPackage(
  supabase: SupabaseClient, user: AuthenticatedUser, year?: number,
): Promise<unknown> {
  const y = year ?? YEAR_DEFAULT;
  const { data, error } = await supabase
    .schema("facturapp").from("invoices")
    .select("id").eq("user_id", user.id).eq("anio", y);
  if (error) throw new Error(`Error consultando facturas para exportar: ${error.message}`);
  return { formato: "zip", archivos: (data ?? []).length, status: "mock_fase4" };
}

function toolExplainDeductions(): unknown {
  return { categorias: CATEGORIAS_INFO };
}

async function executeTool(
  name: string, supabase: SupabaseClient, user: AuthenticatedUser, args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_summary":
      return toolGetSummary(supabase, user, args.year as number | undefined, args.categoria as string | undefined);
    case "list_invoices":
      return toolListInvoices(
        supabase, user,
        args.year as number | undefined, args.month as number | undefined, args.categoria as string | undefined,
      );
    case "reclassify_invoice":
      return toolReclassifyInvoice(supabase, user, (args.uuid as string) ?? "", (args.nueva_categoria as string) ?? "");
    case "export_package":
      return toolExportPackage(supabase, user, args.year as number | undefined);
    case "explain_deductions":
      return toolExplainDeductions();
    default:
      return { error: `herramienta desconocida: ${name}` };
  }
}

// --------------------------------------------------------------------------
// LLM (OpenAI) — aislado para poder mockearlo en tests
// --------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "Eres el asistente de FacturasMX, una plataforma mexicana de deducciones " +
  "fiscales (CFDI 4.0). Responde SIEMPRE en español, claro y accionable. " +
  "Usa las herramientas disponibles para consultar los datos reales del " +
  "usuario antes de responder con montos o listas. No inventes cifras.";

export class ChatServiceError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
  }
}

// deno-lint-ignore no-explicit-any
type LlmMessage = { content: string | null; tool_calls?: any[] | null };

/** Traduce un error de OpenAI a ChatServiceError (mensaje legible + log).
 * Función pura y separada de la llamada de red para poder testearla con
 * instancias reales de error construidas a mano — mismo patrón que
 * test_chat.py, que monkeypatchea `_get_client` en vez de mockear HTTP. */
export function translateOpenAIError(exc: unknown): ChatServiceError {
  if (exc instanceof RateLimitError) {
    console.warn("OpenAI rate limit:", exc.message);
    return new ChatServiceError("Estoy un poco ocupado en este momento. Intenta de nuevo en unos segundos.");
  }
  if (exc instanceof APIError) {
    console.error("OpenAI APIError:", exc.message);
    return new ChatServiceError("Tengo problemas para conectarme con el asistente. Intenta más tarde.");
  }
  if (exc instanceof OpenAIError) {
    console.error("OpenAI error inesperado:", exc.message);
    return new ChatServiceError("Algo salió mal procesando tu mensaje. Intenta de nuevo.");
  }
  throw exc;
}

/** Llama a OpenAI de verdad. Los tests de orquestación inyectan un mock vía
 * el parámetro `chatCompletionFn` de chat() (no se monkeypatchea un módulo
 * — no aplica en ESM; es inyección de dependencia, mismo patrón que
 * ValidationEngine.classify en validator.ts, Fase M3). La traducción de
 * errores (translateOpenAIError) sí se testea aislada y directamente. */
export async function realChatCompletion(
  // deno-lint-ignore no-explicit-any
  messages: any[], tools: any[], apiKey: string, model: string,
): Promise<LlmMessage> {
  const client = new OpenAI({ apiKey });
  try {
    const resp = await client.chat.completions.create({
      model, messages, tools, tool_choice: "auto",
    });
    return resp.choices[0].message;
  } catch (exc) {
    throw translateOpenAIError(exc);
  }
}

// --------------------------------------------------------------------------
// Orquestador
// --------------------------------------------------------------------------

export interface ChatResult {
  response: string;
  tools_used: string[];
}

export type ChatCompletionFn = (
  // deno-lint-ignore no-explicit-any
  messages: any[], tools: any[],
) => Promise<LlmMessage>;

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const HISTORY_LIMIT = 20;

/** Lee los últimos N mensajes de `chat_messages` para un usuario, en orden
 * cronológico (más viejo primero, como espera `chat()`). Extensión Fase
 * M4b para el canal de WhatsApp — ver nota de divergencia arriba. */
export async function getRecentChatHistory(
  supabase: SupabaseClient, userId: number,
): Promise<ChatHistoryMessage[]> {
  const { data, error } = await supabase
    .schema("facturapp").from("chat_messages")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(`Error consultando historial de chat: ${error.message}`);
  return ((data ?? []) as ChatHistoryMessage[]).reverse();
}

/** Port 1:1 de chat() en chat.py — sin `history`, se comporta exactamente
 * igual que la versión original (NO pasa historial, ver divergencia #1).
 * `history` es una extensión Fase M4b usada solo por el canal de WhatsApp. */
export async function chat(
  supabase: SupabaseClient,
  user: AuthenticatedUser,
  message: string,
  chatCompletionFn: ChatCompletionFn,
  history: ChatHistoryMessage[] = [],
): Promise<ChatResult> {
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];
  const toolsUsed: string[] = [];

  try {
    const first = await chatCompletionFn(messages, TOOLS);
    const toolCalls = first.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      return { response: first.content ?? "", tools_used: toolsUsed };
    }

    messages.push({
      role: "assistant",
      content: first.content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await executeTool(name, supabase, user, args);
      toolsUsed.push(name);
      messages.push({
        role: "tool", tool_call_id: tc.id, content: JSON.stringify(result),
      });
    }

    const final = await chatCompletionFn(messages, TOOLS);
    return { response: final.content ?? "", tools_used: toolsUsed };
  } catch (exc) {
    if (exc instanceof ChatServiceError) {
      return { response: exc.userMessage, tools_used: [] };
    }
    throw exc;
  }
}
