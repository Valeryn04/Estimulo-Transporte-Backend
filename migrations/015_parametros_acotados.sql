-- Migración 015 · Qué se puede parametrizar y con qué límites.
-- Un parámetro mal ajustado puede tumbar la operación o debilitar la seguridad (por ejemplo, sesiones de varios días
-- o archivos enormes). Por eso: (1) solo se muestran y se pueden cambiar los parámetros que el software ya usa;
-- (2) cada uno tiene un rango corto y seguro; y (3) el tamaño por documento nunca pasa de 10 MB.

ALTER TABLE parametros ADD COLUMN en_uso boolean NOT NULL DEFAULT true;

-- Todavía no los usa ninguna función de esta entrega: se activan cuando exista su módulo.
UPDATE parametros SET en_uso = false
 WHERE clave IN ('plazo_subsanacion_dias', 'max_rondas_subsanacion', 'plazo_descargos_dias', 'meta_beneficiarios');

UPDATE parametros SET minimo = 5, maximo = 120 WHERE clave = 'sesion_inactividad_minutos';
UPDATE parametros SET minimo = 1, maximo = 12  WHERE clave = 'sesion_maxima_horas';
UPDATE parametros SET minimo = 3, maximo = 10  WHERE clave = 'login_max_intentos';
UPDATE parametros SET minimo = 5, maximo = 120 WHERE clave = 'login_bloqueo_minutos';
UPDATE parametros SET minimo = 1, maximo = 168 WHERE clave = 'verificacion_correo_horas';
UPDATE parametros SET minimo = 5, maximo = 15  WHERE clave = 'otp_vigencia_minutos';
UPDATE parametros SET minimo = 7, maximo = 180 WHERE clave = 'enlace_seguro_dias';
UPDATE parametros SET minimo = 1, maximo = 30  WHERE clave = 'reenvio_verificacion_minutos';
UPDATE parametros SET minimo = 1, maximo = 10  WHERE clave = 'archivo_max_mb';

-- Si algún valor vigente quedó fuera del rango nuevo, se deja una versión nueva con el límite más cercano.
DO $$
DECLARE
  r record;
  actual integer;
BEGIN
  FOR r IN SELECT clave, minimo, maximo FROM parametros WHERE tipo = 'ENTERO' AND minimo IS NOT NULL AND maximo IS NOT NULL LOOP
    SELECT valor::integer INTO actual FROM parametro_versiones
     WHERE clave = r.clave AND vigente_desde <= now()
     ORDER BY vigente_desde DESC, id DESC LIMIT 1;
    IF actual < r.minimo THEN
      INSERT INTO parametro_versiones (clave, valor, justificacion)
      VALUES (r.clave, r.minimo::text, 'Ajuste automático al nuevo rango permitido');
    ELSIF actual > r.maximo THEN
      INSERT INTO parametro_versiones (clave, valor, justificacion)
      VALUES (r.clave, r.maximo::text, 'Ajuste automático al nuevo rango permitido');
    END IF;
  END LOOP;
END $$;

-- El permiso de parámetros es solo del administrador: se retira de cualquier otro rol que lo tuviera.
DELETE FROM rol_permiso
 WHERE permiso_codigo = 'parametros.administrar'
   AND rol_id NOT IN (SELECT id FROM roles WHERE codigo = 'ADMINISTRADOR');
