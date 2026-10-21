-- Migración 020 · Registro de la entrega del medio de transporte y activación del beneficio (RF-ASI-05, RF-ASI-06).

ALTER TABLE beneficios ADD COLUMN activado_at timestamptz;

-- ---------------------------------------------------------------------------------------------------------
-- Entrega de la tarjeta (o mecanismo) a cada persona del beneficio: quién la recibió, cuándo, con qué soporte y de
-- manos de qué funcionario. Una tarjeta no puede estar en dos beneficios vigentes (tarjeta única).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE entregas (
  id                              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficio_id                    bigint NOT NULL REFERENCES beneficios (id),
  rol                             text NOT NULL CHECK (rol IN ('PCD', 'CUIDADOR')),
  tarjeta_id                      text NOT NULL CHECK (tarjeta_id ~ '^[A-Z0-9-]{4,30}$'),
  tipo_transporte_id              integer NOT NULL REFERENCES catalogo_items (id),
  fecha_entrega                   date NOT NULL,
  receptor_tipo                   text NOT NULL CHECK (receptor_tipo IN ('PCD', 'CUIDADOR', 'TERCERO')),
  receptor_nombre                 text NOT NULL CHECK (length(btrim(receptor_nombre)) BETWEEN 3 AND 150),
  receptor_tipo_identificacion_id integer REFERENCES catalogo_items (id),
  receptor_numero                 text CHECK (receptor_numero ~ '^[A-Z0-9]{4,20}$'),
  funcionario_entrega             text NOT NULL CHECK (length(btrim(funcionario_entrega)) BETWEEN 3 AND 150),
  soporte_ruta                    text NOT NULL,
  soporte_nombre                  text NOT NULL,
  soporte_mime                    text NOT NULL,
  soporte_tamano                  integer NOT NULL,
  soporte_sha256                  text NOT NULL,
  -- Se pone en falso solo cuando el beneficio finaliza: así la tarjeta queda libre.
  vigente                         boolean NOT NULL DEFAULT true,
  registrado_por                  integer NOT NULL REFERENCES usuarios (id),
  registrado_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tercero_con_identificacion CHECK (
    receptor_tipo <> 'TERCERO' OR (receptor_tipo_identificacion_id IS NOT NULL AND receptor_numero IS NOT NULL))
);
CREATE UNIQUE INDEX uq_tarjeta_vigente ON entregas (tarjeta_id) WHERE vigente;
CREATE UNIQUE INDEX uq_entrega_vigente_por_rol ON entregas (beneficio_id, rol) WHERE vigente;
CREATE INDEX ix_entregas_beneficio ON entregas (beneficio_id);

-- El registro de una entrega no se modifica; solo se libera la tarjeta cuando el beneficio finaliza.
CREATE FUNCTION entrega_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.vigente AND NOT NEW.vigente
     AND (to_jsonb(NEW) - 'vigente') = (to_jsonb(OLD) - 'vigente') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El registro de la entrega no se modifica ni se elimina' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER entregas_inmutables BEFORE UPDATE OR DELETE ON entregas
  FOR EACH ROW EXECUTE FUNCTION entrega_inmutable();

-- ---------------------------------------------------------------------------------------------------------
-- Procedimiento con el operador de transporte (parametrizable) y textos de la notificación de entrega
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, pendiente_definicion) VALUES
  ('entrega_activacion_inmediata', 'Asignación',
   'Si es «true», al registrar la entrega el beneficio queda activo; si es «false», queda pendiente de activación hasta confirmarla con el operador de transporte (RF-ASI-05)',
   'BOOLEANO', NULL, NULL, true),
  ('entrega_recomendaciones', 'Asignación',
   'Recomendaciones de uso del medio de transporte que se incluyen en el correo de entrega (RF-ASI-06)',
   'TEXTO', NULL, NULL, true);
INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('entrega_activacion_inmediata', 'false', 'Valor inicial: la activación se confirma con el operador de transporte'),
  ('entrega_recomendaciones', 'Es personal e intransferible: solo la usa la persona a quien se entregó. Guárdela en un lugar seguro y reporte de inmediato si la pierde.', 'Valor inicial: la Gerencia debe validarlo');

INSERT INTO plantillas_correo (codigo, nombre, descripcion, variables_permitidas, variables_obligatorias) VALUES
  ('ENTREGA_REGISTRADA', 'Entrega del medio de transporte',
   'Se envía cuando se registra la entrega del medio de transporte: datos de la entrega, recomendaciones y causales de revocatoria (RF-ASI-06).',
   ARRAY['nombre', 'radicado', 'fecha_entrega', 'tarjeta_enmascarada', 'tipo_transporte', 'recomendaciones_uso', 'causales_revocatoria', 'enlace_consulta'],
   ARRAY['radicado', 'fecha_entrega', 'tarjeta_enmascarada', 'tipo_transporte', 'causales_revocatoria', 'enlace_consulta']),
  ('BENEFICIO_ACTIVADO', 'Beneficio activado',
   'Se envía cuando el beneficio queda activo y se puede usar el medio de transporte.',
   ARRAY['nombre', 'radicado', 'enlace_consulta'],
   ARRAY['radicado', 'enlace_consulta']);

INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion) VALUES
  ('ENTREGA_REGISTRADA', 1,
   'Registramos la entrega de su medio de transporte · Solicitud {{radicado}}',
   $c$Hola:

Registramos la entrega del medio de transporte de la solicitud {{radicado}} de {{nombre}}.

Fecha de entrega: {{fecha_entrega}}
Identificador de la tarjeta: {{tarjeta_enmascarada}}
Tipo de transporte: {{tipo_transporte}}

Recomendaciones de uso:
{{recomendaciones_uso}}

Recuerde que el beneficio puede revocarse, entre otras, por estas causales:
{{causales_revocatoria}}

Puede consultar el estado de su beneficio en:
{{enlace_consulta}}$c$, 'Texto inicial'),
  ('BENEFICIO_ACTIVADO', 1,
   'Su beneficio está activo · Solicitud {{radicado}}',
   $c$Hola:

El beneficio de la solicitud {{radicado}} de {{nombre}} ya está activo: puede usar su medio de transporte.

Puede consultar el estado de su beneficio en:
{{enlace_consulta}}$c$, 'Texto inicial');
