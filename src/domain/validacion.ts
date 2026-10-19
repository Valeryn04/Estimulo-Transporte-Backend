/**
 * Reglas de la validación de requisitos (RF-VAL-02): la lista de chequeo y la decisión motivada. Son funciones
 * puras: el servicio las aplica antes de guardar cualquier decisión.
 */

export const RESULTADOS = ['CUMPLE', 'NO_CUMPLE', 'PENDIENTE', 'NO_APLICA'] as const;
export type ResultadoRequisito = (typeof RESULTADOS)[number];

export const DECISIONES = ['APROBAR', 'SUBSANAR', 'RECHAZAR'] as const;
export type DecisionValidacion = (typeof DECISIONES)[number];

export const NOMBRE_RESULTADO: Record<ResultadoRequisito, string> = {
  CUMPLE: 'Cumple',
  NO_CUMPLE: 'No cumple',
  PENDIENTE: 'Pendiente',
  NO_APLICA: 'No aplica',
};

/** Un requisito de la lista de chequeo del caso, con su resultado. */
export interface ItemChequeo {
  id: number;
  nombre: string;
  resultado: ResultadoRequisito;
  fuente: string;
  observacion: string;
  evidencia: string;
  documentoId: number | null;
  campos: string[];
}

export interface ErrorDecision {
  campo: string;
  mensaje: string;
}

export interface ContextoDecision {
  /** Cuántas veces ya se pidió subsanación en este caso. */
  subsanacionesPrevias: number;
  /** Máximo de rondas de subsanación (parámetro). */
  maxRondas: number;
  /** El plazo de una subsanación anterior venció sin respuesta: se puede rechazar por falta de respuesta. */
  subsanacionVencida: boolean;
  /** Datos de priorización que el validador aún no registró. */
  variablesFaltantes: string[];
}

const lista = (items: { nombre: string }[]) => items.map((i) => `«${i.nombre}»`).join(', ');

/** Un requisito se puede corregir si se apoya en un documento o en datos de la caracterización. */
export const esSubsanable = (i: Pick<ItemChequeo, 'documentoId' | 'campos'>) =>
  i.documentoId !== null || i.campos.length > 0;

/**
 * Qué impide emitir la decisión (lista vacía = se puede):
 *  - Aprobar: ningún requisito en «no cumple» o «pendiente», cada resultado con su fuente, y los datos de priorización.
 *  - Subsanar: al menos un requisito por corregir, cada uno con su observación y algo que la persona pueda corregir.
 *  - Rechazar: con motivación clara y, salvo falta de respuesta a una subsanación, con requisitos que no se cumplen.
 */
export function erroresDeDecision(
  decision: DecisionValidacion,
  items: ItemChequeo[],
  motivacion: string,
  ctx: ContextoDecision,
): ErrorDecision[] {
  const e: ErrorDecision[] = [];
  const texto = motivacion.trim();
  const incumplen = items.filter((i) => i.resultado === 'NO_CUMPLE');
  const pendientes = items.filter((i) => i.resultado === 'PENDIENTE');

  if (decision === 'APROBAR') {
    if (incumplen.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `No se puede aprobar: hay requisitos que no cumple (${lista(incumplen)}).`,
      });
    }
    if (pendientes.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `No se puede aprobar: faltan por revisar ${lista(pendientes)}.`,
      });
    }
    const sinFuente = items.filter((i) => i.resultado === 'CUMPLE' && i.fuente.trim() === '');
    if (sinFuente.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `Indique la fuente consultada de: ${lista(sinFuente)}.`,
      });
    }
    const sinMotivo = items.filter(
      (i) => i.resultado === 'NO_APLICA' && i.observacion.trim() === '',
    );
    if (sinMotivo.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `Explique en la observación por qué no aplica: ${lista(sinMotivo)}.`,
      });
    }
    if (ctx.variablesFaltantes.length > 0) {
      e.push({
        campo: 'priorizacion',
        mensaje: `Falta registrar los datos de priorización: ${ctx.variablesFaltantes.join(', ')}.`,
      });
    }
    return e;
  }

  if (decision === 'SUBSANAR') {
    const porCorregir = [...incumplen, ...pendientes];
    if (porCorregir.length === 0) {
      e.push({
        campo: 'decision',
        mensaje:
          'Para pedir subsanación marque al menos un requisito como «no cumple» o «pendiente».',
      });
    }
    const sinObservacion = porCorregir.filter((i) => i.observacion.trim() === '');
    if (sinObservacion.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `Escriba qué debe corregir la persona en: ${lista(sinObservacion)}.`,
      });
    }
    const noSubsanables = porCorregir.filter((i) => !esSubsanable(i));
    if (noSubsanables.length > 0) {
      e.push({
        campo: 'decision',
        mensaje: `La persona no puede corregir ${lista(noSubsanables)} (no se apoya en un documento ni en datos del formulario): rechace la solicitud o márquelo como cumple.`,
      });
    }
    if (ctx.subsanacionesPrevias >= ctx.maxRondas) {
      e.push({
        campo: 'decision',
        mensaje: `Ya se agotó el máximo de ${ctx.maxRondas} ronda(s) de subsanación: apruebe o rechace la solicitud.`,
      });
    }
    if (texto.length < 5) {
      e.push({
        campo: 'motivacion',
        mensaje: 'Motivación: explique brevemente qué se debe corregir.',
      });
    }
    return e;
  }

  // RECHAZAR
  if (texto.length < 20) {
    e.push({
      campo: 'motivacion',
      mensaje:
        'Motivación: escriba con claridad por qué no se cumplen los requisitos (mínimo 20 caracteres).',
    });
  }
  if (incumplen.length === 0 && !ctx.subsanacionVencida) {
    e.push({
      campo: 'decision',
      mensaje:
        'Para rechazar, marque como «no cumple» los requisitos que no se cumplen (o rechace por falta de respuesta a una subsanación vencida).',
    });
  }
  return e;
}

/** Texto con lo que la persona debe corregir, tal como va en el correo y en la pantalla. */
export function textoItemsSubsanar(items: { nombre: string; observacion: string }[]): string {
  return items.map((i) => `- ${i.nombre}: ${i.observacion}`).join('\n');
}
