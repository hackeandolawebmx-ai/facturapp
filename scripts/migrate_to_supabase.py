"""Migración/creación de tablas en Supabase (Fase 2a).

Uso:
    # 1. Configura DATABASE_URL en .env (connection string de Supabase)
    # 2. Ejecuta:
    python scripts/migrate_to_supabase.py

Crea las tablas users, invoices y chat_messages en la BD apuntada por
DATABASE_URL. Con --seed carga 2 usuarios de prueba (password: 'password123').

Idempotente: create_all no recrea tablas existentes.
"""
from __future__ import annotations

import argparse
import sys

# Permite ejecutar el script desde la raíz del repo.
sys.path.insert(0, ".")

from dotenv import load_dotenv  # noqa: E402

load_dotenv()  # carga .env antes de leer la configuración

from facturapp.auth import generate_web_token, hash_password  # noqa: E402
from facturapp.config import settings  # noqa: E402
from facturapp.database import SessionLocal, init_db  # noqa: E402
from facturapp.models import User  # noqa: E402

TEST_USERS = [
    ("daniela@example.com", "Daniela Ávila", "DAXX860715XX0"),
    ("bruno@example.com", "Bruno Reyes", "REBB900110AB1"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Migra el esquema a Supabase/Postgres.")
    parser.add_argument("--seed", action="store_true", help="Carga 2 usuarios de prueba")
    args = parser.parse_args()

    destino = settings.database_url.split("@")[-1] if "@" in settings.database_url else settings.database_url
    print(f"-> Conectando a: {destino}")
    init_db()
    print("[OK] Tablas creadas/verificadas: users, invoices, chat_messages")

    if args.seed:
        db = SessionLocal()
        try:
            creados = 0
            for email, nombre, rfc in TEST_USERS:
                if db.query(User).filter(User.email == email).first():
                    continue
                db.add(User(
                    email=email, nombre=nombre, rfc=rfc,
                    hashed_password=hash_password("password123"),
                    web_token=generate_web_token(),
                ))
                creados += 1
            db.commit()
            print(f"[OK] Usuarios de prueba insertados: {creados} (password: 'password123')")
        finally:
            db.close()


if __name__ == "__main__":
    main()
