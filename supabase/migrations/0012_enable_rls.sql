-- Fase M20 — Habilitar Row Level Security (RLS) en todas las tablas expuestas
-- a PostgREST en el esquema facturapp.
--
-- NOTA ARQUITECTÓNICA: El sistema usa JWT personalizado, no auth.users.
-- Las Edge Functions acceden con service_role (que ignora RLS). Las políticas
-- aquí son para BLOQUEAR acceso directo vía PostgREST a usuarios públicos/
-- autenticados. Sin políticas = acceso denegado automáticamente.

-- ============================================================================
-- Tablas privadas por usuario: con user_id
-- ============================================================================

ALTER TABLE facturapp.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturapp.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturapp.user_rfcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturapp.authorized_senders ENABLE ROW LEVEL SECURITY;

-- Sin políticas explícitas: anon/authenticated quedan completamente bloqueados.
-- service_role ignora RLS, así que las Edge Functions no se ven afectadas.

-- ============================================================================
-- Tabla users: acceso bloqueado
-- ============================================================================

ALTER TABLE facturapp.users ENABLE ROW LEVEL SECURITY;

-- Sin políticas: acceso denegado. Las Edge Functions usan service_role.

-- ============================================================================
-- Tablas globales del sistema: acceso bloqueado
-- ============================================================================

ALTER TABLE facturapp.debug_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturapp.rate_limit_attempts ENABLE ROW LEVEL SECURITY;

-- Sin políticas: acceso denegado a anon/authenticated.
-- Solo service_role (Edge Functions) puede leer/escribir.
