/** Estado del embarazo de la persona con discapacidad (RF-CAR-01). */
export type Embarazo = 'NO' | 'SI' | 'NO_APLICA';
export const EMBARAZOS: readonly Embarazo[] = ['NO', 'SI', 'NO_APLICA'];

/**
 * Datos de la caracterización de la persona con discapacidad y del cuidador (RF-CAR-01, RF-CAR-02). Todo puede
 * estar sin diligenciar: el avance se guarda a medias (RF-CAR-04) y la completitud se evalúa aparte.
 */
export interface DatosCaracterizacion {
  generoId: number | null;
  telefonoFijo: string | null;
  celular: string | null;
  /** Fecha en formato AAAA-MM-DD. */
  fechaNacimiento: string | null;
  estadoCivilId: number | null;
  tieneHijos: boolean | null;
  hijosCantidad: number | null;
  /** Una edad por hijo; una posición `null` es una edad que aún no se escribe. */
  hijosEdades: (number | null)[] | null;
  etniaId: number | null;
  escolaridadId: number | null;
  ocupacionId: number | null;
  epsId: number | null;
  embarazo: Embarazo | null;
  semanasGestacion: number | null;
  recibeSubsidios: boolean | null;
  subsidioCual: string | null;
  tipoTransporteId: number | null;
  justificacionTransporte: string | null;
  requiereCuidador: boolean | null;
  cuidadorGeneroId: number | null;
  cuidadorTelefonoFijo: string | null;
  cuidadorCelular: string | null;
  cuidadorCorreo: string | null;
}

export type CampoDato = keyof DatosCaracterizacion;

export const CAMPOS: readonly CampoDato[] = [
  'generoId',
  'telefonoFijo',
  'celular',
  'fechaNacimiento',
  'estadoCivilId',
  'tieneHijos',
  'hijosCantidad',
  'hijosEdades',
  'etniaId',
  'escolaridadId',
  'ocupacionId',
  'epsId',
  'embarazo',
  'semanasGestacion',
  'recibeSubsidios',
  'subsidioCual',
  'tipoTransporteId',
  'justificacionTransporte',
  'requiereCuidador',
  'cuidadorGeneroId',
  'cuidadorTelefonoFijo',
  'cuidadorCelular',
  'cuidadorCorreo',
];

/**
 * Datos sensibles (salud, etnia y condición socioeconómica, Ley 1581 de 2012): se guardan cifrados y se
 * conservan cifrados en el historial de correcciones (RNF-03).
 */
export const CAMPOS_SENSIBLES: readonly CampoDato[] = [
  'etniaId',
  'epsId',
  'embarazo',
  'semanasGestacion',
  'recibeSubsidios',
  'subsidioCual',
];

export const esSensible = (campo: string): boolean =>
  (CAMPOS_SENSIBLES as readonly string[]).includes(campo);

/** Catálogo del que sale cada campo que se elige de una lista. */
export const CATALOGO_DE_CAMPO: Partial<Record<CampoDato, string>> = {
  generoId: 'GENERO',
  estadoCivilId: 'ESTADO_CIVIL',
  etniaId: 'ETNIA',
  escolaridadId: 'ESCOLARIDAD',
  ocupacionId: 'OCUPACION',
  epsId: 'EPS',
  tipoTransporteId: 'TIPO_TRANSPORTE',
  cuidadorGeneroId: 'GENERO',
};

export function datosVacios(): DatosCaracterizacion {
  return Object.fromEntries(CAMPOS.map((c) => [c, null])) as unknown as DatosCaracterizacion;
}

/** Deja solo los dígitos y quita el indicativo del país: «+57 300 123 4567» → «3001234567». */
export function normalizarTelefono(texto: string): string {
  const d = texto.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('57') ? d.slice(2) : d;
}

export const PATRON_CELULAR = /^3\d{9}$/;
export const PATRON_FIJO = /^(\d{7}|60\d{8})$/;

