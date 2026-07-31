/**
 * Motor de validación — 5 reglas CFDI para deducciones (Fase M3).
 *
 * Port 1:1 de facturapp/facturapp/validator.py.
 *
 * NOTA sobre "7 reglas": el sistema completo tiene 7 códigos de hallazgo,
 * pero solo 5 viven dentro del motor de validación — las otras 2
 * (XML_MAL_FORMADO, PDF_SIN_XML) ocurren antes/fuera de este módulo (en el
 * parser y en el handler del webhook, respectivamente). Igual que en
 * Python: ValidationEngine.validate() solo corre 5 reglas.
 *
 * DIVERGENCIAS DECLARADAS respecto al spec original de esta fase:
 * 1. `hallazgos` es `Hallazgo[]` (objetos {codigo, severidad, mensaje}),
 *    NO `string[]`. El campo `mensaje` es lo que el usuario final lee en
 *    las respuestas de los webhooks — perderlo habría sido una regresión.
 * 2. `validate()` NO es async — no hay ninguna operación asíncrona real
 *    (Python tampoco la tiene). UUID_DUPLICADO sigue recibiendo el set de
 *    UUIDs ya resuelto como dato plano, igual que en Python — quien llame
 *    a esto (el webhook handler, en M4) resuelve la consulta a BD antes.
 */

import { classifyInvoice, type ClassificationResult } from "./classifier.ts";
import type { ParsedInvoice } from "./parser.ts";

export const SEV_VALIDA = "valida";
export const SEV_ADVERTENCIA = "advertencia";
export const SEV_POR_REVISAR = "por_revisar";
export const SEV_RECHAZADA = "rechazada";

export type Severidad =
  | typeof SEV_VALIDA
  | typeof SEV_ADVERTENCIA
  | typeof SEV_POR_REVISAR
  | typeof SEV_RECHAZADA;

const PRIORIDAD: Record<Severidad, number> = {
  [SEV_VALIDA]: 0,
  [SEV_POR_REVISAR]: 1,
  [SEV_ADVERTENCIA]: 2,
  [SEV_RECHAZADA]: 3,
};

// Categorías donde el SAT exige pago electrónico.
const CATEGORIAS_PAGO_ELECTRONICO = new Set(["Médicos", "Colegiaturas", "Seguros GMM"]);
// Usos de CFDI genéricos que no permiten deducir.
const USOS_GENERICOS = new Set(["G03", "S01"]);
// Prefijos de ClaveProdServ que "parecen deducibles".
const PREFIJOS_DEDUCIBLES = ["62", "84", "51", "23", "85"];
// Palabras que evidencian un emisor del ramo médico.
const KEYWORDS_MEDICO = [
  "medic", "médic", "doctor", "dr.", "dra.", "dental", "dentista",
  "psic", "hospital", "clinic", "clínic", "consultorio", "salud",
];

export interface Hallazgo {
  codigo: string;
  severidad: Severidad;
  mensaje: string;
}

export interface ValidationResult {
  status: Severidad;
  categoria: string;
  hallazgos: Hallazgo[];
}

/** Los tests de Python (y los de acá) usan tanto ParsedInvoice completos
 * como dicts/objetos sueltos con solo algunos campos — igual que Python,
 * que recibe cualquier dict. Por eso Partial, no ParsedInvoice a secas. */
export type InvoiceLike = Partial<ParsedInvoice>;

interface ValidateContext {
  fechaPrevia?: string | null;
}

export class ValidationEngine {
  private userRfc: string;
  private existingUuids: Set<string>;
  private classify: (inv: InvoiceLike) => ClassificationResult;

  constructor(
    userRfc: string,
    existingUuids: string[] = [],
    classify: (inv: InvoiceLike) => ClassificationResult = classifyInvoice,
  ) {
    this.userRfc = userRfc.toUpperCase();
    this.existingUuids = new Set(existingUuids.map((u) => u.toUpperCase()));
    this.classify = classify;
  }

  // ---- Reglas individuales ------------------------------------------------

  private reglaUuidDuplicado(inv: InvoiceLike, ctx: ValidateContext): Hallazgo | null {
    if (this.existingUuids.has((inv.uuid ?? "").toUpperCase())) {
      const fecha = ctx.fechaPrevia || inv.fecha_emision || "";
      return {
        codigo: "UUID_DUPLICADO",
        severidad: SEV_RECHAZADA,
        mensaje: `Ya tenías registrada esta factura (recibida el ${fecha})`,
      };
    }
    return null;
  }

  private reglaRfcAjeno(inv: InvoiceLike): Hallazgo | null {
    if ((inv.receptor_rfc ?? "").toUpperCase() !== this.userRfc) {
      return {
        codigo: "RFC_AJENO",
        severidad: SEV_ADVERTENCIA,
        mensaje: `Factura emitida a RFC ${inv.receptor_rfc ?? ""}; no será deducible`,
      };
    }
    return null;
  }

