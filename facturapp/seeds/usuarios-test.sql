-- Seed de 2 usuarios de prueba (Fase 2a).
-- Las contraseñas están hasheadas con bcrypt; el texto plano es "password123".
-- Úsalo en Supabase (SQL Editor) o adáptalo. web_token sirve para /a/{token}.

INSERT INTO users (email, nombre, rfc, hashed_password, web_token, plan)
VALUES
  ('daniela@example.com', 'Daniela Ávila', 'DAXX860715XX0',
   '$2b$12$aQ8Zr0m3o5m1QK5h3G0k9uZ2vJH2b7yQwq3o5m1QK5h3G0k9uZ2vC', 'token-daniela-demo', 'free'),
  ('bruno@example.com',   'Bruno Reyes',   'REBB900110AB1',
   '$2b$12$aQ8Zr0m3o5m1QK5h3G0k9uZ2vJH2b7yQwq3o5m1QK5h3G0k9uZ2vC', 'token-bruno-demo',   'free')
ON CONFLICT (email) DO NOTHING;

-- Nota: los hashes de arriba son ilustrativos. Genera hashes reales con:
--   python -c "from passlib.context import CryptContext; \
--     print(CryptContext(schemes=['bcrypt']).hash('password123'))"
