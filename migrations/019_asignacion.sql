-- Migración 019 · Cupos y presupuesto por vigencia (RF-ASI-01), asignación en orden de prioridad (RF-ASI-02), lista de
-- espera y reasignación (RF-ASI-03), notificación de asignación (RF-ASI-04) y avisos internos.

-- ---------------------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('cupos.administrar',  'Asignación', 'Configurar cupos, valor del estímulo, presupuesto y su distribución por vigencia'),
  ('asignacion.ver',     'Asignación', 'Ver cupos, la propuesta de asignación, la lista de espera y los beneficiarios'),
  ('asignacion.asignar', 'Asignación', 'Asignar el beneficio en orden de prioridad y pasar casos a lista de espera');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR' AND p.codigo IN ('cupos.administrar', 'asignacion.ver', 'asignacion.asignar');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('RESPONSABLE_PROCESO', 'cupos.administrar'),
  ('RESPONSABLE_PROCESO', 'asignacion.ver'),
  ('ASIGNADOR', 'asignacion.ver'),
  ('ASIGNADOR', 'asignacion.asignar'),
  ('ANALISTA', 'asignacion.ver'),
  ('CONTROL_INTERNO', 'asignacion.ver')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

ALTER TABLE solicitudes DROP CONSTRAINT solicitudes_estado_check;
ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_estado_check CHECK (estado IN (
  'PREINSCRITA', 'CORREO_VERIFICADO', 'RADICADA',
  'EN_REVISION', 'EN_SUBSANACION', 'SUBSANADA', 'VALIDADA', 'NO_CUMPLE',
  'PRIORIZADA', 'EN_LISTA_ESPERA', 'ASIGNADA'));

-- ---------------------------------------------------------------------------------------------------------
-- Valor del estímulo y presupuesto de la vigencia (los cupos ya estaban en cupos_totales)
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE vigencias
  ADD COLUMN valor_estimulo     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (valor_estimulo >= 0),
  ADD COLUMN presupuesto_total  numeric(16, 2) NOT NULL DEFAULT 0 CHECK (presupuesto_total >= 0);

-- Distribución opcional de los cupos por localidad o por tipo de transporte.
CREATE TABLE vigencia_distribucion (
  vigencia_id integer NOT NULL REFERENCES vigencias (id),
  tipo        text NOT NULL CHECK (tipo IN ('LOCALIDAD', 'TRANSPORTE')),
  item_id     integer NOT NULL REFERENCES catalogo_items (id),
  cupos       integer NOT NULL CHECK (cupos >= 0),
  PRIMARY KEY (vigencia_id, tipo, item_id)
);

