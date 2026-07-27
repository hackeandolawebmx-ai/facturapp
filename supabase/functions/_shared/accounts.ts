/**
 * Aprovisionamiento de cuentas mínimas (Fase M4) — port 1:1 de
 * facturapp/facturapp/accounts.py.
 *
 * Lógica compartida entre el webhook de WhatsApp (M4) y el de SendGrid (M5)
 * para crear cuentas cuando un usuario envía una factura antes de haberse
 * registrado formalmente.
 */
import { createHash } from "node:crypto";

/** RFC sintético, único y determinístico (13 caracteres) para cuentas
 * auto-creadas. `seed` puede ser el email o el teléfono del usuario.
 *
 * No pasa por el validador estricto de registro — el usuario debe completar
 * su RFC real desde su perfil antes de usar sus deducciones formalmente.
 *
 * Síncrono (como en Python) — usamos `node:crypto` en vez de Web Crypto
 * (`crypto.subtle`) porque este último es async-only; forzar `await` en
 * cada llamada de esta función determinística no aporta nada.
 */
export function placeholderRfc(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf-8").digest("hex").toUpperCase();
  return `PEND${hex.slice(0, 9)}`;
}
