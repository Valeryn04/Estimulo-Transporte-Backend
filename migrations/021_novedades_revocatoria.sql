-- Migración 021 · Novedades del beneficio (RF-NOV-01), revocatoria con debido proceso (RF-NOV-02) y alertas de los
-- cruces periódicos (RF-NOV-03).

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('novedades.gestionar', 'Novedades', 'Bloquear, suspender y reactivar beneficios; llevar las revocatorias y analizar las alertas de cruce'),
  ('novedades.ver',       'Novedades', 'Ver novedades, revocatorias y alertas de cruce');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR' AND p.codigo IN ('novedades.gestionar', 'novedades.ver');
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('GESTOR_NOVEDADES', 'novedades.gestionar'),
  ('GESTOR_NOVEDADES', 'novedades.ver'),
  ('RESPONSABLE_PROCESO', 'novedades.ver'),
  ('ANALISTA', 'novedades.ver'),
  ('CONTROL_INTERNO', 'novedades.ver')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

-- Causales de bloqueo o suspensión de ejemplo: la Gerencia las ajusta desde «Listas del formulario».
INSERT INTO catalogo_items (catalogo, codigo, nombre) VALUES
  ('CAUSAL_BLOQUEO', 'REPORTE_PERDIDA', 'Reporte de pérdida o robo de la tarjeta'),
  ('CAUSAL_BLOQUEO', 'VERIFICACION_IRREGULARIDAD', 'En verificación por una posible irregularidad'),
  ('CAUSAL_BLOQUEO', 'SOLICITUD_BENEFICIARIO', 'Solicitud del beneficiario'),
  ('CAUSAL_BLOQUEO', 'DOCUMENTACION_PENDIENTE', 'Documentación pendiente de actualizar');

-- ---------------------------------------------------------------------------------------------------------
-- Novedades: secuencia completa de bloqueos, suspensiones y levantamientos. Nunca se borran ni se modifican.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE novedades (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficio_id            bigint NOT NULL REFERENCES beneficios (id),
  tipo                    text NOT NULL CHECK (tipo IN ('BLOQUEO', 'SUSPENSION', 'LEVANTAMIENTO')),
  causal_id               integer REFERENCES catalogo_items (id),
  fecha_efectiva          date NOT NULL,
  observacion             text NOT NULL DEFAULT '' CHECK (length(observacion) <= 1000),
  evidencia_ruta          text NOT NULL,
  evidencia_nombre        text NOT NULL,
  evidencia_mime          text NOT NULL,
  evidencia_tamano        integer NOT NULL,
  evidencia_sha256        text NOT NULL,
  responsable_id          integer NOT NULL REFERENCES usuarios (id),
  -- Comunicación enviada a la persona.
  correo_id               bigint REFERENCES correos (id),
  -- Para los bloqueos temporales: cuándo se avisa al gestor para que confirme la reactivación.
  levantamiento_programado date,
  -- El levantamiento cierra una novedad abierta.
  levanta_novedad_id      bigint UNIQUE REFERENCES novedades (id),
  estado_previo           text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT novedad_con_causal CHECK ((tipo = 'LEVANTAMIENTO') = (causal_id IS NULL)),
  CONSTRAINT novedad_levanta CHECK ((tipo = 'LEVANTAMIENTO') = (levanta_novedad_id IS NOT NULL)),
  CONSTRAINT novedad_programada CHECK (levantamiento_programado IS NULL OR (tipo <> 'LEVANTAMIENTO' AND levantamiento_programado >= fecha_efectiva))
);
CREATE INDEX ix_novedades_beneficio ON novedades (beneficio_id, created_at);
CREATE TRIGGER novedades_inmutables BEFORE UPDATE OR DELETE ON novedades
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Cruces periódicos: qué significa que alguien aparezca (o no) en el archivo, y la causal que sugiere.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE cruce_estructuras
  ADD COLUMN alerta_novedad text NOT NULL DEFAULT 'NINGUNA' CHECK (alerta_novedad IN ('NINGUNA', 'PRESENCIA', 'AUSENCIA')),
  ADD COLUMN causal_codigo  text CHECK (causal_codigo IS NULL OR causal_codigo ~ '^[A-Z_]{3,60}$');
