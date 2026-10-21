/** Reglas de la priorización (RF-PRI-01..04): matriz de ponderación, puntaje y desempate. Sin acceso a la base de datos. */

export type OrigenVariable = 'VALIDADOR' | 'SUBSIDIOS';

export interface OpcionMatriz {
  codigo: string;
  etiqueta: string;
  puntos: number;
}

export interface VariableMatriz {
  codigo: string;
  nombre: string;
  descripcion: string;
  origen: OrigenVariable;
  peso: number;
  opciones: OpcionMatriz[];
}

export interface DefinicionMatriz {
  notas: string;
  desempate: string[];
  variables: VariableMatriz[];
}

/** Estados de los casos que tienen o pueden tener puntaje. */
export const ESTADOS_PRIORIZABLES = ['VALIDADA', 'PRIORIZADA', 'EN_LISTA_ESPERA'] as const;

/** Las opciones de la variable que sale de la caracterización no se escriben: solo se les pone el puntaje. */
export const OPCIONES_SUBSIDIOS = ['SIN_SUBSIDIOS', 'CON_SUBSIDIOS'] as const;

export const FECHA_RADICACION = 'FECHA_RADICACION';
export const MAX_VARIABLES = 30;
export const MAX_CRITERIOS_DESEMPATE = 6;

export const redondear = (n: number): number => Math.round(n * 100) / 100;

/** Valor de la variable «ausencia de otros subsidios» a partir de la caracterización. */
export function valorSubsidios(recibeSubsidios: boolean | null | undefined) {
  if (recibeSubsidios === undefined || recibeSubsidios === null) return undefined;
  return recibeSubsidios ? 'CON_SUBSIDIOS' : 'SIN_SUBSIDIOS';
}

export function puntajeMaximo(variables: readonly VariableMatriz[]): number {
  return redondear(
    variables.reduce((t, v) => t + v.peso * Math.max(0, ...v.opciones.map((o) => o.puntos)), 0),
  );
}

type ErrorCampo = { campo: string; mensaje: string };

/** Revisa que la matriz se pueda usar para calcular: variables, opciones, pesos y criterios de desempate. */
export function erroresDeMatriz(d: DefinicionMatriz): ErrorCampo[] {
  const errores: ErrorCampo[] = [];
  if (d.variables.length === 0) {
    errores.push({ campo: 'variables', mensaje: 'Variables: agregue al menos una variable' });
  }
  if (d.variables.length > MAX_VARIABLES) {
    errores.push({ campo: 'variables', mensaje: `Variables: máximo ${MAX_VARIABLES}` });
  }
  const codigos = new Set<string>();
  d.variables.forEach((v, i) => {
    const etiqueta = `Variable ${i + 1} («${v.nombre || v.codigo}»)`;
    if (codigos.has(v.codigo)) {
      errores.push({
        campo: 'variables',
        mensaje: `${etiqueta}: el código ${v.codigo} está repetido`,
      });
    }
    codigos.add(v.codigo);
    if (v.origen === 'SUBSIDIOS') {
      const esperadas = [...OPCIONES_SUBSIDIOS].sort().join(',');
      if (
        v.opciones
          .map((o) => o.codigo)
          .sort()
          .join(',') !== esperadas
      ) {
        errores.push({
          campo: 'variables',
          mensaje: `${etiqueta}: debe tener solo las opciones «recibe» y «no recibe» subsidios`,
        });
      }
    } else if (v.opciones.length < 2) {
      errores.push({ campo: 'variables', mensaje: `${etiqueta}: agregue al menos dos opciones` });
    }
    const opciones = new Set<string>();
    for (const o of v.opciones) {
      if (opciones.has(o.codigo)) {
        errores.push({
          campo: 'variables',
          mensaje: `${etiqueta}: la opción ${o.codigo} está repetida`,
        });
      }
      opciones.add(o.codigo);
    }
  });
  if (d.variables.length > 0 && puntajeMaximo(d.variables) <= 0) {
    errores.push({
      campo: 'variables',
      mensaje: 'Variables: algún puntaje debe ser mayor que cero',
    });
  }
  if (d.desempate.length > MAX_CRITERIOS_DESEMPATE) {
    errores.push({
      campo: 'desempate',
      mensaje: `Desempate: máximo ${MAX_CRITERIOS_DESEMPATE} criterios`,
    });
  }
  const vistos = new Set<string>();
  for (const c of d.desempate) {
    const valido =
      c === FECHA_RADICACION ||
      (c.startsWith('VARIABLE:') && d.variables.some((v) => `VARIABLE:${v.codigo}` === c));
    if (!valido) {
      errores.push({ campo: 'desempate', mensaje: `Desempate: el criterio ${c} no existe` });
    } else if (vistos.has(c)) {
      errores.push({ campo: 'desempate', mensaje: `Desempate: el criterio ${c} está repetido` });
    }
    vistos.add(c);
  }
  return errores;
}

