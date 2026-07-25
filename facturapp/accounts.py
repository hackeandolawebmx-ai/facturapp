"""Aprovisionamiento de cuentas mínimas (Fase 3a/3b).

Lógica compartida entre email_service.py y whatsapp_service.py para crear
cuentas cuando un usuario envía una factura (por correo o WhatsApp) antes de
haberse registrado formalmente.
"""
from __future__ import annotations

import hashlib


def placeholder_rfc(seed: str) -> str:
    """RFC sintético, único y determinístico (13 caracteres) para cuentas
    auto-creadas. `seed` puede ser el email o el teléfono del usuario.

    No pasa por el validador estricto de UserRegister (ese solo aplica al
    registro manual vía /auth/register) — el usuario debe completar su RFC
    real desde su perfil antes de usar sus deducciones formalmente.
    """
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest().upper()
    return f"PEND{digest[:9]}"
