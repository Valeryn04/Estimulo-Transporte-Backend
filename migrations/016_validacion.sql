-- Migración 016 · Validación de requisitos (RF-VAL-01, RF-VAL-02, RF-VAL-05), subsanación (RF-CAR-06) y lista de
-- chequeo parametrizable (RN-05, RF-ADM-04).

-- ---------------------------------------------------------------------------------------------------------
-- Permisos y reparto entre los roles del documento (RF-SEG-02: cada rol solo hace lo suyo).
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('validacion.ver',        'Validación', 'Ver la bandeja de validación y los casos'),
  ('validacion.validar',    'Validación', 'Revisar casos con la lista de chequeo y emitir la decisión'),
  ('validacion.asignar',    'Validación', 'Asignar y reasignar casos entre validadores'),
  ('datos.sensibles.ver',   'Datos personales', 'Ver los datos sensibles y los documentos de las solicitudes'),
  ('requisitos.administrar','Administración', 'Administrar la lista de chequeo de requisitos');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR'
   AND p.codigo IN ('validacion.ver', 'validacion.validar', 'validacion.asignar', 'datos.sensibles.ver', 'requisitos.administrar');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('AUDITOR_VERIFICADOR', 'validacion.ver'),
  ('AUDITOR_VERIFICADOR', 'validacion.validar'),
  ('AUDITOR_VERIFICADOR', 'datos.sensibles.ver'),
  ('RESPONSABLE_PROCESO', 'validacion.ver'),
  ('RESPONSABLE_PROCESO', 'validacion.asignar'),
  ('RESPONSABLE_PROCESO', 'datos.sensibles.ver')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

-- ---------------------------------------------------------------------------------------------------------
-- Estados de la solicitud durante la validación (numeral 3.4).
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE solicitudes DROP CONSTRAINT solicitudes_estado_check;
ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_estado_check CHECK (estado IN (
  'PREINSCRITA', 'CORREO_VERIFICADO', 'RADICADA',
  'EN_REVISION', 'EN_SUBSANACION', 'SUBSANADA', 'VALIDADA', 'NO_CUMPLE'));

-- ---------------------------------------------------------------------------------------------------------
-- Parámetros de la validación: ahora sí los usa el software.
-- ---------------------------------------------------------------------------------------------------------
UPDATE parametros SET en_uso = true, minimo = 3, maximo = 30
 WHERE clave = 'plazo_subsanacion_dias';
UPDATE parametros SET en_uso = true, minimo = 1, maximo = 5
 WHERE clave = 'max_rondas_subsanacion';

INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion) VALUES
  ('tiempo_max_atencion_dias', 'Verificación',
   'Días calendario desde la radicación después de los cuales un caso se resalta en la bandeja de validación (RF-VAL-01)',
   'ENTERO', 1, 30, true),
  ('plazo_recursos_dias', 'Verificación',
   'Días que tiene la persona para interponer recursos cuando se rechaza su solicitud; se informa en el correo (RF-VAL-05)',
   'ENTERO', 5, 30, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('tiempo_max_atencion_dias', '5', 'Valor inicial'),
  ('plazo_recursos_dias', '10', 'Valor inicial');

-- ---------------------------------------------------------------------------------------------------------
-- Lista de chequeo parametrizable (RN-05): cada requisito se verifica por separado. Puede apoyarse en un documento
-- que la persona carga y/o en datos de la caracterización: son los únicos que la persona puede corregir si se le
-- pide subsanar ese requisito (RF-CAR-06).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE requisitos_validacion (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo         text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9_]{3,60}$'),
  nombre         text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 3 AND 150),
  descripcion    text NOT NULL DEFAULT '' CHECK (length(descripcion) <= 500),
  aplica_a       text NOT NULL CHECK (aplica_a IN ('PCD', 'CUIDADOR', 'COMUN')),
  -- Dónde debe consultar el validador (ADRES, SISBÉN IV...): se sugiere al registrar el resultado.
  fuente_sugerida text NOT NULL DEFAULT '' CHECK (length(fuente_sugerida) <= 200),
  documento_id   integer REFERENCES documentos_requeridos (id),
  campos         text[] NOT NULL DEFAULT '{}',
  -- Si el requisito se contrasta con un archivo de cruce, las coincidencias salen como alerta (RF-VAL-03).
  cruce_codigo   text,
  activo         boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_requisito_nombre ON requisitos_validacion (aplica_a, lower(btrim(nombre)));
CREATE TRIGGER requisitos_validacion_version BEFORE UPDATE ON requisitos_validacion
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER requisitos_validacion_historial AFTER INSERT OR UPDATE ON requisitos_validacion
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

