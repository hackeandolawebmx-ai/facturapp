"""Rate limiting (Fase 2b) — protege endpoints sensibles contra fuerza bruta.

Un único `Limiter` global, compartido por la app. En tests se resetea entre
casos (`limiter.reset()`) para que los límites de un test no contaminen otro.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