UPDATE cruce_estructuras SET alerta_novedad = 'AUSENCIA', causal_codigo = 'INACTIVIDAD',
       descripcion = 'Reporte de uso de tarjetas del operador. Los beneficiarios activos que no aparecen generan una alerta de posible inactividad.'
 WHERE codigo = 'TRANSMETRO';
UPDATE cruce_estructuras SET alerta_novedad = 'PRESENCIA', causal_codigo = 'FALLECIMIENTO'
 WHERE codigo = 'DEFUNCIONES';
UPDATE cruce_estructuras SET alerta_novedad = 'PRESENCIA', causal_codigo = 'DUPLICIDAD'
 WHERE codigo = 'BENEFICIOS_INCOMPATIBLES';

-- Los números de identificación del cruce se comparan con los de la persona y el cuidador de los beneficios activos.
CREATE TABLE cruce_alertas (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carga_id       bigint NOT NULL REFERENCES cruce_cargas (id),
  estructura_id  integer NOT NULL REFERENCES cruce_estructuras (id),
  beneficio_id   bigint NOT NULL REFERENCES beneficios (id),
  causal_codigo  text,
  detalle        text NOT NULL DEFAULT '' CHECK (length(detalle) <= 500),
  estado         text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'DESCARTADA', 'EN_TRAMITE')),
  analizada_por  integer REFERENCES usuarios (id),
  analizada_at   timestamptz,
  observacion    text CHECK (observacion IS NULL OR length(observacion) <= 1000),
  revocatoria_id bigint,
  creada_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (carga_id, beneficio_id),
  CONSTRAINT alerta_analizada CHECK ((estado = 'PENDIENTE') = (analizada_at IS NULL))
);
CREATE INDEX ix_cruce_alertas_pendientes ON cruce_alertas (estado, creada_at DESC);

