/** Reglas de los archivos de cruce (RF-ADM-05): lectura del CSV y normalización de identificaciones. */

export const MAX_FILAS_CRUCE = 300_000;

/** Quita tildes, pasa a mayúsculas y deja solo letras y números: «C.C. 1.234-5» → «CC12345». */
export function normalizarIdentificacion(valor: string): string {
  return valor
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export const IDENTIFICACION_VALIDA = /^[A-Z0-9]{4,20}$/;

/** Encabezados comparables: sin tildes, mayúsculas y sin espacios sobrantes. */
export const normalizarEncabezado = (t: string): string =>
  t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

/** Lee un CSV (comas o punto y coma, comillas dobles, saltos de línea de Windows o Unix). */
export function leerCsv(texto: string): string[][] {
  const limpio = texto.replace(/^\uFEFF/, '');
  const primera = limpio.split(/\r?\n/, 1)[0] ?? '';
  const separador =
    (primera.match(/;/g)?.length ?? 0) > (primera.match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i] as string;
    if (entreComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else entreComillas = false;
      } else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === separador) {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpio[i + 1] === '\n') i++;
      fila.push(campo);
      campo = '';
      filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x.trim() !== '')) filas.push(fila);
  return filas;
}

export interface ResultadoLectura {
  /** Filas válidas: identificación normalizada y detalle. */
  registros: { fila: number; identificacion: string; detalle: string }[];
  errores: { fila: number; mensaje: string }[];
  total: number;
}

/**
 * Interpreta el archivo según la estructura. Si falta la columna de identificación, el archivo no sirve (devuelve
 * el error); si solo fallan algunas filas, se informan para que se corrijan y se cargan las demás.
 */
export function interpretarCruce(
  texto: string,
  columnaIdentificacion: string,
  columnaDetalle: string | null,
): ResultadoLectura | { error: string } {
  const filas = leerCsv(texto);
  const encabezado = filas[0];
  if (!encabezado) return { error: 'El archivo está vacío.' };
  const titulos = encabezado.map(normalizarEncabezado);
  const posId = titulos.indexOf(normalizarEncabezado(columnaIdentificacion));
  if (posId < 0) {
    return {
      error: `El archivo no tiene la columna «${columnaIdentificacion}». Los encabezados encontrados son: ${encabezado.map((t) => t.trim()).join(', ')}.`,
    };
  }
  const posDetalle = columnaDetalle ? titulos.indexOf(normalizarEncabezado(columnaDetalle)) : -1;
  // Los números de fila son los del archivo; las filas totalmente vacías se ignoran.
  const datos = filas.slice(1);
  const conDatos = datos.filter((f) => f.some((x) => x.trim() !== '')).length;
  if (conDatos > MAX_FILAS_CRUCE) {
    return { error: `El archivo tiene más de ${MAX_FILAS_CRUCE} filas. Divídalo en varios.` };
  }
  const vistos = new Set<string>();
  const registros: ResultadoLectura['registros'] = [];
  const errores: ResultadoLectura['errores'] = [];
  datos.forEach((f, idx) => {
    if (!f.some((x) => x.trim() !== '')) return;
    const numeroFila = idx + 2;
    const id = normalizarIdentificacion(f[posId] ?? '');
    if (id === '') {
      errores.push({ fila: numeroFila, mensaje: 'La identificación está vacía.' });
    } else if (!IDENTIFICACION_VALIDA.test(id)) {
      errores.push({
        fila: numeroFila,
        mensaje: 'La identificación debe tener de 4 a 20 letras o números.',
      });
    } else if (vistos.has(id)) {
      errores.push({ fila: numeroFila, mensaje: 'La identificación está repetida en el archivo.' });
    } else {
      vistos.add(id);
      registros.push({
        fila: numeroFila,
        identificacion: id,
        detalle: posDetalle >= 0 ? (f[posDetalle] ?? '').trim().slice(0, 200) : '',
      });
    }
  });
  return { registros, errores, total: conDatos };
}
