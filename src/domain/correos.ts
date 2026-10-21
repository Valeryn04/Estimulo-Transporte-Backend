/** Aclaración que debe mostrarse en el portal y en las notificaciones (RF-PRE, RF-CAR-04). */
export const AVISO_PREINSCRIPCION =
  'Importante: la preinscripción o el registro de su solicitud no equivale a la aprobación del beneficio. ' +
  'La asignación depende de la verificación de requisitos, la disponibilidad presupuestal y los criterios de priorización vigentes.';

/** Código de cada plantilla de correo (son también los eventos que generan una comunicación, RF-COM-01). */
export type TipoCorreo =
  | 'PREINSCRIPCION_VERIFICACION'
  | 'PREINSCRIPCION_EXITOSA'
  | 'CARACTERIZACION_RADICADA'
  | 'CODIGO_CONSULTA'
  | 'CUENTA_CREADA'
  | 'PASSWORD_RESTABLECIDA'
  | 'VALIDACION_APROBADA'
  | 'VALIDACION_SUBSANACION'
  | 'VALIDACION_RECHAZADA'
  | 'SUBSANACION_RECIBIDA'
  | 'ASIGNACION_BENEFICIO'
  | 'LISTA_ESPERA'
  | 'ENTREGA_REGISTRADA'
  | 'BENEFICIO_ACTIVADO'
  | 'NOVEDAD_BENEFICIO'
  | 'REVOCATORIA_TRASLADO'
  | 'REVOCATORIA_DECISION'
  | 'ENCUESTA_INVITACION';

/** Datos con los que se arma un correo. Cada plantilla usa solo las variables que tiene permitidas. */
export interface DatosCorreo {
  /** Nombre de la persona con discapacidad a quien corresponde la solicitud. */
  nombre: string;
  enlaceVerificacion?: string;
  horasVigencia?: number;
  estado?: string;
  siguientePaso?: string;
  enlaceCaracterizacion?: string;
  enlaceConsulta?: string;
  radicado?: string;
  fechaRadicacion?: string;
  /** Código de un solo uso para consultar el estado (RNF-05). */
  codigo?: string;
  minutosVigencia?: number;
  fechaLimite?: string;
  itemsSubsanar?: string;
  /** Motivación de una decisión de validación. */
  motivacion?: string;
  plazoRecursosDias?: number;
  /** Instrucciones de la entrega del medio de transporte (parámetros). */
  lugarEntrega?: string;
  documentosEntrega?: string;
  instruccionesEntrega?: string;
  fechaEntrega?: string;
  /** Identificador de la tarjeta con solo los últimos caracteres visibles. */
  tarjetaEnmascarada?: string;
  tipoTransporte?: string;
  recomendacionesUso?: string;
  /** Causales de revocatoria que se recuerdan a la persona (RN-09). */
  causalesRevocatoria?: string;
  tipoNovedad?: string;
  causal?: string;
  fechaEfectiva?: string;
  observacion?: string;
  traslado?: string;
  resultado?: string;
  tituloEncuesta?: string;
  enlaceEncuesta?: string;
  /** Usuario de ingreso al portal interno. */
  usuario?: string;
  enlaceAcceso?: string;
  /**
   * Contraseña temporal del funcionario. NUNCA se escribe en el texto guardado del correo: allí queda un marcador y
   * la contraseña viaja cifrada aparte hasta que el correo sale.
   */
  contrasenaTemporal?: string;
}

/** Lo que reemplaza a la contraseña temporal en el texto que se conserva del correo. */
export const MARCADOR_CONTRASENA = '[contraseña temporal]';

