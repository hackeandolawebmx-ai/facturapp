-- Fase M6 -- Seed de datos reales existentes en facturapp.db (SQLite local).
--
-- IMPORTANTE: estos son los UNICOS datos presentes en el facturapp.db local
-- en el momento de esta migracion -- 2 usuarios de PRUEBA (dominio @example.com,
-- los mismos RFC de fixture usados en los tests de M4/M5.5), 0 facturas, 0 chats.
-- Si la produccion real vive en un volumen de Railway distinto a este archivo,
-- esta migracion NO la cubre -- habria que repetir el proceso apuntando a ese SQLite.
--
-- Divergencias respecto al script propuesto originalmente para esta fase:
-- 1. La columna facturapp.users.plan (SQLite) no existe en el schema de Supabase
--    (0001_initial_schema.sql) -- se descarta, no se migra.
-- 2. SQLite no tiene columna whatsapp_phone -- queda NULL en Supabase (columna
--    nullable, comportamiento correcto: estas cuentas no se crearon via WhatsApp).
-- 3. invoices/chat_messages no se incluyen: 0 filas en el SQLite de origen.

INSERT INTO facturapp.users (id, email, nombre, rfc, hashed_password, web_token, whatsapp_phone, created_at)
VALUES
  (1, 'daniela@example.com', 'Daniela Ávila', 'DAXX860715XX0', '$2b$12$.8h2SJBtKgM7RSATw9QSkus0k/Ud/oIdXgKYQ66w8eZXru22qmqTy', 'XBgteXHWaz9E44Dw_-50XXfx5_73b520', NULL, '2026-07-24 04:30:05.220279'),
  (2, 'bruno@example.com', 'Bruno Reyes', 'REBB900110AB1', '$2b$12$s7V9y942rfaPzaoPB7o6Lu/a.DY327/mhTJ96TZdom0sh0GZnRZ6q', 'JnOl00AHzasEhpXEU6Xyu2q5t8Je3_BP', NULL, '2026-07-24 04:30:05.220286')
ON CONFLICT (id) DO NOTHING;

-- Alinear la secuencia de BIGSERIAL con el ultimo id insertado explicitamente,
-- para que el proximo usuario creado por la app no choque con estos ids.
SELECT setval(pg_get_serial_sequence('facturapp.users', 'id'), (SELECT MAX(id) FROM facturapp.users));
