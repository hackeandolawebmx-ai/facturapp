/**
 * Clasificador determinístico de facturas → categoría de deducción (Fase M3).
 *
 * Port 1:1 de facturapp/facturapp/classifier.py.
 *
 * DIVERGENCIA DECLARADA respecto al spec original de esta fase: NO existe
 * ninguna tabla `deduction_rules` en el sistema actual — classifier.py es
 * una lista de reglas EN MEMORIA, matcheando (uso_cfdi exacto + prefijo de
 * clave_prod_principal) combinados. El mismo prefijo puede mapear a
 * categorías distintas según el uso_cfdi (p. ej. "84" → Colegiaturas con
 * D02/D10, pero Seguros GMM con D07) — una tabla keyed solo por producto
 * no puede representar esto sin perder información. Se porta tal cual:
 * lista en memoria, no tabla Postgres.
 */

export const SIN_CLASIFICAR = "Sin clasificar";

interface Rule {
  usoCfdi: string;
  claveProdPrefix: string;
  categoria: string;
}

// Mismo orden que Python — el primer match gana.
const RULES: Rule[] = [
  { usoCfdi: "D02", claveProdPrefix: "62", categoria: "Médicos" },
  { usoCfdi: "D02", claveProdPrefix: "85", categoria: "Médicos" },
  { usoCfdi: "D01", claveProdPrefix: "62", categoria: "Médicos" },
  { usoCfdi: "D02", claveProdPrefix: "84", categoria: "Colegiaturas" },
  { usoCfdi: "D10", claveProdPrefix: "84", categoria: "Colegiaturas" },
  { usoCfdi: "D02", claveProdPrefix: "51", categoria: "Seguros GMM" },
  { usoCfdi: "D07", claveProdPrefix: "84", categoria: "Seguros GMM" },
  { usoCfdi: "D02", claveProdPrefix: "23", categoria: "Hipoteca" },
  { usoCfdi: "D05", claveProdPrefix: "23", categoria: "Hipoteca" },
];

export interface ClassificationResult {
  categoria: string;
  origen: "regla" | "ninguno";
  confianza: number;
}

interface ClassifiableInvoice {
  uso_cfdi?: string;
  clave_prod_principal?: string;
}

/** Devuelve (categoria, origen, confianza) — mismo shape que Classifier.classify()
 * en Python (ahí es una tupla; aquí un objeto, más explícito en TS). */
export function classifyInvoice(invoice: ClassifiableInvoice): ClassificationResult {
  const uso = invoice.uso_cfdi ?? "";
  const clave = invoice.clave_prod_principal ?? "";
  for (const rule of RULES) {
    if (uso === rule.usoCfdi && clave.startsWith(rule.claveProdPrefix)) {
      return { categoria: rule.categoria, origen: "regla", confianza: 0.95 };
    }
  }
  return { categoria: SIN_CLASIFICAR, origen: "ninguno", confianza: 0.0 };
}
