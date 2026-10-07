-- Migración 007 · Caracterización de la PCD y del cuidador (RF-CAR-01, RF-CAR-02), guardado de avance (RF-CAR-04),
-- historial de correcciones (RNF-10) y datos sensibles cifrados (RNF-03).

-- ---------------------------------------------------------------------------------------------------------
-- Catálogos administrables del formulario (RF-CAR-01): se agregan a los que ya existen.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE catalogo_items DROP CONSTRAINT catalogo_items_catalogo_check;
ALTER TABLE catalogo_items ADD CONSTRAINT catalogo_items_catalogo_check CHECK (catalogo IN (
  'TIPO_IDENTIFICACION', 'LOCALIDAD', 'BARRIO', 'EPS', 'TIPO_TRANSPORTE',
  'GENERO', 'ESTADO_CIVIL', 'ETNIA', 'ESCOLARIDAD', 'OCUPACION',
  'CAUSAL_BLOQUEO', 'CAUSAL_REVOCATORIA'));

INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('GENERO', 'FEMENINO', 'Femenino', 1),
  ('GENERO', 'MASCULINO', 'Masculino', 2),
  ('GENERO', 'OTRO', 'Otro', 3),
  ('GENERO', 'NA', 'N/A', 4),

  ('ESTADO_CIVIL', 'CASADO', 'Casado/a', 1),
  ('ESTADO_CIVIL', 'DIVORCIADO', 'Divorciado/a', 2),
  ('ESTADO_CIVIL', 'SOLTERO', 'Soltero/a', 3),
  ('ESTADO_CIVIL', 'UNION_LIBRE', 'Unión libre', 4),
  ('ESTADO_CIVIL', 'VIUDO', 'Viudo/a', 5),
  ('ESTADO_CIVIL', 'NA', 'N/A', 6),

  ('ETNIA', 'AFRODESCENDIENTE', 'Afrodescendiente', 1),
  ('ETNIA', 'INDIGENA', 'Indígena', 2),
  ('ETNIA', 'RAIZAL', 'Raizal', 3),
  ('ETNIA', 'NINGUNA', 'Ninguna', 4),
  ('ETNIA', 'NA', 'N/A', 5),

  -- Niveles de la educación formal colombiana, de la educación inicial al doctorado (la Gerencia puede ajustarlos).
  ('ESCOLARIDAD', 'EDUCACION_INICIAL', 'Educación inicial', 1),
  ('ESCOLARIDAD', 'PREESCOLAR', 'Preescolar', 2),
  ('ESCOLARIDAD', 'BASICA_PRIMARIA', 'Básica primaria', 3),
  ('ESCOLARIDAD', 'BASICA_SECUNDARIA', 'Básica secundaria', 4),
  ('ESCOLARIDAD', 'MEDIA', 'Media (bachillerato)', 5),
  ('ESCOLARIDAD', 'TECNICA_PROFESIONAL', 'Técnica profesional', 6),
  ('ESCOLARIDAD', 'TECNOLOGICA', 'Tecnológica', 7),
  ('ESCOLARIDAD', 'UNIVERSITARIA', 'Profesional universitaria', 8),
  ('ESCOLARIDAD', 'ESPECIALIZACION', 'Especialización', 9),
  ('ESCOLARIDAD', 'MAESTRIA', 'Maestría', 10),
  ('ESCOLARIDAD', 'DOCTORADO', 'Doctorado', 11),
  ('ESCOLARIDAD', 'NINGUNA', 'Ninguna', 12),
  ('ESCOLARIDAD', 'NA', 'N/A', 13),

  ('OCUPACION', 'AMA_DE_CASA', 'Ama de casa', 1),
  ('OCUPACION', 'DESEMPLEADO', 'Desempleado/a', 2),
  ('OCUPACION', 'EMPLEADO', 'Empleado/a', 3),
  ('OCUPACION', 'ESTUDIANTE', 'Estudiante', 4),
  ('OCUPACION', 'INDEPENDIENTE', 'Independiente', 5),
  ('OCUPACION', 'JUBILADO', 'Jubilado/a', 6),
  ('OCUPACION', 'NINGUNO', 'Ninguno', 7),
  ('OCUPACION', 'NA', 'N/A', 8);

