-- Migración 008 · Documentos soporte (RF-CAR-03, RNF-06), radicación (RF-CAR-04) y modelos de carta.

-- ---------------------------------------------------------------------------------------------------------
-- Radicación: número único con fecha y hora, y el estado «Radicada».
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE solicitudes DROP CONSTRAINT solicitudes_estado_check;
ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_estado_check
  CHECK (estado IN ('PREINSCRITA', 'CORREO_VERIFICADO', 'RADICADA'));
ALTER TABLE solicitudes ADD COLUMN radicado text UNIQUE
  CHECK (radicado ~ '^EST-[0-9]{4}-[0-9]{6}$');
ALTER TABLE solicitudes ADD COLUMN radicada_at timestamptz;
ALTER TABLE solicitudes ADD CONSTRAINT radicado_con_fecha
  CHECK ((radicado IS NULL) = (radicada_at IS NULL));
ALTER TABLE solicitudes ADD CONSTRAINT radicada_tiene_radicado
  CHECK (estado <> 'RADICADA' OR radicado IS NOT NULL);

-- Consecutivo por año. El número se toma dentro de la misma transacción que radica la solicitud: si algo falla no
-- se pierde ningún número, y dos radicaciones simultáneas nunca reciben el mismo (la fila queda bloqueada).
CREATE TABLE radicado_consecutivos (
  anio   integer PRIMARY KEY CHECK (anio BETWEEN 2000 AND 2999),
  ultimo integer NOT NULL CHECK (ultimo > 0)
);

CREATE FUNCTION siguiente_radicado(p_anio integer) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO radicado_consecutivos (anio, ultimo) VALUES (p_anio, 1)
  ON CONFLICT (anio) DO UPDATE SET ultimo = radicado_consecutivos.ultimo + 1
  RETURNING ultimo INTO n;
  RETURN 'EST-' || p_anio || '-' || lpad(n::text, 6, '0');
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Documentos cargados por la ciudadanía (RNF-06): el archivo se guarda cifrado fuera de la base de datos y aquí
-- queda su registro con fecha, hash de integridad y estado. Un documento nunca se borra: al reemplazarlo el
-- anterior queda como «reemplazado».
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE documentos_solicitud (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id    integer NOT NULL REFERENCES solicitudes (id),
  documento_id    integer NOT NULL REFERENCES documentos_requeridos (id),
  estado          text NOT NULL DEFAULT 'CARGADO' CHECK (estado IN ('CARGADO', 'REEMPLAZADO', 'RECHAZADO')),
  nombre_original text NOT NULL CHECK (length(btrim(nombre_original)) BETWEEN 1 AND 200),
  formato         text NOT NULL CHECK (formato IN ('pdf', 'jpg', 'png')),
  mime            text NOT NULL,
  tamano_bytes    integer NOT NULL CHECK (tamano_bytes > 0),
  -- Hash SHA-256 del contenido original: permite demostrar que el archivo no cambió (RNF-06).
  sha256          char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Ubicación del archivo cifrado en el almacenamiento.
  ruta            text NOT NULL UNIQUE,
  origen          text NOT NULL DEFAULT 'CIUDADANO' CHECK (origen IN ('CIUDADANO', 'FUNCIONARIO')),
  cargado_por     integer REFERENCES usuarios (id),
  ip              text,
  cargado_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT origen_con_usuario_doc CHECK ((origen = 'FUNCIONARIO') = (cargado_por IS NOT NULL))
);
-- Solo un archivo vigente por documento y solicitud.
CREATE UNIQUE INDEX uq_documento_vigente ON documentos_solicitud (solicitud_id, documento_id)
  WHERE estado = 'CARGADO';
CREATE INDEX ix_documentos_solicitud ON documentos_solicitud (solicitud_id, documento_id, cargado_at);

CREATE FUNCTION documentos_solicitud_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los documentos cargados no se pueden borrar' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.solicitud_id IS DISTINCT FROM OLD.solicitud_id OR NEW.documento_id IS DISTINCT FROM OLD.documento_id
     OR NEW.nombre_original IS DISTINCT FROM OLD.nombre_original OR NEW.formato IS DISTINCT FROM OLD.formato
     OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.tamano_bytes IS DISTINCT FROM OLD.tamano_bytes
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.ruta IS DISTINCT FROM OLD.ruta
     OR NEW.cargado_at IS DISTINCT FROM OLD.cargado_at OR NEW.cargado_por IS DISTINCT FROM OLD.cargado_por
     OR NEW.origen IS DISTINCT FROM OLD.origen THEN
    RAISE EXCEPTION 'El registro de un documento cargado es inmutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Un documento reemplazado o rechazado no vuelve a ser el vigente.
  IF OLD.estado <> 'CARGADO' AND NEW.estado <> OLD.estado THEN
    RAISE EXCEPTION 'Un documento % no cambia de estado', lower(OLD.estado) USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documentos_solicitud_inmutables BEFORE UPDATE OR DELETE ON documentos_solicitud
  FOR EACH ROW EXECUTE FUNCTION documentos_solicitud_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Modelos descargables (RF-CAR-03): la carta de solicitud y el formato de carta de cuidador los entrega la Gerencia
-- y los administra desde el portal interno. Son públicos, por eso no van cifrados.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE documento_modelos (
  documento_id    integer PRIMARY KEY REFERENCES documentos_requeridos (id),
  nombre_original text NOT NULL CHECK (length(btrim(nombre_original)) BETWEEN 1 AND 200),
  formato         text NOT NULL CHECK (formato IN ('pdf', 'docx', 'odt')),
  mime            text NOT NULL,
  tamano_bytes    integer NOT NULL CHECK (tamano_bytes > 0),
  sha256          char(64) NOT NULL,
  ruta            text NOT NULL,
  cargado_por     integer NOT NULL REFERENCES usuarios (id),
  cargado_at      timestamptz NOT NULL DEFAULT now()
);
