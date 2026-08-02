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