INSERT INTO requisitos_validacion (codigo, nombre, descripcion, aplica_a, fuente_sugerida, documento_id, campos, cruce_codigo)
SELECT v.codigo, v.nombre, v.descripcion, v.aplica_a, v.fuente, d.id, v.campos, v.cruce
  FROM (VALUES
    ('PCD_IDENTIDAD', 'Identidad de la persona con discapacidad', 'El documento es legible, está vigente y coincide con los datos registrados.', 'PCD', 'Documento de identidad / Registraduría', 'PCD_DOCUMENTO_IDENTIDAD', '{}'::text[], NULL),
    ('PCD_RESIDENCIA', 'Reside en Barranquilla', 'La residencia declarada corresponde al distrito de Barranquilla (RN-02).', 'PCD', 'Dirección declarada y documento de identidad', 'PCD_DOCUMENTO_IDENTIDAD', '{}'::text[], NULL),
    ('PCD_CERTIFICADO_DISCAPACIDAD', 'Certificado de discapacidad vigente', 'El certificado es legible y vigente (RN-02).', 'PCD', 'Certificado de discapacidad', 'PCD_CERTIFICADO_DISCAPACIDAD', '{}'::text[], NULL),
    ('PCD_RLCPD', 'Registro en el RLCPD', 'Figura en el Registro de Localización y Caracterización de Personas con Discapacidad (RN-02).', 'PCD', 'Consulta del RLCPD', 'PCD_CERTIFICADO_DISCAPACIDAD', '{}'::text[], NULL),
    ('PCD_DEPENDENCIA', 'Alta dependencia o apoyo de tercero', 'El certificado acredita alta dependencia o necesidad de apoyo de un tercero (RN-02).', 'PCD', 'Certificado de discapacidad', 'PCD_CERTIFICADO_DISCAPACIDAD', '{}'::text[], NULL),
    ('PCD_REGIMEN_SUBSIDIADO', 'Afiliada al régimen subsidiado', 'La persona está afiliada al régimen subsidiado de salud (RN-02).', 'PCD', 'ADRES (consulta de afiliación)', 'PCD_AFILIACION_SUBSIDIADO', '{}'::text[], NULL),
    ('PCD_SISBEN', 'SISBÉN IV grupo A, B o C', 'Está clasificada en SISBÉN IV, grupo A, B o C (RN-02).', 'PCD', 'Consulta del SISBÉN IV', 'PCD_SISBEN', '{}'::text[], NULL),
    ('CUI_IDENTIDAD_RESIDENCIA', 'Identidad y residencia del cuidador', 'El documento es legible y el cuidador reside en Barranquilla (RN-03).', 'CUIDADOR', 'Documento de identidad / Registraduría', 'CUIDADOR_DOCUMENTO_IDENTIDAD', '{}'::text[], NULL),
    ('CUI_SISBEN', 'SISBÉN IV grupo A, B o C del cuidador', 'El cuidador está clasificado en SISBÉN IV, grupo A, B o C (RN-03).', 'CUIDADOR', 'Consulta del SISBÉN IV', 'CUIDADOR_SISBEN', '{}'::text[], NULL),
    ('CUI_CUIDADO', 'Cuidado o asistencia permanente acreditado', 'La carta de cuidado está completa, firmada por ambos y aprobada por jurídica (RN-03).', 'CUIDADOR', 'Carta de cuidado y contacto', 'CUIDADOR_CARTA_CUIDADO', '{}'::text[], NULL),
    ('COM_CARTA_SOLICITUD', 'Carta de solicitud firmada', 'La carta está firmada por la persona con discapacidad y por el cuidador.', 'COMUN', 'Carta de solicitud', 'COMUN_CARTA_SOLICITUD', '{}'::text[], NULL),
    ('COM_BENEFICIOS_INCOMPATIBLES', 'Sin apoyos de transporte incompatibles', 'No recibe apoyos distritales de transporte equivalentes o incompatibles, por ejemplo el ESTE (RN-04).', 'COMUN', 'Archivo de cruce de Gestión Social', NULL, ARRAY['recibeSubsidios', 'subsidioCual'], 'BENEFICIOS_INCOMPATIBLES'),
    ('COM_DATOS_CARACTERIZACION', 'Datos de la caracterización coherentes', 'Los datos declarados son consistentes con los documentos aportados.', 'COMUN', 'Caracterización y documentos', NULL,
      ARRAY['generoId', 'telefonoFijo', 'celular', 'fechaNacimiento', 'estadoCivilId', 'tieneHijos', 'hijosCantidad', 'hijosEdades',
            'etniaId', 'escolaridadId', 'ocupacionId', 'epsId', 'embarazo', 'semanasGestacion', 'recibeSubsidios', 'subsidioCual',
            'tipoTransporteId', 'justificacionTransporte', 'requiereCuidador', 'cuidadorGeneroId', 'cuidadorTelefonoFijo',
            'cuidadorCelular', 'cuidadorCorreo'], NULL)
  ) AS v (codigo, nombre, descripcion, aplica_a, fuente, doc, campos, cruce)
  LEFT JOIN documentos_requeridos d ON d.codigo = v.doc;

