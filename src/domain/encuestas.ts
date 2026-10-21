/** Reglas de las encuestas de satisfacción (RF-NOV-04). */

export type TipoPregunta = 'SELECCION' | 'ESCALA' | 'TEXTO';

export interface PreguntaEncuesta {
  id: number;
  tipo: TipoPregunta;
  texto: string;
  obligatoria: boolean;
  opciones: string[] | null;
  escalaMax: number | null;
}

export type DatosPregunta = Omit<PreguntaEncuesta, 'id'>;

type ErrorCampo = { campo: string; mensaje: string };

export function erroresDePreguntas(preguntas: readonly DatosPregunta[]): ErrorCampo[] {
  const e: ErrorCampo[] = [];
  if (preguntas.length === 0)
    e.push({ campo: 'preguntas', mensaje: 'Preguntas: agregue al menos una' });
  if (preguntas.length > 30) e.push({ campo: 'preguntas', mensaje: 'Preguntas: máximo 30' });
  preguntas.forEach((p, i) => {
    const n = `Pregunta ${i + 1}`;
    if (p.texto.trim().length < 5)
      e.push({ campo: 'preguntas', mensaje: `${n}: escriba el texto (mínimo 5 caracteres)` });
    if (p.tipo === 'SELECCION') {
      const limpias = (p.opciones ?? []).map((o) => o.trim()).filter(Boolean);
      if (limpias.length < 2)
        e.push({ campo: 'preguntas', mensaje: `${n}: agregue al menos dos opciones` });
      if (new Set(limpias.map((o) => o.toLowerCase())).size !== limpias.length) {
        e.push({ campo: 'preguntas', mensaje: `${n}: hay opciones repetidas` });
      }
    }
    if (p.tipo === 'ESCALA' && (p.escalaMax === null || p.escalaMax < 3 || p.escalaMax > 10)) {
      e.push({ campo: 'preguntas', mensaje: `${n}: la escala va de 1 a un máximo entre 3 y 10` });
    }
  });
  return e;
}

export type Respuestas = Record<string, unknown>;

/** Revisa lo que respondió la persona contra las preguntas y devuelve solo los valores válidos. */
export function validarRespuestas(
  preguntas: readonly PreguntaEncuesta[],
  crudo: Respuestas,
): { respuestas: Record<string, string | number>; errores: ErrorCampo[] } {
  const respuestas: Record<string, string | number> = {};
  const errores: ErrorCampo[] = [];
  for (const p of preguntas) {
    const v = crudo[String(p.id)];
    const vacia = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (vacia) {
      if (p.obligatoria) errores.push({ campo: String(p.id), mensaje: `Responda: ${p.texto}` });
      continue;
    }
    if (p.tipo === 'ESCALA') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > (p.escalaMax as number)) {
        errores.push({
          campo: String(p.id),
          mensaje: `Elija un valor de 1 a ${p.escalaMax}: ${p.texto}`,
        });
      } else respuestas[String(p.id)] = n;
    } else if (p.tipo === 'SELECCION') {
      if (typeof v !== 'string' || !(p.opciones ?? []).includes(v)) {
        errores.push({ campo: String(p.id), mensaje: `Elija una de las opciones: ${p.texto}` });
      } else respuestas[String(p.id)] = v;
    } else {
      const t = String(v).trim();
      if (t.length > 1000)
        errores.push({ campo: String(p.id), mensaje: `Máximo 1000 caracteres: ${p.texto}` });
      else respuestas[String(p.id)] = t;
    }
  }
  return { respuestas, errores };
}

export interface ResultadoPregunta {
  id: number;
  tipo: TipoPregunta;
  texto: string;
  respondidas: number;
  /** SELECCION y ESCALA: cuántas personas eligieron cada valor. */
  conteo?: { valor: string; cantidad: number }[];
  /** ESCALA. */
  promedio?: number | null;
  /** TEXTO: respuestas sin identificar, en orden de llegada. */
  textos?: string[];
}

/** Resultados anonimizados: solo conteos, promedios y textos, sin ninguna referencia a quién respondió. */
export function resumirResultados(
  preguntas: readonly PreguntaEncuesta[],
  todas: readonly Respuestas[],
): ResultadoPregunta[] {
  return preguntas.map((p) => {
    const valores = todas.map((r) => r[String(p.id)]).filter((v) => v !== undefined && v !== null);
    const base = { id: p.id, tipo: p.tipo, texto: p.texto, respondidas: valores.length };
    if (p.tipo === 'TEXTO') return { ...base, textos: valores.map(String).slice(0, 200) };
    const opciones =
      p.tipo === 'ESCALA'
        ? Array.from({ length: p.escalaMax as number }, (_, i) => String(i + 1))
        : (p.opciones ?? []);
    const conteo = opciones.map((o) => ({
      valor: o,
      cantidad: valores.filter((v) => String(v) === o).length,
    }));
    if (p.tipo === 'ESCALA') {
      const nums = valores.map(Number);
      return {
        ...base,
        conteo,
        promedio: nums.length
          ? Math.round((nums.reduce((t, n) => t + n, 0) / nums.length) * 100) / 100
          : null,
      };
    }
    return { ...base, conteo };
  });
}

/** Indicador de satisfacción (0 a 100): promedio de todas las respuestas de escala, llevadas a esa medida. */
export function indicadorSatisfaccion(
  preguntas: readonly PreguntaEncuesta[],
  todas: readonly Respuestas[],
): number | null {
  const valores: number[] = [];
  for (const p of preguntas.filter((x) => x.tipo === 'ESCALA')) {
    for (const r of todas) {
      const v = r[String(p.id)];
      if (typeof v === 'number') valores.push(((v - 1) / ((p.escalaMax as number) - 1)) * 100);
    }
  }
  if (valores.length === 0) return null;
  return Math.round((valores.reduce((t, n) => t + n, 0) / valores.length) * 10) / 10;
}