export const MAX_HIJOS = 20;
export const MAX_EDAD_HIJO = 100;
export const MAX_SEMANAS_GESTACION = 42;

/** Un error asociado al campo que debe corregir la persona. */
export interface ErrorCampo {
  campo: string;
  mensaje: string;
}

/**
 * Hace coherentes los datos que dependen de otros: lo que ya no aplica se borra, para no guardar datos
 * contradictorios (por ejemplo, edades de hijos cuando dice que no tiene hijos).
 */
export function aplicarDependencias(d: DatosCaracterizacion): DatosCaracterizacion {
  const r = { ...d };
  if (r.tieneHijos !== true) {
    r.hijosCantidad = null;
    r.hijosEdades = null;
  } else if (r.hijosCantidad !== null) {
    const edades = r.hijosEdades ?? [];
    r.hijosEdades = Array.from({ length: r.hijosCantidad }, (_, i) => edades[i] ?? null);
  } else {
    r.hijosEdades = null;
  }
  if (r.embarazo !== 'SI') r.semanasGestacion = null;
  if (r.recibeSubsidios !== true) r.subsidioCual = null;
  if (r.requiereCuidador !== true) {
    r.cuidadorGeneroId = null;
    r.cuidadorTelefonoFijo = null;
    r.cuidadorCelular = null;
    r.cuidadorCorreo = null;
  }
  return r;
}

/** Reglas entre campos que no se pueden revisar de uno en uno (RNF-10: consistencia). */
export function erroresDeConsistencia(
  d: DatosCaracterizacion,
  ctx: { generoCodigo: string | undefined; hoy: string },
): ErrorCampo[] {
  const e: ErrorCampo[] = [];
  if (d.fechaNacimiento !== null) {
    if (d.fechaNacimiento > ctx.hoy) {
      e.push({
        campo: 'fechaNacimiento',
        mensaje: 'Fecha de nacimiento: no puede ser una fecha futura',
      });
    } else if (d.fechaNacimiento < '1900-01-01') {
      e.push({
        campo: 'fechaNacimiento',
        mensaje: 'Fecha de nacimiento: revise el año, es demasiado antiguo',
      });
    }
  }
  if (d.embarazo === 'SI' && ctx.generoCodigo === 'MASCULINO') {
    e.push({
      campo: 'embarazo',
      mensaje: 'Estado de embarazo: no es coherente con el género indicado; revise ambos datos',
    });
  }
  if (d.hijosEdades) {
    const mayor = d.hijosEdades.findIndex((x) => x !== null && x > MAX_EDAD_HIJO);
    if (mayor >= 0) {
      e.push({
        campo: 'hijosEdades',
        mensaje: `Edad del hijo ${mayor + 1}: escriba un valor entre 0 y ${MAX_EDAD_HIJO}`,
      });
    }
  }
  return e;
}

// ---------------------------------------------------------------------------------------------------------
// Avance por secciones (RF-CAR-01, RNF-11)
// ---------------------------------------------------------------------------------------------------------

export interface Faltante {
  campo: string;
  mensaje: string;
}

export interface SeccionAvance {
  codigo: 'datos-personales' | 'situacion' | 'salud-apoyos' | 'transporte' | 'cuidador';
  nombre: string;
  /** Datos obligatorios de la sección y cuántos ya están diligenciados. */
  requeridos: number;
  completados: number;
  completa: boolean;
  faltantes: Faltante[];
}

export interface Avance {
  secciones: SeccionAvance[];
  requeridos: number;
  completados: number;
  /** Porcentaje de datos obligatorios diligenciados (0–100). */
  porcentaje: number;
  completa: boolean;
}

interface Requerido {
  campo: string;
  mensaje: string;
  ok: boolean;
}

const lleno = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

function seccion(
  codigo: SeccionAvance['codigo'],
  nombre: string,
  items: Requerido[],
): SeccionAvance {
  const faltantes = items.filter((i) => !i.ok).map(({ campo, mensaje }) => ({ campo, mensaje }));
  return {
    codigo,
    nombre,
    requeridos: items.length,
    completados: items.length - faltantes.length,
    completa: faltantes.length === 0,
    faltantes,
  };
}

