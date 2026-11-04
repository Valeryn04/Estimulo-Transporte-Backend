-- Migración 032 · Cambios pedidos por la Gerencia de Desarrollo Social:
--   1. El SISBÉN ya no existe: deja de pedirse el soporte, de revisarse y de puntuar.
--   2. Las cartas (de solicitud y de cuidado y contacto) las genera el sistema con los datos del formulario.
--   3. El certificado de discapacidad debe traer dos hojas (la segunda lleva un código QR).
--   4. El identificador de la tarjeta es «MFPLUS-EV-» seguido de 8 dígitos.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Sin SISBÉN. Se desactivan (no se borran: lo ya revisado conserva su historia).
-- ---------------------------------------------------------------------------------------------------------
UPDATE documentos_requeridos SET activo = false WHERE codigo IN ('PCD_SISBEN', 'CUIDADOR_SISBEN');
UPDATE requisitos_validacion SET activo = false WHERE codigo IN ('PCD_SISBEN', 'CUI_SISBEN');

-- La matriz vigente pierde la variable «Grupo del SISBÉN IV» y su criterio de desempate: se crea una versión nueva ya
-- vigente (la anterior queda archivada y los casos ya calculados conservan la versión con la que se calcularon).
ALTER TABLE matriz_variables DISABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones DISABLE TRIGGER matriz_opciones_borrador;
DO $$
DECLARE
  v_vieja integer;
  v_nueva integer;
  v_version integer;
BEGIN
  SELECT id INTO v_vieja FROM matrices WHERE estado = 'VIGENTE';
  IF v_vieja IS NULL
     OR NOT EXISTS (SELECT 1 FROM matriz_variables WHERE matriz_id = v_vieja AND codigo = 'GRUPO_SISBEN') THEN
    RETURN;
  END IF;
  SELECT max(version) + 1 INTO v_version FROM matrices;
  UPDATE matrices SET estado = 'ARCHIVADA', vigente_hasta = now() WHERE id = v_vieja;
  INSERT INTO matrices (version, estado, notas, desempate, vigente_desde, decidida_at, motivo_decision)
  SELECT v_version, 'VIGENTE',
         'Sin el grupo del SISBÉN, que ya no existe. Las demás ponderaciones se conservan; la Gerencia de Desarrollo Social debe validarlas.',
         array_remove(desempate, 'VARIABLE:GRUPO_SISBEN'), now(), now(),
         'Cambio indicado por la Gerencia de Desarrollo Social: el SISBÉN ya no es un criterio.'
    FROM matrices WHERE id = v_vieja
  RETURNING id INTO v_nueva;
  INSERT INTO matriz_variables (matriz_id, codigo, nombre, descripcion, origen, peso, posicion)
  SELECT v_nueva, codigo, nombre, descripcion, origen, peso, row_number() OVER (ORDER BY posicion)
    FROM matriz_variables WHERE matriz_id = v_vieja AND codigo <> 'GRUPO_SISBEN';
  INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
  SELECT nv.id, o.codigo, o.etiqueta, o.puntos, o.posicion
    FROM matriz_variables ov
    JOIN matriz_opciones o ON o.variable_id = ov.id
    JOIN matriz_variables nv ON nv.matriz_id = v_nueva AND nv.codigo = ov.codigo
   WHERE ov.matriz_id = v_vieja;
END
$$;
ALTER TABLE matriz_variables ENABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones ENABLE TRIGGER matriz_opciones_borrador;

-- ---------------------------------------------------------------------------------------------------------
-- 2 y 3. Documentos generados por el sistema y hojas mínimas de un documento.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE documentos_requeridos
  ADD COLUMN generado text CHECK (generado IN ('CARTA_SOLICITUD', 'CARTA_CUIDADO')),
  ADD COLUMN hojas_minimas integer NOT NULL DEFAULT 1 CHECK (hojas_minimas BETWEEN 1 AND 10);

UPDATE documentos_requeridos
   SET generado = 'CARTA_SOLICITUD',
       descripcion = 'La genera el sistema con los datos que usted escribe y se adjunta sola al enviar la solicitud: no tiene que subirla.'
 WHERE codigo = 'COMUN_CARTA_SOLICITUD';
UPDATE documentos_requeridos
   SET generado = 'CARTA_CUIDADO',
       descripcion = 'La genera el sistema con los datos del cuidador y se adjunta sola al enviar la solicitud: no tiene que subirla. La Gerencia de Desarrollo Social la revisa y la autoriza.'
 WHERE codigo = 'CUIDADOR_CARTA_CUIDADO';
UPDATE documentos_requeridos
   SET hojas_minimas = 2,
       descripcion = 'Certificado vigente de discapacidad, completo: son dos hojas y la segunda trae un código QR de verificación. Cárguelo en un solo PDF con las dos hojas.'
 WHERE codigo = 'PCD_CERTIFICADO_DISCAPACIDAD';

UPDATE requisitos_validacion
   SET nombre = 'Carta de solicitud generada',
       descripcion = 'La carta que generó el sistema coincide con los datos de la persona con discapacidad y de su cuidador.'
 WHERE codigo = 'COM_CARTA_SOLICITUD';
UPDATE requisitos_validacion
   SET nombre = 'Cuidado o asistencia permanente autorizado',
       descripcion = 'La carta de cuidado y contacto generada por el sistema está completa y la autoriza la Gerencia de Desarrollo Social.'
 WHERE codigo = 'CUI_CUIDADO';
UPDATE requisitos_validacion
   SET descripcion = 'El certificado es legible, vigente y tiene las dos hojas; el código QR de la segunda se puede verificar.'
 WHERE codigo = 'PCD_CERTIFICADO_DISCAPACIDAD';

-- ---------------------------------------------------------------------------------------------------------
-- 4. Identificador de la tarjeta: «MFPLUS-EV-» y 8 dígitos.
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion, en_uso) VALUES
  ('tarjeta_digitos', 'Asignación',
   'Cuántos dígitos lleva el identificador de la tarjeta después del prefijo. Escriba 0 si no se exige una cantidad fija',
   'ENTERO', 0, 20, false, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('tarjeta_digitos', '8', 'Indicado por la Gerencia de Desarrollo Social'),
  ('tarjeta_prefijo', 'MFPLUS-EV-', 'Indicado por la Gerencia de Desarrollo Social');
UPDATE parametros SET pendiente_definicion = false WHERE clave = 'tarjeta_prefijo';
