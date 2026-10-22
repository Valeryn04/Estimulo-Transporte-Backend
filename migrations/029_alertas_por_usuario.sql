-- Migración 029 · Un aviso puede ir dirigido a una persona concreta (por ejemplo, el validador a quien se le asignó un
-- caso) y no solo a todos los que tienen un permiso. Sin usuario_destino el aviso sigue siendo del permiso.
ALTER TABLE alertas ADD COLUMN usuario_destino integer REFERENCES usuarios (id);
CREATE INDEX ix_alertas_usuario ON alertas (usuario_destino) WHERE atendida_at IS NULL AND usuario_destino IS NOT NULL;