-- Toda modificación de cupos, valor, presupuesto o distribución queda con su motivo y su soporte (acto de adición...).
CREATE TABLE cupos_ajustes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vigencia_id      integer NOT NULL REFERENCES vigencias (id),
  tipo             text NOT NULL CHECK (tipo IN ('CUPOS', 'VALOR_ESTIMULO', 'PRESUPUESTO', 'DISTRIBUCION_LOCALIDAD', 'DISTRIBUCION_TRANSPORTE')),
  valor_anterior   jsonb NOT NULL,
  valor_nuevo      jsonb NOT NULL,
  motivo           text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 10 AND 1000),
  soporte_ruta     text,
  soporte_nombre   text,
  soporte_mime     text,
  soporte_tamano   integer,
  soporte_sha256   text,
  creado_por       integer NOT NULL REFERENCES usuarios (id),
  creado_at        timestamptz NOT NULL DEFAULT now(),
  -- Cambiar los cupos o el presupuesto exige soporte.
  CONSTRAINT ajuste_con_soporte CHECK (tipo NOT IN ('CUPOS', 'PRESUPUESTO') OR soporte_ruta IS NOT NULL)
);
CREATE INDEX ix_cupos_ajustes_vigencia ON cupos_ajustes (vigencia_id, creado_at DESC);
CREATE TRIGGER cupos_ajustes_inmutable BEFORE UPDATE OR DELETE ON cupos_ajustes
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Beneficios: un beneficio por solicitud asignada. Ocupa un cupo y compromete el valor del estímulo de cada persona
-- que lo recibe (la persona con discapacidad y, si lo requiere, su cuidador).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE beneficios (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id           integer NOT NULL UNIQUE REFERENCES solicitudes (id),
  vigencia_id            integer NOT NULL REFERENCES vigencias (id),
  estado                 text NOT NULL DEFAULT 'PENDIENTE_ENTREGA' CHECK (estado IN (
                           'PENDIENTE_ENTREGA', 'PENDIENTE_ACTIVACION', 'ACTIVO', 'BLOQUEADO', 'SUSPENDIDO', 'FINALIZADO')),
  personas               smallint NOT NULL CHECK (personas IN (1, 2)),
  valor_comprometido     numeric(16, 2) NOT NULL CHECK (valor_comprometido >= 0),
  -- Localidad y transporte con los que se asignó: así la distribución de cupos no cambia si luego se corrigen datos.
  localidad_id           integer REFERENCES catalogo_items (id),
  transporte_id          integer REFERENCES catalogo_items (id),
  priorizacion_id        bigint REFERENCES priorizaciones (id),
  puntaje_final          numeric(7, 2) NOT NULL,
  posicion               integer NOT NULL CHECK (posicion >= 1),
  asignado_por           integer NOT NULL REFERENCES usuarios (id),
  asignado_at            timestamptz NOT NULL DEFAULT now(),
  -- Si ocupa un cupo que se liberó, cuál (trazabilidad del cupo liberado y del nuevo beneficiario, RF-ASI-03).
  reemplaza_beneficio_id bigint UNIQUE REFERENCES beneficios (id),
  finalizado_at          timestamptz,
  motivo_fin             text CHECK (motivo_fin IS NULL OR length(motivo_fin) <= 500),
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beneficio_fin_coherente CHECK ((estado = 'FINALIZADO') = (finalizado_at IS NOT NULL))
);
CREATE INDEX ix_beneficios_vigencia ON beneficios (vigencia_id, estado);
CREATE TRIGGER beneficios_version BEFORE UPDATE ON beneficios
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER beneficios_historial AFTER INSERT OR UPDATE ON beneficios
  FOR EACH ROW EXECUTE FUNCTION guardar_version();
CREATE TRIGGER beneficios_no_borrar BEFORE DELETE ON beneficios
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- Quién recibe cada beneficio. RN-01: una persona no puede tener más de un beneficio vigente.
CREATE TABLE beneficio_personas (
  beneficio_id bigint NOT NULL REFERENCES beneficios (id),
  persona_id   integer NOT NULL REFERENCES personas (id),
  rol          text NOT NULL CHECK (rol IN ('PCD', 'CUIDADOR')),
  vigente      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (beneficio_id, rol)
);
CREATE UNIQUE INDEX uq_persona_beneficio_vigente ON beneficio_personas (persona_id) WHERE vigente;

-- Cupos que el asignador dejó sin asignar estando por delante en el orden de prioridad (RF-ASI-02).
CREATE TABLE asignacion_omisiones (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id   integer NOT NULL REFERENCES solicitudes (id),
  posicion       integer NOT NULL,
  puntaje_final  numeric(7, 2) NOT NULL,
  causa          text NOT NULL CHECK (length(btrim(causa)) BETWEEN 10 AND 500),
  registrado_por integer NOT NULL REFERENCES usuarios (id),
  registrado_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_omisiones_solicitud ON asignacion_omisiones (solicitud_id, registrado_at DESC);
CREATE TRIGGER omisiones_inmutables BEFORE UPDATE OR DELETE ON asignacion_omisiones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Avisos internos: cada uno va dirigido a quien tenga un permiso (por ejemplo, el asignador cuando se libera un cupo).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE alertas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo             text NOT NULL CHECK (tipo ~ '^[A-Z_]{3,60}$'),
  permiso_destino  text NOT NULL REFERENCES permisos (codigo),
  titulo           text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 3 AND 150),
  mensaje          text NOT NULL CHECK (length(btrim(mensaje)) BETWEEN 3 AND 1000),
  -- Ruta del portal interno a la que lleva el aviso.
  enlace           text CHECK (enlace IS NULL OR enlace ~ '^/interno/'),
  solicitud_id     integer REFERENCES solicitudes (id),
  beneficio_id     bigint REFERENCES beneficios (id),
  -- Evita avisar dos veces lo mismo mientras siga pendiente.
  clave            text,
  creada_at        timestamptz NOT NULL DEFAULT now(),
  atendida_por     integer REFERENCES usuarios (id),
  atendida_at      timestamptz,
  CONSTRAINT alerta_atendida_coherente CHECK ((atendida_por IS NULL) = (atendida_at IS NULL))
);
CREATE UNIQUE INDEX uq_alerta_pendiente_clave ON alertas (clave) WHERE clave IS NOT NULL AND atendida_at IS NULL;
CREATE INDEX ix_alertas_pendientes ON alertas (permiso_destino) WHERE atendida_at IS NULL;

