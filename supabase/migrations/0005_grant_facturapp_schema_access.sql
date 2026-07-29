-- Fase M7 (deploy) -- permisos del schema `facturapp` para los roles de la
-- Data API.
--
-- POR QUÉ HACE FALTA: Supabase aplica estos grants automáticamente al
-- schema `public`, pero NO a un schema creado aparte. `facturapp` se creó
-- en 0001_initial_schema.sql, así que `anon`/`authenticated`/`service_role`
-- no tenían USAGE sobre él — PostgREST (y por tanto `supabase-js` con
-- `.schema("facturapp")`) no podía tocar ninguna tabla aunque el schema
-- estuviera marcado como expuesto en el dashboard.
--
-- Esto salió a la luz al desplegar M7: `auth-register` devolvía 500 con
-- PGRST106 al primer query. Se deja como migración (y no como un cambio
-- manual en el dashboard) para que el entorno sea reproducible desde cero.

grant usage on schema facturapp to anon, authenticated, service_role;

grant all on all tables in schema facturapp to anon, authenticated, service_role;
grant all on all sequences in schema facturapp to anon, authenticated, service_role;
grant all on all functions in schema facturapp to anon, authenticated, service_role;

-- Para las tablas/secuencias que se creen en fases futuras, sin tener que
-- repetir los grants de arriba en cada migración nueva.
alter default privileges in schema facturapp
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema facturapp
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema facturapp
  grant all on functions to anon, authenticated, service_role;
