/**
 * Parser de CFDI 4.0 → objeto plano (Fase M2).
 *
 * Port 1:1 de facturapp/facturapp/parser.py (Fase 1). Usa @libs/xml (JSR)
 * en vez de lxml. Mismo shape de salida, mismos casos de error.
 *
 * DIVERGENCIAS DECLARADAS respecto a la versión Python (ninguna silenciosa):
 *
 * 1. Resolución de namespaces por PREFIJO LITERAL, no por URI.
 *    lxml resuelve `cfdi:Emisor` vía la URI real del namespace
 *    (http://www.sat.gob.mx/cfd/4), sin importar qué prefijo use el
 *    documento (aceptaría <foo:Emisor xmlns:foo="...cfd/4">). Aquí se
 *    matchea literalmente contra los prefijos `cfdi:` y `tfd:` — que son
 *    los únicos que usa CUALQUIER PAC certificado del SAT en la práctica
 *    (son, de facto, un estándar fijo en todo el ecosistema CFDI). Resolver
 *    por URI real requeriría construir un mapa de prefijos a partir de los
 *    atributos `@xmlns:*` en cada nivel del árbol — complejidad adicional
 *    para un caso que no ocurre en la práctica real.
 *
 * 2. Los campos de texto opcionales (emisor_nombre, uso_cfdi, forma_pago,
 *    metodo_pago, clave_prod_principal, concepto_descripcion) son SIEMPRE
 *    `string` (cadena vacía `""` si faltan) — NUNCA `null`/`undefined`.
 *    Esto refleja el comportamiento REAL de parser.py (`emisor.get(...) or
 *    ""`), no la interfaz `string | null` propuesta inicialmente para esta
 *    fase, que no correspondía con lo que la versión Python realmente hace.
 */

import { parse as parseXml } from "@libs/xml/parse";

export class CFDIParseError extends Error {
  constructor(message: string, public detalle?: string) {
    super(message);
    this.name = "CFDIParseError";
  }
}

export interface ParsedInvoice {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  receptor_rfc: string;
  fecha_emision: string;
  subtotal: number;
  iva: number;
  total: number;
  uso_cfdi: string;
  forma_pago: string;
  metodo_pago: string;
  clave_prod_principal: string;
  concepto_descripcion: string;
  raw_xml: string;
}

// ---------------------------------------------------------------------
// Helpers de bajo nivel (equivalentes a los que ofrece lxml implícitamente)
// ---------------------------------------------------------------------

/** Nodo XML parseado por @libs/xml: attrs como "@Nombre", hijos anidados. */
type XmlNode = Record<string, unknown>;

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0.0;
  const n = Number(value);
  return Number.isNaN(n) ? 0.0 : n;
}

/** Normaliza un valor que puede venir como objeto único o array (cuando hay
 * varios hijos con el mismo nombre) a SIEMPRE un array — equivalente a
 * root.findall() en Python. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Toma el primer elemento si es array, o el objeto tal cual si no lo es —
 * equivalente a root.find() en Python (siempre el PRIMER match). */
function firstOf<T>(value: T | T[] | undefined): T | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function attr(node: XmlNode | undefined, name: string): string {
  if (!node) return "";
  const v = node[`@${name}`];
  return v === undefined || v === null ? "" : String(v);
}

// ---------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------

export function parseCfdi(contenido: Uint8Array | string): ParsedInvoice {
  const raw =
    typeof contenido === "string" ? contenido : new TextDecoder("utf-8").decode(contenido);

  let doc: XmlNode;
  try {
    doc = parseXml(raw) as unknown as XmlNode;
  } catch (exc) {
    throw new CFDIParseError(`XML mal formado: ${(exc as Error).message}`, String(exc));
  }

  // Busca la clave de nivel superior cuyo nombre local (después de ":")
  // sea "Comprobante" — equivalente a root.tag.endswith("}Comprobante").
  const rootKey = Object.keys(doc).find((k) => k.split(":").pop() === "Comprobante");
  const root = rootKey ? (doc[rootKey] as XmlNode) : undefined;

  if (!root) {
    throw new CFDIParseError("El nodo raíz no es cfdi:Comprobante");
  }

  const emisor = root["cfdi:Emisor"] as XmlNode | undefined;
  const receptor = root["cfdi:Receptor"] as XmlNode | undefined;
  const conceptos = root["cfdi:Conceptos"] as XmlNode | undefined;
  const concepto = firstOf(conceptos?.["cfdi:Concepto"] as XmlNode | XmlNode[] | undefined);
  const complemento = root["cfdi:Complemento"] as XmlNode | undefined;
  const tfd = complemento?.["tfd:TimbreFiscalDigital"] as XmlNode | undefined;

  if (!tfd) {
    throw new CFDIParseError("Falta el nodo TimbreFiscalDigital (no timbrado)");
  }

  const uuid = attr(tfd, "UUID");
  if (!uuid) {
    throw new CFDIParseError("El TimbreFiscalDigital no contiene UUID");
  }

  if (!emisor || !receptor) {
    throw new CFDIParseError("Faltan nodos Emisor o Receptor");
  }

  // IVA = suma de traslados a nivel comprobante (NO los de dentro de
  // Conceptos/Concepto — mismo alcance que root.findall(...) en Python).
  const impuestos = root["cfdi:Impuestos"] as XmlNode | undefined;
  const traslados = impuestos?.["cfdi:Traslados"] as XmlNode | undefined;
  const trasladoList = asArray(traslados?.["cfdi:Traslado"] as XmlNode | XmlNode[] | undefined);
  let iva = 0.0;
  for (const traslado of trasladoList) {
    iva += toFloat(traslado[`@Importe`]);
  }

  const fecha = attr(root, "Fecha");
  const fechaEmision = fecha ? fecha.split("T")[0] : "";

  return {
    uuid: uuid.toUpperCase(),
    emisor_rfc: attr(emisor, "Rfc").toUpperCase(),
    emisor_nombre: attr(emisor, "Nombre"),
    receptor_rfc: attr(receptor, "Rfc").toUpperCase(),
    fecha_emision: fechaEmision,
    subtotal: toFloat(root["@SubTotal"]),
    iva: Math.round(iva * 100) / 100,
    total: toFloat(root["@Total"]),
    uso_cfdi: attr(receptor, "UsoCFDI"),
    forma_pago: attr(root, "FormaPago"),
    metodo_pago: attr(root, "MetodoPago"),
    clave_prod_principal: attr(concepto, "ClaveProdServ"),
    concepto_descripcion: attr(concepto, "Descripcion"),
    raw_xml: raw,
  };
}
