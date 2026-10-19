-- Migración 017 · Estructuras y cargas de archivos de cruce (RF-ADM-05) y alertas de la validación (RF-VAL-03).

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('cruces.administrar', 'Cruces', 'Configurar las estructuras de los archivos de cruce y cargarlos');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, 'cruces.administrar' FROM roles r
 WHERE r.codigo IN ('ADMINISTRADOR', 'RESPONSABLE_PROCESO', 'GESTOR_NOVEDADES');

-- ---------------------------------------------------------------------------------------------------------
-- Estructura de cada archivo de cruce: qué entidad lo entrega y en qué columna viene el número de identificación.
-- El código es el que usan los requisitos de la lista de chequeo (requisitos_validacion.cruce_codigo).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE cruce_estructuras (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo                 text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9_]{3,60}$'),
  nombre                 text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 3 AND 100),
  entidad                text NOT NULL DEFAULT '' CHECK (length(entidad) <= 150),
  descripcion            text NOT NULL DEFAULT '' CHECK (length(descripcion) <= 500),
  -- Encabezados del archivo (CSV con la primera fila de títulos).
  columna_identificacion text NOT NULL CHECK (length(btrim(columna_identificacion)) BETWEEN 2 AND 60),
  columna_detalle        text CHECK (columna_detalle IS NULL OR length(btrim(columna_detalle)) BETWEEN 2 AND 60),
  -- A qué personas se les busca: la persona con discapacidad, el cuidador o ambos.
  aplica_a               text NOT NULL DEFAULT 'AMBOS' CHECK (aplica_a IN ('PCD', 'CUIDADOR', 'AMBOS')),
  activo                 boolean NOT NULL DEFAULT true,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cruce_estructura_nombre ON cruce_estructuras (lower(btrim(nombre)));
CREATE TRIGGER cruce_estructuras_version BEFORE UPDATE ON cruce_estructuras
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER cruce_estructuras_historial AFTER INSERT OR UPDATE ON cruce_estructuras
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

INSERT INTO cruce_estructuras (codigo, nombre, entidad, descripcion, columna_identificacion, columna_detalle, aplica_a) VALUES
  ('BENEFICIOS_INCOMPATIBLES', 'Apoyos de transporte incompatibles', 'Gestión Social',
   'Personas que ya reciben apoyos distritales de transporte equivalentes o incompatibles, por ejemplo el ESTE (RN-04).',
   'IDENTIFICACION', 'BENEFICIO', 'AMBOS'),
  ('TRANSMETRO', 'Uso del sistema de transporte masivo', 'Transmetro',
   'Registro de uso de la tarjeta del sistema de transporte masivo (novedades periódicas).',
   'IDENTIFICACION', 'ESTADO', 'PCD'),
  ('DEFUNCIONES', 'Registro de defunciones', 'Registraduría / Secretaría de Salud',
   'Personas fallecidas, para suspender el beneficio y evitar pagos indebidos (novedades periódicas).',
   'IDENTIFICACION', 'FECHA_DEFUNCION', 'AMBOS');

-- ---------------------------------------------------------------------------------------------------------
-- Cada archivo cargado. La carga vigente de una estructura es la última; las anteriores quedan como historia.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE cruce_cargas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estructura_id   integer NOT NULL REFERENCES cruce_estructuras (id),
  archivo_nombre  text NOT NULL CHECK (length(archivo_nombre) <= 200),
  archivo_hash    text NOT NULL,
  filas_total     integer NOT NULL CHECK (filas_total >= 0),
  filas_validas   integer NOT NULL CHECK (filas_validas >= 0),
  filas_error     integer NOT NULL CHECK (filas_error >= 0),
  vigente         boolean NOT NULL DEFAULT true,
  cargado_por     integer NOT NULL REFERENCES usuarios (id),
  cargado_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cruce_carga_vigente ON cruce_cargas (estructura_id) WHERE vigente;
CREATE INDEX ix_cruce_cargas_estructura ON cruce_cargas (estructura_id, cargado_at DESC);

-- La identificación se guarda como huella (HMAC), no en claro: el archivo trae datos de personas ajenas al programa.
CREATE TABLE cruce_registros (
  carga_id               bigint NOT NULL REFERENCES cruce_cargas (id),
  identificacion_huella  text NOT NULL,
  detalle                text NOT NULL DEFAULT '' CHECK (length(detalle) <= 200),
  PRIMARY KEY (carga_id, identificacion_huella)
);

CREATE TABLE cruce_errores (
  carga_id bigint NOT NULL REFERENCES cruce_cargas (id),
  fila     integer NOT NULL,
  mensaje  text NOT NULL CHECK (length(mensaje) <= 300),
  PRIMARY KEY (carga_id, fila, mensaje)
);

CREATE TRIGGER cruce_cargas_inmutable_borrado BEFORE DELETE ON cruce_cargas
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();
