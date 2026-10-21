-- Migración 022 · Encuestas de satisfacción (RF-NOV-04).

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('encuestas.administrar', 'Encuestas', 'Crear, publicar y cerrar encuestas de satisfacción'),
  ('encuestas.resultados',  'Encuestas', 'Ver los resultados anonimizados de las encuestas');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR' AND p.codigo IN ('encuestas.administrar', 'encuestas.resultados');
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('RESPONSABLE_PROCESO', 'encuestas.resultados'),
  ('ANALISTA', 'encuestas.resultados'),
  ('CONTROL_INTERNO', 'encuestas.resultados'),
  ('GESTOR_NOVEDADES', 'encuestas.resultados')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

CREATE TABLE encuestas (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  titulo         text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 5 AND 150),
  descripcion    text NOT NULL DEFAULT '' CHECK (length(descripcion) <= 1000),
  estado         text NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'PUBLICADA', 'CERRADA')),
  -- Periodo de vigencia: solo se responde dentro de estas fechas.
  vigente_desde  date NOT NULL,
  vigente_hasta  date NOT NULL,
  creada_por     integer NOT NULL REFERENCES usuarios (id),
  creada_at      timestamptz NOT NULL DEFAULT now(),
  publicada_at   timestamptz,
  cerrada_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encuesta_periodo CHECK (vigente_hasta >= vigente_desde)
);
CREATE TRIGGER encuestas_version BEFORE UPDATE ON encuestas
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER encuestas_historial AFTER INSERT OR UPDATE ON encuestas
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

CREATE TABLE encuesta_preguntas (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encuesta_id integer NOT NULL REFERENCES encuestas (id),
  posicion    integer NOT NULL,
  tipo        text NOT NULL CHECK (tipo IN ('SELECCION', 'ESCALA', 'TEXTO')),
  texto       text NOT NULL CHECK (length(btrim(texto)) BETWEEN 5 AND 300),
  obligatoria boolean NOT NULL DEFAULT true,
  -- SELECCION: lista de opciones.
  opciones    text[],
  -- ESCALA: de 1 al máximo (por ejemplo, 1 a 5).
  escala_max  smallint CHECK (escala_max BETWEEN 3 AND 10),
  UNIQUE (encuesta_id, posicion),
  CONSTRAINT pregunta_segun_tipo CHECK (
    (tipo = 'SELECCION' AND cardinality(opciones) BETWEEN 2 AND 12 AND escala_max IS NULL)
    OR (tipo = 'ESCALA' AND escala_max IS NOT NULL AND opciones IS NULL)
    OR (tipo = 'TEXTO' AND opciones IS NULL AND escala_max IS NULL))
);

-- Una encuesta publicada no cambia sus preguntas.
CREATE FUNCTION encuesta_preguntas_solo_borrador() RETURNS trigger AS $$
DECLARE
  v_estado text;
BEGIN
  SELECT estado INTO v_estado FROM encuestas WHERE id = COALESCE(NEW.encuesta_id, OLD.encuesta_id);
  IF v_estado IS DISTINCT FROM 'BORRADOR' THEN
    RAISE EXCEPTION 'Una encuesta publicada no cambia sus preguntas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER encuesta_preguntas_borrador BEFORE INSERT OR UPDATE OR DELETE ON encuesta_preguntas
  FOR EACH ROW EXECUTE FUNCTION encuesta_preguntas_solo_borrador();

-- Invitaciones: aquí vive la identidad del beneficiario (para no invitarlo ni dejarlo responder dos veces).
CREATE TABLE encuesta_invitaciones (
  encuesta_id   integer NOT NULL REFERENCES encuestas (id),
  beneficio_id  bigint NOT NULL REFERENCES beneficios (id),
  token_hash    text NOT NULL UNIQUE,
  enviada_at    timestamptz NOT NULL DEFAULT now(),
  respondida_at timestamptz,
  PRIMARY KEY (encuesta_id, beneficio_id)
);

-- Respuestas: sin ninguna referencia al beneficiario ni a la invitación (análisis anonimizado). Solo la localidad
-- y la fecha del día, para poder segmentar sin identificar.
CREATE TABLE encuesta_respuestas (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encuesta_id   integer NOT NULL REFERENCES encuestas (id),
  localidad_id  integer REFERENCES catalogo_items (id),
  dia           date NOT NULL DEFAULT CURRENT_DATE,
  -- { "<preguntaId>": valor }
  respuestas    jsonb NOT NULL
);
CREATE INDEX ix_encuesta_respuestas ON encuesta_respuestas (encuesta_id);
CREATE TRIGGER encuesta_respuestas_inmutables BEFORE UPDATE OR DELETE ON encuesta_respuestas
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('ENCUESTA_INVITACION', 'Invitación a la encuesta de satisfacción',
   'Se envía a los beneficiarios activos al publicar una encuesta, con el enlace personal para responderla (RF-NOV-04).',
   ARRAY['nombre', 'titulo_encuesta', 'fecha_limite', 'enlace_encuesta'],
   ARRAY['titulo_encuesta', 'fecha_limite', 'enlace_encuesta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('ENCUESTA_INVITACION', 1,
   'Queremos conocer su opinión: {{titulo_encuesta}}',
   $c$Hola:

Como beneficiario(a) del Estímulo Social de Transporte, queremos conocer su opinión sobre el servicio.

Encuesta: {{titulo_encuesta}}
Puede responderla hasta el {{fecha_limite}} en este enlace personal:
{{enlace_encuesta}}

Solo se puede responder una vez. Sus respuestas se analizan de forma anónima: no se asocian con su nombre ni su documento.$c$, 'Texto inicial');
