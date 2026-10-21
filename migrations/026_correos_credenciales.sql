-- Migración 026 · El correo de la cuenta nueva o de la contraseña restablecida lleva solo la contraseña temporal: el
-- usuario se lo informa a la persona quien creó la cuenta, y así el correo por sí solo no basta para ingresar.
UPDATE plantillas_correo
   SET variables_obligatorias = ARRAY['contrasena_temporal', 'enlace_acceso']
 WHERE codigo IN ('CUENTA_CREADA', 'PASSWORD_RESTABLECIDA');

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('CUENTA_CREADA', 2,
   'Su acceso al portal interno · Estímulo Social de Transporte',
   $c$Hola {{nombre_funcionario}}:

Se creó su cuenta en el portal interno del Estímulo Social de Transporte de la Alcaldía de Barranquilla.

Su contraseña temporal es:

{{contrasena_temporal}}

Ingrese aquí:

{{enlace_acceso}}

Su usuario se lo informa la persona que creó su cuenta. La primera vez que ingrese, el sistema le pedirá crear su contraseña definitiva, sin necesidad de escribir esta. La contraseña temporal solo sirve para ese primer ingreso. No la comparta con nadie. Si no esperaba este mensaje, avise al administrador.$c$,
   'Solo la contraseña temporal, sin el usuario'),
  ('PASSWORD_RESTABLECIDA', 2,
   'Su contraseña fue restablecida · Estímulo Social de Transporte',
   $c$Hola {{nombre_funcionario}}:

El administrador restableció su contraseña del portal interno del Estímulo Social de Transporte.

Su contraseña temporal es:

{{contrasena_temporal}}

Ingrese aquí:

{{enlace_acceso}}

Al ingresar, el sistema le pedirá crear su contraseña definitiva, sin necesidad de escribir esta. La contraseña temporal solo sirve para ese ingreso. No la comparta con nadie. Si usted no la pidió, avise al administrador.$c$,
   'Solo la contraseña temporal, sin el usuario');