  private reglaPagoEfectivo(inv: InvoiceLike, categoria: string): Hallazgo | null {
    if (inv.forma_pago === "01" && CATEGORIAS_PAGO_ELECTRONICO.has(categoria)) {
      return {
        codigo: "PAGO_EFECTIVO",
        severidad: SEV_ADVERTENCIA,
        mensaje:
          "Pagada en efectivo: SAT no acepta como deducible. Pide refacturación con pago electrónico",
      };
    }
    return null;
  }

  private reglaUsoCfdiIncorrecto(inv: InvoiceLike): Hallazgo | null {
    const clave = inv.clave_prod_principal ?? "";
    const pareceDeducible = PREFIJOS_DEDUCIBLES.some((p) => clave.startsWith(p));
    if (inv.uso_cfdi !== undefined && USOS_GENERICOS.has(inv.uso_cfdi) && pareceDeducible) {
      return {
        codigo: "USO_CFDI_INCORRECTO",
        severidad: SEV_ADVERTENCIA,
        mensaje: "Uso de CFDI incorrecto (esperado D02); pide corrección al emisor",
      };
    }
    return null;
  }

  private reglaEmisorSinEspecialidad(inv: InvoiceLike, categoria: string): Hallazgo | null {
    if (categoria === "Médicos") {
      const nombre = (inv.emisor_nombre ?? "").toLowerCase();
      if (!KEYWORDS_MEDICO.some((k) => nombre.includes(k))) {
        return {
          codigo: "EMISOR_SIN_ESPECIALIDAD",
          severidad: SEV_POR_REVISAR,
          mensaje: "El SAT exige que el emisor sea profesional colegiado; verifica que tenga cédula",
        };
      }
    }
    return null;
  }

  // ---- Orquestación --------------------------------------------------------

  validate(invoice: InvoiceLike, fechaPrevia: string | null = null): ValidationResult {
    const { categoria } = this.classify(invoice);
    const ctx: ValidateContext = { fechaPrevia };

    const checks: Array<() => Hallazgo | null> = [
      () => this.reglaUuidDuplicado(invoice, ctx),
      () => this.reglaRfcAjeno(invoice),
      () => this.reglaPagoEfectivo(invoice, categoria),
      () => this.reglaUsoCfdiIncorrecto(invoice),
      () => this.reglaEmisorSinEspecialidad(invoice, categoria),
    ];

    const hallazgos: Hallazgo[] = [];
    for (const check of checks) {
      const h = check();
      if (h) hallazgos.push(h);
    }

    return { status: estatusDeHallazgos(hallazgos), categoria, hallazgos };
  }
}

/** El estatus es la severidad más alta entre los hallazgos. */
export function estatusDeHallazgos(hallazgos: Hallazgo[]): Severidad {
  let status: Severidad = SEV_VALIDA;
  for (const h of hallazgos) {
    if (PRIORIDAD[h.severidad] > PRIORIDAD[status]) status = h.severidad;
  }
  return status;
}

/**
 * Recalcula el hallazgo RFC_AJENO de una factura ya guardada, tras un cambio
 * del RFC del usuario (Fase M11).
 *
 * POR QUÉ HACE FALTA: los hallazgos se evalúan al ingerir y no se recalculan.
 * Como las cuentas creadas por WhatsApp o correo nacen con un RFC sintético
 * (`PEND...`), toda su facturación se guarda marcada `RFC_AJENO`. Al capturar
 * por fin el RFC real, esas advertencias no solo quedaban obsoletas: pasaban
 * a ser autocontradictorias en pantalla — "Factura emitida a RFC X; no será
 * deducible" junto a un encabezado que muestra ese mismo X como el RFC del
 * usuario. Es información falsa sobre deducibilidad, que es precisamente lo
 * que el producto promete acertar.
 *
 * Solo se toca RFC_AJENO. Los demás hallazgos (pago en efectivo, uso de CFDI,
 * emisor sin especialidad) no dependen del RFC del usuario, así que
 * recalcularlos aquí sería reinventar el validador con datos incompletos: la
 * factura guardada no conserva todo lo que necesitan sus reglas.
 *
 * Función pura: recibe y devuelve datos, sin tocar la base.
 */
export function revalidarRfcAjeno(
  hallazgos: Hallazgo[],
  receptorRfc: string,
  rfcUsuario: string,
): { hallazgos: Hallazgo[]; estatus: Severidad } {
  const coincide = (receptorRfc ?? "").toUpperCase() === rfcUsuario.toUpperCase();
  const otros = hallazgos.filter((h) => h.codigo !== "RFC_AJENO");

  const actualizados: Hallazgo[] = coincide ? otros : [
    ...otros,
    {
      codigo: "RFC_AJENO",
      severidad: SEV_ADVERTENCIA,
      mensaje: `Factura emitida a RFC ${receptorRfc ?? ""}; no será deducible`,
    },
  ];

  return { hallazgos: actualizados, estatus: estatusDeHallazgos(actualizados) };
}
