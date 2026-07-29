import re

# Leer archivos en orden (dependencias antes de quien las usa).
#
# CORREGIDO respecto a la versión original de este script:
# 1. Faltaban cors.ts y accounts.ts en la lista -- corsHeaders y
#    placeholderRfc quedaban indefinidos en el bundle generado.
# 2. El regex de imports solo quitaba "../_shared/..." (como los ve
#    index.ts, en el directorio vecino) -- los shared modules se importan
#    entre sí con "./..." (mismo directorio), que NUNCA se filtraba. El
#    bundle anterior tenía líneas `import ... from "./classifier.ts"` etc.
#    colgando, apuntando a archivos que no existen relativo al bundle.
# 3. Se agregan whatsapp_commands.ts, debug_log.ts y chat.ts (Fase M4b/M5.5)
#    -- el bundle anterior es de antes de esas fases y no tiene el chat
#    conversacional de WhatsApp en absoluto.
#
# NOTA: chat.ts importa `AuthenticatedUser` (solo como tipo) desde
# "./auth.ts", que NO se incluye aquí (solo lo usa api-chat, no el webhook
# de WhatsApp). Esa importación se filtra igual que las demás -- el nombre
# de tipo queda sin resolver, pero al ser un `import type` se borra por
# completo al transpilar (Deno no lo necesita en runtime). Esto es
# aceptable para un bundle de un solo archivo pensado para deploy, no para
# `deno check` (que de todas formas no incluye este archivo en su glob).
files = [
    "supabase/functions/_shared/cors.ts",
    "supabase/functions/_shared/accounts.ts",
    "supabase/functions/_shared/parser.ts",
    "supabase/functions/_shared/validator.ts",
    "supabase/functions/_shared/classifier.ts",
    "supabase/functions/_shared/whatsapp.ts",
    "supabase/functions/_shared/whatsapp_commands.ts",
    "supabase/functions/_shared/users.ts",
    "supabase/functions/_shared/invoices.ts",
    "supabase/functions/_shared/debug_log.ts",
    "supabase/functions/_shared/chat.ts",
    "supabase/functions/whatsapp-webhook/index.ts",
]

# Los archivos fuente usan especificadores "bare" (@libs/xml, openai, etc.)
# que solo resuelven vía el import map de supabase/deno.json. El bundle
# vive fuera de ese directorio, así que hay que reescribirlos a su forma
# explícita jsr:/npm: -- el mismo patrón que index.ts ya usa para
# @supabase/supabase-js.
BARE_TO_EXPLICIT = {
    "@libs/xml/parse": "jsr:@libs/xml@8/parse",
    "@supabase/supabase-js": "jsr:@supabase/supabase-js@2",
    "openai": "npm:openai@4",
}

output = ""
seen_import_lines: set[str] = set()

for file in files:
    with open(file, encoding='utf-8') as f:
        content = f.read()

    # Remover imports internos (relativos, "./..." o "../_shared/..." --
    # ya están incluidos en el bundle por los otros archivos de la lista).
    # Se captura CADA import statement completo (single o multilínea, no
    # greedy) y solo se descarta si su especificador es relativo -- así no
    # se traga por error un import externo (jsr:/npm:/https:) que quede
    # en medio de dos imports relativos. Los externos que sobreviven se
    # reescriben a su forma jsr:/npm: explícita.
    def _rewrite_import(match: "re.Match") -> str:
        specifier = match.group(1)
        if specifier.startswith("./") or specifier.startswith("../"):
            return ""
        explicit = BARE_TO_EXPLICIT.get(specifier, specifier)
        line = match.group(0).replace(f'"{specifier}"', f'"{explicit}"').replace(f"'{specifier}'", f"'{explicit}'")
        # Cada shared module repite sus propios imports externos (p.ej.
        # `import type { SupabaseClient } from ...` aparece en 4 archivos
        # distintos) -- en el bundle final quedan todos en el mismo scope,
        # así que solo se conserva la primera aparición de cada línea.
        if line in seen_import_lines:
            return ""
        seen_import_lines.add(line)
        return line

    content = re.sub(
        r'import\s[\s\S]*?from\s+["\']([^"\']+)["\'];?\n',
        _rewrite_import,
        content,
    )
    content = re.sub(r'export ', '', content)  # remover exports

    output += f"\n// ===== {file} =====\n"
    output += content

# chat.ts usa `AuthenticatedUser` (tipo importado de auth.ts, que NO se
# incluye aquí -- solo lo usa api-chat, no el webhook de WhatsApp). Misma
# forma que AppUser (definido en users.ts, sí incluido) -- se alias para
# que el bundle type-checkee limpio de forma standalone.
output += "\ntype AuthenticatedUser = AppUser;\n"

with open("whatsapp-webhook-bundled.ts", "w", encoding='utf-8') as f:
    f.write(output)

print("OK: whatsapp-webhook-bundled.ts generado")