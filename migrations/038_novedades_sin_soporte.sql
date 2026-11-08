-- Migración 038 · Las novedades (bloqueo, suspensión, reactivación y finalización) y los ajustes de cupos ya no exigen
-- adjuntar un soporte: solo la justificación es obligatoria. Si se adjunta algo, se sigue guardando.
ALTER TABLE novedades
  ALTER COLUMN evidencia_ruta DROP NOT NULL,
  ALTER COLUMN evidencia_nombre DROP NOT NULL,
  ALTER COLUMN evidencia_mime DROP NOT NULL,
  ALTER COLUMN evidencia_tamano DROP NOT NULL,
  ALTER COLUMN evidencia_sha256 DROP NOT NULL;
ALTER TABLE cupos_ajustes DROP CONSTRAINT ajuste_con_soporte;
