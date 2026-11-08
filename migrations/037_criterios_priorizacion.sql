-- Migración 037 · Nuevos criterios de priorización indicados por la Gerencia de Desarrollo Social:
--   1. Grado de dependencia funcional de la persona con discapacidad.
--   2. Clasificación en el grupo A del SISBÉN IV (solo el grupo A suma puntos).
--   3. Presencia de enfermedades crónicas o tratamientos médicos frecuentes.
--   4. Condición de pobreza extrema o desplazamiento.
--   5. Hogares monoparentales o con cuidadores mayores o con discapacidad.
--   6. Personas con discapacidad en edad infantil, adulta mayor o con múltiples discapacidades.
--   7. Se prioriza a quienes no perciben subsidios del Estado.
-- Se crea una versión nueva de la matriz ya vigente (la actual queda archivada y los casos ya calculados conservan la
-- versión con la que se calcularon). Las ponderaciones se conservan; la Gerencia debe validarlas.

ALTER TABLE matriz_variables DISABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones DISABLE TRIGGER matriz_opciones_borrador;
DO $$
DECLARE
  v_actual integer;
  v_nueva integer;
  v_version integer;
BEGIN
  SELECT id INTO v_actual FROM matrices WHERE estado = 'VIGENTE';
  IF v_actual IS NULL THEN
    RETURN;
  END IF;
  SELECT max(version) + 1 INTO v_version FROM matrices;
  UPDATE matrices SET estado = 'ARCHIVADA', vigente_hasta = now() WHERE id = v_actual;
  INSERT INTO matrices (version, estado, notas, desempate, vigente_desde, decidida_at, motivo_decision)
  SELECT v_version, 'VIGENTE',
         'Criterios indicados por la Gerencia de Desarrollo Social: el SISBÉN puntúa solo por pertenecer al grupo A. Las ponderaciones se conservan y deben ser validadas.',
         desempate, now(), now(),
         'Cambio de criterios de priorización indicado por la Gerencia de Desarrollo Social.'
    FROM matrices WHERE id = v_actual
  RETURNING id INTO v_nueva;

  INSERT INTO matriz_variables (matriz_id, codigo, nombre, descripcion, origen, peso, posicion)
  SELECT v_nueva, codigo,
         CASE codigo
           WHEN 'DEPENDENCIA_FUNCIONAL' THEN 'Grado de dependencia funcional'
           WHEN 'GRUPO_SISBEN' THEN 'Clasificación en el grupo A del SISBÉN IV'
           WHEN 'ENFERMEDAD_CRONICA' THEN 'Enfermedades crónicas o tratamientos médicos frecuentes'
           WHEN 'POBREZA_DESPLAZAMIENTO' THEN 'Pobreza extrema o desplazamiento'
           WHEN 'HOGAR_VULNERABLE' THEN 'Hogar monoparental o cuidador mayor o con discapacidad'
           WHEN 'EDAD_EXTREMA_MULTIPLE' THEN 'Edad infantil, adulta mayor o múltiples discapacidades'
           WHEN 'AUSENCIA_SUBSIDIOS' THEN 'No percibe subsidios del Estado'
           ELSE nombre END,
         CASE codigo
           WHEN 'GRUPO_SISBEN' THEN 'La persona está clasificada en el grupo A del SISBÉN IV.'
           WHEN 'AUSENCIA_SUBSIDIOS' THEN 'No percibe subsidios otorgados por el Estado (sale de la caracterización).'
           ELSE descripcion END,
         origen, peso, posicion
    FROM matriz_variables WHERE matriz_id = v_actual;

  -- Opciones: las mismas, salvo el SISBÉN (grupo A sí o no) y el texto de los subsidios.
  INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
  SELECT nv.id, o.codigo, o.etiqueta, o.puntos, o.posicion
    FROM matriz_variables ov
    JOIN matriz_opciones o ON o.variable_id = ov.id
    JOIN matriz_variables nv ON nv.matriz_id = v_nueva AND nv.codigo = ov.codigo
   WHERE ov.matriz_id = v_actual AND ov.codigo <> 'GRUPO_SISBEN';

  INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
  SELECT nv.id, x.codigo, x.etiqueta, x.puntos, x.posicion
    FROM matriz_variables nv
    JOIN matriz_variables ov ON ov.matriz_id = v_actual AND ov.codigo = 'GRUPO_SISBEN'
    CROSS JOIN LATERAL (VALUES
      ('GRUPO_A', 'Sí, está en el grupo A', COALESCE((SELECT puntos FROM matriz_opciones WHERE variable_id = ov.id AND codigo = 'GRUPO_A'), 20), 1),
      ('OTRO', 'No está en el grupo A', 0, 2)
    ) AS x (codigo, etiqueta, puntos, posicion)
   WHERE nv.matriz_id = v_nueva AND nv.codigo = 'GRUPO_SISBEN';

  UPDATE matriz_opciones SET etiqueta = 'No percibe subsidios del Estado'
   WHERE codigo = 'SIN_SUBSIDIOS' AND variable_id IN (SELECT id FROM matriz_variables WHERE matriz_id = v_nueva);
  UPDATE matriz_opciones SET etiqueta = 'Percibe subsidios del Estado'
   WHERE codigo = 'CON_SUBSIDIOS' AND variable_id IN (SELECT id FROM matriz_variables WHERE matriz_id = v_nueva);
END
$$;
ALTER TABLE matriz_variables ENABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones ENABLE TRIGGER matriz_opciones_borrador;
