import re

# Leer archivos en orden
files = [
    "supabase/functions/_shared/parser.ts",
    "supabase/functions/_shared/validator.ts",
    "supabase/functions/_shared/classifier.ts",
    "supabase/functions/_shared/whatsapp.ts",
    "supabase/functions/_shared/users.ts",
    "supabase/functions/_shared/invoices.ts",
    "supabase/functions/whatsapp-webhook/index.ts",
]

output = ""

for file in files:
    with open(file, encoding='utf-8') as f:
        content = f.read()
    
    # Remover imports internos (ya están incluidos)
    content = re.sub(r'import.*from ["\']\.\./_shared/.*["\'];?\n', '', content)
    content = re.sub(r'export ', '', content)  # remover exports
    
    output += f"\n// ===== {file} =====\n"
    output += content

with open("whatsapp-webhook-bundled.ts", "w", encoding='utf-8') as f:
    f.write(output)

print("✓ whatsapp-webhook-bundled.ts generado")