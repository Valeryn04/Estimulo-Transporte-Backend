-- Migración 018 · Priorización: matriz de ponderación versionada (RF-PRI-02), cálculo del puntaje con trazabilidad
-- (RF-PRI-01), excepciones justificadas (RF-PRI-03) y listado priorizado (RF-PRI-04).

-- ---------------------------------------------------------------------------------------------------------
-- Permisos. Aprobar la matriz o una excepción es del responsable del proceso, y nunca de quien la propuso.
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('matriz.administrar',    'Priorización', 'Configurar la matriz de ponderación y simular sus cambios'),
  ('priorizacion.ver',      'Priorización', 'Ver los puntajes, el listado priorizado y las excepciones'),
  ('priorizacion.calcular', 'Priorización', 'Calcular el puntaje de los casos validados, de forma individual o masiva'),
  ('priorizacion.proponer', 'Priorización', 'Proponer ajustes de prioridad para casos especiales'),
  ('priorizacion.aprobar',  'Priorización', 'Aprobar o rechazar versiones de la matriz y excepciones');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR'
   AND p.codigo IN ('matriz.administrar', 'priorizacion.ver', 'priorizacion.calcular', 'priorizacion.proponer', 'priorizacion.aprobar');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('ASIGNADOR', 'priorizacion.ver'),
  ('ASIGNADOR', 'priorizacion.calcular'),
  ('ASIGNADOR', 'priorizacion.proponer'),
  ('RESPONSABLE_PROCESO', 'priorizacion.ver'),
  ('RESPONSABLE_PROCESO', 'priorizacion.calcular'),
  ('RESPONSABLE_PROCESO', 'priorizacion.aprobar'),
  ('ANALISTA', 'priorizacion.ver'),
  ('CONTROL_INTERNO', 'priorizacion.ver')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

-- Un caso con puntaje pasa a «Priorizada».
ALTER TABLE solicitudes DROP CONSTRAINT solicitudes_estado_check;
ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_estado_check CHECK (estado IN (
  'PREINSCRITA', 'CORREO_VERIFICADO', 'RADICADA',
  'EN_REVISION', 'EN_SUBSANACION', 'SUBSANADA', 'VALIDADA', 'NO_CUMPLE', 'PRIORIZADA'));

-- ---------------------------------------------------------------------------------------------------------
-- Matriz de ponderación. Cada cambio es una versión nueva: solo se edita mientras es borrador; al aprobarse queda
-- vigente y las anteriores se archivan. Los cálculos guardan la versión con la que se hicieron.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE matrices (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version         integer NOT NULL UNIQUE CHECK (version >= 1),
  estado          text NOT NULL CHECK (estado IN ('BORRADOR', 'EN_APROBACION', 'VIGENTE', 'ARCHIVADA', 'RECHAZADA')),
  notas           text NOT NULL DEFAULT '' CHECK (length(notas) <= 1000),
  -- Criterios de desempate en orden: 'VARIABLE:<CODIGO>' (gana el mayor aporte) o 'FECHA_RADICACION' (gana la más antigua).
  desempate       text[] NOT NULL DEFAULT '{}',
  creada_por      integer REFERENCES usuarios (id),
  creada_at       timestamptz NOT NULL DEFAULT now(),
  solicitada_por  integer REFERENCES usuarios (id),
  solicitada_at   timestamptz,
  decidida_por    integer REFERENCES usuarios (id),
  decidida_at     timestamptz,
  motivo_decision text CHECK (motivo_decision IS NULL OR length(motivo_decision) <= 1000),
  vigente_desde   timestamptz,
  vigente_hasta   timestamptz
);
-- Solo una vigente y solo una en construcción a la vez.
CREATE UNIQUE INDEX uq_matriz_vigente ON matrices ((true)) WHERE estado = 'VIGENTE';
CREATE UNIQUE INDEX uq_matriz_abierta ON matrices ((true)) WHERE estado IN ('BORRADOR', 'EN_APROBACION');

CREATE TABLE matriz_variables (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  matriz_id   integer NOT NULL REFERENCES matrices (id),
  codigo      text NOT NULL CHECK (codigo ~ '^[A-Z0-9_]{2,60}$'),
  nombre      text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 3 AND 150),
  descripcion text NOT NULL DEFAULT '' CHECK (length(descripcion) <= 500),
  -- VALIDADOR: lo registra el validador al revisar el caso. SUBSIDIOS: sale de la caracterización (recibe subsidios).
  origen      text NOT NULL CHECK (origen IN ('VALIDADOR', 'SUBSIDIOS')),
  peso        numeric(6, 2) NOT NULL DEFAULT 1 CHECK (peso > 0 AND peso <= 100),
  posicion    integer NOT NULL DEFAULT 0,
  UNIQUE (matriz_id, codigo)
);