-- ---------------------------------------------------------------------------------------------------------
-- Revocatoria con debido proceso (RN-09, RN-10): causal y evidencia, traslado, descargos y acto motivado.
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion) VALUES
  ('plazo_decision_dias', 'Beneficio',
   'Días calendario para decidir una revocatoria después del vencimiento del plazo de descargos o de recibirlos (RF-NOV-02)', 'ENTERO', 5, 60, true),
  ('inactividad_meses', 'Beneficio',
   'Meses de beneficio activo desde los cuales se evalúa la inactividad en el cruce con el operador de transporte (RF-NOV-03)', 'ENTERO', 1, 12, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('plazo_decision_dias', '15', 'Valor inicial'),
  ('inactividad_meses', '3', 'Valor inicial: inactividad mayor de tres meses (RN-09)');
UPDATE parametros SET en_uso = true, minimo = 3, maximo = 30 WHERE clave = 'plazo_descargos_dias';

CREATE TABLE revocatorias (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficio_id      bigint NOT NULL REFERENCES beneficios (id),
  causal_id         integer NOT NULL REFERENCES catalogo_items (id),
  descripcion       text NOT NULL CHECK (length(btrim(descripcion)) BETWEEN 10 AND 2000),
  estado            text NOT NULL DEFAULT 'INICIADA' CHECK (estado IN ('INICIADA', 'EN_TRASLADO', 'CON_DESCARGOS', 'DECIDIDA')),
  resultado         text CHECK (resultado IN ('REVOCADA', 'ARCHIVADA')),
  traslado_at       timestamptz,
  vence_descargos_at timestamptz,
  descargos_at      timestamptz,
  sin_descargos     boolean NOT NULL DEFAULT false,
  decidida_at       timestamptz,
  iniciada_por      integer NOT NULL REFERENCES usuarios (id),
  origen_alerta_id  bigint REFERENCES cruce_alertas (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revocatoria_decidida CHECK ((estado = 'DECIDIDA') = (resultado IS NOT NULL))
);
-- Un beneficio tiene a lo sumo una revocatoria en curso.
CREATE UNIQUE INDEX uq_revocatoria_abierta ON revocatorias (beneficio_id) WHERE estado <> 'DECIDIDA';
ALTER TABLE cruce_alertas ADD CONSTRAINT cruce_alertas_revocatoria FOREIGN KEY (revocatoria_id) REFERENCES revocatorias (id);

CREATE TABLE revocatoria_eventos (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revocatoria_id   bigint NOT NULL REFERENCES revocatorias (id),
  etapa            text NOT NULL CHECK (etapa IN ('INICIO', 'TRASLADO', 'DESCARGOS', 'SIN_DESCARGOS', 'ACTO')),
  texto            text NOT NULL DEFAULT '' CHECK (length(texto) <= 4000),
  fecha            date NOT NULL,
  -- Número del acto administrativo, cuando es la etapa del acto.
  referencia       text CHECK (referencia IS NULL OR length(referencia) <= 100),
  evidencia_ruta   text,
  evidencia_nombre text,
  evidencia_mime   text,
  evidencia_tamano integer,
  evidencia_sha256 text,
  usuario_id       integer NOT NULL REFERENCES usuarios (id),
  correo_id        bigint REFERENCES correos (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidencia_completa CHECK (
    (evidencia_ruta IS NULL) = (evidencia_nombre IS NULL) AND (evidencia_ruta IS NULL) = (evidencia_sha256 IS NULL)),
  CONSTRAINT evidencia_obligatoria CHECK (etapa NOT IN ('INICIO', 'ACTO') OR evidencia_ruta IS NOT NULL)
);
CREATE INDEX ix_revocatoria_eventos ON revocatoria_eventos (revocatoria_id, created_at);
CREATE TRIGGER revocatoria_eventos_inmutables BEFORE UPDATE OR DELETE ON revocatoria_eventos
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Notificaciones
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('NOVEDAD_BENEFICIO', 'Novedad del beneficio',
   'Se envía cuando el beneficio se bloquea, se suspende o se reactiva: causal, fecha efectiva y lo que debe hacer la persona (RF-NOV-01).',
   ARRAY['nombre', 'radicado', 'tipo_novedad', 'causal', 'fecha_efectiva', 'observacion', 'enlace_consulta'],
   ARRAY['radicado', 'tipo_novedad', 'fecha_efectiva', 'enlace_consulta']),
  ('REVOCATORIA_TRASLADO', 'Traslado de la revocatoria',
   'Comunica a la persona las razones por las que se estudia revocar su beneficio y el plazo para presentar descargos (RF-NOV-02).',
   ARRAY['nombre', 'radicado', 'causal', 'traslado', 'fecha_limite', 'enlace_consulta'],
   ARRAY['radicado', 'causal', 'traslado', 'fecha_limite', 'enlace_consulta']),
  ('REVOCATORIA_DECISION', 'Decisión de la revocatoria',
   'Comunica el acto administrativo que decide la revocatoria y los recursos que proceden (RF-NOV-02).',
   ARRAY['nombre', 'radicado', 'resultado', 'motivacion', 'plazo_recursos_dias', 'enlace_consulta'],
   ARRAY['radicado', 'resultado', 'motivacion', 'plazo_recursos_dias', 'enlace_consulta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('NOVEDAD_BENEFICIO', 1,
   'Novedad en su beneficio: {{tipo_novedad}} · Solicitud {{radicado}}',
   $c$Hola:

Registramos una novedad en el beneficio de la solicitud {{radicado}} de {{nombre}}.

Novedad: {{tipo_novedad}}
Causal: {{causal}}
Fecha efectiva: {{fecha_efectiva}}

{{observacion}}

Puede consultar el estado de su beneficio en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('REVOCATORIA_TRASLADO', 1,
   'Traslado de razones sobre su beneficio · Solicitud {{radicado}}',
   $c$Hola:

Estamos estudiando la revocatoria del beneficio de la solicitud {{radicado}} de {{nombre}}, por esta causal: {{causal}}.

Razones:
{{traslado}}

Usted tiene derecho a presentar sus descargos y las pruebas que considere, hasta el {{fecha_limite}}.

Puede consultar el estado de su beneficio en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('REVOCATORIA_DECISION', 1,
   'Decisión sobre su beneficio · Solicitud {{radicado}}',
   $c$Hola:

Se decidió el trámite de revocatoria del beneficio de la solicitud {{radicado}} de {{nombre}}.

Decisión: {{resultado}}

Motivación:
{{motivacion}}

Contra esta decisión proceden los recursos que establece la ley, que puede presentar dentro de los {{plazo_recursos_dias}} días siguientes a esta comunicación.

Puede consultar el estado de su beneficio en:
{{enlace_consulta}}$c$, 'Texto inicial');
