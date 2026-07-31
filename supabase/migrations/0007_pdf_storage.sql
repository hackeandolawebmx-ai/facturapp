-- Fase M13 -- almacenamiento del PDF de las facturas.
--
-- El XML se guarda en la columna `raw_xml` porque es texto y cabe cómodo en
-- Postgres. Un PDF es binario y pesa mucho más, así que va a Supabase
-- Storage y en la tabla solo queda la ruta.
--
-- POR QUÉ IMPORTA: legalmente el XML es el comprobante fiscal y el PDF solo
-- su representación impresa, así que para deducir basta el XML. Pero cuando
-- un usuario manda ambos y solo conservamos uno, pierde algo que nos
-- confió -- y para enseñarle una factura a alguien que no lee XML, el PDF es
-- lo práctico.

alter table facturapp.invoices
  add column if not exists pdf_path text;

-- Bucket privado: las facturas son datos fiscales personales y no deben ser
-- accesibles por URL directa. Las Edge Functions leen con la service role,
-- que se salta RLS, y sirven el archivo solo tras validar el JWT y que la
-- factura sea del usuario que la pide.
insert into storage.buckets (id, name, public)
values ('facturas', 'facturas', false)
on conflict (id) do nothing;
