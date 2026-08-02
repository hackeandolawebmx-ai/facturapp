/**
 * Tests de correos autorizados de una cuenta (Fase M18).
 *
 * Lo que importa probar: que un correo ya sea el propio de una cuenta o ya
 * esté autorizado en otra, no se pueda volver a autorizar en una tercera --
 * eso es lo que evita que una factura por correo quede atribuida de forma
 * ambigua.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import {
  agregarCorreoAutorizado, eliminarCorreoAutorizado, listarCorreosAutorizados,
} from "./authorized_senders.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

// deno-lint-ignore no-explicit-any
function conUsuario(supabase: any, id: number, email: string) {
  supabase.tables.users.push({ id, email, nombre: `Usuario ${id}`, rfc: `PEND${id}` });
}

// deno-lint-ignore no-explicit-any
function conCorreoAutorizado(supabase: any, id: number, userId: number, email: string) {
  supabase.tables.authorized_senders.push({ id, user_id: userId, email, alias: null });
}

Deno.test("listarCorreosAutorizados: devuelve los de la cuenta", async () => {
  const supabase = client();
  conCorreoAutorizado(supabase, 1, 7, "trabajo@empresa.com");
  conCorreoAutorizado(supabase, 2, 7, "contador@despacho.com");

  const correos = await listarCorreosAutorizados(supabase, 7);
  assertEquals(correos.length, 2);
});

Deno.test("listarCorreosAutorizados: no devuelve los de otra cuenta", async () => {
  const supabase = client();
  conCorreoAutorizado(supabase, 1, 99, "trabajo@empresa.com");
  assertEquals((await listarCorreosAutorizados(supabase, 7)).length, 0);
});

Deno.test("agregarCorreoAutorizado: da de alta uno nuevo", async () => {
  const supabase = client();
  const resultado = await agregarCorreoAutorizado(supabase, 7, "Trabajo@Empresa.com", "Trabajo");

  assertEquals(resultado.ok, true);
  if (resultado.ok) {
    assertEquals(resultado.correo.email, "trabajo@empresa.com");
    assertEquals(resultado.correo.alias, "Trabajo");
  }
});

Deno.test("agregarCorreoAutorizado: rechaza el correo propio de una cuenta existente", async () => {
  // De lo contrario, dos cuentas podrían reclamar el mismo remitente y una
  // factura de ese correo quedaría atribuida de forma ambigua.
  const supabase = client();
  conUsuario(supabase, 1, "dueño@golfdynasty.mx");

  const resultado = await agregarCorreoAutorizado(supabase, 7, "dueño@golfdynasty.mx", null);
  assertEquals(resultado.ok, false);
  if (!resultado.ok) assertEquals(resultado.motivo, "ya_registrado");
});

Deno.test("agregarCorreoAutorizado: rechaza un correo ya autorizado en otra cuenta", async () => {
  const supabase = client();
  conCorreoAutorizado(supabase, 1, 99, "compartido@empresa.com");

  const resultado = await agregarCorreoAutorizado(supabase, 7, "compartido@empresa.com", null);
  assertEquals(resultado.ok, false);
  if (!resultado.ok) assertEquals(resultado.motivo, "ya_registrado");
});

Deno.test("eliminarCorreoAutorizado: quita el de la cuenta", async () => {
  const supabase = client();
  conCorreoAutorizado(supabase, 1, 7, "trabajo@empresa.com");

  assertEquals(await eliminarCorreoAutorizado(supabase, 7, 1), true);
  assertEquals(supabase.tables.authorized_senders.length, 0);
});

Deno.test("eliminarCorreoAutorizado: el de otra cuenta no se toca", async () => {
  const supabase = client();
  conCorreoAutorizado(supabase, 1, 99, "trabajo@empresa.com");

  assertEquals(await eliminarCorreoAutorizado(supabase, 7, 1), false);
  assertEquals(supabase.tables.authorized_senders.length, 1);
});

Deno.test("eliminarCorreoAutorizado: id inexistente devuelve false", async () => {
  const supabase = client();
  assertEquals(await eliminarCorreoAutorizado(supabase, 7, 999), false);
});
