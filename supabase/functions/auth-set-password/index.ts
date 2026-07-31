// Fase M12 — POST /auth/set-password. Establecer o cambiar la contraseña.
//
// No existe en Python. Se construyó porque faltaba un eslabón sin el cual el
// dashboard es inalcanzable para la mayoría de los usuarios: las cuentas que
// se crean solas al recibir una factura por WhatsApp o correo nacen SIN
// contraseña (`hashed_password` en null), así que no pueden hacer login — y
// sin login no llegan a ningún endpoint donde ponerse una. Un callejón sin
// salida que solo se rompía editando la base a mano.
//
// Dos caminos de autorización, según el estado de la cuenta:
//
//   1. **Ya tiene contraseña** → hace falta el JWT *y* la contraseña actual.
//      Exigir la actual es lo que impide que un token robado se convierta en
//      un secuestro de cuenta: con solo el token, el atacante podría fijar
//      una contraseña nueva y dejar fuera al dueño.
//
//   2. **No tiene contraseña todavía** → se acepta el `web_token` de la
//      cuenta como prueba de titularidad. Es el mismo nivel de confianza que
//      el diseño original de Python daba a ese token (`/a/{token}` abría el
//      archivo fiscal completo), pero acotado: aquí solo sirve para el
//      arranque, y en cuanto existe una contraseña deja de funcionar para
//      cambiarla.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { hashPassword, verifyPassword } from "../_shared/passwords.ts";
import {
  getUserAuth, getUserAuthByWebToken, setUserPassword, type UserAuthRow,
} from "../_shared/users.ts";
import { ipDelCliente, registrarIntento } from "../_shared/rate_limit.ts";

const MAX_INTENTOS = 5;
const VENTANA_SEGUNDOS = 60;

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

interface Payload {
  password_nuevo?: string;
  password_actual?: string;
  web_token?: string;
}

async function handlePost(req: Request): Promise<Response> {
  const supabase = getSupabaseClient();

  // Igual que en login: se limita antes de ejecutar bcrypt, que es caro a
  // propósito. Este endpoint verifica contraseñas, así que es un objetivo de
  // fuerza bruta tan válido como el login.
  const ip = ipDelCliente(req.headers);
  if (!await registrarIntento(supabase, `set-password:ip:${ip}`, MAX_INTENTOS, VENTANA_SEGUNDOS)) {
    return new Response(
      JSON.stringify({ detail: "Demasiados intentos. Espera un momento e inténtalo de nuevo." }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": String(VENTANA_SEGUNDOS) } },
    );
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ detail: "JSON inválido" }, 400);
  }

  const nueva = payload.password_nuevo ?? "";
  if (nueva.length < 8 || nueva.length > 128) {
    return jsonResponse({ detail: "La contraseña debe tener entre 8 y 128 caracteres" }, 422);
  }

  // ---- Resolver de quién es la cuenta -------------------------------------
  let usuario: UserAuthRow | null = null;
  let viaWebToken = false;

  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const secretKey = Deno.env.get("SECRET_KEY") ?? "";
    const autenticado = await getCurrentUser(authHeader, supabase, secretKey);
    if (autenticado) usuario = await getUserAuth(supabase, autenticado.id);
  } else if (payload.web_token) {
    usuario = await getUserAuthByWebToken(supabase, payload.web_token);
    viaWebToken = true;
  }

  if (!usuario) {
    return jsonResponse({ detail: "No autenticado" }, 401);
  }

  // ---- Autorizar el cambio -------------------------------------------------
  if (usuario.hashed_password) {
    // La cuenta ya tiene contraseña: el web_token deja de ser suficiente.
    if (viaWebToken) {
      return jsonResponse(
        { detail: "Esta cuenta ya tiene contraseña. Inicia sesión para cambiarla." },
        403,
      );
    }
    const actual = payload.password_actual ?? "";
    if (!verifyPassword(actual, usuario.hashed_password)) {
      console.warn(`Contraseña actual incorrecta al cambiarla (usuario ${usuario.id})`);
      return jsonResponse({ detail: "La contraseña actual no es correcta" }, 401);
    }
  }

  const guardada = await setUserPassword(supabase, usuario.id, hashPassword(nueva));
  if (!guardada) {
    return jsonResponse({ detail: "No se pudo guardar la contraseña" }, 500);
  }

  return jsonResponse({
    message: usuario.hashed_password
      ? "Contraseña actualizada"
      : "Contraseña establecida. Ya puedes iniciar sesión.",
  }, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "POST") return handlePost(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
