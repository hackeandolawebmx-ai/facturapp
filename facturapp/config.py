"""Configuración central (Fase 2a/2b) — lee variables de entorno.

Usa pydantic-settings. En producción se conecta a Supabase (Postgres) vía
DATABASE_URL; en tests, si DATABASE_URL apunta a SQLite, corre offline.
"""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Carga .env a os.environ antes de instanciar Settings (útil para scripts y CLI).
load_dotenv()

_LOG_DIR = Path("logs")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Base de datos ---
    # Supabase Postgres en prod; SQLite en tests/dev si se sobreescribe.
    database_url: str = "sqlite:///./facturapp.db"

    # Cliente Supabase (opcional; solo si se usa supabase-py además de SQLAlchemy)
    supabase_url: str = ""
    supabase_key: str = ""
    supabase_service_key: str = ""

    # --- JWT ---
    secret_key: str = "dev-secret-change-me-please-min-32-characters-long"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60  # 1 h (Fase 2b)
    refresh_token_expire_days: int = 7

    # --- LLM (OpenAI) ---
    openai_api_key: str = ""
    openai_model: str = "gpt-5.6"

    # --- WhatsApp (Meta Cloud API, Fase 3b) ---
    whatsapp_token: str = ""              # access token (Graph API: descargar media + enviar mensajes)
    whatsapp_verify_token: str = ""       # solo para el handshake GET de verificación del webhook
    whatsapp_app_secret: str = ""         # firma HMAC-SHA256 del body (header X-Hub-Signature-256).
                                           # NO es el mismo valor que whatsapp_verify_token.
    whatsapp_phone_number_id: str = ""    # requerido por Graph API para enviar mensajes
    whatsapp_business_account_id: str = ""

    # --- App ---
    debug: bool = True
    year_default: int = 2026


settings = Settings()


def setup_logging() -> logging.Logger:
    """Configura logging a archivo rotativo (5MB x 5 backups). Idempotente:
    seguro de llamar varias veces (p. ej. con --reload) sin duplicar handlers.
    """
    logger = logging.getLogger("facturapp")
    if logger.handlers:
        return logger

    logger.setLevel(logging.WARNING)
    _LOG_DIR.mkdir(exist_ok=True)

    handler = RotatingFileHandler(
        _LOG_DIR / "facturapp.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8",
    )
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    ))
    logger.addHandler(handler)
    return logger
