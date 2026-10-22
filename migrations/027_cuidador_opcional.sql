-- Migración 027 · No toda persona con discapacidad tiene cuidador: en la preinscripción el cuidador es opcional.
-- Sin cuidador, la solicitud queda con cuidador_id nulo y el beneficio cubre a una sola persona.
ALTER TABLE solicitudes ALTER COLUMN cuidador_id DROP NOT NULL;
