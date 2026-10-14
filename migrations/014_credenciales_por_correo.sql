-- Migración 014 · Las contraseñas temporales de los funcionarios las genera el sistema y llegan por correo.
-- El texto que se conserva del correo (inmutable) lleva un marcador en lugar de la contraseña; la contraseña viaja
-- cifrada en `secretos` solo mientras el correo sale y se borra al enviarse o al fallar definitivamente.
ALTER TABLE correos ADD COLUMN secretos bytea;

INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('CUENTA_CREADA', 'Cuenta de funcionario creada',
   'Se envía al funcionario cuando el administrador crea su cuenta: usuario, contraseña temporal y enlace de ingreso.',
   ARRAY['nombre_funcionario', 'usuario', 'contrasena_temporal', 'enlace_acceso'],
   ARRAY['usuario', 'contrasena_temporal', 'enlace_acceso']),
  ('PASSWORD_RESTABLECIDA', 'Contraseña restablecida',
   'Se envía al funcionario cuando el administrador restablece su contraseña.',
   ARRAY['nombre_funcionario', 'usuario', 'contrasena_temporal', 'enlace_acceso'],
   ARRAY['usuario', 'contrasena_temporal', 'enlace_acceso']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('CUENTA_CREADA', 1,
   'Su acceso al portal interno · Estímulo Social de Transporte',
   $c$Hola {{nombre_funcionario}}:

Se creó su cuenta en el portal interno del Estímulo Social de Transporte de la Alcaldía de Barranquilla.

Usuario: {{usuario}}
Contraseña temporal: {{contrasena_temporal}}

Ingrese aquí: {{enlace_acceso}}

La primera vez que ingrese, el sistema le pedirá cambiar esta contraseña por una propia. La contraseña temporal solo sirve para ese primer ingreso. No la comparta con nadie. Si no esperaba este mensaje, avise al administrador.$c$,
   'Texto inicial'),
  ('PASSWORD_RESTABLECIDA', 1,
   'Su contraseña fue restablecida · Estímulo Social de Transporte',
   $c$Hola {{nombre_funcionario}}:

El administrador restableció su contraseña del portal interno del Estímulo Social de Transporte.

Usuario: {{usuario}}
Contraseña temporal: {{contrasena_temporal}}

Ingrese aquí: {{enlace_acceso}}

Al ingresar, el sistema le pedirá cambiar esta contraseña por una propia. La contraseña temporal solo sirve para ese ingreso. No la comparta con nadie. Si usted no la pidió, avise al administrador.$c$,
   'Texto inicial');
