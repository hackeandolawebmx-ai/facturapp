-- Fase M1 — Esquema inicial de facturapp en Supabase Postgres.
--
-- Esquema dedicado `facturapp` (NO `public`) para convivir en el mismo
-- proyecto que RanchoApp2-DB sin colisionar con sus tablas.
--
-- Solo estructura — sin lógica de negocio (triggers, RLS, funciones) todavía;
-- eso se agrega en fases posteriores según haga falta.

CREATE SCHEMA IF NOT EXISTS facturapp;

CREATE TABLE facturapp.users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    rfc TEXT NOT NULL,
    hashed_password TEXT,           -- nullable: cuentas auto-creadas por email/whatsapp
                                     -- no tienen contraseña hasta que el usuario se registra
    web_token TEXT UNIQUE NOT NULL,
    whatsapp_phone TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE facturapp.invoices (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES facturapp.users(id),
    uuid_fiscal TEXT NOT NULL,
    usuario_rfc TEXT NOT NULL,
    emisor_rfc TEXT NOT NULL,
    emisor_nombre TEXT,
    receptor_rfc TEXT NOT NULL,
    fecha_emision TEXT NOT NULL,
    anio INTEGER NOT NULL,
    subtotal NUMERIC(12,2),
    iva NUMERIC(12,2),
    total NUMERIC(12,2),
    uso_cfdi TEXT,
    forma_pago TEXT,
    metodo_pago TEXT,
    clave_prod_principal TEXT,
    concepto_descripcion TEXT,
    categoria TEXT,
    confianza NUMERIC(3,2),
    estatus TEXT NOT NULL,
    hallazgos JSONB,
    raw_xml TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, uuid_fiscal)   -- aislamiento + anti-duplicado, igual que en Fase 1
);

CREATE TABLE facturapp.chat_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES facturapp.users(id),
    role TEXT NOT NULL,             -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Índice para la consulta más frecuente: resumen/cédula de un usuario por año.
CREATE INDEX idx_invoices_user_anio ON facturapp.invoices(user_id, anio);

-- NOTA: no se agregan índices explícitos para users.whatsapp_phone ni
-- users.web_token — ambas columnas ya son UNIQUE, y Postgres crea
-- automáticamente un índice único para cada restricción UNIQUE. Un
-- CREATE INDEX adicional sobre la misma columna sería 100% redundante
-- (duplica el índice, sin ningún beneficio, solo overhead de escritura).