-- ---------------------------------------------------------------------------------------------------------
-- La validación de cada solicitud: quién la tiene asignada, quién la está revisando ahora (nadie más puede
-- trabajarla al mismo tiempo) y en qué ronda va (RF-VAL-01).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE validaciones (
  solicitud_id integer PRIMARY KEY REFERENCES solicitudes (id),
  asignado_a   integer REFERENCES usuarios (id),
  asignado_por integer REFERENCES usuarios (id),
  asignado_at  timestamptz,
  tomada_por   integer REFERENCES usuarios (id),
  tomada_at    timestamptz,
  ronda        integer NOT NULL DEFAULT 1 CHECK (ronda >= 1),
  -- Volvió de una subsanación: la bandeja la marca como «subsanado».
  subsanado    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tomada_con_fecha CHECK ((tomada_por IS NULL) = (tomada_at IS NULL))
);
CREATE INDEX ix_validaciones_asignado ON validaciones (asignado_a) WHERE asignado_a IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------
-- La lista de chequeo del caso. Al empezar la revisión se guarda una copia de cada requisito (RF-ADM-04: el caso
-- conserva la versión con la que se tramitó, aunque después cambie la lista). Cada cambio queda versionado.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE validacion_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id     integer NOT NULL REFERENCES solicitudes (id),
  requisito_id     integer NOT NULL REFERENCES requisitos_validacion (id),
  requisito_version integer NOT NULL,
  codigo           text NOT NULL,
  nombre           text NOT NULL,
  descripcion      text NOT NULL DEFAULT '',
  aplica_a         text NOT NULL,
  fuente_sugerida  text NOT NULL DEFAULT '',
  documento_id     integer REFERENCES documentos_requeridos (id),
  campos           text[] NOT NULL DEFAULT '{}',
  cruce_codigo     text,
  resultado        text NOT NULL DEFAULT 'PENDIENTE' CHECK (resultado IN ('CUMPLE', 'NO_CUMPLE', 'PENDIENTE', 'NO_APLICA')),
  fuente           text NOT NULL DEFAULT '' CHECK (length(fuente) <= 200),
  observacion      text NOT NULL DEFAULT '' CHECK (length(observacion) <= 1000),
  evidencia        text NOT NULL DEFAULT '' CHECK (length(evidencia) <= 1000),
  registrado_por   integer REFERENCES usuarios (id),
  registrado_at    timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (solicitud_id, requisito_id)
);
CREATE TRIGGER validacion_items_version BEFORE UPDATE ON validacion_items
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER validacion_items_historial AFTER INSERT OR UPDATE ON validacion_items
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

-- Datos que el validador captura para la priorización (se definen con la matriz, RF-PRI-02).
CREATE TABLE validacion_variables (
  solicitud_id   integer NOT NULL REFERENCES solicitudes (id),
  variable       text NOT NULL CHECK (variable ~ '^[A-Z0-9_]{2,60}$'),
  valor          text NOT NULL CHECK (length(valor) BETWEEN 1 AND 100),
  registrado_por integer NOT NULL REFERENCES usuarios (id),
  registrado_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (solicitud_id, variable)
);

-- Decisiones de validación: son inmutables (quedan en el expediente con usuario, fecha y hora).
CREATE TABLE validacion_decisiones (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id integer NOT NULL REFERENCES solicitudes (id),
  ronda        integer NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('APROBAR', 'SUBSANAR', 'RECHAZAR')),
  motivacion   text NOT NULL CHECK (length(btrim(motivacion)) BETWEEN 5 AND 2000),
  -- Copia de la lista de chequeo tal como quedó al decidir.
  items        jsonb NOT NULL,
  decidido_por integer NOT NULL REFERENCES usuarios (id),
  decidido_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_validacion_decisiones_solicitud ON validacion_decisiones (solicitud_id, decidido_at);
