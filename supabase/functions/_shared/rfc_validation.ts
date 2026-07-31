/**
 * Validación de RFC (Fase M7, extendida en M14).
 *
 * La versión original (port 1:1 del `field_validator("rfc")` de
 * `UserRegister` en schemas.py) solo aceptaba 13 caracteres — el formato de
 * **persona física** (4 letras + 6 dígitos + 3 de homoclave). Es correcto
 * para `auth-register` y el perfil: ahí el RFC es la identidad personal del
 * dueño de la cuenta.
 *
 * Pero un RFC de **persona moral** tiene 12 caracteres (3 letras + 6 dígitos
 * + 3 de homoclave) — una letra menos, porque las empresas no llevan la
 * inicial del apellido materno que sí llevan las personas. Se detectó al
 * intentar dar de alta un RFC real de empresa (`DJB850527F30`, 12
 * caracteres) en `/api/user/rfcs`, que sí declara el tipo explícitamente:
 * ese es el único lugar donde corresponde aceptar el formato moral.
 *
 * El parámetro por defecto es `"fisica"` para no cambiar el comportamiento
 * de los llamadores existentes (`auth-register`, el perfil).
 */
const RFC_FISICA_RE = /^[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}$/;
const RFC_MORAL_RE = /^[A-ZÑ&]{3}\d{6}[A-Z0-9]{3}$/;

/** Normaliza (upper + trim) y valida un RFC según el tipo de contribuyente.
 * Devuelve el RFC normalizado, o `null` si es inválido (caller decide el
 * mensaje). */
export function validateRfc(rfc: string, tipo: "fisica" | "moral" = "fisica"): string | null {
  const normalized = rfc.trim().toUpperCase();
  const patron = tipo === "moral" ? RFC_MORAL_RE : RFC_FISICA_RE;
  const longitudEsperada = tipo === "moral" ? 12 : 13;
  if (normalized.length !== longitudEsperada) return null;
  if (!patron.test(normalized)) return null;
  return normalized;
}
