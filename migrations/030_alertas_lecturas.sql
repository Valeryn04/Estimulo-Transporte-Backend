-- Migración 030 · Cada persona marca sus avisos como leídos: que uno de varios del mismo rol lea un aviso no se lo quita
-- a los demás. (Antes, al atender un aviso del rol desaparecía para todos.)
CREATE TABLE alerta_lecturas (
  alerta_id  bigint  NOT NULL REFERENCES alertas (id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES usuarios (id),
  leida_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alerta_id, usuario_id)
);
