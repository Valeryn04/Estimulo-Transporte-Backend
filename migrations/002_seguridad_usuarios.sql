-- Migración 002 · RF-ADM-01 (usuarios, roles, permisos, vigencias) y RNF-05 (identidad y control de acceso).
-- También crea la base de parámetros versionados (RNF-12) que necesita la seguridad de la sesión;
-- su administración completa (RF-ADM-02) llega en la rebanada siguiente.

-- «Hoy» en America/Bogota: las vigencias de acceso son días de calendario locales.
CREATE FUNCTION hoy_bogota() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'America/Bogota')::date $$;

-- Catálogo de permisos: acciones del software a las que se da acceso a un rol.
CREATE TABLE permisos (
  codigo      text PRIMARY KEY,
  modulo      text NOT NULL,
  descripcion text NOT NULL
);

-- Roles del numeral 3.2 del documento. Son fijos: no se crean ni eliminan desde la interfaz
-- (el ciudadano no es un rol interno: accede por correo verificado y código de un solo uso).
CREATE TABLE roles (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo      text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z_]{3,40}$'),
  nombre      text NOT NULL UNIQUE,
  descripcion text NOT NULL
);

CREATE TABLE rol_permiso (
  rol_id         integer NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permiso_codigo text    NOT NULL REFERENCES permisos (codigo) ON DELETE RESTRICT,
  PRIMARY KEY (rol_id, permiso_codigo)
);

