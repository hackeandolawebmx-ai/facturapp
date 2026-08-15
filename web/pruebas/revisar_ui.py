#!/usr/bin/env python3
"""Revisión visual de las pantallas de Facturino en varios anchos.

POR QUÉ EXISTE: los defectos de maquetación no se ven leyendo CSS. Los dos
peores que se han encontrado en este proyecto --el botón "Quitar" invisible en
Contribuyentes y el scroll horizontal en toda la app en móvil-- eran
FUNCIONALES, no cosméticos, y ninguno de los dos era evidente en el código:
salieron de renderizar las páginas y medirlas.

QUÉ COMPRUEBA, automáticamente (sin que nadie mire las capturas):
  1. Desbordamiento horizontal -- que ninguna página sea más ancha que su
     viewport. En un teléfono eso significa que toda la app se arrastra de
     lado.
  2. Filas huérfanas en las rejillas -- 8 tarjetas cayendo 7+1 se lee como un
     error de maquetación.
  3. Tablas más anchas que su contenedor -- es lo que deja botones fuera del
     área visible.
Además guarda una captura de cada pantalla por si se quiere comparar a ojo.

CÓMO SE USA:
    pip install playwright && python -m playwright install chromium
    cd web && python -m http.server 8899 &      # sirve los archivos locales
    python pruebas/revisar_ui.py

    # o contra producción:
    BASE=https://app.facturino.mx python pruebas/revisar_ui.py

Sale con código 1 si encuentra algún problema, para poder encadenarlo en CI.

NOTA SOBRE LOS DATOS: no se crea ninguna cuenta de prueba. `datos_falsos.js`
intercepta `fetch` y responde con datos inventados, así que corre el MISMO
código de render que producción sin tocar la base ni ensuciar las métricas.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

AQUI = pathlib.Path(__file__).parent
BASE = os.environ.get("BASE", "http://127.0.0.1:8899").rstrip("/")
SALIDA = AQUI / "capturas"

# 390 = teléfono actual; 768 = tablet; 1366 = la laptop más común;
# 1920 = monitor externo. Los cuatro han destapado defectos distintos.
ANCHOS = [("movil", 390, 844), ("tablet", 768, 1024),
          ("laptop", 1366, 768), ("ancho", 1920, 1080)]

# Rejillas que deben terminar en filas completas.
REJILLAS = [("dashboard.html", "ayuda", ".tarjetas-ayuda"),
            ("admin.html", None, ".rejilla-metricas"),
            ("admin.html", None, ".desgloses")]

JS_DESBORDE = """() => ({
  doc: document.documentElement.scrollWidth,
  vista: window.innerWidth,
  culpables: [...document.querySelectorAll('*')].filter(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return false;
    if (r.right <= document.documentElement.clientWidth + 1 && r.left >= -1) return false;
    // Solo el más profundo: si un padre desborda por culpa de un hijo,
    // reportar ambos no dice cuál hay que arreglar.
    return ![...el.children].some(c => {
      const cr = c.getBoundingClientRect();
      return cr.right > document.documentElement.clientWidth + 1 || cr.left < -1;
    });
  }).slice(0, 4).map(el => el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).join('.') : ''))
})"""

# Solo se evalúa a partir de ANCHO_MIN_TABLAS. Por debajo, que una tabla sea
# más ancha que su tarjeta y haga scroll interno es el diseño buscado (ver
# .archivo{overflow-x:auto}): 9 columnas en 390px serían ilegibles. Lo que NO
# se vale es que no quepa a los anchos donde sí está pensada para caber --
# ahí una columna de más significa botones que el usuario no ve.
ANCHO_MIN_TABLAS = 1366

JS_TABLAS = """() => [...document.querySelectorAll('.archivo, .tabla-rfcs-wrap')]
  .filter(c => c.offsetParent !== null)
  .map(c => {
    const t = c.querySelector('table');
    if (!t) return null;
    return {sobra: Math.round(t.scrollWidth - c.clientWidth),
            donde: c.className.trim().split(/\\s+/)[0]};
  }).filter(Boolean).filter(x => x.sobra > 1)"""

JS_REJILLA = """(sel) => {
  const g = document.querySelector(sel);
  if (!g) return null;
  const filas = {};
  [...g.children].filter(c => c.getBoundingClientRect().width > 0)
    .forEach(c => { const t = Math.round(c.getBoundingClientRect().top);
                    filas[t] = (filas[t] || 0) + 1; });
  return Object.values(filas);
}"""

PANTALLAS = [("resumen", "02-resumen"), ("facturas", "03-facturas"),
             ("contribuyentes", "04-contribuyentes"), ("ayuda", "05-ayuda")]


def revisar(pg, nombre, etiqueta, ancho, fallos):
    """Mide la pantalla actual y anota los problemas encontrados."""
    SALIDA.mkdir(exist_ok=True)
    pg.screenshot(path=str(SALIDA / f"{nombre}-{etiqueta}.png"), full_page=True)

    d = pg.evaluate(JS_DESBORDE)
    if d["doc"] > d["vista"] + 1:
        fallos.append(f"{nombre} @{etiqueta}: la pagina desborda "
                      f"({d['doc']}px en {d['vista']}px) -> {', '.join(d['culpables'])}")

    if ancho >= ANCHO_MIN_TABLAS:
        for t in pg.evaluate(JS_TABLAS):
            fallos.append(f"{nombre} @{etiqueta}: la tabla de '{t['donde']}' se sale "
                          f"{t['sobra']}px de su contenedor "
                          f"(su ultima columna queda fuera de la vista)")


def main():
    fallos = []
    with sync_playwright() as p:
        navegador = p.chromium.launch(headless=True)
        stub = (AQUI / "datos_falsos.js").read_text(encoding="utf-8")

        for etiqueta, w, h in ANCHOS:
            print(f"== {etiqueta} ({w}x{h}) ==")
            ctx = navegador.new_context(viewport={"width": w, "height": h})
            ctx.add_init_script(stub)
            pg = ctx.new_page()

            # Pantalla de acceso: sin sesion.
            sin_sesion = ctx.new_page()
            sin_sesion.add_init_script("sessionStorage.removeItem('facturapp_token')")
            sin_sesion.goto(f"{BASE}/dashboard.html", wait_until="networkidle")
            sin_sesion.wait_for_timeout(600)
            revisar(sin_sesion, "01-acceso", etiqueta, w, fallos)
            sin_sesion.close()

            pg.goto(f"{BASE}/dashboard.html", wait_until="networkidle")
            pg.wait_for_timeout(1200)   # deja que se retire el velo de carga
            for tab, nombre in PANTALLAS:
                pg.click(f'.tab[data-tab="{tab}"]')
                pg.wait_for_timeout(450)
                revisar(pg, nombre, etiqueta, w, fallos)

            pg.goto(f"{BASE}/admin.html", wait_until="networkidle")
            pg.wait_for_timeout(1200)
            revisar(pg, "06-admin", etiqueta, w, fallos)
            pg.click(".fila-cuenta")
            pg.wait_for_timeout(600)
            # full_page con position:fixed deja el panel donde estaba en el
            # viewport, asi que este se captura sin full_page.
            pg.screenshot(path=str(SALIDA / f"07-admin-detalle-{etiqueta}.png"))
            ctx.close()

        # Rejillas: solo tiene sentido a partir de tablet.
        for etiqueta, w, h in ANCHOS:
            if w < 768:
                continue
            ctx = navegador.new_context(viewport={"width": w, "height": h})
            ctx.add_init_script(stub)
            pg = ctx.new_page()
            for pagina, tab, sel in REJILLAS:
                pg.goto(f"{BASE}/{pagina}", wait_until="networkidle")
                pg.wait_for_timeout(1200)
                if tab:
                    pg.click(f'.tab[data-tab="{tab}"]')
                    pg.wait_for_timeout(400)
                filas = pg.evaluate(JS_REJILLA, sel)
                if filas and len(filas) > 1 and filas[-1] < filas[0]:
                    fallos.append(f"{sel} @{etiqueta}: fila final incompleta "
                                  f"{filas} (queda un elemento huerfano)")
            ctx.close()
        navegador.close()

    print()
    if fallos:
        print(f"{len(fallos)} problema(s):")
        for f in fallos:
            print(f"  - {f}")
        return 1
    print(f"Sin problemas. Capturas en {SALIDA}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
