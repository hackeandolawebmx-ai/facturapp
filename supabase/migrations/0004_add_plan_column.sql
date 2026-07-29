-- Fase M7 -- agrega la columna `plan` a facturapp.users, que existe en el
-- User de SQLAlchemy original (models.py: `plan = Column(String(20),
-- default="free")`) y se devuelve en /api/user/profile, pero se omitió por
-- error del esquema inicial (0001_initial_schema.sql, Fase M1) -- ese
-- esquema se escribió antes de tener el modelo Python completo a la vista.
alter table facturapp.users
  add column if not exists plan text not null default 'free';