CREATE TABLE usuarios (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario               text NOT NULL CHECK (usuario ~ '^[a-z0-9._-]{3,40}$'),
  nombres               text NOT NULL CHECK (length(btrim(nombres)) BETWEEN 3 AND 150),
  correo                text NOT NULL CHECK (correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Solo hash adaptativo con sal (argon2id). Nunca texto plano (RNF-05).
  password_hash         text NOT NULL,
  -- BLOQUEADO lo fija el administrador; BAJA es definitiva (el usuario nunca se borra: trazabilidad).
  estado                text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO', 'BLOQUEADO', 'BAJA')),
  debe_cambiar_password boolean NOT NULL DEFAULT true,
  password_cambiada_at  timestamptz NOT NULL DEFAULT now(),
  -- Bloqueo temporal automático por intentos fallidos (RNF-05); distinto del bloqueo administrativo.
  intentos_fallidos     integer NOT NULL DEFAULT 0,
  bloqueado_hasta       timestamptz,
  -- Se incrementa al cambiar la contraseña o al bloquear/dar de baja: invalida los tokens ya emitidos.
  token_version         integer NOT NULL DEFAULT 0,
  ultimo_login_at       timestamptz,
  -- Administrador principal: no se puede bloquear ni dar de baja, ni quitarle el rol de administrador.
  protegido             boolean NOT NULL DEFAULT false,
  baja_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_baja_coherente CHECK ((estado = 'BAJA') = (baja_at IS NOT NULL))
);
-- Ninguna cuenta comparte credenciales: usuario y correo son únicos (RNF-05).
CREATE UNIQUE INDEX uq_usuarios_usuario ON usuarios (lower(usuario));
CREATE UNIQUE INDEX uq_usuarios_correo ON usuarios (lower(correo));

-- Un usuario puede tener varios roles, cada uno con su vigencia de acceso (RF-ADM-01).
CREATE TABLE usuario_rol (
  usuario_id    integer NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  rol_id        integer NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  vigente_desde date NOT NULL DEFAULT hoy_bogota(),
  vigente_hasta date,
  PRIMARY KEY (usuario_id, rol_id),
  CONSTRAINT usuario_rol_vigencia CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE INDEX ix_usuario_rol_rol ON usuario_rol (rol_id);

-- Sesiones con refresh token rotativo. El token de acceso dura minutos y vive solo en la memoria del navegador;
-- el refresh token viaja en una cookie HttpOnly y aquí se guarda únicamente su hash.
CREATE TABLE sesiones_internas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        integer NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  token_hash        text NOT NULL,
  -- Hash del refresh token anterior: permite detectar su reutilización (robo) y tolerar dos pestañas simultáneas.
  anterior_hash     text,
  rotado_at         timestamptz NOT NULL DEFAULT now(),
  inicio_at         timestamptz NOT NULL DEFAULT now(),
  ultimo_uso_at     timestamptz NOT NULL DEFAULT now(),
  revocada_at       timestamptz,
  motivo_revocacion text
);
CREATE INDEX ix_sesiones_internas_usuario ON sesiones_internas (usuario_id) WHERE revocada_at IS NULL;

-- Parámetros versionados (RNF-12): el valor vigente es la última versión cuya vigencia ya comenzó.
CREATE TABLE parametros (
  clave       text PRIMARY KEY CHECK (clave ~ '^[a-z0-9_]{3,60}$'),
  grupo       text NOT NULL,
  descripcion text NOT NULL,
  tipo        text NOT NULL CHECK (tipo IN ('ENTERO', 'TEXTO', 'BOOLEANO')),
  minimo      integer,
  maximo      integer
);

CREATE TABLE parametro_versiones (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave         text NOT NULL REFERENCES parametros (clave) ON DELETE RESTRICT,
  valor         text NOT NULL,
  vigente_desde timestamptz NOT NULL DEFAULT now(),
  aprobado_por  integer REFERENCES usuarios (id),
  justificacion text,
  creado_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_parametro_versiones_clave ON parametro_versiones (clave, vigente_desde DESC, id DESC);

-- Las versiones son historial: no se editan ni se borran.
CREATE TRIGGER parametro_versiones_sin_modificar BEFORE UPDATE OR DELETE ON parametro_versiones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- La bitácora ya puede referenciar usuarios (los usuarios nunca se borran).
ALTER TABLE bitacora ADD CONSTRAINT bitacora_usuario_fk FOREIGN KEY (usuario_id) REFERENCES usuarios (id);

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('usuarios.administrar',    'Administración', 'Crear, modificar, bloquear y dar de baja usuarios internos y asignarles roles'),
  ('catalogos.administrar',   'Administración', 'Administrar los catálogos del programa'),
  ('parametros.administrar',  'Administración', 'Administrar los parámetros, vigencias, cupos y textos de autorización');

INSERT INTO roles (codigo, nombre, descripcion) VALUES
  ('AUDITOR_VERIFICADOR', 'Auditor verificador',
   'Revisa la solicitud requisito por requisito con la lista de chequeo y emite el resultado.'),
  ('ASIGNADOR', 'Asignador',
   'Aplica la priorización, revisa casos especiales, asigna cupos y registra la entrega y activación.'),
  ('GESTOR_NOVEDADES', 'Gestor de novedades',
   'Registra bloqueos, levantamientos, suspensiones, revocatorias y finalizaciones.'),
  ('RESPONSABLE_PROCESO', 'Responsable del proceso',
   'Monitorea la operación y los indicadores, y aprueba las excepciones.'),
  ('ANALISTA', 'Analista',
   'Consulta expedientes, historial, tablero de control y reportes (solo lectura).'),
  ('CONTROL_INTERNO', 'Control interno',
   'Consulta la bitácora de auditoría (solo lectura).'),
  ('ADMINISTRADOR', 'Administrador',
   'Administra usuarios, roles, catálogos, parámetros y reglas.');

-- En esta entrega solo el administrador tiene funciones; los permisos de los demás roles llegan con sus módulos.
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p WHERE r.codigo = 'ADMINISTRADOR';

INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo) VALUES
  ('sesion_inactividad_minutos', 'Seguridad', 'Minutos de inactividad tras los cuales se cierra la sesión de un usuario interno', 'ENTERO', 5, 480),
  ('sesion_maxima_horas',        'Seguridad', 'Horas máximas de una sesión desde que se inicia, aunque haya actividad continua', 'ENTERO', 1, 24),
  ('login_max_intentos',         'Seguridad', 'Intentos fallidos de ingreso antes de bloquear temporalmente la cuenta', 'ENTERO', 3, 10),
  ('login_bloqueo_minutos',      'Seguridad', 'Minutos que dura el bloqueo temporal por intentos fallidos', 'ENTERO', 1, 1440);

INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('sesion_inactividad_minutos', '30', 'Valor inicial'),
  ('sesion_maxima_horas',        '12', 'Valor inicial'),
  ('login_max_intentos',         '5',  'Valor inicial'),
  ('login_bloqueo_minutos',      '15', 'Valor inicial');
