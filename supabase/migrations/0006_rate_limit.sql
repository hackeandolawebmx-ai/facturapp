-- Fase M8 -- rate limiting con estado en Postgres.
--
-- POR QUÉ NO ES UN PORT: Python usa slowapi (`@limiter.limit("5/minute")`),
-- un contador en memoria del proceso. En Edge Functions cada invocación
-- puede caer en una instancia distinta sin memoria compartida, así que ese
-- enfoque no limita nada -- daría una falsa sensación de protección. El
-- estado tiene que vivir fuera del proceso, y Postgres ya está ahí.
--
-- El conteo y el registro van juntos dentro de una función para que sean
-- atómicos: si se hicieran como dos queries desde la Edge Function, dos
-- intentos simultáneos podrían leer el mismo conteo y pasar ambos.

create table if not exists facturapp.rate_limit_attempts (
  id bigserial primary key,
  clave text not null,
  intentado_en timestamptz not null default now()
);

-- La consulta siempre filtra por clave y ventana de tiempo.
create index if not exists idx_rate_limit_clave_tiempo
  on facturapp.rate_limit_attempts (clave, intentado_en desc);

/*
 * Registra un intento y dice si se permite.
 *
 * Devuelve true si el intento cabe dentro del límite (y lo registra), o
 * false si ya se excedió (y NO lo registra, para que una ráfaga de
 * peticiones bloqueadas no extienda la ventana indefinidamente).
 *
 * Ventana deslizante, no fija: cuenta los intentos de los últimos
 * `p_ventana_segundos`, en vez de reiniciar el contador en marcas de reloj
 * fijas. Una ventana fija permitiría el doble del límite a caballo entre
 * dos ventanas (5 al final de un minuto + 5 al inicio del siguiente).
 */
create or replace function facturapp.registrar_intento(
  p_clave text,
  p_max_intentos int,
  p_ventana_segundos int
) returns boolean
language plpgsql
as $$
declare
  v_intentos int;
begin
  -- Limpieza oportunista: mantiene la tabla acotada sin necesitar un job
  -- programado aparte. Solo borra lo de esta clave, así que es barato.
  delete from facturapp.rate_limit_attempts
  where clave = p_clave
    and intentado_en < now() - make_interval(secs => p_ventana_segundos);

  select count(*) into v_intentos
  from facturapp.rate_limit_attempts
  where clave = p_clave;

  if v_intentos >= p_max_intentos then
    return false;
  end if;

  insert into facturapp.rate_limit_attempts (clave) values (p_clave);
  return true;
end;
$$;

grant execute on function facturapp.registrar_intento(text, int, int)
  to anon, authenticated, service_role;
grant all on facturapp.rate_limit_attempts to anon, authenticated, service_role;
grant usage, select on sequence facturapp.rate_limit_attempts_id_seq
  to anon, authenticated, service_role;
