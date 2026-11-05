-- Migración 036 · La consulta del régimen de salud solo responde sí o no: ya no se adjunta una constancia.
UPDATE documentos_requeridos
   SET descripcion = 'No se carga: el sistema consulta con el documento de identidad de la persona con discapacidad si es del régimen subsidiado.'
 WHERE codigo = 'PCD_AFILIACION_SUBSIDIADO';
