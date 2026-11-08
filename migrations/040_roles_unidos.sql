-- Migración 040 · Roles unidos por defecto, con la posibilidad de volver a los roles individuales.
--   - Operativo = Auditor verificador + Asignador + Gestor de novedades.
--   - Seguimiento y control = Analista + Control interno.
--   - Administrador y Responsable del proceso se mantienen.
-- El parámetro «roles_individuales» decide qué roles se ofrecen al crear o editar usuarios: apagado (por defecto) se ofrecen
-- los unidos; encendido, los siete individuales. Los usuarios ya creados conservan su rol.

ALTER TABLE roles ADD COLUMN oferta text NOT NULL DEFAULT 'GENERAL' CHECK (oferta IN ('GENERAL', 'UNIDO', 'INDIVIDUAL'));
UPDATE roles SET oferta = 'INDIVIDUAL'
 WHERE codigo IN ('AUDITOR_VERIFICADOR', 'ASIGNADOR', 'GESTOR_NOVEDADES', 'ANALISTA', 'CONTROL_INTERNO');

INSERT INTO roles (codigo, nombre, descripcion, sistema, oferta) VALUES
  ('OPERATIVO', 'Operativo',
   'Valida los casos, aplica la priorización, asigna los cupos, registra la entrega y las novedades (une los roles Auditor verificador, Asignador y Gestor de novedades).',
   true, 'UNIDO'),
  ('SEGUIMIENTO', 'Seguimiento y control',
   'Consulta expedientes, tablero, reportes y la bitácora de auditoría, solo lectura (une los roles Analista y Control interno).',
   true, 'UNIDO');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT DISTINCT n.id, rp.permiso_codigo
  FROM roles n
  JOIN roles o ON o.codigo IN ('AUDITOR_VERIFICADOR', 'ASIGNADOR', 'GESTOR_NOVEDADES')
  JOIN rol_permiso rp ON rp.rol_id = o.id
 WHERE n.codigo = 'OPERATIVO';
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT DISTINCT n.id, rp.permiso_codigo
  FROM roles n
  JOIN roles o ON o.codigo IN ('ANALISTA', 'CONTROL_INTERNO')
  JOIN rol_permiso rp ON rp.rol_id = o.id
 WHERE n.codigo = 'SEGUIMIENTO';

-- Los usuarios que ya existen pasan al rol unido que corresponde a su rol individual.
UPDATE usuario_rol ur
   SET rol_id = (SELECT id FROM roles WHERE codigo = 'OPERATIVO')
 WHERE ur.rol_id IN (SELECT id FROM roles WHERE codigo IN ('AUDITOR_VERIFICADOR', 'ASIGNADOR', 'GESTOR_NOVEDADES'));
UPDATE usuario_rol ur
   SET rol_id = (SELECT id FROM roles WHERE codigo = 'SEGUIMIENTO')
 WHERE ur.rol_id IN (SELECT id FROM roles WHERE codigo IN ('ANALISTA', 'CONTROL_INTERNO'));

INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion, en_uso) VALUES
  ('roles_individuales', 'Seguridad',
   'Si es «true» se ofrecen los siete roles individuales al crear o editar usuarios; si es «false» (por defecto) se ofrecen los roles unidos: Operativo, y Seguimiento y control. Los usuarios ya creados conservan su rol',
   'BOOLEANO', NULL, NULL, false, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('roles_individuales', 'false', 'Valor inicial: los roles quedan unidos');