export interface AporteVariable {
  variable: string;
  nombre: string;
  valor: string;
  etiqueta: string;
  puntos: number;
  peso: number;
  aporte: number;
}

export interface ResultadoCalculo {
  puntaje: number;
  detalle: AporteVariable[];
  /** Variables para las que no hay un valor válido (no suman). */
  faltantes: { codigo: string; nombre: string }[];
}

/** Puntaje = suma, por variable, del peso por los puntos de la opción elegida. */
export function calcularPuntaje(
  variables: readonly VariableMatriz[],
  valores: Readonly<Record<string, string | undefined>>,
): ResultadoCalculo {
  const detalle: AporteVariable[] = [];
  const faltantes: ResultadoCalculo['faltantes'] = [];
  for (const v of variables) {
    const opcion = v.opciones.find((o) => o.codigo === valores[v.codigo]);
    if (!opcion) {
      faltantes.push({ codigo: v.codigo, nombre: v.nombre });
      continue;
    }
    detalle.push({
      variable: v.codigo,
      nombre: v.nombre,
      valor: opcion.codigo,
      etiqueta: opcion.etiqueta,
      puntos: opcion.puntos,
      peso: v.peso,
      aporte: redondear(opcion.puntos * v.peso),
    });
  }
  return { puntaje: redondear(detalle.reduce((t, d) => t + d.aporte, 0)), detalle, faltantes };
}

export interface FilaOrdenable {
  puntajeFinal: number;
  aportes: Readonly<Record<string, number>>;
  radicadaAt: Date | null;
  radicado: string;
}

function comparar(a: FilaOrdenable, b: FilaOrdenable, desempate: readonly string[]): string | null {
  if (a.puntajeFinal !== b.puntajeFinal) return null;
  for (const c of desempate) {
    if (c === FECHA_RADICACION) {
      const x = a.radicadaAt?.getTime() ?? Infinity;
      const y = b.radicadaAt?.getTime() ?? Infinity;
      if (x !== y) return c;
    } else if (c.startsWith('VARIABLE:')) {
      const k = c.slice('VARIABLE:'.length);
      if ((a.aportes[k] ?? 0) !== (b.aportes[k] ?? 0)) return c;
    }
  }
  return 'RADICADO';
}

/** Orden de prioridad: mayor puntaje primero y, si empatan, los criterios de desempate; al final, el radicado. */
export function ordenarPorPrioridad<T extends FilaOrdenable>(
  filas: readonly T[],
  desempate: readonly string[],
): (T & { criterioDesempate: string | null })[] {
  const ordenadas = [...filas].sort((a, b) => {
    if (a.puntajeFinal !== b.puntajeFinal) return b.puntajeFinal - a.puntajeFinal;
    for (const c of desempate) {
      if (c === FECHA_RADICACION) {
        const x = a.radicadaAt?.getTime() ?? Infinity;
        const y = b.radicadaAt?.getTime() ?? Infinity;
        if (x !== y) return x - y;
      } else if (c.startsWith('VARIABLE:')) {
        const k = c.slice('VARIABLE:'.length);
        const d = (b.aportes[k] ?? 0) - (a.aportes[k] ?? 0);
        if (d !== 0) return d;
      }
    }
    return a.radicado.localeCompare(b.radicado);
  });
  // El criterio que dejó a cada caso por debajo del anterior cuando tenían el mismo puntaje.
  return ordenadas.map((f, i) => ({
    ...f,
    criterioDesempate: i === 0 ? null : comparar(ordenadas[i - 1] as T, f, desempate),
  }));
}

/** Texto del criterio de desempate para mostrar. */
export function describirCriterio(
  criterio: string | null,
  variables: readonly Pick<VariableMatriz, 'codigo' | 'nombre'>[],
): string | null {
  if (criterio === null) return null;
  if (criterio === FECHA_RADICACION) return 'Fecha de radicación más antigua';
  if (criterio === 'RADICADO') return 'Número de radicado';
  const v = variables.find((x) => `VARIABLE:${x.codigo}` === criterio);
  return v ? `Mayor puntaje en «${v.nombre}»` : criterio;
}
