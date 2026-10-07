-- Migración 009 · Roles administrables y un solo rol por usuario.
-- Decisión del proyecto: cada usuario interno tiene un único rol y los roles no llevan vigencia. Además del conjunto
-- inicial de roles del documento (que se marcan «del sistema»), el administrador puede crear roles propios y elegir
-- sus permisos.

ALTER TABLE roles ADD COLUMN sistema boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE roles ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Los roles que existen hoy son los del numeral 3.2 del documento.
UPDATE roles SET sistema = true;

-- Un rol propio puede llevar números en su nombre, y por tanto en su código.
ALTER TABLE roles DROP CONSTRAINT roles_codigo_check;
ALTER TABLE roles ADD CONSTRAINT roles_codigo_check CHECK (codigo ~ '^[A-Z0-9_]{3,40}$');
-- Dos roles no pueden llamarse igual aunque difieran en mayúsculas o espacios.
CREATE UNIQUE INDEX uq_roles_nombre_ci ON roles (lower(btrim(nombre)));
ALTER TABLE roles ADD CONSTRAINT roles_nombre_largo CHECK (length(btrim(nombre)) BETWEEN 3 AND 60);

-- Si algún usuario tuviera varios roles, conserva uno: el de administrador si lo tiene y, si no, el de menor id.
DELETE FROM usuario_rol ur
 USING (
   SELECT usuario_id, rol_id,
          row_number() OVER (
            PARTITION BY usuario_id
            ORDER BY (SELECT (r.codigo = 'ADMINISTRADOR') FROM roles r WHERE r.id = usuario_rol.rol_id) DESC, rol_id
          ) AS orden
     FROM usuario_rol
 ) x
 WHERE ur.usuario_id = x.usuario_id AND ur.rol_id = x.rol_id AND x.orden > 1;

ALTER TABLE usuario_rol DROP CONSTRAINT usuario_rol_vigencia;
ALTER TABLE usuario_rol DROP COLUMN vigente_desde;
ALTER TABLE usuario_rol DROP COLUMN vigente_hasta;
-- Un usuario, un rol.
CREATE UNIQUE INDEX uq_usuario_un_rol ON usuario_rol (usuario_id);
