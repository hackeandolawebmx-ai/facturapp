"""Conexión a la base de datos (Fase 2a).

- Producción: Supabase (Postgres) vía DATABASE_URL.
- Tests/dev: SQLite (archivo o en-memory con StaticPool si es ':memory:').

El engine se construye desde `settings.database_url`, así que los tests solo
tienen que exportar DATABASE_URL antes de importar el paquete.
"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings

Base = declarative_base()


def _make_engine(url: str):
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
        # ':memory:' o 'sqlite://' → BD única compartida entre threads
        if url in ("sqlite://", "sqlite:///:memory:"):
            return create_engine(
                url, connect_args=connect_args, poolclass=StaticPool
            )
        return create_engine(url, connect_args=connect_args)
    # Postgres / Supabase — usa el driver psycopg3
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return create_engine(url, pool_pre_ping=True)


engine = _make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    """Crea las tablas si no existen. Importa models para registrarlas."""
    from . import models  # noqa: F401  (registra las clases en Base.metadata)

    Base.metadata.create_all(bind=engine)


def reset_db() -> None:
    """Borra y recrea todas las tablas — útil para tests."""
    from . import models  # noqa: F401

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Dependencia FastAPI: sesión por request, siempre cerrada al final."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
