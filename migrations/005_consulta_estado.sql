-- Migración 005 · Consulta del estado de la solicitud (RF-PRE-05) y acceso del ciudadano por código de un solo
-- uso enviado al correo registrado (RNF-05).

CREATE TABLE codigos_consulta (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id integer NOT NULL REFERENCES solicitudes (id),
  -- HMAC del código con el secreto del servidor: un código de 6 dígitos nunca se guarda en claro.
  codigo_hash  char(64) NOT NULL,
  expira_at    timestamptz NOT NULL,
  intentos     integer NOT NULL DEFAULT 0,
  usado_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_codigos_consulta_solicitud ON codigos_consulta (solicitud_id, created_at DESC);

-- El código llega por correo: es un evento más de la bandeja de salida.
ALTER TABLE correos DROP CONSTRAINT correos_tipo_check;
ALTER TABLE correos ADD CONSTRAINT correos_tipo_check CHECK (tipo IN (
  'PREINSCRIPCION_VERIFICACION', 'PREINSCRIPCION_EXITOSA', 'CARACTERIZACION_RADICADA', 'CODIGO_CONSULTA'));