/**
 * Qué datos obligatorios están diligenciados y cuáles faltan, por sección. Es la única fuente de la regla
 * «campos obligatorios» (RF-CAR-04): la pantalla solo la muestra. El nombre, la identificación y el correo vienen de
 * la preinscripción y no cuentan como pendientes.
 */
export function calcularAvance(d: DatosCaracterizacion): Avance {
  const datos = seccion('datos-personales', 'Datos personales', [
    { campo: 'generoId', mensaje: 'Género: elija una opción', ok: lleno(d.generoId) },
    { campo: 'celular', mensaje: 'Celular: escriba su número', ok: lleno(d.celular) },
  ]);

  const situacion: Requerido[] = [
    { campo: 'ocupacionId', mensaje: 'Ocupación: elija una opción', ok: lleno(d.ocupacionId) },
  ];
  if (d.tieneHijos === true) {
    situacion.push(
      {
        campo: 'hijosCantidad',
        mensaje: 'Cuántos hijos tiene: escriba un número',
        ok: lleno(d.hijosCantidad),
      },
      {
        campo: 'hijosEdades',
        mensaje: 'Edades de los hijos: escriba la edad de cada uno',
        ok:
          d.hijosEdades !== null &&
          d.hijosEdades.length > 0 &&
          d.hijosEdades.every((x) => x !== null),
      },
    );
  }

  const salud: Requerido[] = [
    { campo: 'epsId', mensaje: 'EPS: elija una opción', ok: lleno(d.epsId) },
    { campo: 'embarazo', mensaje: 'Estado de embarazo: elija una opción', ok: lleno(d.embarazo) },
  ];
  if (d.embarazo === 'SI') {
    salud.push({
      campo: 'semanasGestacion',
      mensaje: 'Tiempo de gestación: escriba las semanas',
      ok: lleno(d.semanasGestacion),
    });
  }
  salud.push({
    campo: 'recibeSubsidios',
    mensaje: 'Subsidios de otras entidades: responda sí o no',
    ok: lleno(d.recibeSubsidios),
  });
  if (d.recibeSubsidios === true) {
    salud.push({
      campo: 'subsidioCual',
      mensaje: 'Cuál subsidio, renta o beneficio recibe: escríbalo',
      ok: lleno(d.subsidioCual),
    });
  }

  const secciones = [
    datos,
    seccion('situacion', 'Su situación', situacion),
    seccion('salud-apoyos', 'Salud y apoyos', salud),
    seccion('transporte', 'Transporte', [
      {
        campo: 'requiereCuidador',
        mensaje: 'Servicio para el cuidador: responda sí o no',
        ok: lleno(d.requiereCuidador),
      },
    ]),
  ];
  if (d.requiereCuidador === true) {
    secciones.push(
      seccion('cuidador', 'Cuidador o asistente personal', [
        {
          campo: 'cuidadorGeneroId',
          mensaje: 'Género del cuidador: elija una opción',
          ok: lleno(d.cuidadorGeneroId),
        },
        {
          campo: 'cuidadorCelular',
          mensaje: 'Celular del cuidador: escriba su número',
          ok: lleno(d.cuidadorCelular),
        },
        {
          campo: 'cuidadorCorreo',
          mensaje: 'Correo del cuidador: escríbalo',
          ok: lleno(d.cuidadorCorreo),
        },
      ]),
    );
  }
  const requeridos = secciones.reduce((a, s) => a + s.requeridos, 0);
  const completados = secciones.reduce((a, s) => a + s.completados, 0);
  return {
    secciones,
    requeridos,
    completados,
    porcentaje: requeridos === 0 ? 0 : Math.round((completados / requeridos) * 100),
    completa: secciones.every((s) => s.completa),
  };
}