-- ---------------------------------------------------------------------------------------------------------
-- Caracterización: una por solicitud. Todo es opcional en la base porque el avance se guarda a medias (RF-CAR-04);
-- la completitud se valida en la aplicación antes de radicar. Los datos de salud, condición socioeconómica y
-- etnia (sensibles según la Ley 1581 de 2012) se guardan cifrados con AES-256-GCM (RNF-03).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE caracterizaciones (
  solicitud_id          integer PRIMARY KEY REFERENCES solicitudes (id),
  -- Control de concurrencia: dos pestañas abiertas no se pisan entre sí.
  version               integer NOT NULL DEFAULT 1,

  -- Persona con discapacidad.
  pcd_genero_id         integer REFERENCES catalogo_items (id),
  pcd_telefono_fijo     text CHECK (pcd_telefono_fijo ~ '^(\d{7}|60\d{8})$'),
  pcd_celular           text CHECK (pcd_celular ~ '^3\d{9}$'),
  pcd_fecha_nacimiento  date CHECK (pcd_fecha_nacimiento >= DATE '1900-01-01'),
  pcd_estado_civil_id   integer REFERENCES catalogo_items (id),
  tiene_hijos           boolean,
  hijos_cantidad        smallint CHECK (hijos_cantidad BETWEEN 1 AND 20),
  -- Una edad por hijo; una posición vacía es una edad que aún no se ha escrito.
  hijos_edades          smallint[],
  pcd_escolaridad_id    integer REFERENCES catalogo_items (id),
  pcd_ocupacion_id      integer REFERENCES catalogo_items (id),

  -- Etnia, EPS, embarazo y subsidios: JSON cifrado.
  datos_sensibles       bytea,

  -- Transporte y cuidador.
  tipo_transporte_id    integer REFERENCES catalogo_items (id),
  justificacion_transporte text CHECK (length(btrim(justificacion_transporte)) BETWEEN 3 AND 500),
  requiere_cuidador     boolean,

  -- Cuidador (RF-CAR-02): son datos de esta solicitud; el nombre y la identificación viven en `personas`.
  cuidador_genero_id    integer REFERENCES catalogo_items (id),
  cuidador_telefono_fijo text CHECK (cuidador_telefono_fijo ~ '^(\d{7}|60\d{8})$'),
  cuidador_celular      text CHECK (cuidador_celular ~ '^3\d{9}$'),
  cuidador_correo       text CHECK (cuidador_correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(cuidador_correo) <= 150),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hijos_coherentes CHECK (
    tiene_hijos IS TRUE OR (hijos_cantidad IS NULL AND hijos_edades IS NULL)),
  CONSTRAINT hijos_edades_segun_cantidad CHECK (
    hijos_edades IS NULL OR (hijos_cantidad IS NOT NULL AND cardinality(hijos_edades) = hijos_cantidad)),
  -- Sin cuidador no hay datos del cuidador (RF-CAR-02).
  CONSTRAINT cuidador_solo_si_se_requiere CHECK (
    requiere_cuidador IS TRUE OR (cuidador_genero_id IS NULL AND cuidador_telefono_fijo IS NULL
      AND cuidador_celular IS NULL AND cuidador_correo IS NULL))
);

-- ---------------------------------------------------------------------------------------------------------
-- Historial de correcciones (RNF-10): valor anterior, valor nuevo, usuario y fecha de cada dato corregido.
-- Los valores de los datos sensibles se guardan cifrados. Solo se inserta: nunca se edita ni se borra.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE historial_correcciones (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id   integer REFERENCES solicitudes (id),
  entidad        text NOT NULL CHECK (entidad IN ('persona', 'caracterizacion')),
  entidad_id     integer NOT NULL,
  campo          text NOT NULL,
  valor_anterior text,
  valor_nuevo    text,
  -- Si es verdadero, los valores son texto cifrado en base64.
  sensible       boolean NOT NULL DEFAULT false,
  -- Quien corrigió: un funcionario (usuario_id) o la persona con su acceso a la solicitud.
  usuario_id     integer REFERENCES usuarios (id),
  origen         text NOT NULL CHECK (origen IN ('CIUDADANO', 'FUNCIONARIO')),
  ip             text,
  creado_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT origen_con_usuario CHECK ((origen = 'FUNCIONARIO') = (usuario_id IS NOT NULL))
);
CREATE INDEX ix_historial_correcciones_solicitud ON historial_correcciones (solicitud_id, creado_at);
CREATE TRIGGER historial_correcciones_inmutable BEFORE UPDATE OR DELETE ON historial_correcciones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Cuidador asociado a más de una PCD en la misma vigencia (RN-01, RF-CAR-02): se permite, pero queda marcado para
-- que el auditor y el asignador sepan que solo podrá recibir un beneficio.
-- ---------------------------------------------------------------------------------------------------------
CREATE VIEW solicitudes_cuidador_compartido AS
SELECT s.id AS solicitud_id, count(o.id)::integer AS otras_solicitudes
  FROM solicitudes s
  JOIN solicitudes o ON o.cuidador_id = s.cuidador_id AND o.vigencia_id = s.vigencia_id AND o.pcd_id <> s.pcd_id
 GROUP BY s.id;
