-- Migración 025 · Los textos que ven los funcionarios (descripciones de parámetros, plantillas, permisos...) no llevan
-- las referencias internas a los requisitos de la propuesta, como «(RF-ASI-05)».
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.column_name IN ('descripcion', 'nombre') AND c.data_type = 'text'
  LOOP
    BEGIN
      EXECUTE format(
        $q$UPDATE %I SET %I = btrim(regexp_replace(%I, '\s*\((?:RNF?|RF)-[A-Z]+(?:-[0-9]+)?(?:,\s*(?:RNF?|RF)-[A-Z]+(?:-[0-9]+)?)*\)', '', 'g'))
            WHERE %I ~ '\((?:RNF?|RF)-'$q$,
        t.table_name, t.column_name, t.column_name, t.column_name);
    EXCEPTION WHEN OTHERS THEN
      -- Tablas de solo inserción (historiales, bitácora): no se tocan.
      NULL;
    END;
  END LOOP;
END
$$;
