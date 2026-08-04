/**
 * Año fiscal en curso según la zona horaria de México, no la del servidor.
 *
 * Las Edge Functions corren en UTC. Entre las 18:00 y la medianoche del 31 de
 * diciembre en México ya es 1 de enero en UTC, así que usar la fecha del
 * servidor daría el año equivocado justo en el cambio de ejercicio fiscal —
 * el peor momento posible para equivocarse en una app de deducciones.
 *
 * Antes vivía duplicada como `YEAR_DEFAULT = 2026` hardcoded en chat.ts,
 * invoices_api.ts y cada index.ts de las rutas REST; se centraliza aquí para
 * que el "año en curso" avance solo en 2027 sin tocar cinco archivos.
 */
export function anioFiscalActual(hoy: Date = new Date()): number {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
  }).format(hoy);
  return Number.parseInt(partes, 10);
}

/** Mes en curso (1-12) según la zona horaria de México. Mismo motivo que
 * `anioFiscalActual()`: el job de revisión mensual (Fase M20) corre en UTC y
 * decide "el mes que se está cerrando" con esto, no con la fecha del
 * servidor. */
export function mesFiscalActual(hoy: Date = new Date()): number {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    month: "numeric",
  }).format(hoy);
  return Number.parseInt(partes, 10);
}

/** Año y mes del mes calendario ANTERIOR al actual, en la zona horaria de
 * México. Lo usa el aviso "de corte" del job de revisión mensual: cuando
 * corre el día 1, `mesFiscalActual()` ya devuelve el mes NUEVO que apenas
 * empezó -- este es el que hace que el corte revise el mes que se acaba de
 * cerrar, no el que arranca. */
export function anioMesAnterior(hoy: Date = new Date()): { anio: number; mes: number } {
  const anio = anioFiscalActual(hoy);
  const mes = mesFiscalActual(hoy);
  return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}
