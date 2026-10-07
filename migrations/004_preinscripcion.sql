-- Migración 004 · Preinscripción (RF-PRE-01 a RF-PRE-04), calidad de datos (RNF-10) y registro de correos (RNF-13).

-- ---------------------------------------------------------------------------------------------------------
-- Personas: la persona con discapacidad (PCD) y el cuidador. El tipo y número de identificación son llave única
-- (RNF-10). Un cuidador puede estar asociado a más de una PCD (RN-01), por eso es una persona independiente.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE personas (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo_identificacion_id integer NOT NULL REFERENCES catalogo_items (id),
  numero_identificacion  text NOT NULL CHECK (numero_identificacion ~ '^[A-Z0-9]{4,20}$'),
  nombre_completo        text NOT NULL CHECK (length(btrim(nombre_completo)) BETWEEN 3 AND 150),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_persona_identificacion UNIQUE (tipo_identificacion_id, numero_identificacion)
);

-- ---------------------------------------------------------------------------------------------------------
-- Solicitudes: una por PCD y vigencia (RNF-10). La solicitud se organiza alrededor de la PCD (RN-01).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE solicitudes (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vigencia_id          integer NOT NULL REFERENCES vigencias (id),
  pcd_id               integer NOT NULL REFERENCES personas (id),
  cuidador_id          integer NOT NULL REFERENCES personas (id),
  direccion            text CHECK (direccion IS NULL OR length(btrim(direccion)) BETWEEN 3 AND 200),
  localidad_id         integer REFERENCES catalogo_items (id),
  barrio_id            integer REFERENCES catalogo_items (id),
  correo               text NOT NULL CHECK (correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(correo) <= 150),
  estado               text NOT NULL DEFAULT 'PREINSCRITA' CHECK (estado IN ('PREINSCRITA', 'CORREO_VERIFICADO')),
  correo_verificado_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_solicitud_pcd_vigencia UNIQUE (vigencia_id, pcd_id),
  CONSTRAINT solicitud_pcd_distinto_cuidador CHECK (pcd_id <> cuidador_id),
  CONSTRAINT solicitud_barrio_con_localidad CHECK (barrio_id IS NULL OR localidad_id IS NOT NULL)
);
CREATE INDEX ix_solicitudes_cuidador ON solicitudes (cuidador_id);
CREATE INDEX ix_solicitudes_estado ON solicitudes (estado, vigencia_id);
CREATE INDEX ix_solicitudes_correo ON solicitudes (lower(correo));

-- Aceptación de la autorización de datos: fecha, hora, IP y versión del texto aceptado (RF-PRE-03).
CREATE TABLE aceptaciones_autorizacion (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id integer NOT NULL REFERENCES solicitudes (id),
  version      integer NOT NULL REFERENCES textos_autorizacion (version),
  aceptada_at  timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  UNIQUE (solicitud_id)
);
CREATE TRIGGER aceptaciones_autorizacion_inmutable BEFORE UPDATE OR DELETE ON aceptaciones_autorizacion
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- Enlaces de un solo propósito enviados por correo. Solo se guarda el hash del token.
CREATE TABLE solicitud_tokens (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id integer NOT NULL REFERENCES solicitudes (id),
  proposito    text NOT NULL CHECK (proposito IN ('VERIFICACION_CORREO', 'ENLACE_SEGURO')),
  token_hash   char(64) NOT NULL UNIQUE,
  expira_at    timestamptz NOT NULL,
  usado_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_solicitud_tokens_solicitud ON solicitud_tokens (solicitud_id, proposito, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------
-- Correos (RNF-13): cada comunicación conserva el texto exacto con el que salió y su estado de entrega.
-- Funciona como bandeja de salida con reintentos automáticos.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE correos (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id        integer REFERENCES solicitudes (id),
  -- Evento que originó el correo (RF-COM-01).
  tipo                text NOT NULL CHECK (tipo IN ('PREINSCRIPCION_VERIFICACION', 'PREINSCRIPCION_EXITOSA', 'CARACTERIZACION_RADICADA')),
  destinatario        text NOT NULL,
  asunto              text NOT NULL,
  cuerpo              text NOT NULL,
  estado              text NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (estado IN ('PENDIENTE', 'ENVIADO', 'ENTREGADO', 'REBOTADO', 'FALLIDO')),
  intentos            integer NOT NULL DEFAULT 0,
  proximo_intento_at  timestamptz NOT NULL DEFAULT now(),
  ultimo_error        text,
  message_id          text UNIQUE,
  enviado_at          timestamptz,
  entregado_at        timestamptz,
  rebote_motivo       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_correos_pendientes ON correos (proximo_intento_at) WHERE estado = 'PENDIENTE';
CREATE INDEX ix_correos_solicitud ON correos (solicitud_id, created_at);

-- El texto que salió no se puede modificar ni borrar; solo cambia el estado de entrega.
CREATE FUNCTION correos_texto_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los correos enviados no se pueden borrar' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.asunto IS DISTINCT FROM OLD.asunto OR NEW.cuerpo IS DISTINCT FROM OLD.cuerpo
     OR NEW.destinatario IS DISTINCT FROM OLD.destinatario
     OR NEW.tipo IS DISTINCT FROM OLD.tipo THEN
    RAISE EXCEPTION 'El texto de un correo es inmutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER correos_inmutables BEFORE UPDATE OR DELETE ON correos
  FOR EACH ROW EXECUTE FUNCTION correos_texto_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Parámetros nuevos de la preinscripción.
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion) VALUES
  ('enlace_seguro_dias', 'Preinscripción', 'Días de vigencia del enlace seguro de consulta y caracterización enviado por correo (RF-PRE-05)', 'ENTERO', 1, 365, true),
  ('reenvio_verificacion_minutos', 'Preinscripción', 'Minutos mínimos entre dos reenvíos del enlace de verificación del correo (RF-PRE-04)', 'ENTERO', 1, 60, false);

INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('enlace_seguro_dias', '90', 'Valor inicial'),
  ('reenvio_verificacion_minutos', '2', 'Valor inicial');
