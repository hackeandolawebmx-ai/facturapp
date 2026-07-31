-- Fase M14 -- varios RFCs por cuenta, con tipo de contribuyente explícito.
--
-- POR QUÉ EL TIPO ES OBLIGATORIO: todo el motor fiscal de este sistema
-- implementa DEDUCCIONES PERSONALES (Art. 151 LISR). El clasificador solo
-- conoce usos personales (D01, D02, D05, D07, D10) y el validador trata
-- `G03` como "uso que no permite deducir" — cuando G03, *Gastos en general*,
-- es justamente el uso correcto de una persona moral.
--
-- Si se dejara pasar una factura de persona moral por esas reglas, el sistema
-- le diría a una empresa que sus gastos legítimos están mal facturados y que
-- pida corrección al proveedor. Sería consejo fiscal falso con formato de
-- consejo correcto: el peor modo de fallo posible aquí.
--
-- Por eso las facturas de RFCs marcados como `moral` se ARCHIVAN sin
-- clasificar ni validar. Se conservan, se descargan y se consultan, pero el
-- sistema no emite un juicio de deducibilidad que no está capacitado para
-- emitir. Construir el motor de personas morales (Art. 25 LISR:
-- proporcionalidad, depreciación, límites por tipo de gasto) es un proyecto
-- aparte, no una variante de este.

create table if not exists facturapp.user_rfcs (
  id bigserial primary key,
  user_id bigint not null references facturapp.users(id) on delete cascade,
  rfc text not null,
  -- 'fisica' → se aplican las reglas de deducciones personales.
  -- 'moral'  → se archiva sin clasificar ni validar.
  tipo text not null check (tipo in ('fisica', 'moral')),
  -- Nombre para distinguirlos en la interfaz ("Mi empresa", "Mamá").
  alias text,
  -- El principal es el que se usa por defecto y el que vive en users.rfc.
  es_principal boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, rfc)
);

create index if not exists idx_user_rfcs_user on facturapp.user_rfcs(user_id);

-- Un solo principal por cuenta. Índice parcial en vez de constraint porque
-- la condición es sobre las filas con es_principal = true.
create unique index if not exists idx_user_rfcs_un_principal
  on facturapp.user_rfcs(user_id) where es_principal;

-- Migrar el RFC que ya tiene cada usuario como su RFC principal de persona
-- física. Se excluyen los sintéticos (PEND...): no son RFCs reales, son
-- marcadores de "todavía no sabemos el suyo", y darlos de alta aquí los
-- convertiría en algo que parece configurado a propósito.
insert into facturapp.user_rfcs (user_id, rfc, tipo, alias, es_principal)
select id, rfc, 'fisica', 'Principal', true
from facturapp.users
where rfc is not null and rfc not like 'PEND%'
on conflict (user_id, rfc) do nothing;

-- Alinear las facturas ya archivadas con el RFC actual del usuario.
--
-- `usuario_rfc` guarda el RFC que tenía la cuenta al momento de ingerir. Para
-- las creadas por WhatsApp o correo eso es un placeholder `PEND...`, así que
-- al empezar a filtrar el resumen por RFC esas facturas desaparecerían de la
-- vista de su propio dueño. Se realinean con el RFC real.
update facturapp.invoices i
set usuario_rfc = u.rfc
from facturapp.users u
where i.user_id = u.id
  and u.rfc not like 'PEND%'
  and i.usuario_rfc is distinct from u.rfc;

grant all on facturapp.user_rfcs to anon, authenticated, service_role;
grant usage, select on sequence facturapp.user_rfcs_id_seq
  to anon, authenticated, service_role;
