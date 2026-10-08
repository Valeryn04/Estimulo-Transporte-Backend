-- Migración 010 · El orden de una lista no se repite.
-- Cada elemento ocupa una posición propia (1, 2, 3…): en cada catálogo (y, en los barrios, en cada localidad)
-- y en la lista de documentos exigidos. Al darle a un elemento la posición de otro, la aplicación mueve los demás
-- (nunca quedan dos con el mismo número). La restricción se revisa al terminar la transacción para que ese
-- movimiento pueda hacerse en varios pasos.

-- Ordena lo que ya existe: conserva el orden actual y desempata por nombre.
UPDATE catalogo_items c SET orden = r.n
  FROM (SELECT id, (row_number() OVER (PARTITION BY catalogo, padre_id ORDER BY orden, lower(nombre), id))::int AS n
          FROM catalogo_items) r
 WHERE c.id = r.id AND c.orden <> r.n;

UPDATE documentos_requeridos d SET orden = r.n
  FROM (SELECT id, (row_number() OVER (ORDER BY orden, lower(nombre), id))::int AS n
          FROM documentos_requeridos) r
 WHERE d.id = r.id AND d.orden <> r.n;

ALTER TABLE catalogo_items
  ADD CONSTRAINT ck_catalogo_orden_positivo CHECK (orden >= 1),
  ADD CONSTRAINT uq_catalogo_orden UNIQUE NULLS NOT DISTINCT (catalogo, padre_id, orden)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE documentos_requeridos
  ADD CONSTRAINT ck_documento_orden_positivo CHECK (orden >= 1),
  ADD CONSTRAINT uq_documento_orden UNIQUE (orden) DEFERRABLE INITIALLY DEFERRED;
