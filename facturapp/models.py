"""Modelos SQLAlchemy (Fase 2a) — multiusuario.

Tablas: users, invoices (con user_id), chat_messages.
El engine/sesión viven en database.py; aquí solo las clases ORM.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    Column, DateTime, Float, ForeignKey, Integer, String, JSON, Text,
)
from sqlalchemy.orm import relationship

from .database import Base
# Re-export para compatibilidad con imports de Fase 1.
from .database import SessionLocal, engine, init_db, reset_db  # noqa: F401


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    nombre = Column(String(255), nullable=False)
    rfc = Column(String(13), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)
    web_token = Column(String(64), unique=True, index=True)
    plan = Column(String(20), default="free")
    created_at = Column(DateTime, default=_utcnow)

    invoices = relationship("Invoice", back_populates="user", cascade="all, delete-orphan")
    messages = relationship("ChatMessage", back_populates="user", cascade="all, delete-orphan")

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "nombre": self.nombre,
            "rfc": self.rfc,
            "plan": self.plan,
            "web_token": self.web_token,
        }


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    uuid_fiscal = Column(String(36), nullable=False, index=True)
    usuario_rfc = Column(String(13))
    emisor_rfc = Column(String(13))
    emisor_nombre = Column(String(255))
    receptor_rfc = Column(String(13))
    fecha_emision = Column(String(10))
    anio = Column(Integer, index=True)
    subtotal = Column(Float, default=0.0)
    iva = Column(Float, default=0.0)
    total = Column(Float, default=0.0)
    uso_cfdi = Column(String(4))
    forma_pago = Column(String(2))
    metodo_pago = Column(String(3))
    clave_prod_principal = Column(String(20))
    concepto_descripcion = Column(String(500))
    categoria = Column(String(50))
    confianza = Column(Float, default=0.0)
    estatus = Column(String(20))
    hallazgos = Column(JSON, default=list)
    raw_xml = Column(Text)
    creado_en = Column(DateTime, default=_utcnow)

    user = relationship("User", back_populates="invoices")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "uuid": self.uuid_fiscal,
            "emisor_rfc": self.emisor_rfc,
            "emisor_nombre": self.emisor_nombre,
            "receptor_rfc": self.receptor_rfc,
            "fecha_emision": self.fecha_emision,
            "anio": self.anio,
            "subtotal": self.subtotal,
            "iva": self.iva,
            "total": self.total,
            "uso_cfdi": self.uso_cfdi,
            "forma_pago": self.forma_pago,
            "metodo_pago": self.metodo_pago,
            "clave_prod_principal": self.clave_prod_principal,
            "concepto_descripcion": self.concepto_descripcion,
            "categoria": self.categoria,
            "confianza": self.confianza,
            "estatus": self.estatus,
            "hallazgos": self.hallazgos or [],
        }


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(String(20), nullable=False)  # 'user' | 'assistant'
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    user = relationship("User", back_populates="messages")
