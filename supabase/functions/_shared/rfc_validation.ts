/**
 * Validación de RFC persona física (Fase M7) — port 1:1 del
 * `field_validator("rfc")` de `UserRegister` en schemas.py.
 */
const RFC_RE = /^[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}$/;

/** Normaliza (upper + trim) y valida un RFC de 13 caracteres. Devuelve el
 * RFC normalizado, o `null` si es inválido (caller decide el mensaje). */
export function validateRfc(rfc: string): string | null {
  const normalized = rfc.trim().toUpperCase();
  if (normalized.length !== 13) return null;
  if (!RFC_RE.test(normalized)) return null;
  return normalized;
}
