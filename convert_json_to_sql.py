import json

with open('production_users.json') as f:
    users = json.load(f)

print("-- USERS")
for user in users:
    print(f"INSERT INTO facturapp.users (email, nombre, rfc, web_token) VALUES ('{user['email']}', '{user['nombre']}', '{user['rfc']}', '{user['web_token']}') ON CONFLICT DO NOTHING;")

with open('production_invoices.json') as f:
    invoices = json.load(f)

if invoices:
    print("\n-- INVOICES")
    for inv in invoices:
        print(f"INSERT INTO facturapp.invoices (user_id, uuid_fiscal) VALUES ({inv['user_id']}, '{inv['uuid_fiscal']}') ON CONFLICT DO NOTHING;")
else:
    print("\n-- No invoices")

with open('production_chat_messages.json') as f:
    chats = json.load(f)

if chats:
    print("\n-- CHAT")
    for chat in chats:
        print(f"INSERT INTO facturapp.chat_messages (user_id, role) VALUES ({chat['user_id']}, '{chat['role']}') ON CONFLICT DO NOTHING;")
else:
    print("\n-- No chats")