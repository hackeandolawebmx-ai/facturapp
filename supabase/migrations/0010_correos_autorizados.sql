-- Fase M18 -- varios remitentes de correo autorizados por cuenta.
--
-- CONTEXTO: las facturas por correo se atribuyen hoy por el remitente EXACTO
-- (getOrCreateUserByEmail busca/crea una cuenta por `from`). Eso significa
-- que si el dueño de la cuenta reenvía facturas desde una dirección
-- DISTINTA a la registrada (su correo de trabajo, el de su contador, etc.),
-- el sistema no falla -- crea o usa una cuenta DIFERENTE, ligada a esa otra
-- dirección, silenciosamente. El usuario nunca ve el error: simplemente la
-- factura no aparece en el dashboard que sí revisa.
--
-- Mismo problema que resolvieron los múltiples RFCs (0008) pero del lado del
-- remitente: una cuenta, varios correos autorizados a alimentarla.
create table if not exists facturapp.authorized_senders (
  id bigserial primary key,
  user_id bigint not null references facturapp.users(id) on delete cascade,
  -- Normalizado a minúsculas antes de guardar, igual que users.email.
  email text not null,
  -- Para distinguirlos en la interfaz ("Contador", "Trabajo").
  alias text,
  created_at timestamptz not null default now(),
  -- Un correo autorizado solo puede apuntar a UNA cuenta -- si dos cuentas
  -- pudieran reclamar el mismo remitente, una factura de ese correo sería
  -- ambigua: ¿de cuál de las dos es? Global, no por cuenta.
  unique (email)
);

create index if not exists idx_authorized_senders_user
  on facturapp.authorized_senders(user_id);

grant all on facturapp.authorized_senders to anon, authenticated, service_role;
grant usage, select on sequence facturapp.authorized_senders_id_seq
  to anon, authenticated, service_role;
