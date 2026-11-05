-- Migración 034 · Consulta automática del régimen de salud (BDUA/ADRES) y tipos de documento aceptados por ese servicio.

-- Tipos de documento que acepta el servicio (los que ya existen conservan su código).
INSERT INTO catalogo_items (catalogo, codigo, nombre) VALUES
  ('TIPO_IDENTIFICACION', 'PA', 'Pasaporte'),
  ('TIPO_IDENTIFICACION', 'PE', 'Permiso Especial de Permanencia'),
  ('TIPO_IDENTIFICACION', 'SC', 'Salvoconducto de Permanencia'),
  ('TIPO_IDENTIFICACION', 'PC', 'Permiso Especial para Representantes de Menores'),
  ('TIPO_IDENTIFICACION', 'CN', 'Certificado de Nacido Vivo'),
  ('TIPO_IDENTIFICACION', 'MS', 'Menor sin Identificación'),
  ('TIPO_IDENTIFICACION', 'AS', 'Adulto sin Identificación')
ON CONFLICT (catalogo, codigo) DO NOTHING;

-- Resultado de cada consulta (se conserva el historial: es la evidencia que ve el validador).
CREATE TABLE consultas_regimen (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id integer NOT NULL REFERENCES solicitudes (id),
  tipo_codigo  text NOT NULL,
  resultado    text NOT NULL CHECK (resultado IN ('SUBSIDIADO', 'NO_SUBSIDIADO', 'NO_DISPONIBLE')),
  mensaje      text NOT NULL DEFAULT '',
  consultada_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consultas_regimen_solicitud ON consultas_regimen (solicitud_id, id DESC);

UPDATE documentos_requeridos
   SET descripcion = 'Se consulta sola con su documento de identidad y la constancia se adjunta automáticamente. Solo cárguelo usted si la consulta no puede confirmar que está afiliada al régimen subsidiado.'
 WHERE codigo = 'PCD_AFILIACION_SUBSIDIADO';
UPDATE requisitos_validacion
   SET fuente_sugerida = 'Consulta automática BDUA/ADRES (constancia adjunta)',
       descripcion = 'La persona figura activa (AC) en el régimen subsidiado según la consulta automática, o el soporte cargado lo demuestra (RN-02).'
 WHERE codigo = 'PCD_REGIMEN_SUBSIDIADO';
