-- Migración 011 · Las listas ya no tienen un número de orden.
-- Los desplegables se muestran por nombre (A-Z): no hay nada que ordenar a mano ni números que se repitan.
ALTER TABLE catalogo_items
  DROP CONSTRAINT IF EXISTS uq_catalogo_orden,
  DROP CONSTRAINT IF EXISTS ck_catalogo_orden_positivo,
  DROP COLUMN orden;

ALTER TABLE documentos_requeridos
  DROP CONSTRAINT IF EXISTS uq_documento_orden,
  DROP CONSTRAINT IF EXISTS ck_documento_orden_positivo,
  DROP COLUMN orden;
