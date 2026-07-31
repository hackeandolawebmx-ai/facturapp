/**
 * Tests del almacenamiento de PDFs (Fase M13).
 *
 * Usan el Storage simulado del FakeSupabaseClient — no hay bucket real
 * disponible aquí. Lo que se prueba es la lógica propia: cómo se arma la
 * ruta y cómo se reacciona a un fallo, no que Supabase Storage funcione.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import { BUCKET, descargarPdf, rutaPdf, subirPdf } from "./pdf_storage.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

const CONTENIDO = new TextEncoder().encode("%PDF-1.4 contenido de prueba");

Deno.test("rutaPdf: agrupa por usuario y nombra con el UUID fiscal", () => {
  assertEquals(rutaPdf(7, "4DDDC0C0-16E3-4103-98FE-1B36B3E9C331"),
    "7/4DDDC0C0-16E3-4103-98FE-1B36B3E9C331.pdf");
});

Deno.test("rutaPdf: usuarios distintos no colisionan con el mismo UUID", () => {
  // Dos personas pueden recibir la misma factura (p. ej. un servicio
  // facturado a nombre de uno y reenviado al otro).
  assert(rutaPdf(1, "UUID-X") !== rutaPdf(2, "UUID-X"));
});

Deno.test("subirPdf: guarda el archivo y devuelve su ruta", async () => {
  const supabase = client();
  const ruta = await subirPdf(supabase, 7, "UUID-A", CONTENIDO);

  assertEquals(ruta, "7/UUID-A.pdf");
  assert(supabase.archivos[`${BUCKET}/7/UUID-A.pdf`] !== undefined);
});

Deno.test("subirPdf: ante un fallo devuelve null y NO lanza", async () => {
  // Perder el PDF es molesto; tumbar la ingesta de una factura válida por eso
  // sería peor. El XML —el comprobante fiscal— ya está guardado a estas
  // alturas.
  const supabase = client();
  supabase.storage = {
    from: () => ({
      upload: () => Promise.resolve({ data: null, error: { message: "cuota excedida" } }),
    }),
  };
  assertEquals(await subirPdf(supabase, 7, "UUID-A", CONTENIDO), null);
});

Deno.test("subirPdf: reenviar la misma factura reemplaza, no duplica", async () => {
  const supabase = client();
  await subirPdf(supabase, 7, "UUID-A", CONTENIDO);
  await subirPdf(supabase, 7, "UUID-A", new TextEncoder().encode("%PDF-1.4 nuevo"));

  assertEquals(Object.keys(supabase.archivos).length, 1);
  assertEquals(
    new TextDecoder().decode(supabase.archivos[`${BUCKET}/7/UUID-A.pdf`]),
    "%PDF-1.4 nuevo",
  );
});

Deno.test("descargarPdf: recupera el mismo contenido que se subió", async () => {
  const supabase = client();
  const ruta = await subirPdf(supabase, 7, "UUID-A", CONTENIDO);

  const blob = await descargarPdf(supabase, ruta!);
  assertEquals(await blob!.text(), "%PDF-1.4 contenido de prueba");
});

Deno.test("descargarPdf: archivo inexistente devuelve null", async () => {
  const supabase = client();
  assertEquals(await descargarPdf(supabase, "7/no-existe.pdf"), null);
});
