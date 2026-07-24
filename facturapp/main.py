"""FacturasMX — API FastAPI (Fase 2a).

Multiusuario con JWT. El parser/validator/classifier de Fase 1 no cambian;
aquí se agregan las capas de auth, chat y aislamiento por usuario.
"""
from __future__ import annotations

import datetime as dt
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.responses import HTMLResponse, JSONResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy.orm import Session

from . import chat as chat_module
from .auth import (
    create_access_token, create_refresh_token, generate_web_token,
    get_current_user, hash_password, oauth2_scheme, verify_password,
    verify_refresh_token,
)
from .classifier import Classifier
from .config import setup_logging, settings
from .database import get_db, init_db
from .models import ChatMessage, Invoice, User
from .parser import CFDIParseError, parse_cfdi
from .schemas import (
    ChatRequest, ChatResponse, TokenResponse, UserLogin, UserProfile, UserRegister,
)
from .security import limiter
from .validator import SEV_POR_REVISAR, SEV_RECHAZADA, ValidationEngine

TEMPLATE = Path(__file__).parent / "templates" / "dashboard.html"
classifier = Classifier()
logger = logging.getLogger("facturapp.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    init_db()
    yield


app = FastAPI(title="FacturasMX", version="0.2.0", lifespan=lifespan)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": "Demasiados intentos. Intenta de nuevo en un minuto."},
    )


def _anio_de(fecha_emision: str) -> int:
    try:
        return int(fecha_emision[:4])
    except (ValueError, TypeError):
        return dt.date.today().year


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "facturapp", "fase": "2a"}


# ==========================================================================
# AUTH
# ==========================================================================

@app.post("/auth/register", status_code=status.HTTP_201_CREATED)
async def register(payload: UserRegister, db: Session = Depends(get_db)) -> dict:
    existing = db.query(User).filter(
        (User.email == payload.email) | (User.rfc == payload.rfc)
    ).first()
    if existing:
        campo = "email" if existing.email == payload.email else "RFC"
        raise HTTPException(status_code=400, detail=f"Ese {campo} ya está registrado")

    user = User(
        email=payload.email,
        nombre=payload.nombre,
        rfc=payload.rfc,
        hashed_password=hash_password(payload.password),
        web_token=generate_web_token(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"user_id": user.id, "message": "Registrado exitosamente"}


@app.post("/auth/login", response_model=TokenResponse)
@limiter.limit("5/minute")
async def login(
    request: Request, payload: UserLogin, db: Session = Depends(get_db)
) -> TokenResponse:
    user = db.query(User).filter(User.email == payload.email).first()
    if user is None or not verify_password(payload.password, user.hashed_password):
        logger.warning("Login fallido para %s", payload.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales inválidas",
        )
    claims = {"sub": str(user.id), "rfc": user.rfc}
    access = create_access_token(claims)
    refresh = create_refresh_token(claims)
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        user_id=user.id,
        expires_in=settings.access_token_expire_minutes * 60,
    )


@app.post("/auth/refresh", response_model=TokenResponse)
async def refresh_access_token(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> TokenResponse:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Falta el refresh token",
        )
    token_data = verify_refresh_token(token)
    user = db.query(User).filter(User.id == token_data.user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario no encontrado",
        )
    new_access = create_access_token({"sub": str(user.id), "rfc": user.rfc})
    return TokenResponse(
        access_token=new_access,
        user_id=user.id,
        expires_in=settings.access_token_expire_minutes * 60,
    )


@app.get("/api/user/profile", response_model=UserProfile)
async def profile(current_user: User = Depends(get_current_user)) -> UserProfile:
    return UserProfile(**current_user.to_public())


# ==========================================================================
# INGESTA (por usuario)
# ==========================================================================

