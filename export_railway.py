import json

def convert_users(json_file):
    """Convierte users.json a INSERT statements"""
    with open(json_file) as f:
        users = json.load(f)
    
    for user in users:
        email = user['email'].replace("'", "''")
        nombre = user['nombre'].replace("'", "''")
        rfc = user['rfc'].replace("'", "''")
        web_token = user['web_token'].replace("'", "''")
        hashed_pwd = user.get('hashed_password', '').replace("'", "''") if user.get('hashed_password') else 'NULL'
        whatsapp = f"'{user['whatsapp_phone'].replace(chr(39), chr(39)*2)}'" if user.get('whatsapp_phone') else 'NULL'
        
        sql = f"INSERT INTO facturapp.users (email, nombre, rfc, hashed_password, web_token, whatsapp_phone, created_at) VALUES ('{email}', '{nombre}', '{rfc}', '{hashed_pwd}', '{web_token}', {whatsapp}, now()) ON CONFLICT (email) DO NOTHING;"
        print(sql)

def convert_invoices(json_file):
    """Convierte invoices.json a INSERT statements"""
    with open(json_file) as f:
        invoices = json.load(f)
    
    if not invoices:
        print("-- No invoices to insert")
        return
    
    for inv in invoices:
        hallazgos_json = json.dumps(inv.get('hallazgos', {})).replace("'", "''") if inv.get('hallazgos') else 'null'
        raw_xml = inv.get('raw_xml', '').replace("'", "''") if inv.get('raw_xml') else 'null'
        
        sql = f"INSERT INTO facturapp.invoices (user_id, uuid_fiscal, usuario_rfc, emisor_rfc, emisor_nombre, receptor_rfc, fecha_emision, anio, subtotal, iva, total, uso_cfdi, forma_pago, metodo_pago, clave_prod_principal, concepto_descripcion, categoria, confianza, estatus, hallazgos, raw_xml, created_at) VALUES ({inv['user_id']}, '{inv['uuid_fiscal']}', '{inv['usuario_rfc']}', '{inv['emisor_rfc']}', '{inv.get('emisor_nombre', '').replace(chr(39), chr(39)*2)}', '{inv['receptor_rfc']}', '{inv['fecha_emision']}', {inv['anio']}, {inv.get('subtotal', 0)}, {inv.get('iva', 0)}, {inv.get('total', 0)}, '{inv.get('uso_cfdi', '')}', '{inv.get('forma_pago', '')}', '{inv.get('metodo_pago', '')}', '{inv.get('clave_prod_principal', '')}', '{inv.get('concepto_descripcion', '').replace(chr(39), chr(39)*2)}', '{inv.get('categoria', '')}', {inv.get('confianza', 0)}, '{inv['estatus']}', '{hallazgos_json}'::jsonb, '{raw_xml}', now()) ON CONFLICT (id) DO NOTHING;"
        print(sql)

def convert_chat(json_file):
    """Convierte chat_messages.json a INSERT statements"""
    with open(json_file) as f:
        chats = json.load(f)
    
    if not chats:
        print("-- No chat messages to insert")
        return
    
    for chat in chats:
        content = chat['content'].replace("'", "''")
        sql = f"INSERT INTO facturapp.chat_messages (user_id, role, content, created_at) VALUES ({chat['user_id']}, '{chat['role']}', '{content}', now()) ON CONFLICT (id) DO NOTHING;"
        print(sql)

if __name__ == "__main__":
    print("-- ===== USERS =====")
    convert_users("production_users.json")
    print("\n-- ===== INVOICES =====")
    convert_invoices("production_invoices.json")
    print("\n-- ===== CHAT MESSAGES =====")
    convert_chat("production_chat_messages.json")