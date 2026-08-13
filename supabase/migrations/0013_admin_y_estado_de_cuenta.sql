-- Fase M23 -- back-office de operación: rol de administrador, estado de la
-- cuenta y atribución de canal de las facturas.
--
-- CONTEXTO: hasta aquí el sistema no tenía forma de ser OPERADO. No existía
-- concepto de rol (nadie podía ver más que sus propios datos), ni de estado de
-- cuenta (la única forma de cortarle el acceso a alguien era borrar su fila, y
-- con ella sus comprobantes fiscales). Diagnosticar el problema de un usuario
-- requería abrir el SQL Editor y consultar a mano -- viable con dos cuentas,
-- no con doscientas.

-- ---------------------------------------------------------------------------
-- Rol y estado de la cuenta
-- ---------------------------------------------------------------------------

alter table facturapp.users
  add column if not exists rol text not null default 'usuario'
    check (rol in ('usuario', 'admin')),
  -- NULL = cuenta activa; con fecha = suspendida. Un timestamptz en vez de un
  -- booleano `activo` porque además de "está suspendida" registra CUÁNDO se
  -- suspendió, que es justo lo que se quiere saber al revisar el caso después.
  -- Un booleano obligaría a una tabla de auditoría aparte para el mismo dato.
  add column if not exists suspendida_en timestamptz,
  add column if not exists suspendida_motivo text;

-- El listado del panel ordena por fecha de alta descendente.
create index if not exists idx_users_created
  on facturapp.users (created_at desc);

-- ---------------------------------------------------------------------------
-- Canal de ingesta de cada factura
-- ---------------------------------------------------------------------------

-- Sin esta columna no hay forma de responder "¿por dónde entran las facturas?".
-- Nullable a propósito: las filas anteriores a este cambio NO se rellenan con
-- una suposición -- se reportan como "desconocido" en las métricas. Inventar
-- una atribución retroactiva daría una gráfica que parece un dato y no lo es.
alter table facturapp.invoices
  add column if not exists origen text
    check (origen in ('correo', 'whatsapp', 'web'));

-- ---------------------------------------------------------------------------
-- Vista del listado de cuentas
-- ---------------------------------------------------------------------------

-- Existe para que el listado del panel sea UNA consulta. Sin ella, la Edge
-- Function tendría que pedir el conteo de facturas por cada usuario de la
-- página (N+1) -- justo el patrón que se vuelve insoportable con el número de
-- cuentas que este panel existe para poder manejar.
--
-- security_invoker = true (PG15): la vista se evalúa con los permisos de quien
-- consulta, no de quien la creó. Como las tablas de abajo tienen RLS activo sin
-- políticas (migración 0012), esto significa que solo `service_role` --que
-- ignora RLS-- puede leerla. Sin esta opción, una vista SECURITY DEFINER sería
-- un agujero alrededor del RLS que acabamos de habilitar.
create or replace view facturapp.admin_usuarios
with (security_invoker = true) as
select
  u.id,
  u.email,
  u.nombre,
  u.rfc,
  u.plan,
  u.rol,
  u.whatsapp_phone,
  u.created_at,
  u.suspendida_en,
  u.suspendida_motivo,
  -- Una cuenta sin contraseña se auto-creó al recibir su primera factura por
  -- correo o WhatsApp y nunca completó el registro. Es la señal de embudo más
  -- útil que hay en esta tabla, así que se expone como columna y no se deja
  -- que cada consumidor deduzca el `is not null`.
  (u.hashed_password is not null) as tiene_password,
  -- RFC sintético `PEND...`: la cuenta existe pero nunca dijo su RFC real, así
  -- que TODAS sus facturas salen marcadas RFC_AJENO. Ver accounts.ts.
  (u.rfc like 'PEND%') as rfc_pendiente,
  coalesce(f.num_facturas, 0) as num_facturas,
  f.ultima_factura_en
