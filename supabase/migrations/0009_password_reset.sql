-- Fase M17 — recuperar contraseña vía WhatsApp.
--
-- Hasta ahora una cuenta que YA tiene contraseña y la olvida no tiene forma
-- de recuperar acceso salvo editar la base a mano: auth-set-password rechaza
-- el web_token en cuanto existe una contraseña (a propósito, ver comentario
-- en ese archivo), y el web_token tampoco debería servir para esto de todas
-- formas -- es el mismo token que abre los enlaces públicos de solo lectura
-- (/api/public/summary, /api/public/invoices), así que reutilizarlo para
-- restablecer contraseña habría convertido cualquier link compartido en un
-- vector de secuestro de cuenta.
--
-- Token aparte, de un solo uso y con expiración corta: se genera solo cuando
-- el propio usuario lo pide por WhatsApp (prueba de titularidad del
-- teléfono registrado en la cuenta), y deja de servir en cuanto se usa o
-- vence.
alter table facturapp.users
    add column reset_token text,
    add column reset_token_expira timestamptz;

create unique index if not exists users_reset_token_key
    on facturapp.users (reset_token)
    where reset_token is not null;
