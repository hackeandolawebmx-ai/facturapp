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
// Menú interactivo (botones de lista de WhatsApp)
//
// Antes de esto, un usuario nuevo solo recibía texto explicando qué escribir
// -- funcionaba, pero exigía que adivinara la frase correcta ("¿cuánto
// llevo?", "olvidé mi contraseña"...). El menú de lista nativo de WhatsApp
// le da opciones para tocar en vez de redactar. Se dispara con el mismo
// saludo/ayuda de siempre, más la palabra explícita "menu".
// ---------------------------------------------------------------------------

const MENU_KEYWORD = /^(menu|men[uú]|opciones|inicio|start)[\s!.?]*$/i;

/** ¿El usuario pidió ver el menú? Cubre saludo, ayuda, y la palabra directa. */
export function esPeticionDeMenu(text: string): boolean {
  const trimmed = text.trim();
  return GREETING.test(trimmed) || HELP.test(trimmed) || MENU_KEYWORD.test(trimmed);
}

export interface FilaMenu { id: string; title: string; description: string }
export interface SeccionMenu { title: string; rows: FilaMenu[] }
export interface MenuPrincipal {
  header: string; body: string; footer: string; boton: string; secciones: SeccionMenu[];
}

export const MENU_PRINCIPAL: MenuPrincipal = {
  header: "Facturino",
  body: "¿Qué necesitas? Elige una opción, o en cualquier momento mándame el XML de una factura o escríbeme lo que sea.",
  footer: "Facturino · Deducciones sin esfuerzo",
  boton: "Ver opciones",
  secciones: [
    {
      title: "Facturas",
      rows: [
        { id: "menu_registrar", title: "📄 Registrar factura", description: "Cómo mandarme el XML" },
        { id: "menu_envio", title: "📥 Formas de envío", description: "Correo, WhatsApp o la web" },
        { id: "menu_mis_facturas", title: "🗂️ Mis facturas", description: "Ver lo que llevas este mes" },
      ],
    },
    {
      title: "Deducciones",
      rows: [
        { id: "menu_resumen", title: "💰 ¿Cuánto llevo?", description: "Resumen de tus deducciones" },
        { id: "menu_deducible", title: "❓ ¿Qué es deducible?", description: "Guía rápida de categorías" },
      ],
    },
    {
      title: "Tu cuenta",
      rows: [
        { id: "menu_web", title: "🌐 Entrar a la web", description: "Panel completo desde la computadora" },
        { id: "menu_password", title: "🔑 Contraseña olvidada", description: "Recupera el acceso a la web" },
      ],
    },
  ],
};

/** Respuesta fija para "registrar factura": no hay una frase de texto que
 * dispare esto por sí sola (registrar no es una PREGUNTA), así que no pasa
 * por `TEXTO_DE_FILA_MENU` como las demás filas. */
export const MENSAJE_COMO_REGISTRAR =
  "Mándame el XML de la factura como documento (el archivo .xml, no una foto ni el PDF) " +
  "y lo registro y clasifico al instante.";

/** Traduce el id de una fila del menú a la frase de texto equivalente, para
 * reusar exactamente la misma lógica de intents que ya procesa mensajes de
 * texto (esPeticionDeEnlaceWeb, esPeticionDeRecuperarPassword, chat()...).
 * Así el menú no duplica ninguna decisión: solo simula lo que el usuario
 * habría escrito. `menu_registrar` no aparece aquí porque tiene su propia
 * respuesta fija (MENSAJE_COMO_REGISTRAR), sin pasar por texto. */
const TEXTO_DE_FILA_MENU: Record<string, string> = {
  menu_envio: "¿cómo envío mis facturas?",
  menu_mis_facturas: "mis facturas de este mes",
  menu_resumen: "¿cuánto llevo deducido?",
  menu_deducible: "¿qué puedo deducir?",
  menu_web: "quiero entrar a la plataforma web",
  menu_password: "olvidé mi contraseña",
};

export function textoDeFilaMenu(id: string): string | null {
  return TEXTO_DE_FILA_MENU[id] ?? null;
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
