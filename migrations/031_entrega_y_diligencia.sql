-- Migración 031 · (1) Quién diligenció la preinscripción: la persona con discapacidad o su cuidador.
-- (2) Entrega de la tarjeta: si el receptor es un tercero, se deja constancia de si presentó la autorización.
-- (3) Prefijo del identificador de la tarjeta (lo define la Gerencia con el operador de transporte).
ALTER TABLE solicitudes ADD COLUMN diligenciada_por text CHECK (diligenciada_por IN ('PCD', 'CUIDADOR'));
ALTER TABLE entregas ADD COLUMN tercero_con_autorizacion boolean;
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion, en_uso) VALUES
  ('tarjeta_prefijo', 'Asignación',
   'Con qué debe comenzar el identificador de la tarjeta (el que viene impreso). Déjelo vacío si las tarjetas no llevan un prefijo fijo (RF-ASI-05)',
   'TEXTO', NULL, NULL, true, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('tarjeta_prefijo', 'ESTBQ-', 'Valor inicial: la Gerencia debe confirmarlo con el operador de transporte');
