# Dashboard web de FacturasMX

`dashboard.html` es la interfaz web: un único archivo estático, sin build ni
dependencias. Se autentica contra las Edge Functions de Supabase (login con
JWT) y muestra la cédula de deducciones, el archivo de facturas y el
formulario para capturar el RFC.

## Por qué NO vive en una Edge Function

Se intentó servirlo desde `supabase/functions/dashboard/` y **la plataforma
no lo permite**. Supabase reescribe el `Content-Type` de las respuestas de
Edge Functions cuando el navegador las renderizaría como HTML, así que la
página llegaba como texto plano y el usuario veía el código fuente.

Comprobado explícitamente (mismo endpoint, distinto `Content-Type`):

| Pedido | Devuelto |
|---|---|
| `text/html` | `text/plain` |
| `text/html; charset=utf-8` | `text/plain` |
| `application/xhtml+xml` | `text/plain` |
| `application/json` | `application/json` |
| `text/css` | `text/css` |

Solo se bloquean los tipos que producen renderizado de HTML, lo que apunta a
una medida anti-phishing: servir páginas arbitrarias desde un dominio
`*.supabase.co` permitiría montar suplantaciones con apariencia legítima. No
es un límite que se pueda rodear, y la restricción tiene sentido.

Como efecto secundario, la arquitectura queda mejor: frontend estático en un
CDN, API en Supabase.

## Configuración

Una sola línea, al inicio del `<script>`:

```js
var API = "https://<project-ref>.supabase.co/functions/v1";
```

## Publicarlo

Cualquier hosting estático sirve. Es un archivo sin build.

**Cloudflare Pages** (gratis, sin tarjeta): crear un proyecto, subir la
carpeta `web/`, listo. Admite dominio propio.

**Netlify / Vercel** (gratis): arrastrar la carpeta, o conectar el
repositorio apuntando a `web/` como directorio de publicación.

**Tu propio hosting**: subir `dashboard.html` por FTP y abrirlo. No necesita
nada del lado del servidor.

**Probarlo en local** — ojo, `file://` no sirve: el navegador bloquea las
peticiones por CORS desde ese esquema. Hace falta un servidor:

```bash
cd web && python -m http.server 8080
# luego abrir http://localhost:8080/dashboard.html
```

## CORS

Las Edge Functions responden `Access-Control-Allow-Origin: *`, así que el
dashboard funciona desde cualquier origen sin configuración adicional.

`Access-Control-Allow-Methods` incluye `PATCH` a propósito: guardar el RFC
usa ese método, que **siempre** exige preflight. Sin declararlo, el navegador
rechaza la petición aunque el servidor la aceptaría — y el fallo se ve solo
en la consola del navegador, no en los logs del servidor.

## Qué hace y qué no

Hace: login, cédula por categoría, tabla de facturas con filtros (mes,
categoría, estatus) y búsqueda por emisor/RFC/folio, y captura del RFC.

No hace: subir facturas, reclasificar, ni exportar. Los botones de exportar
del diseño original se retiraron porque `export_package` es un stub que
devuelve `{status: "mock_fase4"}` — un botón que no exporta nada es peor que
no tenerlo.

## Nota sobre el diseño original

El template de Python (`facturapp/templates/dashboard.html`) traía cifras
escritas a mano —un total de $61,535, "12 facturas" por categoría, una barra
de "34% de $198,031", filas de farmacias inventadas— que el JavaScript
sustituía al cargar. Si el `fetch` fallaba, el `catch` solo cambiaba una
leyenda y el usuario se quedaba viendo **cantidades fiscales fabricadas con
aspecto de reales**. Aquí no se renderiza ninguna cifra que no venga de la
base de datos.