/** Variables disponibles para las plantillas, con su descripción y un ejemplo para la vista previa. */
export const VARIABLES: Record<string, { descripcion: string; ejemplo: string }> = {
  nombre: { descripcion: 'Nombre de la persona con discapacidad', ejemplo: 'María Pérez' },
  radicado: { descripcion: 'Número de radicado de la solicitud', ejemplo: 'EST-2026-000123' },
  fecha_radicacion: {
    descripcion: 'Fecha y hora de la radicación',
    ejemplo: '15/03/2026 10:30',
  },
  estado: { descripcion: 'Estado actual de la solicitud', ejemplo: 'Radicada' },
  siguiente_paso: {
    descripcion: 'Qué debe hacer la persona a continuación',
    ejemplo: 'Esperar la verificación de requisitos; le avisaremos por este medio.',
  },
  fecha_limite: { descripcion: 'Fecha límite de un plazo', ejemplo: '25/03/2026' },
  items_subsanar: {
    descripcion: 'Lista de requisitos que debe corregir',
    ejemplo: '- Documento de identidad ilegible',
  },
  enlace_verificacion: {
    descripcion: 'Enlace para verificar el correo electrónico',
    ejemplo: 'https://estimulo.barranquilla.gov.co/verificar-correo?token=ejemplo',
  },
  enlace_caracterizacion: {
    descripcion: 'Enlace para completar la caracterización y cargar documentos',
    ejemplo: 'https://estimulo.barranquilla.gov.co/caracterizacion?token=ejemplo',
  },
  enlace_consulta: {
    descripcion: 'Enlace seguro para consultar el estado de la solicitud',
    ejemplo: 'https://estimulo.barranquilla.gov.co/consulta?token=ejemplo',
  },
  horas_vigencia: { descripcion: 'Horas de vigencia del enlace de verificación', ejemplo: '72' },
  codigo: { descripcion: 'Código de un solo uso para consultar el estado', ejemplo: '482915' },
  minutos_vigencia: { descripcion: 'Minutos de vigencia del código', ejemplo: '10' },
  motivacion: {
    descripcion: 'Motivación de la decisión del validador',
    ejemplo: 'No se acreditó la afiliación al régimen subsidiado.',
  },
  plazo_recursos_dias: {
    descripcion: 'Días para interponer recursos contra una decisión',
    ejemplo: '10',
  },
  lugar_entrega: {
    descripcion: 'Lugar, fecha y horario de la entrega del medio de transporte',
    ejemplo: 'Gerencia de Desarrollo Social, calle 34 # 43-31, lunes a viernes de 8:00 a 12:00',
  },
  documentos_entrega: {
    descripcion: 'Documentos que debe presentar quien recibe el medio de transporte',
    ejemplo: 'Documento de identidad original de quien recibe.',
  },
  instrucciones_entrega: {
    descripcion: 'Otras instrucciones para la entrega del medio de transporte',
    ejemplo: 'Presente este correo al recibir el medio de transporte.',
  },
  fecha_entrega: {
    descripcion: 'Fecha en que se entregó el medio de transporte',
    ejemplo: '20/04/2026',
  },
  tarjeta_enmascarada: {
    descripcion: 'Identificador de la tarjeta, con solo los últimos caracteres visibles',
    ejemplo: '*******4821',
  },
  tipo_transporte: { descripcion: 'Tipo de transporte del beneficio', ejemplo: 'Transmetro' },
  recomendaciones_uso: {
    descripcion: 'Recomendaciones de uso del medio de transporte',
    ejemplo: 'Es personal e intransferible.',
  },
  causales_revocatoria: {
    descripcion: 'Causales por las que el beneficio puede revocarse',
    ejemplo: '- Uso por una persona distinta a la autorizada',
  },
  tipo_novedad: { descripcion: 'Tipo de novedad del beneficio', ejemplo: 'Bloqueo temporal' },
  causal: {
    descripcion: 'Causal de la novedad o de la revocatoria',
    ejemplo: 'Reporte de pérdida de la tarjeta',
  },
  fecha_efectiva: { descripcion: 'Fecha desde la cual rige la novedad', ejemplo: '20/04/2026' },
  observacion: {
    descripcion: 'Observación del funcionario',
    ejemplo: 'La tarjeta se repondrá cuando se verifique el reporte.',
  },
  traslado: {
    descripcion: 'Razones que se trasladan a la persona en la revocatoria',
    ejemplo: 'El reporte del operador indica que la tarjeta no se usa desde hace cuatro meses.',
  },
  resultado: { descripcion: 'Resultado de la decisión', ejemplo: 'Beneficio revocado' },
  titulo_encuesta: {
    descripcion: 'Título de la encuesta de satisfacción',
    ejemplo: 'Satisfacción con el servicio',
  },
  enlace_encuesta: {
    descripcion: 'Enlace personal para responder la encuesta (una sola vez)',
    ejemplo: 'https://estimulo.barranquilla.gov.co/encuesta?token=ejemplo',
  },
  nombre_funcionario: { descripcion: 'Nombre del funcionario', ejemplo: 'Carlos Gómez' },
  usuario: { descripcion: 'Usuario para ingresar al portal interno', ejemplo: 'cgomez' },
  contrasena_temporal: {
    descripcion: 'Contraseña temporal generada por el sistema (se cambia al primer ingreso)',
    ejemplo: 'Kp7#mXw2Rq9a',
  },
  enlace_acceso: {
    descripcion: 'Enlace para ingresar al portal interno',
    ejemplo: 'https://estimulo.barranquilla.gov.co/interno/login',
  },
  aviso_preinscripcion: {
    descripcion: 'Aclaración de que la preinscripción no equivale a la aprobación del beneficio',
    ejemplo: AVISO_PREINSCRIPCION,
  },
};