@app.post("/webhooks/email")
async def ingest_email(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    contenido = await file.read()
    nombre = (file.filename or "").lower()

    if nombre.endswith(".pdf") or contenido[:5] == b"%PDF-":
        return JSONResponse(status_code=202, content={
            "uuid": None, "estatus": SEV_POR_REVISAR,
            "hallazgos": [{
                "codigo": "PDF_SIN_XML", "severidad": SEV_POR_REVISAR,
                "mensaje": ("Solo recibimos el PDF. Necesitas el XML para deducir; "
                            "pídelo al emisor"),
            }],
        })

    try:
        invoice = parse_cfdi(contenido)
    except CFDIParseError as exc:
        return JSONResponse(status_code=422, content={
            "uuid": None, "estatus": SEV_RECHAZADA,
            "hallazgos": [{
                "codigo": "XML_MAL_FORMADO", "severidad": SEV_RECHAZADA,
                "mensaje": "XML inválido o no es CFDI 4.0. Pídelo de nuevo al emisor",
                "detalle": str(exc),
            }],
        })

    # UUIDs existentes SOLO de este usuario (aislamiento).
    existing = {
        row[0] for row in db.query(Invoice.uuid_fiscal)
        .filter(Invoice.user_id == current_user.id).all()
    }
    previa = (
        db.query(Invoice)
        .filter(Invoice.user_id == current_user.id, Invoice.uuid_fiscal == invoice["uuid"])
        .first()
    )
    fecha_previa = previa.fecha_emision if previa else None

    engine = ValidationEngine(current_user.rfc, existing_uuids=list(existing), classifier=classifier)
    resultado = engine.validate(invoice, fecha_previa=fecha_previa)
    categoria = resultado["categoria"]
    _, _, confianza = classifier.classify(invoice)

    if resultado["status"] != SEV_RECHAZADA:
        row = Invoice(
            user_id=current_user.id,
            uuid_fiscal=invoice["uuid"],
            usuario_rfc=current_user.rfc,
            emisor_rfc=invoice["emisor_rfc"],
            emisor_nombre=invoice["emisor_nombre"],
            receptor_rfc=invoice["receptor_rfc"],
            fecha_emision=invoice["fecha_emision"],
            anio=_anio_de(invoice["fecha_emision"]),
            subtotal=invoice["subtotal"], iva=invoice["iva"], total=invoice["total"],
            uso_cfdi=invoice["uso_cfdi"], forma_pago=invoice["forma_pago"],
            metodo_pago=invoice["metodo_pago"],
            clave_prod_principal=invoice["clave_prod_principal"],
            concepto_descripcion=invoice["concepto_descripcion"],
            categoria=categoria, confianza=confianza,
            estatus=resultado["status"], hallazgos=resultado["hallazgos"],
            raw_xml=invoice["raw_xml"],
        )
        db.add(row)
        db.commit()

    return JSONResponse(content={
        "uuid": invoice["uuid"], "estatus": resultado["status"],
        "categoria": categoria, "hallazgos": resultado["hallazgos"],
    })


# ==========================================================================
# API (por usuario, requiere auth)
# ==========================================================================

@app.get("/api/summary")
async def get_summary(
    year: int = 2026,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return _summary_for_user(db, current_user.id, year)


@app.get("/api/invoices")
async def list_invoices(
    year: int = 2026,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    rows = (
        db.query(Invoice)
        .filter(Invoice.user_id == current_user.id, Invoice.anio == year)
        .order_by(Invoice.fecha_emision.desc())
        .all()
    )
    return {"year": year, "invoices": [r.to_dict() for r in rows]}


@app.post("/api/invoices/{invoice_id}/reclassify")
async def reclassify(
    invoice_id: int,
    nueva_categoria: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    inv = (
        db.query(Invoice)
        .filter(Invoice.id == invoice_id, Invoice.user_id == current_user.id)
        .first()
    )
    if inv is None:
        raise HTTPException(status_code=404, detail="Factura no encontrada")
    inv.categoria = nueva_categoria
    inv.confianza = 1.0
    db.commit()
    return {"id": invoice_id, "categoria": nueva_categoria}


# ==========================================================================
# CHAT (por usuario, requiere auth)
# ==========================================================================

@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    db.add(ChatMessage(user_id=current_user.id, role="user", content=payload.message))
    db.commit()

    try:
        result = chat_module.chat(db, current_user, payload.message)
    except Exception:
        logger.exception("Error inesperado en /api/chat para user %s", current_user.id)
        raise HTTPException(status_code=500, detail="Error procesando tu mensaje.")

    db.add(ChatMessage(user_id=current_user.id, role="assistant", content=result.response))
    db.commit()
    return result


# ==========================================================================
# WEB (dashboard por token) + endpoints públicos-por-token
# ==========================================================================

def _summary_for_user(db: Session, user_id: int, year: int) -> dict:
    rows = db.query(Invoice).filter(
        Invoice.user_id == user_id, Invoice.anio == year
    ).all()
    cedula: dict[str, dict] = {}
    total_general = 0.0
    for r in rows:
        cat = r.categoria or "Sin clasificar"
        e = cedula.setdefault(cat, {"total": 0.0, "facturas": 0})
        e["total"] = round(e["total"] + (r.total or 0.0), 2)
        e["facturas"] += 1
        total_general = round(total_general + (r.total or 0.0), 2)
    return {"year": year, "categorias": cedula,
            "total_general": total_general, "num_facturas": len(rows)}


def _user_by_token(db: Session, token: str) -> User:
    user = db.query(User).filter(User.web_token == token).first()
    if user is None:
        raise HTTPException(status_code=404, detail="Token inválido")
    return user


@app.get("/api/public/summary")
async def public_summary(token: str, year: int = 2026, db: Session = Depends(get_db)) -> dict:
    user = _user_by_token(db, token)
    return _summary_for_user(db, user.id, year)


@app.get("/api/public/invoices")
async def public_invoices(token: str, year: int = 2026, db: Session = Depends(get_db)) -> dict:
    user = _user_by_token(db, token)
    rows = (
        db.query(Invoice)
        .filter(Invoice.user_id == user.id, Invoice.anio == year)
        .order_by(Invoice.fecha_emision.desc())
        .all()
    )
    return {"year": year, "invoices": [r.to_dict() for r in rows]}


@app.get("/a/{token}", response_class=HTMLResponse)
async def get_web(token: str) -> HTMLResponse:
    if TEMPLATE.exists():
        return HTMLResponse(TEMPLATE.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>Dashboard no disponible</h1>", status_code=404)
