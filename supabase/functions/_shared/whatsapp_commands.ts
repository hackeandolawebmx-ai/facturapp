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
  "¡Hola! 🧾 Soy el asistente de Facturino. Mándame el XML de una factura " +
  "para registrarla, o pregúntame cosas como \"¿cuánto llevo en médicos?\" " +
  "o \"mis facturas de este mes\". Escribe *ayuda* para ver todo lo que puedo hacer.";

const HELP_REPLY =
  "Puedo ayudarte a:\n" +
  "• Registrar una factura (envía el XML como documento)\n" +
  "• Darte tu resumen de deducciones (\"¿cuánto llevo?\")\n" +
  "• Listar tus facturas (\"mis facturas de julio\")\n" +
  "• Reclasificar una factura (\"cambia esa factura a médicos\")\n" +
  "• Explicarte qué es deducible (\"¿qué puedo deducir?\")\n" +
  "• Darte el acceso a la plataforma web (\"quiero entrar a la web\")\n" +
  "• Ayudarte a recuperar tu contraseña (\"olvidé mi contraseña\")\n" +
  "• Decirte dónde enviar facturas (\"¿dónde envío mis facturas?\")";

/** Devuelve la respuesta del comando rápido, o `null` si el mensaje debe
 * pasar a chat() con OpenAI. */
export function interceptQuickCommand(text: string): string | null {
  const trimmed = text.trim();
  if (GREETING.test(trimmed)) return GREETING_REPLY;
  if (HELP.test(trimmed)) return HELP_REPLY;
  return null;
}

// ---------------------------------------------------------------------------
// Acceso a la web (Fase M12)
// ---------------------------------------------------------------------------

/**
 * ¿El usuario está pidiendo entrar a la plataforma web?
 *
 * Va aparte de `interceptQuickCommand` porque la respuesta necesita datos del
 * usuario (su `web_token`), y ese intercept es deliberadamente puro. Aquí solo
 * se decide SI aplica; el mensaje lo arma el webhook, que sí tiene el usuario.
 *
 * Se reconoce por SUSTANTIVOS, no por verbos. Intentar cubrir las
 * conjugaciones ("entrar", "entro", "accedo", "accede"…) resultó frágil y
 * dejaba fuera formas evidentes. En cambio, estas palabras no aparecen en una
 * consulta fiscal: nadie pregunta por su plataforma o su navegador cuando
 * quiere saber cuánto lleva deducido. Con eso basta y es mucho más robusto.
 *
 * Deliberadamente amplio, al contrario que los otros comandos: equivocarse
 * aquí cuesta un mensaje de más, mientras que NO reconocerlo deja al usuario
 * sin ninguna forma de entrar a la web. El fallo caro es el segundo.
 */
const ENLACE_WEB =
  /\b(web|p[áa]gina|portal|plataforma|dashboard|tablero|sitio|internet|computadora|compu|navegador|liga|enlace|link|url)\b/i;

export function esPeticionDeEnlaceWeb(text: string): boolean {
  return ENLACE_WEB.test(text.trim());
}

/** Mensaje con el enlace de alta, para cuentas que aún no tienen contraseña. */
export function mensajeEnlaceAlta(urlDashboard: string, webToken: string): string {
  const url = `${urlDashboard}?token=${encodeURIComponent(webToken)}`;
  return (
    "Para entrar desde la computadora, crea tu contraseña aquí:\n\n" +
    `${url}\n\n` +
    "El enlace es personal: cualquiera que lo tenga podría crear la contraseña " +
    "de tu cuenta, así que no lo compartas. Deja de funcionar en cuanto la " +
    "establezcas."
  );
}

/** Mensaje para cuentas que ya tienen contraseña: se manda la dirección, no
 * el enlace con token — ese ya no sirve para nada y compartirlo sería filtrar
 * una credencial sin motivo. */
export function mensajeEnlaceLogin(urlDashboard: string): string {
  return (
    "Entra desde la computadora aquí:\n\n" +
    `${urlDashboard}\n\n` +
    "Usa el correo de tu cuenta y la contraseña que ya creaste. Si no la " +
    "recuerdas, avísame y la reestablecemos."
  );
}

