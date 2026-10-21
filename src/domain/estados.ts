export type EstadoSolicitud =
  | 'PREINSCRITA'
  | 'CORREO_VERIFICADO'
  | 'RADICADA'
  | 'EN_REVISION'
  | 'EN_SUBSANACION'
  | 'SUBSANADA'
  | 'VALIDADA'
  | 'NO_CUMPLE'
  | 'PRIORIZADA'
  | 'EN_LISTA_ESPERA'
  | 'ASIGNADA';

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
  EN_REVISION: {
    etapa: 'Validación',
    nombre: 'En revisión',
    explicacion:
      'Un funcionario está verificando, requisito por requisito, los datos y documentos de su solicitud.',
    siguientePaso:
      'Espere el resultado. Le avisaremos por este correo; si necesitamos que corrija algo, se lo indicaremos con un plazo.',
  },
  EN_SUBSANACION: {
    etapa: 'Validación',
    nombre: 'Por subsanar',
    explicacion:
      'Al revisar su solicitud encontramos datos o documentos que debe corregir o completar. Solo puede modificar lo que le indicamos.',
    siguientePaso:
      'Ingrese al enlace que le enviamos por correo, corrija lo señalado y envíe su respuesta dentro del plazo.',
  },
  SUBSANADA: {
    etapa: 'Validación',
    nombre: 'Subsanada',
    explicacion: 'Recibimos sus correcciones. Su solicitud volvió a revisión.',
    siguientePaso:
      'Espere el resultado de la nueva revisión; no necesita hacer nada más por ahora.',
  },
  VALIDADA: {
    etapa: 'Validación',
    nombre: 'Validada',
    explicacion:
      'Su solicitud cumplió los requisitos. Continúa con la priorización y la asignación, que dependen de los cupos y del presupuesto.',
    siguientePaso:
      'Espere. Haber cumplido los requisitos no garantiza el beneficio: le avisaremos si resulta asignado.',
  },
  PRIORIZADA: {
    etapa: 'Priorización',
    nombre: 'Priorizada',
    explicacion:
      'Su solicitud cumplió los requisitos y ya tiene un puntaje de priorización. La asignación depende de ese puntaje, de los cupos y del presupuesto disponibles.',
    siguientePaso:
      'Espere. Haber cumplido los requisitos no garantiza el beneficio: le avisaremos por este correo si resulta asignado o queda en lista de espera.',
  },
  EN_LISTA_ESPERA: {
    etapa: 'Asignación',
    nombre: 'En lista de espera',
    explicacion:
      'Su solicitud cumplió los requisitos, pero por ahora no hay cupos o presupuesto disponibles. Conserva su lugar en la lista según su puntaje de priorización.',
    siguientePaso:
      'Espere. Si se libera un cupo, se asignará siguiendo el orden de la lista y le avisaremos por este correo.',
  },
  ASIGNADA: {
    etapa: 'Asignación',
    nombre: 'Asignada',
    explicacion:
      'Su solicitud resultó beneficiaria del Estímulo Social de Transporte. El beneficio está pendiente de entrega.',
    siguientePaso:
      'Siga las instrucciones del correo de asignación para recibir el medio de transporte: lugar, documentos que debe presentar y horario.',
  },
  NO_CUMPLE: {
    etapa: 'Validación',
    nombre: 'No cumple los requisitos',
    explicacion:
      'Su solicitud no cumplió los requisitos del programa. La decisión y su motivación se la enviamos por correo, con los recursos que proceden.',
    siguientePaso:
      'Si no está de acuerdo, puede interponer el recurso que le indicamos en el correo dentro del plazo señalado.',
  },
};

export type EstadoBeneficioPersona =
  | 'PENDIENTE_ENTREGA'
  | 'PENDIENTE_ACTIVACION'
  | 'ACTIVO'
  | 'BLOQUEADO'
  | 'SUSPENDIDO'
  | 'FINALIZADO';

/** Lo que ve la persona en su consulta cuando su solicitud ya fue asignada, según el estado del beneficio. */
export const ESTADOS_BENEFICIO: Record<EstadoBeneficioPersona, DescripcionEstado> = {
  PENDIENTE_ENTREGA: ESTADOS.ASIGNADA,
  PENDIENTE_ACTIVACION: {
    etapa: 'Entrega',
    nombre: 'Entregada, en activación',
    explicacion:
      'Registramos la entrega de su medio de transporte. Falta confirmar su activación con el operador de transporte.',
    siguientePaso:
      'Espere la confirmación: le avisaremos por este correo cuando el beneficio esté activo.',
  },
  ACTIVO: {
    etapa: 'Beneficio',
    nombre: 'Beneficio activo',
    explicacion: 'Su beneficio está activo: puede usar su medio de transporte.',
    siguientePaso:
      'Use el medio de transporte solo usted o su cuidador autorizado. Si lo pierde, repórtelo de inmediato.',
  },
  BLOQUEADO: {
    etapa: 'Beneficio',
    nombre: 'Beneficio bloqueado',
    explicacion:
      'Su beneficio está bloqueado temporalmente. Los motivos y el procedimiento se los informamos por correo.',
    siguientePaso:
      'Revise el correo que le enviamos y comuníquese con la Gerencia de Desarrollo Social.',
  },
  SUSPENDIDO: {
    etapa: 'Beneficio',
    nombre: 'Beneficio suspendido',
    explicacion:
      'Su beneficio está suspendido. Los motivos y el procedimiento se los informamos por correo.',
    siguientePaso:
      'Revise el correo que le enviamos y comuníquese con la Gerencia de Desarrollo Social.',
  },
  FINALIZADO: {
    etapa: 'Beneficio',
    nombre: 'Beneficio finalizado',
    explicacion: 'Su beneficio finalizó. La decisión y sus motivos se los informamos por correo.',
    siguientePaso:
      'Si no está de acuerdo, siga las instrucciones del correo para presentar sus descargos.',
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
  VALIDACION_APROBADA: 'Validación aprobada',
  VALIDACION_SUBSANACION: 'Solicitud de subsanación',
  VALIDACION_RECHAZADA: 'Validación rechazada',
  SUBSANACION_RECIBIDA: 'Subsanación recibida',
  ASIGNACION_BENEFICIO: 'Asignación del beneficio',
  LISTA_ESPERA: 'Caso en lista de espera',
  ENTREGA_REGISTRADA: 'Entrega del medio de transporte',
  BENEFICIO_ACTIVADO: 'Beneficio activado',
  NOVEDAD_BENEFICIO: 'Novedad del beneficio',
  REVOCATORIA_TRASLADO: 'Traslado de la revocatoria',
  REVOCATORIA_DECISION: 'Decisión de la revocatoria',
  ENCUESTA_INVITACION: 'Invitación a la encuesta de satisfacción',
};