-- ---------------------------------------------------------------------------------------------------------
-- Instrucciones de la entrega: se incluyen en la notificación de asignación (RF-ASI-04)
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion) VALUES
  ('entrega_lugar', 'Asignación',
   'Lugar, fecha y horario donde se entrega el medio de transporte; se incluye en el correo de asignación (RF-ASI-04)', 'TEXTO', NULL, NULL, true),
  ('entrega_documentos', 'Asignación',
   'Documentos que debe presentar quien recibe el medio de transporte; se incluyen en el correo de asignación (RF-ASI-04)', 'TEXTO', NULL, NULL, true),
  ('entrega_instrucciones', 'Asignación',
   'Otras instrucciones para la entrega del medio de transporte (RF-ASI-04)', 'TEXTO', NULL, NULL, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('entrega_lugar', 'La Gerencia de Desarrollo Social le informará el lugar, la fecha y el horario de la entrega.', 'Valor inicial: la Gerencia debe definirlo'),
  ('entrega_documentos', 'Documento de identidad original de quien recibe. Si lo recibe un tercero autorizado, también su documento y la autorización firmada.', 'Valor inicial: la Gerencia debe validarlo'),
  ('entrega_instrucciones', 'Presente este correo al recibir el medio de transporte.', 'Valor inicial: la Gerencia debe definirlo');

INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('ASIGNACION_BENEFICIO', 'Asignación del beneficio',
   'Se envía cuando el asignador confirma la asignación: cómo y dónde se entrega el medio de transporte (RF-ASI-04).',
   ARRAY['nombre', 'radicado', 'lugar_entrega', 'documentos_entrega', 'instrucciones_entrega', 'enlace_consulta'],
   ARRAY['radicado', 'lugar_entrega', 'documentos_entrega', 'enlace_consulta']),
  ('LISTA_ESPERA', 'Caso en lista de espera',
   'Se envía cuando el caso queda en lista de espera por falta de cupo o de presupuesto (RF-ASI-04).',
   ARRAY['nombre', 'radicado', 'enlace_consulta', 'aviso_preinscripcion'],
   ARRAY['radicado', 'enlace_consulta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('ASIGNACION_BENEFICIO', 1,
   'Su solicitud {{radicado}} fue asignada · Estímulo Social de Transporte',
   $c$Hola:

Tenemos buenas noticias: la solicitud {{radicado}} de {{nombre}} resultó beneficiaria del Estímulo Social de Transporte.

Entrega del medio de transporte
Lugar y horario: {{lugar_entrega}}

Documentos que debe presentar: {{documentos_entrega}}

{{instrucciones_entrega}}

Puede consultar el estado de su solicitud en cualquier momento en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('LISTA_ESPERA', 1,
   'Su solicitud {{radicado}} quedó en lista de espera · Estímulo Social de Transporte',
   $c$Hola:

La solicitud {{radicado}} de {{nombre}} cumplió los requisitos, pero por ahora no hay cupos o presupuesto disponibles para asignarle el beneficio.

Su caso queda en lista de espera, ordenado según su puntaje de priorización. Si se libera un cupo, se asignará siguiendo ese orden y le avisaremos por este medio.

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}

{{aviso_preinscripcion}}$c$, 'Texto inicial');