/** Cuando falta configurar DASHBOARD_URL: se dice la verdad en vez de mandar
 * un enlace roto. */
export const MENSAJE_WEB_NO_DISPONIBLE =
  "Todavía no tengo lista la dirección de la plataforma web. Por ahora puedes " +
  "consultarme por aquí: pregúntame \"¿cuánto llevo?\" o mándame el XML de una factura.";

// ---------------------------------------------------------------------------
// Recuperar contraseña (Fase M17)
// ---------------------------------------------------------------------------

/**
 * ¿El usuario está pidiendo recuperar/restablecer su contraseña?
 *
 * Mismo patrón que `esPeticionDeEnlaceWeb`: se decide aquí SI aplica, el
 * webhook arma la respuesta porque necesita generar el token del usuario.
 *
 * Exige mencionar la contraseña Y una palabra de "olvido/recuperación" — solo
 * "contraseña" sería demasiado amplio (interceptaría preguntas legítimas
 * sobre cómo cambiarla), y solo "olvidé" sin contexto podría ser sobre
 * cualquier otra cosa.
 */
const PALABRA_CONTRASENA = /contrase[ñn]a|password/i;
const PALABRA_OLVIDO = /olvid|recuper|restable|resete|perd[ií]|no\s*(me\s*)?acuerdo|no\s*recuerdo/i;

export function esPeticionDeRecuperarPassword(text: string): boolean {
  const trimmed = text.trim();
  return PALABRA_CONTRASENA.test(trimmed) && PALABRA_OLVIDO.test(trimmed);
}

/** Mensaje con el enlace para poner una contraseña nueva, para cuentas que YA
 * tienen una pero la olvidaron. El token es de un solo uso y vence en 30
 * minutos (ver `generarResetToken` en users.ts) — a diferencia del enlace de
 * alta, que no vence hasta usarse. */
export function mensajeEnlaceReset(urlDashboard: string, resetToken: string): string {
  const url = `${urlDashboard}?reset_token=${encodeURIComponent(resetToken)}`;
  return (
    "Para poner una contraseña nueva, entra aquí:\n\n" +
    `${url}\n\n` +
    "El enlace es personal y solo funciona por 30 minutos: cualquiera que lo " +
    "tenga podría cambiar la contraseña de tu cuenta, así que no lo compartas."
  );
}

// ---------------------------------------------------------------------------
// Dónde enviar facturas (Fase M17)
// ---------------------------------------------------------------------------

/**
 * ¿El usuario está preguntando dónde enviar/registrar sus facturas?
 *
 * Requiere explícitamente verbos de envío: "envío", "mando", "registro", "subo".
 * No intercepta "dónde está mi factura" ni "dónde puedo ver", porque esas son
 * consultas sobre facturas ya existentes, no sobre cómo registrar nuevas.
 */
const PALABRA_ENVIO = /envío|env[íi]o|mando|registro|subo|upload|c[óo]mo\s+(envío|mando|registro|subo)/i;
const PALABRA_FACTURAS = /factura|documento|xml|cfdi|invoice/i;

export function esPeticionDeEnvioFacturas(text: string): boolean {
  const trimmed = text.trim();
  return PALABRA_ENVIO.test(trimmed) && PALABRA_FACTURAS.test(trimmed);
}

/** Mensaje con las tres formas de enviar facturas (email, WhatsApp, web). */
export function mensajeFormasEnvio(emailDomain: string, urlDashboard: string): string {
  return (
    "Puedes enviar tus facturas de 3 formas:\n\n" +
    `📧 *Por correo:* ${emailDomain}\n` +
    "Adjunta el XML (y el PDF si tienes) — se procesa automático.\n\n" +
    "💬 *Por WhatsApp:* Mándame el XML como documento\n" +
    "Lo recibo, lo parseo y lo clasifico de inmediato.\n\n" +
    `🌐 *Por la plataforma web:* ${urlDashboard}\n` +
    "Entra, ve a Facturas, y sube tus documentos.\n\n" +
    "En cualquier caso, primero debe existir tu cuenta (registrada aquí o por email/WhatsApp)."
  );
}
