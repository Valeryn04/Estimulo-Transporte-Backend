-- Migración 023 · Bitácora consultable (RF-SEG-01), expediente integral (RF-SEG-03), tablero (RF-SEG-04), reportes
-- exportables con registro de exportación (RF-SEG-05, RF-SEG-06) y eventos para BI (RF-SEG-07).

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('bitacora.ver',       'Seguridad y reportes', 'Consultar la bitácora de auditoría'),
  ('expediente.ver',     'Seguridad y reportes', 'Consultar el expediente integral de una persona'),
  ('tablero.ver',        'Seguridad y reportes', 'Ver el tablero de control del programa'),
  ('reportes.ver',       'Seguridad y reportes', 'Consultar los reportes del programa'),
  ('reportes.exportar',  'Seguridad y reportes', 'Exportar reportes a Excel y PDF'),
  ('bi.consultar',       'Seguridad y reportes', 'Consultar los eventos para tableros de Business Intelligence');

INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, permisos p
 WHERE r.codigo = 'ADMINISTRADOR'
   AND p.codigo IN ('bitacora.ver', 'expediente.ver', 'tablero.ver', 'reportes.ver', 'reportes.exportar', 'bi.consultar');
INSERT INTO rol_permiso (rol_id, permiso_codigo)
SELECT r.id, p.codigo FROM roles r, (VALUES
  ('CONTROL_INTERNO', 'bitacora.ver'),
  ('CONTROL_INTERNO', 'expediente.ver'),
  ('CONTROL_INTERNO', 'tablero.ver'),
  ('CONTROL_INTERNO', 'reportes.ver'),
  ('CONTROL_INTERNO', 'reportes.exportar'),
  ('ANALISTA', 'bitacora.ver'),
  ('ANALISTA', 'expediente.ver'),
  ('ANALISTA', 'tablero.ver'),
  ('ANALISTA', 'reportes.ver'),
  ('ANALISTA', 'reportes.exportar'),
  ('ANALISTA', 'bi.consultar'),
  ('RESPONSABLE_PROCESO', 'expediente.ver'),
  ('RESPONSABLE_PROCESO', 'tablero.ver'),
  ('RESPONSABLE_PROCESO', 'reportes.ver'),
  ('RESPONSABLE_PROCESO', 'reportes.exportar'),
  ('GESTOR_NOVEDADES', 'expediente.ver'),
  ('GESTOR_NOVEDADES', 'reportes.ver'),
  ('ASIGNADOR', 'expediente.ver'),
  ('ASIGNADOR', 'reportes.ver')
) AS p (rol, codigo) WHERE r.codigo = p.rol;

-- La meta de beneficiarios alimenta el avance del tablero.
UPDATE parametros SET en_uso = true, minimo = 1, maximo = 1000000 WHERE clave = 'meta_beneficiarios';
INSERT INTO parametro_versiones (clave, valor, justificacion)
SELECT 'meta_beneficiarios', '3000', 'Meta del programa: 3.000 beneficiarios'
 WHERE NOT EXISTS (SELECT 1 FROM parametro_versiones WHERE clave = 'meta_beneficiarios');

-- ---------------------------------------------------------------------------------------------------------
-- Cada exportación queda registrada: quién, qué reporte, con qué filtros, cuántas filas y la huella del archivo.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE exportaciones (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id      integer NOT NULL REFERENCES usuarios (id),
  reporte         text NOT NULL CHECK (reporte ~ '^[A-Z_]{3,60}$'),
  formato         text NOT NULL CHECK (formato IN ('XLSX', 'PDF', 'CSV')),
  filtros         jsonb NOT NULL DEFAULT '{}',
  filas           integer NOT NULL CHECK (filas >= 0),
  archivo_nombre  text NOT NULL,
  archivo_sha256  text NOT NULL,
  creada_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_exportaciones_reciente ON exportaciones (creada_at DESC);
CREATE TRIGGER exportaciones_inmutables BEFORE UPDATE OR DELETE ON exportaciones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Eventos para Business Intelligence (RF-SEG-07): una vista sobre la misma información transaccional (la bitácora),
-- sin datos personales: el caso se identifica con una referencia que no se puede revertir y solo se expone el estado.
-- ---------------------------------------------------------------------------------------------------------
CREATE VIEW bi_eventos AS
SELECT b.id                                   AS evento_id,
       b.creado_at                            AS ocurrido_at,
       b.accion                               AS tipo_evento,
       b.modulo                               AS etapa,
       b.valor_nuevo ->> 'estado'             AS estado,
       loc.nombre                             AS localidad,
       v.anio                                 AS vigencia,
       b.usuario_id                           AS usuario_ref,
       CASE WHEN b.solicitud_id IS NULL THEN NULL
            ELSE substr(encode(sha256(convert_to('estimulo-bi:' || b.solicitud_id::text, 'UTF8')), 'hex'), 1, 16)
       END                                    AS caso_ref
  FROM bitacora b
  LEFT JOIN solicitudes s ON s.id = b.solicitud_id
  LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
  LEFT JOIN vigencias v ON v.id = s.vigencia_id
 WHERE b.accion NOT LIKE 'LOGIN%' AND b.accion NOT LIKE 'CONSULTA%' AND b.accion NOT LIKE 'PASSWORD%'
   AND b.accion NOT IN ('LOGOUT', 'SESION_REUTILIZADA', 'BITACORA_CONSULTADA', 'EXPEDIENTE_CONSULTADO');
