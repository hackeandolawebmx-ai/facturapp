-- Fase M20 -- aviso mensual de facturas que necesitan atención.
--
-- Dos cortes al mes, para dar tiempo real de corregir antes de declarar:
--   1. Día 24 -- "última semana": alerta a tiempo de resolver algo antes de
--      que cierre el mes. Día 24 (no "el último lunes" ni similar) porque
--      pg_cron programa por día fijo del mes, y 24 cae dentro de la última
--      semana de CUALQUIER mes (el más corto, febrero, tiene 28).
--   2. Día 1 del mes siguiente -- "el corte": revisa el mes que se acaba de
--      cerrar (`?periodo=anterior`), para quien no alcanzó a corregir antes.
--
-- El secreto que autentica la llamada NO vive en esta migración -- se generó
-- aparte y se guardó en Supabase Vault vía `vault.create_secret(...)`
-- ejecutado una sola vez fuera del control de versiones (igual que
-- CRON_JOB_SECRET en los secrets de la función). Commitear el valor real acá
-- lo dejaría en el historial de git para siempre, incluso si después se
-- rota. La migración solo sabe leerlo por NOMBRE (`cron_job_secret`).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'revision_mensual_ultima_semana',
  '0 15 24 * *',  -- día 24, 15:00 UTC = 9:00 America/Mexico_City (sin DST)
  $$
  select net.http_post(
    url := 'https://smocemszqzsypuachevr.supabase.co/functions/v1/job-revision-mensual?periodo=actual',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'revision_mensual_corte',
  '0 15 1 * *',  -- día 1 del mes siguiente, 15:00 UTC = 9:00 America/Mexico_City
  $$
  select net.http_post(
    url := 'https://smocemszqzsypuachevr.supabase.co/functions/v1/job-revision-mensual?periodo=anterior',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
