-- Migración 024 · Cierre de requisitos pendientes de las Entregas 2 y 3:
--   · RF-BEN-05  finalización del beneficio (fallecimiento, renuncia, fin de vigencia, pérdida de requisitos) y
--                novedades de actualización de datos (dirección, correo, cuidador).
--   · RF-VER-05  recordatorio antes del vencimiento de la subsanación y paso a «no cumple por vencimiento de término».
--   · RF-BEN-04  descargos presentados por la persona desde el portal ciudadano.
--   · RF-COM-03  reenvío de una comunicación rebotada tras actualizar el correo.

-- ---------------------------------------------------------------------------------------------------------
-- Finalización
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE catalogo_items DROP CONSTRAINT catalogo_items_catalogo_check;
ALTER TABLE catalogo_items ADD CONSTRAINT catalogo_items_catalogo_check CHECK (catalogo IN (
  'TIPO_IDENTIFICACION', 'LOCALIDAD', 'BARRIO', 'EPS', 'TIPO_TRANSPORTE', 'GENERO', 'ESTADO_CIVIL', 'ETNIA',
  'ESCOLARIDAD', 'OCUPACION', 'CAUSAL_BLOQUEO', 'CAUSAL_REVOCATORIA', 'CAUSAL_FINALIZACION'));

INSERT INTO catalogo_items (catalogo, codigo, nombre) VALUES
  ('CAUSAL_FINALIZACION', 'FALLECIMIENTO', 'Fallecimiento de la persona con discapacidad o de su cuidador'),
  ('CAUSAL_FINALIZACION', 'RENUNCIA', 'Renuncia voluntaria al beneficio'),
  ('CAUSAL_FINALIZACION', 'FIN_VIGENCIA', 'Fin de la vigencia del programa'),
  ('CAUSAL_FINALIZACION', 'PERDIDA_REQUISITOS', 'Pérdida de los requisitos para ser beneficiario');

ALTER TABLE novedades DROP CONSTRAINT novedades_tipo_check;
ALTER TABLE novedades ADD CONSTRAINT novedades_tipo_check
  CHECK (tipo IN ('BLOQUEO', 'SUSPENSION', 'LEVANTAMIENTO', 'FINALIZACION'));

-- ---------------------------------------------------------------------------------------------------------
-- Actualización de datos del beneficiario: queda el valor anterior, el nuevo, la justificación y el soporte.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE novedades_datos (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficio_id     bigint NOT NULL REFERENCES beneficios (id),
  dato             text NOT NULL CHECK (dato IN ('DIRECCION', 'CORREO', 'CUIDADOR')),
  valor_anterior   jsonb NOT NULL,
  valor_nuevo      jsonb NOT NULL,
  justificacion    text NOT NULL CHECK (length(btrim(justificacion)) BETWEEN 10 AND 1000),
  evidencia_ruta   text NOT NULL,
  evidencia_nombre text NOT NULL,
  evidencia_mime   text NOT NULL,
  evidencia_tamano integer NOT NULL,
  evidencia_sha256 text NOT NULL,
  responsable_id   integer NOT NULL REFERENCES usuarios (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_novedades_datos ON novedades_datos (beneficio_id, created_at);
CREATE TRIGGER novedades_datos_inmutables BEFORE UPDATE OR DELETE ON novedades_datos
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Descargos desde el portal ciudadano: el evento puede no tener un funcionario como autor.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE revocatoria_eventos ALTER COLUMN usuario_id DROP NOT NULL;
ALTER TABLE revocatoria_eventos ADD COLUMN origen text NOT NULL DEFAULT 'FUNCIONARIO'
  CHECK (origen IN ('FUNCIONARIO', 'CIUDADANO'));
ALTER TABLE revocatoria_eventos ADD CONSTRAINT evento_con_autor
  CHECK ((origen = 'CIUDADANO') = (usuario_id IS NULL));

-- ---------------------------------------------------------------------------------------------------------
-- Comunicaciones: un reenvío conserva el texto exacto del original y queda vinculado a él.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE correos ADD COLUMN reenvio_de bigint REFERENCES correos (id);
CREATE UNIQUE INDEX uq_correo_reenvio ON correos (reenvio_de) WHERE reenvio_de IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------
-- Subsanación: recordatorio previo al vencimiento (una sola vez por subsanación).
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE subsanaciones ADD COLUMN recordatorio_at timestamptz;

INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion, en_uso) VALUES
  ('subsanacion_recordatorio_dias', 'Verificación',
   'Días antes del vencimiento del plazo de subsanación en que se envía el recordatorio a la persona (RF-VER-05)',
   'ENTERO', 1, 10, true, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('subsanacion_recordatorio_dias', '2', 'Valor inicial');

-- ---------------------------------------------------------------------------------------------------------
-- Plantillas
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('FINALIZACION_BENEFICIO', 'Finalización del beneficio',
   'Se envía cuando el beneficio finaliza por fallecimiento, renuncia, fin de vigencia o pérdida de requisitos (RF-BEN-05).',
   ARRAY['nombre', 'radicado', 'causal', 'fecha_efectiva', 'observacion', 'enlace_consulta'],
   ARRAY['radicado', 'causal', 'fecha_efectiva', 'enlace_consulta']),
  ('RECORDATORIO_SUBSANACION', 'Recordatorio de subsanación',
   'Avisa que se acerca el vencimiento del plazo para corregir los requisitos pendientes (RF-COM-01).',
   ARRAY['nombre', 'radicado', 'fecha_limite', 'items_subsanar', 'enlace_caracterizacion', 'enlace_consulta'],
   ARRAY['radicado', 'fecha_limite', 'items_subsanar', 'enlace_caracterizacion', 'enlace_consulta']),
  ('SUBSANACION_VENCIDA', 'Subsanación vencida',
   'Informa que venció el plazo sin respuesta y la solicitud pasó a «no cumple por vencimiento de término» (RN-12).',
   ARRAY['nombre', 'radicado', 'fecha_limite', 'plazo_recursos_dias', 'enlace_consulta'],
   ARRAY['radicado', 'fecha_limite', 'plazo_recursos_dias', 'enlace_consulta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('FINALIZACION_BENEFICIO', 1,
   'Finalización de su beneficio · Solicitud {{radicado}}',
   $c$Hola:

Registramos la finalización del beneficio de la solicitud {{radicado}} de {{nombre}}.

Causal: {{causal}}
Fecha efectiva: {{fecha_efectiva}}

{{observacion}}

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('RECORDATORIO_SUBSANACION', 1,
   'Recordatorio: está por vencer el plazo para corregir su solicitud {{radicado}}',
   $c$Hola:

Aún tiene pendientes por corregir los siguientes requisitos de la solicitud {{radicado}} de {{nombre}}:

{{items_subsanar}}

El plazo vence el {{fecha_limite}}. Si no responde a tiempo, la solicitud pasará a «no cumple por vencimiento de término».

Corrija ahora en:
{{enlace_caracterizacion}}

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('SUBSANACION_VENCIDA', 1,
   'Venció el plazo para corregir su solicitud {{radicado}}',
   $c$Hola:

El plazo para corregir los requisitos de la solicitud {{radicado}} de {{nombre}} venció el {{fecha_limite}} sin que recibiéramos la respuesta. Por eso la solicitud pasó a «no cumple por vencimiento de término».

Contra esta decisión proceden los recursos que establece la ley, que puede presentar dentro de los {{plazo_recursos_dias}} días siguientes a esta comunicación.

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}$c$, 'Texto inicial');
