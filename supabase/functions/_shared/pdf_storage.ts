/**
 * Almacenamiento del PDF de las facturas en Supabase Storage (Fase M13).
 *
 * El XML vive en la columna `raw_xml` porque es texto; el PDF es binario y
 * pesado, así que va a Storage y en la tabla solo queda la ruta.
 *
 * El bucket es privado (ver 0007_pdf_storage.sql): las facturas son datos
 * fiscales personales y no deben quedar accesibles por URL directa. Se leen
 * con la service role y se sirven solo tras comprobar que la factura es de
 * quien la pide.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const BUCKET = "facturas";

/** Ruta dentro del bucket: `{user_id}/{uuid}.pdf`.
 *
 * Agrupar por usuario evita colisiones entre cuentas y deja el bucket
 * legible si algún día hay que inspeccionarlo a mano. El UUID fiscal es
 * único por factura, así que reenviar la misma no duplica archivos. */
export function rutaPdf(userId: number, uuidFiscal: string): string {
  return `${userId}/${uuidFiscal}.pdf`;
}

/** Sube el PDF y devuelve la ruta, o `null` si falla.
 *
 * NO lanza: perder el PDF es molesto, pero tumbar la ingesta de una factura
 * válida por eso sería peor. El XML —que es el comprobante fiscal— ya está
 * guardado para cuando esto corre. El fallo queda en el log.
 */
export async function subirPdf(
  supabase: SupabaseClient, userId: number, uuidFiscal: string, contenido: Uint8Array,
): Promise<string | null> {
  const ruta = rutaPdf(userId, uuidFiscal);
  const { error } = await supabase.storage.from(BUCKET).upload(ruta, contenido, {
    contentType: "application/pdf",
    // Reenviar la misma factura reemplaza el archivo en vez de fallar.
    upsert: true,
  });
  if (error) {
    console.error(`No se pudo subir el PDF de ${uuidFiscal}:`, error);
    return null;
  }
  return ruta;
}

/** Descarga el PDF desde Storage. Devuelve `null` si no existe.
 *
 * Devuelve el `Blob` tal cual y no `Uint8Array` porque el único consumidor lo
 * pasa directo a `new Response(...)`, que acepta Blob. Convertirlo a bytes
 * solo para que Response lo vuelva a envolver sería trabajo de más. */
export async function descargarPdf(
  supabase: SupabaseClient, ruta: string,
): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(ruta);
  if (error || !data) {
    console.error(`No se pudo descargar el PDF ${ruta}:`, error);
    return null;
  }
  return data;
}
