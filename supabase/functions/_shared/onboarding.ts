/**
 * Activación de cuentas auto-creadas (Fase M24).
 *
 * EL PROBLEMA QUE RESUELVE: una cuenta creada por WhatsApp o correo nace con
 * un RFC sintético `PEND...` (ver accounts.ts). El validador compara el
 * receptor de cada factura contra ese placeholder, no coincide nunca, y marca
 * TODA su facturación con `RFC_AJENO: no será deducible`. Es un falso positivo
 * del 100% sobre la regla más importante del sistema, y es literalmente lo
 * primero que ve un usuario nuevo: manda su primera factura y se le contesta
 * que no sirve.
 *
 * El arreglo retroactivo ya existía (`revalidarFacturasTrasCambioDeRfc`), pero
 * solo se disparaba desde el perfil web -- y un usuario de WhatsApp no llega
 * ahí salvo que pida el enlace por su cuenta. Este módulo cierra ese hueco:
 * permite capturar el RFC por el mismo canal por el que llegó el usuario.
 *
 * La captura es SIN ESTADO de conversación: no hay un "estoy esperando tu
 * RFC". Un RFC es un formato lo bastante específico (4 letras + 6 dígitos + 3
 * de homoclave) como para reconocerlo solo, y guardar estado conversacional
 * por usuario en un webhook sin sesión sería mucha maquinaria para algo que el
 * propio dato ya resuelve.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { validateRfc } from "./rfc_validation.ts";
import {
  revalidarFacturasTrasCambioDeRfc, rfcTomadoPorOtro, updateUserRfc,
} from "./users.ts";

/** ¿Esta cuenta sigue con el RFC sintético de alta automática? */
export function tieneRfcPendiente(rfc: string | null | undefined): boolean {
  return /^PEND/i.test(String(rfc ?? ""));
}

/** ¿El mensaje es, él solo, un RFC?
 *
 * Se exige que el mensaje COMPLETO sea el RFC (salvo espacios): buscarlo
 * dentro de una frase capturaría de más -- alguien preguntando "¿por qué mi
 * factura de XAXX010101000 no es deducible?" no está declarando que ese sea
 * su RFC, y quedarse con él le asignaría a su cuenta el RFC de un tercero.
 */
export function mensajeEsRfc(texto: string): boolean {
  const limpio = String(texto ?? "").trim();
  if (/\s/.test(limpio)) return false;
  // Se acepta el largo de persona moral (12) para poder dar un mensaje útil
  // cuando alguien manda el de su empresa -- ver capturarRfc.
  return limpio.length === 12 || limpio.length === 13
    ? /^[A-Za-zÑñ&]{3,4}\d{6}[A-Za-z0-9]{3}$/.test(limpio)
    : false;
}

export type ResultadoCaptura =
  | { ok: true; rfc: string; facturasActualizadas: number }
  | { ok: false; motivo: "invalido" | "es_moral" | "tomado" | "error" };

/**
 * Guarda el RFC real de una cuenta y repara sus facturas.
 *
 * Único camino para dejar atrás el `PEND...`, compartido por el perfil web y
 * el bot de WhatsApp: si cada canal replicara estos cuatro pasos, bastaría con
 * que uno olvidara la revalidación para que ese usuario se quedara con
 * advertencias falsas para siempre.
 *
 * Devuelve cuántas facturas dejaron de estar marcadas como no deducibles, que
 * es lo que de verdad le importa a quien acaba de dar su RFC.
 */
export async function capturarRfc(
  supabase: SupabaseClient, userId: number, rfcCrudo: string,
): Promise<ResultadoCaptura> {
  const rfc = validateRfc(rfcCrudo);
  if (!rfc) {
    // Un RFC de 12 caracteres es válido, pero de persona MORAL, y el RFC de la
    // cuenta es la identidad personal de su dueño. Se distingue para poder
    // explicar a dónde va el de la empresa en vez de decir "inválido" a algo
    // que no lo es.
    if (validateRfc(rfcCrudo, "moral")) return { ok: false, motivo: "es_moral" };
    return { ok: false, motivo: "invalido" };
  }

  if (await rfcTomadoPorOtro(supabase, userId, rfc)) {
    return { ok: false, motivo: "tomado" };
  }

  const perfil = await updateUserRfc(supabase, userId, rfc);
  if (!perfil) return { ok: false, motivo: "error" };

  // Sin esto el RFC quedaría bien en el perfil pero las facturas ya archivadas
  // seguirían mostrando "no será deducible" -- contradiciendo al propio perfil.
  const facturasActualizadas = await revalidarFacturasTrasCambioDeRfc(supabase, userId, rfc);
  return { ok: true, rfc, facturasActualizadas };
}

// ---------------------------------------------------------------------------
// Mensajes de WhatsApp
// ---------------------------------------------------------------------------

/** Se pide el RFC explicando PARA QUÉ. Pedir un dato fiscal sin decir por qué
 * en un chat es exactamente lo que hace un fraude, y además aquí la razón es
 * la respuesta a la queja que el usuario está a punto de tener. */
export const PEDIR_RFC =
  "Para poder decirte si tus facturas son deducibles necesito tu RFC " +
  "(el de persona física, 13 caracteres).\n\n" +
  "Mándamelo en un mensaje, así tal cual:\nAAAA000000XXX";

/** Aviso que acompaña a la primera factura de una cuenta sin RFC. Explica que
 * la advertencia que acaba de recibir es por el dato que falta, no por su
 * factura -- sin esto, la conclusión razonable del usuario es que el sistema
 * le dijo que su factura no sirve. */
export const AVISO_SIN_RFC =
  "\n\n⚠️ Ojo: todavía no tengo tu RFC, así que no puedo confirmar que esta " +
  "factura sea deducible.\n\n" + PEDIR_RFC;

export function confirmacionRfc(rfc: string, facturasActualizadas: number): string {
  const base = `✅ Listo, guardé tu RFC ${rfc}.`;
  if (facturasActualizadas === 0) {
    return `${base}\n\nA partir de ahora sí puedo validar si tus facturas son deducibles.`;
  }
  return `${base}\n\nRevisé de nuevo ${facturasActualizadas} factura` +
    (facturasActualizadas === 1 ? "" : "s") +
    " que tenías guardada" + (facturasActualizadas === 1 ? "" : "s") +
    ": ya no aparece" + (facturasActualizadas === 1 ? "" : "n") +
    " como no deducible" + (facturasActualizadas === 1 ? "" : "s") + ".";
}

export function errorCaptura(motivo: "invalido" | "es_moral" | "tomado" | "error"): string {
  if (motivo === "es_moral") {
    return "Ese parece el RFC de una empresa (12 caracteres). El de tu cuenta " +
      "tiene que ser el tuyo como persona física (13).\n\n" +
      "Los RFC de empresa se agregan desde la web, en Contribuyentes.";
  }
  if (motivo === "tomado") {
    return "Ese RFC ya está registrado en otra cuenta. Si es tuyo y perdiste el " +
      "acceso, escríbenos y lo resolvemos.";
  }
  if (motivo === "invalido") {
    return "Ese RFC no tiene el formato correcto. Son 13 caracteres: " +
      "4 letras, 6 dígitos de tu fecha de nacimiento y 3 de homoclave.\n\n" +
      "Ejemplo: AAAA000000XXX";
  }
  return "No pude guardar tu RFC en este momento. Inténtalo de nuevo en un rato.";
}
