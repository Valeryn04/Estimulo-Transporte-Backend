/** Reglas de la asignación (RF-ASI-01..04): cupos, presupuesto, orden de prioridad y causas de no asignación. */

/** Casos que pueden recibir el beneficio: con puntaje y todavía sin asignar. */
export const ESTADOS_ASIGNABLES = ['PRIORIZADA', 'EN_LISTA_ESPERA'] as const;

export type MotivoNoAlcanza =
  | 'SIN_CUPO'
  | 'SIN_PRESUPUESTO'
  | 'SIN_CUPO_LOCALIDAD'
  | 'SIN_CUPO_TRANSPORTE'
  | 'PERSONA_CON_BENEFICIO';

export const TEXTO_MOTIVO: Record<MotivoNoAlcanza, string> = {
  SIN_CUPO: 'No quedan cupos disponibles',
  SIN_PRESUPUESTO: 'No alcanza el presupuesto disponible',
  SIN_CUPO_LOCALIDAD: 'No quedan cupos para su localidad',
  SIN_CUPO_TRANSPORTE: 'No quedan cupos para su tipo de transporte',
  PERSONA_CON_BENEFICIO: 'Alguna de las personas ya tiene un beneficio vigente (RN-01)',
};

export interface CandidatoAsignacion {
  solicitudId: number;
  /** Personas que recibirían el estímulo: la persona con discapacidad y, si lo requiere, su cuidador. */
  personas: 1 | 2;
  localidadId: number | null;
  transporteId: number | null;
  /** Alguna de las personas ya tiene un beneficio sin finalizar. */
  conBeneficio: boolean;
}

export interface DisponibilidadAsignacion {
  cuposDisponibles: number;
  presupuestoDisponible: number;
  valorEstimulo: number;
  /** Cupos que quedan por localidad / transporte cuando hay distribución definida; sin entrada = sin tope. */
  cuposLocalidad: ReadonlyMap<number, number>;
  cuposTransporte: ReadonlyMap<number, number>;
}

export interface PlanCaso {
  solicitudId: number;
  /** Cabe en los cupos y el presupuesto, siguiendo el orden de prioridad. */
  alcanza: boolean;
  motivo: MotivoNoAlcanza | null;
}

/**
 * Recorre los casos en orden de prioridad y marca hasta dónde alcanzan los cupos y el presupuesto. Un caso que no cabe
 * (por ejemplo, por el tope de su localidad) no consume nada y el recorrido sigue con el siguiente.
 */
export function planificarAsignacion(
  candidatos: readonly CandidatoAsignacion[],
  d: DisponibilidadAsignacion,
): PlanCaso[] {
  let cupos = d.cuposDisponibles;
  let presupuesto = d.presupuestoDisponible;
  const localidad = new Map(d.cuposLocalidad);
  const transporte = new Map(d.cuposTransporte);
  return candidatos.map((c) => {
    const costo = d.valorEstimulo * c.personas;
    const falla = ((): MotivoNoAlcanza | null => {
      if (c.conBeneficio) return 'PERSONA_CON_BENEFICIO';
      if (cupos <= 0) return 'SIN_CUPO';
      if (costo > presupuesto) return 'SIN_PRESUPUESTO';
      if (c.localidadId !== null && (localidad.get(c.localidadId) ?? Infinity) <= 0) {
        return 'SIN_CUPO_LOCALIDAD';
      }
      if (c.transporteId !== null && (transporte.get(c.transporteId) ?? Infinity) <= 0) {
        return 'SIN_CUPO_TRANSPORTE';
      }
      return null;
    })();
    if (falla) return { solicitudId: c.solicitudId, alcanza: false, motivo: falla };
    cupos--;
    presupuesto -= costo;
    if (c.localidadId !== null && localidad.has(c.localidadId)) {
      localidad.set(c.localidadId, (localidad.get(c.localidadId) as number) - 1);
    }
    if (c.transporteId !== null && transporte.has(c.transporteId)) {
      transporte.set(c.transporteId, (transporte.get(c.transporteId) as number) - 1);
    }
    return { solicitudId: c.solicitudId, alcanza: true, motivo: null };
  });
}

/**
 * Casos que se saltaron: los que están por delante, en el orden de prioridad, del último caso asignado en este lote
 * y no se asignan ni están bloqueados por alguna regla. De cada uno el asignador debe dejar la causa (RF-ASI-02).
 */
export function casosSaltados(
  orden: readonly { solicitudId: number; asignable: boolean }[],
  seleccion: ReadonlySet<number>,
): number[] {
  let ultimo = -1;
  orden.forEach((c, i) => {
    if (seleccion.has(c.solicitudId)) ultimo = i;
  });
  return orden
    .slice(0, Math.max(0, ultimo))
    .filter((c) => c.asignable && !seleccion.has(c.solicitudId))
    .map((c) => c.solicitudId);
}

export const redondearMoneda = (n: number): number => Math.round(n * 100) / 100;
