-- Migración 001: base del esquema y bitácora de auditoría inmutable (RF-SEG-01, RNF-07, RN-11).
-- La consulta y exportación de la bitácora son de la Entrega 3; aquí se crea la tabla y su protección,
-- porque desde la Entrega 1 todo cambio de parámetros y de estado debe quedar registrado (RF-ADM-02).

CREATE TABLE bitacora (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creado_at     timestamptz NOT NULL DEFAULT now(),
  -- FK a usuarios.id se agrega cuando exista la tabla (migración de usuarios); null = acción del ciudadano o del sistema.
  usuario_id    bigint,
  modulo        text NOT NULL,
  accion        text NOT NULL,
  entidad       text NOT NULL,
  entidad_id    text,
  solicitud_id  bigint,
  valor_anterior jsonb,
  valor_nuevo   jsonb,
  justificacion text,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text,
  CONSTRAINT bitacora_accion_no_vacia CHECK (length(btrim(accion)) > 0),
  CONSTRAINT bitacora_modulo_no_vacio CHECK (length(btrim(modulo)) > 0)
);

-- Filtros previstos por RF-SEG-01: expediente, usuario, fecha, módulo y acción.
CREATE INDEX bitacora_solicitud_idx ON bitacora (solicitud_id, creado_at) WHERE solicitud_id IS NOT NULL;
CREATE INDEX bitacora_usuario_idx   ON bitacora (usuario_id, creado_at) WHERE usuario_id IS NOT NULL;
CREATE INDEX bitacora_fecha_idx     ON bitacora (creado_at);
CREATE INDEX bitacora_modulo_accion_idx ON bitacora (modulo, accion);

-- Inmutabilidad: ni siquiera un administrador funcional puede editar o borrar registros.
CREATE FUNCTION bitacora_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora de auditoría es inmutable (% no permitido)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER bitacora_sin_modificar BEFORE UPDATE OR DELETE ON bitacora
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();
CREATE TRIGGER bitacora_sin_truncar BEFORE TRUNCATE ON bitacora
  FOR EACH STATEMENT EXECUTE FUNCTION bitacora_inmutable();
