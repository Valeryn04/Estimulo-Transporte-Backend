-- Migración 033 · Corrección de la 032: lo que Gestión Social pidió quitar es la opción «SiBus» de los tipos de
-- transporte, NO el SISBÉN. El SISBÉN se restaura (soporte, requisito y variable de priorización).

-- 1. Se quita SiBus de las opciones de transporte (se desactiva: lo ya registrado conserva su dato).
UPDATE catalogo_items SET activo = false WHERE catalogo = 'TIPO_TRANSPORTE' AND codigo = 'SIBUS';

-- 2. El SISBÉN vuelve a pedirse y a revisarse.
UPDATE documentos_requeridos SET activo = true WHERE codigo IN ('PCD_SISBEN', 'CUIDADOR_SISBEN');
UPDATE requisitos_validacion SET activo = true WHERE codigo IN ('PCD_SISBEN', 'CUI_SISBEN');

-- 3. La matriz vigente recupera la variable «Grupo del SISBÉN IV» y su desempate: se crea una versión nueva ya
-- vigente copiada de la última que la tenía (la actual queda archivada; los casos conservan la versión con la que se calcularon).
ALTER TABLE matriz_variables DISABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones DISABLE TRIGGER matriz_opciones_borrador;
DO $$
DECLARE
  v_actual integer;
  v_origen integer;
  v_nueva integer;
  v_version integer;
BEGIN
  SELECT id INTO v_actual FROM matrices WHERE estado = 'VIGENTE';
  IF v_actual IS NULL
     OR EXISTS (SELECT 1 FROM matriz_variables WHERE matriz_id = v_actual AND codigo = 'GRUPO_SISBEN') THEN
    RETURN;
  END IF;
  SELECT m.id INTO v_origen FROM matrices m
   WHERE EXISTS (SELECT 1 FROM matriz_variables v WHERE v.matriz_id = m.id AND v.codigo = 'GRUPO_SISBEN')
   ORDER BY m.version DESC LIMIT 1;
  IF v_origen IS NULL THEN
    RETURN;
  END IF;
  SELECT max(version) + 1 INTO v_version FROM matrices;
  UPDATE matrices SET estado = 'ARCHIVADA', vigente_hasta = now() WHERE id = v_actual;
  INSERT INTO matrices (version, estado, notas, desempate, vigente_desde, decidida_at, motivo_decision)
  SELECT v_version, 'VIGENTE',
         'Se restaura el grupo del SISBÉN IV: la opción que se quita es SiBus del transporte, no el SISBÉN.',
         desempate, now(), now(),
         'Corrección: el SISBÉN sigue vigente como criterio.'
    FROM matrices WHERE id = v_origen
  RETURNING id INTO v_nueva;
  INSERT INTO matriz_variables (matriz_id, codigo, nombre, descripcion, origen, peso, posicion)
  SELECT v_nueva, codigo, nombre, descripcion, origen, peso, posicion
    FROM matriz_variables WHERE matriz_id = v_origen;
  INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
  SELECT nv.id, o.codigo, o.etiqueta, o.puntos, o.posicion
    FROM matriz_variables ov
    JOIN matriz_opciones o ON o.variable_id = ov.id
    JOIN matriz_variables nv ON nv.matriz_id = v_nueva AND nv.codigo = ov.codigo
   WHERE ov.matriz_id = v_origen;
END
$$;
ALTER TABLE matriz_variables ENABLE TRIGGER matriz_variables_borrador;
ALTER TABLE matriz_opciones ENABLE TRIGGER matriz_opciones_borrador;
