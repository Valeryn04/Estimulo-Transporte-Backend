-- Migración 006 · Plantillas de correo configurables (RF-COM-02, RNF-12).
-- El administrador edita el asunto y el texto de cada plantilla con variables; cada cambio es una versión nueva e
-- inmutable, y cada correo enviado queda enlazado a la versión exacta con la que salió.

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('plantillas.administrar', 'Administración', 'Administrar las plantillas de correo');
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT id, 'plantillas.administrar' FROM roles WHERE codigo = 'ADMINISTRADOR';

CREATE TABLE plantillas_correo (
  codigo                 text PRIMARY KEY CHECK (codigo ~ '^[A-Z_]{3,60}$'),
  nombre                 text NOT NULL,
  descripcion            text NOT NULL,
  -- Variables que se pueden usar en el asunto y en el texto de esta plantilla.
  variables_permitidas   text[] NOT NULL,
  -- Variables que no pueden faltar en el texto (por ejemplo, el enlace de consulta y la aclaración de que la
  -- preinscripción no equivale a la aprobación del beneficio).
  variables_obligatorias text[] NOT NULL DEFAULT '{}',
  CONSTRAINT obligatorias_son_permitidas CHECK (variables_obligatorias <@ variables_permitidas)
);

CREATE TABLE plantilla_versiones (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plantilla_codigo text NOT NULL REFERENCES plantillas_correo (codigo),
  version          integer NOT NULL CHECK (version > 0),
  asunto           text NOT NULL CHECK (length(btrim(asunto)) BETWEEN 5 AND 200 AND asunto !~ '[\r\n]'),
  cuerpo           text NOT NULL CHECK (length(btrim(cuerpo)) BETWEEN 20 AND 10000),
  justificacion    text,
  creado_por       integer REFERENCES usuarios (id),
  creado_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plantilla_codigo, version)
);
CREATE TRIGGER plantilla_versiones_inmutable BEFORE UPDATE OR DELETE ON plantilla_versiones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('PREINSCRIPCION_VERIFICACION', 'Verificación del correo',
   'Se envía al registrar la preinscripción, con el enlace para verificar el correo (RF-PRE-04).',
   ARRAY['nombre', 'enlace_verificacion', 'horas_vigencia', 'aviso_preinscripcion'],
   ARRAY['enlace_verificacion', 'aviso_preinscripcion']),
  ('PREINSCRIPCION_EXITOSA', 'Preinscripción exitosa',
   'Se envía cuando el ciudadano verifica su correo: indica el siguiente paso y el enlace de consulta (RF-PRE-04).',
   ARRAY['nombre', 'estado', 'siguiente_paso', 'enlace_caracterizacion', 'enlace_consulta', 'aviso_preinscripcion'],
   ARRAY['estado', 'siguiente_paso', 'enlace_consulta', 'aviso_preinscripcion']),
  ('CARACTERIZACION_RADICADA', 'Caracterización radicada',
   'Se envía al radicar la solicitud, con el número de radicado (RF-CAR-04).',
   ARRAY['nombre', 'radicado', 'fecha_radicacion', 'estado', 'siguiente_paso', 'enlace_consulta', 'aviso_preinscripcion'],
   ARRAY['radicado', 'estado', 'siguiente_paso', 'enlace_consulta', 'aviso_preinscripcion']),
  ('CODIGO_CONSULTA', 'Código de consulta del estado',
   'Código de un solo uso para consultar el estado de la solicitud (RF-PRE-05, RNF-05).',
   ARRAY['nombre', 'codigo', 'minutos_vigencia', 'aviso_preinscripcion'],
   ARRAY['codigo', 'minutos_vigencia', 'aviso_preinscripcion']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('PREINSCRIPCION_VERIFICACION', 1,
   'Verifique su correo · Estímulo Social de Transporte',
   $c$Hola:

Recibimos la preinscripción de {{nombre}} al Estímulo Social de Transporte de la Alcaldía de Barranquilla. Para continuar, verifique su correo electrónico con este enlace (vigente por {{horas_vigencia}} horas):

{{enlace_verificacion}}

Si usted no realizó esta solicitud, ignore este mensaje.

{{aviso_preinscripcion}}$c$, 'Texto inicial'),
  ('PREINSCRIPCION_EXITOSA', 1,
   'Preinscripción exitosa · Estímulo Social de Transporte',
   $c$Hola:

Su correo fue verificado y la preinscripción de {{nombre}} quedó registrada.

Estado de su solicitud: {{estado}}

Siguiente paso: {{siguiente_paso}}

Para completar la caracterización y adjuntar los documentos, ingrese aquí:
{{enlace_caracterizacion}}

Puede consultar el estado de su solicitud en cualquier momento en:
{{enlace_consulta}}

{{aviso_preinscripcion}}$c$, 'Texto inicial'),
  ('CARACTERIZACION_RADICADA', 1,
   'Solicitud {{radicado}} radicada · Estímulo Social de Transporte',
   $c$Hola:

Recibimos la caracterización y los documentos de {{nombre}}. La solicitud fue radicada el {{fecha_radicacion}}.

Número de radicado: {{radicado}}
Estado: {{estado}}

Siguiente paso: {{siguiente_paso}}

Consulte el estado de su solicitud en cualquier momento en:
{{enlace_consulta}}

{{aviso_preinscripcion}}$c$, 'Texto inicial'),
  ('CODIGO_CONSULTA', 1,
   'Su código de consulta · Estímulo Social de Transporte',
   $c$Hola:

Su código para consultar el estado de la solicitud de {{nombre}} es:

{{codigo}}

Escríbalo en la página de consulta. Vale por {{minutos_vigencia}} minutos y solo se puede usar una vez.

Si usted no lo solicitó, ignore este mensaje: nadie puede ver la solicitud sin este código.

{{aviso_preinscripcion}}$c$, 'Texto inicial');

-- ---------------------------------------------------------------------------------------------------------
-- Cada correo queda enlazado a la versión exacta de la plantilla con la que salió.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE correos ADD COLUMN plantilla_version integer;
UPDATE correos SET plantilla_version = 1;
ALTER TABLE correos ALTER COLUMN plantilla_version SET NOT NULL;
ALTER TABLE correos DROP CONSTRAINT correos_tipo_check;
ALTER TABLE correos ADD CONSTRAINT correos_plantilla_fk
  FOREIGN KEY (tipo, plantilla_version) REFERENCES plantilla_versiones (plantilla_codigo, version);

CREATE OR REPLACE FUNCTION correos_texto_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los correos enviados no se pueden borrar' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.asunto IS DISTINCT FROM OLD.asunto OR NEW.cuerpo IS DISTINCT FROM OLD.cuerpo
     OR NEW.destinatario IS DISTINCT FROM OLD.destinatario
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.plantilla_version IS DISTINCT FROM OLD.plantilla_version THEN
    RAISE EXCEPTION 'El texto de un correo es inmutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
