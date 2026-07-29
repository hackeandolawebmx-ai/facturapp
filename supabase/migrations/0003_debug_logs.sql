-- Fase M4b -- tabla de diagnostico para el webhook de WhatsApp, adoptada del
-- patron probado en produccion documentado en WHATSAPP_BOT_ARCHITECTURE.md
-- (bot de otro proyecto que comparte este mismo Supabase). Sin esto, la
-- unica forma de depurar firmas invalidas / errores de Meta es
-- `supabase functions logs`, que rota rapido y no persiste.
--
-- Vive en el esquema `facturapp` (no `public`) para no colisionar con la
-- tabla homonima del otro proyecto en el mismo Supabase.
create table if not exists facturapp.debug_logs (
  id bigserial primary key,
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_facturapp_debug_logs_created
  on facturapp.debug_logs (created_at desc);

-- Sin RLS: las Edge Functions escriben con la service_role key (que ignora
-- RLS de todas formas) -- mismo razonamiento ya documentado para el resto
-- del esquema facturapp en 0001_initial_schema.sql.