CREATE TABLE matriz_opciones (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variable_id integer NOT NULL REFERENCES matriz_variables (id),
  codigo      text NOT NULL CHECK (codigo ~ '^[A-Z0-9_]{1,60}$'),
  etiqueta    text NOT NULL CHECK (length(btrim(etiqueta)) BETWEEN 1 AND 100),
  puntos      numeric(6, 2) NOT NULL CHECK (puntos >= 0 AND puntos <= 100),
  posicion    integer NOT NULL DEFAULT 0,
  UNIQUE (variable_id, codigo)
);

-- Una versión que ya no es borrador no se toca: ni sus variables ni sus opciones.
CREATE FUNCTION matriz_solo_borrador() RETURNS trigger AS $$
DECLARE
  v_matriz integer;
  v_estado text;
BEGIN
  IF TG_TABLE_NAME = 'matriz_variables' THEN
    v_matriz := COALESCE(NEW.matriz_id, OLD.matriz_id);
  ELSE
    SELECT matriz_id INTO v_matriz FROM matriz_variables WHERE id = COALESCE(NEW.variable_id, OLD.variable_id);
  END IF;
  SELECT estado INTO v_estado FROM matrices WHERE id = v_matriz;
  IF v_estado IS DISTINCT FROM 'BORRADOR' THEN
    RAISE EXCEPTION 'La versión de la matriz ya no es un borrador y no se puede modificar' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER matriz_variables_borrador BEFORE INSERT OR UPDATE OR DELETE ON matriz_variables
  FOR EACH ROW EXECUTE FUNCTION matriz_solo_borrador();
CREATE TRIGGER matriz_opciones_borrador BEFORE INSERT OR UPDATE OR DELETE ON matriz_opciones
  FOR EACH ROW EXECUTE FUNCTION matriz_solo_borrador();
CREATE TRIGGER matrices_no_borrar BEFORE DELETE ON matrices
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- Versión inicial: variables mínimas del documento (RF-PRI-01) con ponderaciones de partida que la Gerencia de
-- Desarrollo Social debe validar (se ajustan con una versión nueva, sin tocar el código).
INSERT INTO matrices (version, estado, notas, desempate)
VALUES (1, 'BORRADOR',
        'Versión inicial con ponderaciones de partida: pendientes de validación por la Gerencia de Desarrollo Social.',
        ARRAY['VARIABLE:DEPENDENCIA_FUNCIONAL', 'VARIABLE:GRUPO_SISBEN', 'FECHA_RADICACION']);

INSERT INTO matriz_variables (matriz_id, codigo, nombre, descripcion, origen, peso, posicion)
SELECT m.id, v.codigo, v.nombre, v.descripcion, v.origen, 1, v.pos
  FROM matrices m, (VALUES
    ('DEPENDENCIA_FUNCIONAL', 'Dependencia funcional', 'Grado de dependencia funcional según el certificado de discapacidad.', 'VALIDADOR', 1),
    ('GRUPO_SISBEN', 'Grupo del SISBÉN IV', 'Grupo de clasificación, desde el de mayor vulnerabilidad.', 'VALIDADOR', 2),
    ('ENFERMEDAD_CRONICA', 'Enfermedades crónicas o tratamientos frecuentes', 'La persona tiene una enfermedad crónica o requiere tratamientos frecuentes.', 'VALIDADOR', 3),
    ('POBREZA_DESPLAZAMIENTO', 'Pobreza extrema o desplazamiento', 'El hogar está en pobreza extrema o es víctima de desplazamiento.', 'VALIDADOR', 4),
    ('HOGAR_VULNERABLE', 'Hogar monoparental o cuidador vulnerable', 'Hogar monoparental, o cuidador mayor o con discapacidad.', 'VALIDADOR', 5),
    ('EDAD_EXTREMA_MULTIPLE', 'Edad extrema o múltiples discapacidades', 'Niñez o vejez, o más de una discapacidad.', 'VALIDADOR', 6),
    ('AUSENCIA_SUBSIDIOS', 'Ausencia de otros subsidios', 'No recibe otros subsidios o beneficios (sale de la caracterización).', 'SUBSIDIOS', 7)
  ) AS v (codigo, nombre, descripcion, origen, pos)
 WHERE m.version = 1;

INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
SELECT mv.id, o.codigo, o.etiqueta, o.puntos, o.pos
  FROM matriz_variables mv JOIN (VALUES
    ('DEPENDENCIA_FUNCIONAL', 'SEVERA', 'Severa', 25, 1),
    ('DEPENDENCIA_FUNCIONAL', 'MODERADA', 'Moderada', 15, 2),
    ('DEPENDENCIA_FUNCIONAL', 'LEVE', 'Leve', 5, 3),
    ('GRUPO_SISBEN', 'GRUPO_A', 'Grupo A', 20, 1),
    ('GRUPO_SISBEN', 'GRUPO_B', 'Grupo B', 15, 2),
    ('GRUPO_SISBEN', 'GRUPO_C', 'Grupo C', 8, 3),
    ('ENFERMEDAD_CRONICA', 'SI', 'Sí', 10, 1),
    ('ENFERMEDAD_CRONICA', 'NO', 'No', 0, 2),
    ('POBREZA_DESPLAZAMIENTO', 'SI', 'Sí', 10, 1),
    ('POBREZA_DESPLAZAMIENTO', 'NO', 'No', 0, 2),
    ('HOGAR_VULNERABLE', 'SI', 'Sí', 10, 1),
    ('HOGAR_VULNERABLE', 'NO', 'No', 0, 2),
    ('EDAD_EXTREMA_MULTIPLE', 'SI', 'Sí', 10, 1),
    ('EDAD_EXTREMA_MULTIPLE', 'NO', 'No', 0, 2),
    ('AUSENCIA_SUBSIDIOS', 'SIN_SUBSIDIOS', 'No recibe otros subsidios', 5, 1),
    ('AUSENCIA_SUBSIDIOS', 'CON_SUBSIDIOS', 'Recibe otros subsidios', 0, 2)
  ) AS o (variable, codigo, etiqueta, puntos, pos) ON o.variable = mv.codigo
 WHERE mv.matriz_id = (SELECT id FROM matrices WHERE version = 1);

UPDATE matrices SET estado = 'VIGENTE', vigente_desde = now() WHERE version = 1;

-- ---------------------------------------------------------------------------------------------------------
-- Cálculos del puntaje (RF-PRI-01). Nunca se sobrescriben: un cálculo nuevo deja el anterior como historia.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE priorizaciones (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id  integer NOT NULL REFERENCES solicitudes (id),
  matriz_id     integer NOT NULL REFERENCES matrices (id),
  puntaje       numeric(7, 2) NOT NULL,
  -- [{ variable, nombre, valor, etiqueta, puntos, peso, aporte }]
  detalle       jsonb NOT NULL,
  vigente       boolean NOT NULL DEFAULT true,
  -- NULL: se calculó solo, al aprobar la validación.
  calculado_por integer REFERENCES usuarios (id),
  calculado_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_priorizacion_vigente ON priorizaciones (solicitud_id) WHERE vigente;
CREATE INDEX ix_priorizaciones_solicitud ON priorizaciones (solicitud_id, calculado_at DESC);
CREATE TRIGGER priorizaciones_no_borrar BEFORE DELETE ON priorizaciones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Excepciones (RF-PRI-03): ajuste de puntaje con justificación, evidencia y aprobación. El cálculo automático no se
-- toca: el puntaje final es el calculado más el ajuste aprobado.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE priorizacion_excepciones (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id      integer NOT NULL REFERENCES solicitudes (id),
  priorizacion_id   bigint NOT NULL REFERENCES priorizaciones (id),
  ajuste            numeric(6, 2) NOT NULL CHECK (ajuste BETWEEN -100 AND 100 AND ajuste <> 0),
  justificacion     text NOT NULL CHECK (length(btrim(justificacion)) BETWEEN 20 AND 2000),
  evidencia_ruta    text NOT NULL,
  evidencia_nombre  text NOT NULL,
  evidencia_mime    text NOT NULL,
  evidencia_tamano  integer NOT NULL,
  evidencia_sha256  text NOT NULL,
  estado            text NOT NULL DEFAULT 'PROPUESTA' CHECK (estado IN ('PROPUESTA', 'APROBADA', 'RECHAZADA')),
  propuesta_por     integer NOT NULL REFERENCES usuarios (id),
  propuesta_at      timestamptz NOT NULL DEFAULT now(),
  decidida_por      integer REFERENCES usuarios (id),
  decidida_at       timestamptz,
  motivo_decision   text CHECK (motivo_decision IS NULL OR length(motivo_decision) <= 1000),
  CONSTRAINT excepcion_decision_coherente CHECK (
    (estado = 'PROPUESTA') = (decidida_por IS NULL AND decidida_at IS NULL)),
  CONSTRAINT excepcion_aprobador_distinto CHECK (decidida_por IS NULL OR decidida_por <> propuesta_por)
);
-- Una propuesta abierta por caso, y una sola aprobada por cálculo.
CREATE UNIQUE INDEX uq_excepcion_abierta ON priorizacion_excepciones (solicitud_id) WHERE estado = 'PROPUESTA';
CREATE UNIQUE INDEX uq_excepcion_aprobada ON priorizacion_excepciones (priorizacion_id) WHERE estado = 'APROBADA';
CREATE INDEX ix_excepciones_estado ON priorizacion_excepciones (estado, propuesta_at DESC);

CREATE FUNCTION excepcion_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.estado <> 'PROPUESTA' THEN
    RAISE EXCEPTION 'Las excepciones decididas no se modifican ni se eliminan' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER excepciones_inmutables BEFORE UPDATE OR DELETE ON priorizacion_excepciones
  FOR EACH ROW EXECUTE FUNCTION excepcion_inmutable();
