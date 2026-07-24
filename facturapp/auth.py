"""Autenticación: JWT + bcrypt (Fase 2a/2b).

Sigue auth-implementation-patterns:
- Contraseñas hasheadas con bcrypt (nunca en claro).
- Access token JWT HS256, expiración corta (1 h, Fase 2b).
- Refresh token JWT HS256, expiración larga (7 días) — solo sirve para
  /auth/refresh, nunca para acceder a la API (se distinguen por el claim
  "type": cada verificador exige el tipo correcto).
- verify_token / verify_refresh_token lanzan HTTPException 401 si el token
  es inválido, expiró, o es del tipo equivocado.
"""
from __future__ import annotations

import datetime as dt
import secrets

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

# bcrypt trunca a 72 bytes; lo hacemos explícito para evitar errores.
_BCRYPT_MAX = 72

_CREDENTIALS_EXC = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="No autenticado o token inválido",
    headers={"WWW-Authenticate": "Bearer"},
)


class TokenData(BaseModel):
    user_id: int
    rfc: str


# ---- Password hashing ----------------------------------------------------

def hash_password(password: str) -> str:
    pw = password.encode("utf-8")[:_BCRYPT_MAX]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    pw = plain.encode("utf-8")[:_BCRYPT_MAX]
    try:
        return bcrypt.checkpw(pw, hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def generate_web_token() -> str:
    return secrets.token_urlsafe(24)


# ---- JWT ------------------------------------------------------------------

def create_access_token(data: dict, expires_delta: dt.timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = dt.datetime.now(dt.timezone.utc) + (
        expires_delta or dt.timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


def create_refresh_token(data: dict, expires_delta: dt.timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = dt.datetime.now(dt.timezone.utc) + (
        expires_delta or dt.timedelta(days=settings.refresh_token_expire_days)
    )
    to_encode.update({"exp": expire, "type": "refresh"})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


def _verify(token: str, expected_type: str) -> TokenData:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        if payload.get("type") != expected_type:
            raise _CREDENTIALS_EXC
        user_id = payload.get("sub")
        rfc = payload.get("rfc")
        if user_id is None or rfc is None:
            raise _CREDENTIALS_EXC
        return TokenData(user_id=int(user_id), rfc=rfc)
    except (JWTError, ValueError):
        raise _CREDENTIALS_EXC


def verify_token(token: str) -> TokenData:
    """Valida un access token. 401 si es inválido, expiró, o es un refresh token."""
    return _verify(token, expected_type="access")


def verify_refresh_token(token: str) -> TokenData:
    """Valida un refresh token. 401 si es inválido, expiró, o es un access token."""
    return _verify(token, expected_type="refresh")


# ---- Dependencia FastAPI --------------------------------------------------

def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not token:
        raise _CREDENTIALS_EXC
    token_data = verify_token(token)
    user = db.query(User).filter(User.id == token_data.user_id).first()
    if user is None:
        raise _CREDENTIALS_EXC
    return user
