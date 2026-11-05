-- Migración 035 · (1) El soporte de afiliación nunca se carga: se consulta con el documento de la persona.
-- (2) En la preinscripción se pregunta si el cuidador también es una persona con discapacidad.

UPDATE documentos_requeridos
   SET descripcion = 'No se carga: el sistema consulta el régimen de salud con el documento de identidad de la persona con discapacidad y adjunta solo la constancia.'
 WHERE codigo = 'PCD_AFILIACION_SUBSIDIADO';

ALTER TABLE solicitudes ADD COLUMN cuidador_es_pcd boolean;
COMMENT ON COLUMN solicitudes.cuidador_es_pcd IS
  'Declaración de la persona: el cuidador también es una persona con discapacidad (NULL = sin cuidador o sin responder).';