const PATRON_VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function variablesUsadas(texto: string): string[] {
  return [...new Set([...texto.matchAll(PATRON_VARIABLE)].map((m) => m[1] as string))];
}

/** Valores reales de las variables a partir de los datos del correo. Solo incluye las que tienen valor. */
export function valoresDeCorreo(d: DatosCorreo): Record<string, string> {
  const v: Record<string, string | number | undefined> = {
    nombre: d.nombre,
    enlace_verificacion: d.enlaceVerificacion,
    horas_vigencia: d.horasVigencia,
    estado: d.estado,
    siguiente_paso: d.siguientePaso,
    enlace_caracterizacion: d.enlaceCaracterizacion,
    enlace_consulta: d.enlaceConsulta,
    radicado: d.radicado,
    fecha_radicacion: d.fechaRadicacion,
    codigo: d.codigo,
    minutos_vigencia: d.minutosVigencia,
    fecha_limite: d.fechaLimite,
    items_subsanar: d.itemsSubsanar,
    motivacion: d.motivacion,
    plazo_recursos_dias: d.plazoRecursosDias,
    lugar_entrega: d.lugarEntrega,
    documentos_entrega: d.documentosEntrega,
    instrucciones_entrega: d.instruccionesEntrega,
    fecha_entrega: d.fechaEntrega,
    tarjeta_enmascarada: d.tarjetaEnmascarada,
    tipo_novedad: d.tipoNovedad,
    causal: d.causal,
    fecha_efectiva: d.fechaEfectiva,
    observacion: d.observacion,
    traslado: d.traslado,
    resultado: d.resultado,
    titulo_encuesta: d.tituloEncuesta,
    enlace_encuesta: d.enlaceEncuesta,
    tipo_transporte: d.tipoTransporte,
    recomendaciones_uso: d.recomendacionesUso,
    causales_revocatoria: d.causalesRevocatoria,
    nombre_funcionario: d.nombre,
    usuario: d.usuario,
    enlace_acceso: d.enlaceAcceso,
    contrasena_temporal: d.contrasenaTemporal === undefined ? undefined : MARCADOR_CONTRASENA,
    aviso_preinscripcion: AVISO_PREINSCRIPCION,
  };
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [k, String(x)]),
  );
}

/** Valores de ejemplo para la vista previa del administrador. */
export function valoresDeEjemplo(): Record<string, string> {
  return Object.fromEntries(Object.entries(VARIABLES).map(([k, v]) => [k, v.ejemplo]));
}

/**
 * Reglas de una plantilla: solo variables permitidas y todas las obligatorias dentro del texto (RF-COM-01:
 * todo correo incluye siguiente paso, enlace de consulta y la aclaración de que no es aprobación).
 */
export function validarPlantilla(
  def: { permitidas: string[]; obligatorias: string[] },
  asunto: string,
  cuerpo: string,
): string[] {
  const errores: string[] = [];
  if (/[\r\n]/.test(asunto)) errores.push('El asunto debe ir en una sola línea');
  const usadasCuerpo = variablesUsadas(cuerpo);
  const desconocidas = [...new Set([...variablesUsadas(asunto), ...usadasCuerpo])].filter(
    (v) => !def.permitidas.includes(v),
  );
  for (const v of desconocidas) {
    errores.push(`La variable {{${v}}} no existe o no se puede usar en esta plantilla`);
  }
  for (const v of def.obligatorias) {
    if (!usadasCuerpo.includes(v)) {
      errores.push(`El texto debe incluir la variable obligatoria {{${v}}}`);
    }
  }
  return errores;
}

/**
 * Reemplaza las variables por sus valores. Una variable sin valor es un error: nunca se envía un correo con un
 * enlace o un dato en blanco. En el asunto se eliminan los saltos de línea.
 */
export function renderizar(
  texto: string,
  valores: Record<string, string>,
  unaLinea = false,
): string {
  const r = texto.replace(PATRON_VARIABLE, (_m, nombre: string) => {
    const valor = valores[nombre];
    if (valor === undefined) throw new Error(`Falta el valor de la variable {{${nombre}}}`);
    return valor;
  });
  return unaLinea ? r.replace(/\s*[\r\n]+\s*/g, ' ').trim() : r;
}

/** Vista previa: las variables desconocidas se dejan tal cual (el problema se informa aparte, no se falla). */
export function renderizarVistaPrevia(
  texto: string,
  valores: Record<string, string>,
  unaLinea = false,
): string {
  const r = texto.replace(PATRON_VARIABLE, (m, nombre: string) => valores[nombre] ?? m);
  return unaLinea ? r.replace(/\s*[\r\n]+\s*/g, ' ').trim() : r;
}