CREATE TRIGGER validacion_decisiones_inmutable BEFORE UPDATE OR DELETE ON validacion_decisiones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- Requerimiento de subsanación al ciudadano (RF-CAR-06): qué corregir, la observación y el plazo.
CREATE TABLE subsanaciones (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id  integer NOT NULL REFERENCES solicitudes (id),
  decision_id   bigint NOT NULL UNIQUE REFERENCES validacion_decisiones (id),
  -- [{ itemId, requisitoId, nombre, observacion, documentoId, campos }]
  items         jsonb NOT NULL,
  vence_at      timestamptz NOT NULL,
  estado        text NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA', 'RESPONDIDA')),
  respondida_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT respondida_con_fecha CHECK ((estado = 'RESPONDIDA') = (respondida_at IS NOT NULL))
);
CREATE INDEX ix_subsanaciones_solicitud ON subsanaciones (solicitud_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------
-- Plantillas de los correos de validación (RF-VAL-05) y de la subsanación recibida (RF-CAR-06).
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('VALIDACION_APROBADA', 'Validación aprobada',
   'Se envía cuando el validador aprueba la solicitud (RF-VAL-05).',
   ARRAY['nombre', 'radicado', 'estado', 'siguiente_paso', 'enlace_consulta', 'aviso_preinscripcion'],
   ARRAY['radicado', 'enlace_consulta', 'aviso_preinscripcion']),
  ('VALIDACION_SUBSANACION', 'Solicitud de subsanación',
   'Se envía cuando el validador pide corregir datos o documentos, con el detalle y el plazo (RF-VAL-05, RF-CAR-06).',
   ARRAY['nombre', 'radicado', 'motivacion', 'items_subsanar', 'fecha_limite', 'enlace_caracterizacion', 'enlace_consulta'],
   ARRAY['radicado', 'items_subsanar', 'fecha_limite', 'enlace_caracterizacion', 'enlace_consulta']),
  ('VALIDACION_RECHAZADA', 'Validación rechazada',
   'Se envía cuando el validador rechaza la solicitud: motivación y recursos que proceden (RF-VAL-05).',
   ARRAY['nombre', 'radicado', 'motivacion', 'plazo_recursos_dias', 'enlace_consulta'],
   ARRAY['radicado', 'motivacion', 'plazo_recursos_dias', 'enlace_consulta']),
  ('SUBSANACION_RECIBIDA', 'Subsanación recibida',
   'Se envía cuando la persona responde la solicitud de subsanación (RF-CAR-06).',
   ARRAY['nombre', 'radicado', 'estado', 'siguiente_paso', 'enlace_consulta'],
   ARRAY['radicado', 'enlace_consulta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('VALIDACION_APROBADA', 1,
   'Su solicitud {{radicado}} cumplió los requisitos · Estímulo Social de Transporte',
   $c$Hola:

La solicitud {{radicado}} de {{nombre}} fue revisada y cumple los requisitos del Estímulo Social de Transporte.

Estado de su solicitud: {{estado}}

Siguiente paso: {{siguiente_paso}}

Puede consultar el estado de su solicitud en cualquier momento en:
{{enlace_consulta}}

{{aviso_preinscripcion}}$c$, 'Texto inicial'),
  ('VALIDACION_SUBSANACION', 1,
   'Necesitamos que corrija su solicitud {{radicado}} · Estímulo Social de Transporte',
   $c$Hola:

Al revisar la solicitud {{radicado}} de {{nombre}} encontramos que debe corregir o completar lo siguiente:

{{items_subsanar}}

Motivo: {{motivacion}}

Tiene plazo hasta el {{fecha_limite}}. Solo podrá modificar lo señalado arriba. Ingrese aquí para hacerlo:
{{enlace_caracterizacion}}

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}

Si no responde dentro del plazo, el funcionario podrá declarar que la solicitud no cumple los requisitos.$c$, 'Texto inicial'),
  ('VALIDACION_RECHAZADA', 1,
   'Resultado de la revisión de su solicitud {{radicado}} · Estímulo Social de Transporte',
   $c$Hola:

Revisamos la solicitud {{radicado}} de {{nombre}} y no cumple los requisitos del Estímulo Social de Transporte.

Motivación de la decisión:
{{motivacion}}

Contra esta decisión procede el recurso de reposición ante la Gerencia de Desarrollo Social, que puede interponer dentro de los {{plazo_recursos_dias}} días siguientes a esta notificación.

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('SUBSANACION_RECIBIDA', 1,
   'Recibimos las correcciones de su solicitud {{radicado}} · Estímulo Social de Transporte',
   $c$Hola:

Recibimos las correcciones de la solicitud {{radicado}} de {{nombre}}. Volverá a revisión.

Estado de su solicitud: {{estado}}

Siguiente paso: {{siguiente_paso}}

Puede consultar el estado de su solicitud en:
{{enlace_consulta}}$c$, 'Texto inicial');
