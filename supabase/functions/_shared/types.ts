// Fase M1 — Interfaces TS que reflejan el esquema `facturapp` (Postgres).
// Solo tipos, sin lógica — la lógica real de negocio llega en Fases M2-M5.

export interface User {
  id: number;
  email: string;
  nombre: string;
  rfc: string;
  whatsapp_phone: string | null;
  web_token: string;
}

export interface Invoice {
  id: number;
  user_id: number;
  uuid_fiscal: string;
  usuario_rfc: string;
  emisor_rfc: string;
  emisor_nombre: string | null;
  receptor_rfc: string;
  fecha_emision: string;
  anio: number;
  subtotal: number;
  iva: number;
  total: number;
  uso_cfdi: string | null;
  forma_pago: string | null;
  metodo_pago: string | null;
  clave_prod_principal: string | null;
  concepto_descripcion: string | null;
  categoria: string | null;
  confianza: number | null;
  estatus: string;
  hallazgos: unknown; // JSONB
  raw_xml: string | null;
}

export interface ChatMessage {
  id: number;
  user_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}
