/**
 * Comandos rápidos de WhatsApp, sin IA (Fase M4b).
 *
 * Corre ANTES de llamar a OpenAI — ahorra latencia y costo en los mensajes
 * más comunes (saludo, ayuda). Patrón adoptado de
 * WHATSAPP_BOT_ARCHITECTURE.md (`interceptQuickCommand` del bot probado en
 * producción de otro proyecto en el mismo Supabase). No existe en el
 * sistema Python original — es parte de la extensión de chat vía WhatsApp
 * (ver whatsapp.ts: extractWhatsappTextMessages).
 *
 * Deliberadamente conservador: solo intercepta mensajes cortos que
 * coinciden EXACTO con un saludo o pedido de ayuda, para no interceptar por
 * error una pregunta real ("hola, cuánto llevo en médicos" debe llegar a
 * OpenAI, no cortarse en el saludo).
 */

const GREETING = /^(hola|buenas|hey|buen[oa]s?\s*d[ií]as?|buenas\s*tardes|buenas\s*noches)[\s!.]*$/i;
const HELP = /^(ayuda|help|comandos?|qu[eé]\s*puedes\s*hacer)[\s?!.]*$/i;

const GREETING_REPLY =
  "¡Hola! 🧾 Soy el asistente de FacturasMX. Mándame el XML de una factura " +
  "para registrarla, o pregúntame cosas como \"¿cuánto llevo en médicos?\" " +
  "o \"mis facturas de este mes\". Escribe *ayuda* para ver todo lo que puedo hacer.";

const HELP_REPLY =
  "Puedo ayudarte a:\n" +
  "• Registrar una factura (envía el XML como documento)\n" +
  "• Darte tu resumen de deducciones (\"¿cuánto llevo?\")\n" +
  "• Listar tus facturas (\"mis facturas de julio\")\n" +
  "• Reclasificar una factura (\"cambia esa factura a médicos\")\n" +
  "• Explicarte qué es deducible (\"¿qué puedo deducir?\")";

/** Devuelve la respuesta del comando rápido, o `null` si el mensaje debe
 * pasar a chat() con OpenAI. */
export function interceptQuickCommand(text: string): string | null {
  const trimmed = text.trim();
  if (GREETING.test(trimmed)) return GREETING_REPLY;
  if (HELP.test(trimmed)) return HELP_REPLY;
  return null;
}
