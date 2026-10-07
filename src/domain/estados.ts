export type EstadoSolicitud = 'PREINSCRITA' | 'CORREO_VERIFICADO' | 'RADICADA';

export interface DescripcionEstado {
  etapa: string;
  nombre: string;
  /** Qué significa, en lenguaje claro (RF-PRE-05, RNF-11). */
  explicacion: string;
  /** Qué debe hacer la persona a continuación. */
  siguientePaso: string;
}

/**
 * Textos de cada estado que ve el ciudadano. Se amplían con los estados de las entregas siguientes
 * (radicada, en verificación, por subsanar, ...).
 */
export const ESTADOS: Record<EstadoSolicitud, DescripcionEstado> = {
  PREINSCRITA: {
    etapa: 'Preinscripción',
    nombre: 'Preinscrita',
    explicacion: 'Recibimos la preinscripción. Falta verificar el correo electrónico registrado.',
    siguientePaso:
      'Abra el enlace que enviamos a su correo para verificarlo. Si no le llegó, puede pedir que lo enviemos de nuevo.',
  },
  CORREO_VERIFICADO: {
    etapa: 'Preinscripción',
    nombre: 'Correo verificado',
    explicacion:
      'Su correo está verificado y la preinscripción quedó registrada. Todavía falta completar la caracterización y cargar los documentos.',
    siguientePaso:
      'Ingrese al enlace que le enviamos por correo para completar la caracterización y adjuntar los documentos.',
  },
  RADICADA: {
    etapa: 'Radicación',
    nombre: 'Radicada',
    explicacion:
      'Recibimos su caracterización y sus documentos. La solicitud quedó radicada con el número que aparece arriba.',
    siguientePaso:
      'Espere la verificación de requisitos. Le avisaremos por este correo cuando haya novedades; no necesita hacer nada más por ahora.',
  },
};

/** Cómo se muestra al ciudadano el estado de entrega de un correo (RNF-13). */
export const ENTREGA_CORREO: Record<string, string> = {
  PENDIENTE: 'Pendiente de envío',
  ENVIADO: 'Enviado',
  ENTREGADO: 'Entregado',
  REBOTADO: 'No se pudo entregar',
  FALLIDO: 'No se pudo enviar',
};

/** Nombre de cada comunicación para el ciudadano. */
export const NOMBRE_COMUNICACION: Record<string, string> = {
  PREINSCRIPCION_VERIFICACION: 'Verificación del correo',
  PREINSCRIPCION_EXITOSA: 'Preinscripción exitosa',
  CARACTERIZACION_RADICADA: 'Solicitud radicada',
};