from facturapp.users u
left join (
  select
    user_id,
    count(*)::int as num_facturas,
    max(created_at) as ultima_factura_en
  from facturapp.invoices
  group by user_id
) f on f.user_id = u.id;

-- Solo service_role: esta vista cruza los datos de TODAS las cuentas, así que
-- no se le concede a `anon` ni a `authenticated` (a diferencia del resto de
-- tablas del esquema). El control de rol vive en la Edge Function.
grant select on facturapp.admin_usuarios to service_role;

-- ---------------------------------------------------------------------------
-- Métricas agregadas
-- ---------------------------------------------------------------------------

-- Un solo JSON en vez de ~10 consultas sueltas desde la Edge Function. Mismo
-- criterio que facturapp.registrar_intento (0006_rate_limit.sql): cuando el
-- trabajo es agregar filas, hacerlo en Postgres y no en TypeScript.
--
-- search_path = '' obliga a calificar cada referencia con su esquema (ya lo
-- están) y evita que la función pueda ser secuestrada por un esquema temporal
-- puesto en el camino de búsqueda.
create or replace function facturapp.admin_metricas()
returns jsonb
language sql
stable
set search_path = ''
as $$
with c as (
  select
    count(*)::int as total,
    count(*) filter (where suspendida_en is null)::int as activas,
    count(*) filter (where suspendida_en is not null)::int as suspendidas,
    count(*) filter (where created_at >= now() - interval '7 days')::int as nuevas_7d,
    count(*) filter (where created_at >= now() - interval '30 days')::int as nuevas_30d,
    count(*) filter (where hashed_password is null)::int as sin_password,
    count(*) filter (where rfc like 'PEND%')::int as rfc_pendiente
  from facturapp.users
),
f as (
  select
    count(*)::int as total,
    count(*) filter (where created_at >= now() - interval '30 days')::int as ultimos_30d,
    coalesce(sum(total), 0)::numeric as monto_total,
    count(distinct user_id)::int as cuentas_con_facturas
  from facturapp.invoices
),
por_estatus as (
  select coalesce(jsonb_object_agg(estatus, n), '{}'::jsonb) as j
  from (
    select estatus, count(*)::int as n
    from facturapp.invoices group by estatus
  ) t
),
por_canal as (
  select coalesce(jsonb_object_agg(canal, n), '{}'::jsonb) as j
  from (
    -- Las filas previas a esta migración no tienen canal y se reportan como
    -- tales, en vez de repartirse entre los tres reales.
    select coalesce(origen, 'desconocido') as canal, count(*)::int as n
    from facturapp.invoices group by 1
  ) t
)
select jsonb_build_object(
  'cuentas', jsonb_build_object(
    'total', c.total,
    'activas', c.activas,
    'suspendidas', c.suspendidas,
    'nuevas_7d', c.nuevas_7d,
    'nuevas_30d', c.nuevas_30d,
    'sin_password', c.sin_password,
    'rfc_pendiente', c.rfc_pendiente,
    'con_facturas', f.cuentas_con_facturas,
    'sin_facturas', c.total - f.cuentas_con_facturas
  ),
  'facturas', jsonb_build_object(
    'total', f.total,
    'ultimos_30d', f.ultimos_30d,
    'monto_total', f.monto_total,
    'por_estatus', por_estatus.j,
    'por_canal', por_canal.j
  )
)
from c, f, por_estatus, por_canal;
$$;

grant execute on function facturapp.admin_metricas() to service_role;

-- ---------------------------------------------------------------------------
-- Arranque: la primera cuenta administradora
-- ---------------------------------------------------------------------------

-- No hay forma de crear el primer admin desde el propio panel (haría falta ser
-- admin para entrar), así que se marca aquí. EDITAR ESTE CORREO antes de
-- aplicar la migración en otro entorno.
update facturapp.users set rol = 'admin' where email = 'danzt@hotmail.com';
