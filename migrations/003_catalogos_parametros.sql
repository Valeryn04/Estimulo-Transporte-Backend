-- Migración 003 · RF-ADM-02 (catálogos y parámetros), RF-PRE-03 (texto de autorización), RF-ASG-03 (cupos por
-- vigencia, solo el registro), RN-05/RN-06 (documentos exigidos).
-- Todo cambio queda versionado (RNF-12): el historial de las tablas editables se guarda con un disparador genérico.

-- ---------------------------------------------------------------------------------------------------------
-- Versionado genérico: cada INSERT/UPDATE guarda una copia completa del registro y quién lo hizo.
-- La aplicación indica el usuario con `SELECT set_config('app.usuario_id', '<id>', true)` dentro de la transacción.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE historial_versiones (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tabla       text NOT NULL,
  registro_id bigint NOT NULL,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  usuario_id  integer REFERENCES usuarios (id),
  creado_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tabla, registro_id, version)
);
CREATE TRIGGER historial_versiones_inmutable BEFORE UPDATE OR DELETE ON historial_versiones
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

CREATE FUNCTION incrementar_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION guardar_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO historial_versiones (tabla, registro_id, version, snapshot, usuario_id)
  VALUES (TG_TABLE_NAME, NEW.id, NEW.version, to_jsonb(NEW),
          NULLIF(current_setting('app.usuario_id', true), '')::integer);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Catálogos (RF-ADM-02): tipos de identificación, localidades, barrios, EPS, tipos de transporte y causales.
-- Los elementos no se borran (los usan las solicitudes): se desactivan.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE catalogo_items (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalogo   text NOT NULL CHECK (catalogo IN (
               'TIPO_IDENTIFICACION', 'LOCALIDAD', 'BARRIO', 'EPS', 'TIPO_TRANSPORTE',
               'CAUSAL_BLOQUEO', 'CAUSAL_REVOCATORIA')),
  codigo     text NOT NULL CHECK (codigo ~ '^[A-Z0-9_]{1,40}$'),
  nombre     text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 2 AND 150),
  -- Un barrio pertenece a una localidad.
  padre_id   integer REFERENCES catalogo_items (id),
  orden      integer NOT NULL DEFAULT 0,
  activo     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalogo, codigo),
  CONSTRAINT catalogo_padre_solo_barrio CHECK ((catalogo = 'BARRIO') = (padre_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_catalogo_nombre ON catalogo_items (catalogo, lower(btrim(nombre)));
CREATE INDEX ix_catalogo_padre ON catalogo_items (padre_id) WHERE padre_id IS NOT NULL;
CREATE TRIGGER catalogo_items_version BEFORE UPDATE ON catalogo_items
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER catalogo_items_historial AFTER INSERT OR UPDATE ON catalogo_items
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

-- El padre de un barrio debe ser una localidad.
CREATE FUNCTION validar_padre_catalogo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.padre_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM catalogo_items p WHERE p.id = NEW.padre_id AND p.catalogo = 'LOCALIDAD') THEN
    RAISE EXCEPTION 'El barrio debe pertenecer a una localidad' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalogo_items_padre BEFORE INSERT OR UPDATE ON catalogo_items
  FOR EACH ROW EXECUTE FUNCTION validar_padre_catalogo();

-- Tipos de identificación (RF-PRE-02).
INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('TIPO_IDENTIFICACION', 'CC', 'Cédula de Ciudadanía', 1),
  ('TIPO_IDENTIFICACION', 'TI', 'Tarjeta de Identidad', 2),
  ('TIPO_IDENTIFICACION', 'RC', 'Registro Civil', 3),
  ('TIPO_IDENTIFICACION', 'CE', 'Cédula de Extranjería', 4),
  ('TIPO_IDENTIFICACION', 'PT', 'Permiso Temporal', 5);

-- Tipos de transporte (RF-CAR-01).
INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('TIPO_TRANSPORTE', 'TRANSMETRO', 'Transmetro', 1),
  ('TIPO_TRANSPORTE', 'SIBUS', 'SiBus', 2);

-- Causales de revocatoria (RN-09). Las causales de bloqueo las define la Gerencia desde la administración.
INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('CAUSAL_REVOCATORIA', 'INFORMACION_FALSA', 'Información falsa, incompleta o adulterada', 1),
  ('CAUSAL_REVOCATORIA', 'USO_INDEBIDO', 'Uso indebido por persona distinta al autorizado o a su cuidador', 2),
  ('CAUSAL_REVOCATORIA', 'INACTIVIDAD', 'Inactividad injustificada mayor de tres meses', 3),
  ('CAUSAL_REVOCATORIA', 'FALLECIMIENTO', 'Fallecimiento de la persona con discapacidad o de su cuidador', 4),
  ('CAUSAL_REVOCATORIA', 'PERDIDA_REQUISITOS', 'Pérdida de requisitos', 5),
  ('CAUSAL_REVOCATORIA', 'DUPLICIDAD', 'Duplicidad de beneficios', 6);

-- EPS: lista inicial a validar por la Gerencia de Desarrollo Social (se administra desde el portal interno).
INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('EPS', 'NUEVA_EPS', 'Nueva EPS', 1),
  ('EPS', 'SALUD_TOTAL', 'Salud Total', 2),
  ('EPS', 'SANITAS', 'Sanitas', 3),
  ('EPS', 'COOSALUD', 'Coosalud', 4),
  ('EPS', 'MUTUAL_SER', 'Mutual SER', 5),
  ('EPS', 'FAMISANAR', 'Famisanar', 6),
  ('EPS', 'ASMET_SALUD', 'Asmet Salud', 7);

-- Localidades de Barranquilla.
INSERT INTO catalogo_items (catalogo, codigo, nombre, orden) VALUES
  ('LOCALIDAD', 'L_METROPOLITANA', 'Metropolitana', 1),
  ('LOCALIDAD', 'L_NORTE_CENTRO_HISTORICO', 'Norte - Centro Histórico', 2),
  ('LOCALIDAD', 'L_RIOMAR', 'Riomar', 3),
  ('LOCALIDAD', 'L_SUR_OCCIDENTE', 'Sur Occidente', 4),
  ('LOCALIDAD', 'L_SUR_ORIENTE', 'Sur Oriente', 5);

-- Barrios de Barranquilla según el POT (datos abiertos de la Alcaldía, datos.gov.co qui6-qeux). Se cargan los que
-- la fuente asigna a una localidad; los corregimientos y barrios sin localidad los agrega la Gerencia desde la
-- administración, indicando su localidad.
INSERT INTO catalogo_items (catalogo, codigo, nombre, padre_id)
SELECT 'BARRIO', b.codigo, b.nombre, l.id
  FROM (VALUES
  ('B_20_DE_JULIO', '20 de Julio', 'Metropolitana'),
  ('B_7_DE_ABRIL', '7 de Abril', 'Metropolitana'),
  ('B_7_DE_AGOSTO', '7 de Agosto', 'Sur Occidente'),
  ('B_ALFONSO_LOPEZ', 'Alfonso Lopez', 'Sur Occidente'),
  ('B_ALTAMIRA', 'Altamira', 'Riomar'),
  ('B_ALTO_PRADO', 'Alto Prado', 'Norte - Centro Histórico'),
  ('B_ALTOS_DE_RIOMAR', 'Altos de Riomar', 'Riomar'),
  ('B_ALTOS_DEL_LIMON', 'Altos del Limon', 'Riomar'),
  ('B_AMERICA', 'America', 'Norte - Centro Histórico'),
  ('B_ANDALUCIA', 'Andalucia', 'Riomar'),
  ('B_ATLANTICO', 'Atlantico', 'Sur Oriente'),
  ('B_BARLOVENTO', 'Barlovento', 'Norte - Centro Histórico'),
  ('B_BARRIO_ABAJO', 'Barrio Abajo', 'Norte - Centro Histórico'),
  ('B_BELLA_ARENA', 'Bella Arena', 'Sur Oriente'),
  ('B_BELLAVISTA', 'Bellavista', 'Norte - Centro Histórico'),
  ('B_BERNARDO_HOYOS', 'Bernardo Hoyos', 'Sur Occidente'),
  ('B_BETANIA', 'Betania', 'Norte - Centro Histórico'),
  ('B_BOSTON', 'Boston', 'Norte - Centro Histórico'),
  ('B_BOYACA', 'Boyaca', 'Sur Oriente'),
  ('B_BUENA_ESPERANZA', 'Buena Esperanza', 'Sur Occidente'),
  ('B_BUENAVISTA', 'Buenavista', 'Riomar'),
  ('B_BUENOS_AIRES', 'Buenos Aires', 'Metropolitana'),
  ('B_CALIFORNIA', 'California', 'Sur Occidente'),
  ('B_CAMPO_ALEGRE', 'Campo Alegre', 'Norte - Centro Histórico'),
  ('B_CARLOS_MEISEL', 'Carlos Meisel', 'Sur Occidente'),
  ('B_CARRIZAL', 'Carrizal', 'Metropolitana'),
  ('B_CENTRO', 'Centro', 'Norte - Centro Histórico'),
  ('B_CEVILLAR', 'Cevillar', 'Metropolitana'),
  ('B_CHIQUINQUIRA', 'Chiquinquira', 'Sur Oriente'),
  ('B_CIUDAD_JARDIN', 'Ciudad Jardin', 'Norte - Centro Histórico'),
  ('B_CIUDAD_MODESTO', 'Ciudad Modesto', 'Sur Occidente'),
  ('B_CIUDADELA_20_DE_JULIO', 'Ciudadela 20 de Julio', 'Metropolitana'),
  ('B_CIUDADELA_DE_LA_SALUD', 'Ciudadela de la Salud', 'Sur Occidente'),
  ('B_COLINA_CAMPESTRE', 'Colina Campestre', 'Sur Occidente'),
  ('B_COLOMBIA', 'Colombia', 'Norte - Centro Histórico'),
  ('B_CORDIALIDAD', 'Cordialidad', 'Sur Occidente'),
  ('B_CUCHILLA_DE_VILLATE', 'Cuchilla de Villate', 'Sur Occidente'),
  ('B_EL_BOSQUE', 'El Bosque', 'Sur Occidente'),
  ('B_EL_CAMPITO', 'El Campito', 'Sur Oriente'),
  ('B_EL_CARMEN', 'El Carmen', 'Sur Occidente'),
  ('B_EL_CASTILLO', 'El Castillo', 'Norte - Centro Histórico'),
  ('B_EL_EDEN_2000', 'El Eden 2000', 'Sur Occidente'),
  ('B_EL_EDEN_I', 'El Eden I', 'Sur Occidente'),
  ('B_EL_GOLF', 'El Golf', 'Norte - Centro Histórico'),
  ('B_EL_GOLFO', 'El Golfo', 'Sur Occidente'),
  ('B_EL_LIMONCITO', 'El Limoncito', 'Riomar'),
  ('B_EL_MILAGRO', 'El Milagro', 'Sur Oriente'),
  ('B_EL_POBLADO', 'El Poblado', 'Riomar'),
  ('B_EL_PORVENIR', 'El Porvenir', 'Norte - Centro Histórico'),
  ('B_EL_PRADO', 'El Prado', 'Norte - Centro Histórico'),
  ('B_EL_PUEBLO', 'El Pueblo', 'Sur Occidente'),
  ('B_EL_RECREO', 'El Recreo', 'Norte - Centro Histórico'),
  ('B_EL_ROMANCE', 'El Romance', 'Sur Occidente'),
  ('B_EL_ROSARIO', 'El Rosario', 'Norte - Centro Histórico'),
  ('B_EL_RUBI', 'El Rubi', 'Sur Occidente'),
  ('B_EL_SANTUARIO', 'El Santuario', 'Metropolitana'),
  ('B_EL_SILENCIO', 'El Silencio', 'Sur Occidente'),
  ('B_EL_TABOR', 'El Tabor', 'Norte - Centro Histórico'),
  ('B_EL_VALLE', 'El Valle', 'Sur Occidente'),
  ('B_EVARISTO_SOURDIS', 'Evaristo Sourdis', 'Sur Occidente'),
  ('B_GRANADILLO', 'Granadillo', 'Norte - Centro Histórico'),
  ('B_INDUSTRIAL_NORTE', 'Industrial Norte', 'Riomar'),
  ('B_INDUSTRIAL_VIA_40', 'Industrial Via 40', 'Norte - Centro Histórico'),
  ('B_JOSE_ANTONIO_GALAN', 'Jose Antonio Galan', 'Sur Oriente'),
  ('B_KALAMARY', 'Kalamary', 'Sur Occidente'),
  ('B_KENNEDY', 'Kennedy', 'Metropolitana'),
  ('B_LA_ALBORAYA', 'La Alboraya', 'Sur Oriente'),
  ('B_LA_CAMPINA', 'La Campiña', 'Norte - Centro Histórico'),
  ('B_LA_CEIBA', 'La Ceiba', 'Sur Occidente'),
  ('B_LA_CHINITA', 'La Chinita', 'Sur Oriente'),
  ('B_LA_CONCEPCION', 'La Concepcion', 'Norte - Centro Histórico'),
  ('B_LA_CUMBRE', 'La Cumbre', 'Norte - Centro Histórico'),
  ('B_LA_ESMERALDA', 'La Esmeralda', 'Sur Occidente'),
  ('B_LA_FLORESTA', 'La Floresta', 'Riomar'),
  ('B_LA_FLORIDA', 'La Florida', 'Sur Occidente'),
  ('B_LA_GLORIA', 'La Gloria', 'Sur Occidente'),
  ('B_LA_LIBERTAD', 'La Libertad', 'Sur Occidente'),
  ('B_LA_LUZ', 'La Luz', 'Sur Oriente'),
  ('B_LA_MAGDALENA', 'La Magdalena', 'Sur Oriente'),
  ('B_LA_MANGA', 'La Manga', 'Sur Occidente'),
  ('B_LA_PAZ', 'La Paz', 'Sur Occidente'),
  ('B_LA_PRADERA', 'La Pradera', 'Sur Occidente'),
  ('B_LA_SIERRA', 'La Sierra', 'Metropolitana'),
  ('B_LA_SIERRITA', 'La Sierrita', 'Metropolitana'),
  ('B_LA_UNION', 'La Union', 'Sur Oriente'),
  ('B_LA_VICTORIA', 'La Victoria', 'Sur Oriente'),
  ('B_LAS_AMERICAS', 'Las Americas', 'Metropolitana'),
  ('B_LAS_CAYENAS', 'Las Cayenas', 'Metropolitana'),
  ('B_LAS_COLINAS', 'Las Colinas', 'Sur Occidente'),
  ('B_LAS_DELICIAS', 'Las Delicias', 'Norte - Centro Histórico'),
  ('B_LAS_DUNAS', 'Las Dunas', 'Sur Oriente'),
  ('B_LAS_ESTRELLAS', 'Las Estrellas', 'Sur Occidente'),
  ('B_LAS_FLORES', 'Las Flores', 'Riomar'),
  ('B_LAS_GARDENIAS', 'Las Gardenias', 'Metropolitana'),
  ('B_LAS_GRANJAS', 'Las Granjas', 'Metropolitana'),
  ('B_LAS_MALVINAS', 'Las Malvinas', 'Sur Occidente'),
  ('B_LAS_MERCEDES', 'Las Mercedes', 'Norte - Centro Histórico'),
  ('B_LAS_NIEVES', 'Las Nieves', 'Sur Oriente'),
  ('B_LAS_PALMAS', 'Las Palmas', 'Sur Oriente'),
  ('B_LAS_PALMERAS', 'Las Palmeras', 'Sur Oriente'),
  ('B_LAS_TERRAZAS', 'Las Terrazas', 'Sur Occidente'),
  ('B_LAS_TRES_AVE_MARIAS', 'Las Tres Ave Marias', 'Riomar'),
  ('B_LIMON', 'Limon', 'Sur Oriente'),
  ('B_LIPAYA', 'Lipaya', 'Sur Occidente'),
  ('B_LOMA_FRESCA', 'Loma Fresca', 'Sur Occidente'),
  ('B_LOS_ALPES', 'Los Alpes', 'Norte - Centro Histórico'),
  ('B_LOS_ANDES', 'Los Andes', 'Sur Occidente'),
  ('B_LOS_ANGELES_I', 'Los Angeles I', 'Sur Occidente'),
  ('B_LOS_ANGELES_II', 'Los Angeles II', 'Sur Occidente'),
  ('B_LOS_ANGELES_III', 'Los Angeles III', 'Sur Occidente'),
  ('B_LOS_CONTINENTES', 'Los Continentes', 'Metropolitana'),
  ('B_LOS_GIRASOLES', 'Los Girasoles', 'Metropolitana'),
  ('B_LOS_JOBOS', 'Los Jobos', 'Norte - Centro Histórico'),
  ('B_LOS_LAURELES', 'Los Laureles', 'Sur Oriente'),
  ('B_LOS_NOGALES', 'Los Nogales', 'Norte - Centro Histórico'),
  ('B_LOS_OLIVOS_I', 'Los Olivos I', 'Sur Occidente'),
  ('B_LOS_OLIVOS_II', 'Los Olivos II', 'Sur Occidente'),
  ('B_LOS_PINOS', 'Los Pinos', 'Sur Occidente'),
  ('B_LOS_ROSALES', 'Los Rosales', 'Sur Occidente'),
  ('B_LOS_TRUPILLOS', 'Los Trupillos', 'Sur Oriente'),
  ('B_LUCERO', 'Lucero', 'Sur Occidente'),
  ('B_ME_QUEJO', 'Me Quejo', 'Sur Occidente'),
  ('B_MERCEDES_SUR', 'Mercedes Sur', 'Sur Occidente'),
  ('B_MIRAMAR', 'Miramar', 'Norte - Centro Histórico'),
  ('B_MODELO', 'Modelo', 'Norte - Centro Histórico'),
  ('B_MONTECRISTO', 'Montecristo', 'Norte - Centro Histórico'),
  ('B_MONTES', 'Montes', 'Sur Oriente'),
  ('B_NUEVA_COLOMBIA', 'Nueva Colombia', 'Sur Occidente'),
  ('B_NUEVA_GRANADA', 'Nueva Granada', 'Sur Occidente'),
  ('B_NUEVO_HORIZONTE', 'Nuevo Horizonte', 'Norte - Centro Histórico'),
  ('B_OLAYA', 'Olaya', 'Sur Occidente'),
  ('B_PALMAS_DEL_RIO', 'Palmas del Rio', 'Riomar'),
  ('B_PARAISO', 'Paraiso', 'Norte - Centro Histórico'),
  ('B_PASADENA', 'Pasadena', 'Sur Oriente'),
  ('B_PASEO_DE_LA_CASTELLANA', 'Paseo de la Castellana', 'Riomar'),
  ('B_POR_FIN', 'Por Fin', 'Sur Occidente'),
  ('B_PRIMERO_DE_MAYO', 'Primero de Mayo', 'Sur Oriente'),
  ('B_PUMAREJO', 'Pumarejo', 'Sur Occidente'),
  ('B_REBOLO', 'Rebolo', 'Sur Oriente'),
  ('B_RIOMAR', 'Riomar', 'Riomar'),
  ('B_SAN_FELIPE', 'San Felipe', 'Sur Occidente'),
  ('B_SAN_FRANCISCO', 'San Francisco', 'Norte - Centro Histórico'),
  ('B_SAN_ISIDRO', 'San Isidro', 'Sur Occidente'),
  ('B_SAN_JOSE', 'San Jose', 'Sur Oriente'),
  ('B_SAN_LUIS', 'San Luis', 'Metropolitana'),
  ('B_SAN_MARINO', 'San Marino', 'Riomar'),
  ('B_SAN_NICOLAS', 'San Nicolas', 'Sur Oriente'),
  ('B_SAN_PEDRO', 'San Pedro', 'Sur Occidente'),
  ('B_SAN_PEDRO_ALEJANDRINO', 'San Pedro Alejandrino', 'Sur Occidente'),
  ('B_SAN_ROQUE', 'San Roque', 'Sur Oriente'),
  ('B_SAN_SALVADOR', 'San Salvador', 'Riomar'),
  ('B_SAN_VICENTE', 'San Vicente', 'Riomar'),
  ('B_SANTA_ANA', 'Santa Ana', 'Norte - Centro Histórico'),
  ('B_SANTA_HELENA', 'Santa Helena', 'Sur Oriente'),
  ('B_SANTA_MARIA', 'Santa Maria', 'Metropolitana'),
  ('B_SANTA_MONICA', 'Santa Monica', 'Riomar'),
  ('B_SANTO_DOMINGO_DE_GUZMAN', 'Santo Domingo de Guzman', 'Metropolitana'),
  ('B_SANTODOMINGO', 'Santodomingo', 'Sur Occidente'),
  ('B_SIAPE', 'Siape', 'Riomar'),
  ('B_SIMON_BOLIVAR', 'Simon Bolivar', 'Sur Oriente'),
  ('B_SOLAIRE_NORTE', 'Solaire Norte', 'Riomar'),
  ('B_TAYRONA', 'Tayrona', 'Sur Oriente'),
  ('B_UNIVERSAL', 'Universal', 'Sur Oriente'),
  ('B_VILLA_BLANCA', 'Villa Blanca', 'Sur Oriente'),
  ('B_VILLA_CAROLINA', 'Villa Carolina', 'Riomar'),
  ('B_VILLA_COUNTRY', 'Villa Country', 'Norte - Centro Histórico'),
  ('B_VILLA_FLOR', 'Villa Flor', 'Sur Occidente'),
  ('B_VILLA_SAN_CARLOS', 'Villa San Carlos', 'Metropolitana'),
  ('B_VILLA_SAN_CARLOS_II', 'Villa San Carlos II', 'Sur Occidente'),
  ('B_VILLA_SAN_PEDRO_II', 'Villa San Pedro II', 'Metropolitana'),
  ('B_VILLA_SANTOS', 'Villa Santos', 'Riomar'),
  ('B_VILLA_SEVILLA', 'Villa Sevilla', 'Metropolitana'),
  ('B_VILLA_DEL_CARMEN', 'Villa del Carmen', 'Sur Oriente'),
  ('B_VILLA_DEL_ESTE', 'Villa del Este', 'Riomar'),
  ('B_VILLA_DEL_ROSARIO', 'Villa del Rosario', 'Sur Occidente'),
  ('B_VILLANUEVA', 'Villanueva', 'Norte - Centro Histórico'),
  ('B_VILLATE', 'Villate', 'Sur Occidente'),
  ('B_ZONA_FRANCA', 'Zona Franca', 'Sur Oriente')
  ) AS b (codigo, nombre, localidad)
  JOIN catalogo_items l ON l.catalogo = 'LOCALIDAD' AND l.nombre = b.localidad;

-- ---------------------------------------------------------------------------------------------------------
-- Documentos exigidos (RN-05, RN-06, RF-CAR-03): parametrizables y versionados.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE documentos_requeridos (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo      text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9_]{3,60}$'),
  nombre      text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 3 AND 150),
  descripcion text NOT NULL DEFAULT '',
  -- PCD: persona con discapacidad · CUIDADOR: solo si se solicita el servicio para el cuidador · COMUN: ambos.
  aplica_a    text NOT NULL CHECK (aplica_a IN ('PCD', 'CUIDADOR', 'COMUN')),
  obligatorio boolean NOT NULL DEFAULT true,
  orden       integer NOT NULL DEFAULT 0,
  activo      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_documento_nombre ON documentos_requeridos (aplica_a, lower(btrim(nombre)));
CREATE TRIGGER documentos_requeridos_version BEFORE UPDATE ON documentos_requeridos
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER documentos_requeridos_historial AFTER INSERT OR UPDATE ON documentos_requeridos
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

-- Documentos mínimos de RN-06.
INSERT INTO documentos_requeridos (codigo, nombre, descripcion, aplica_a, orden) VALUES
  ('PCD_DOCUMENTO_IDENTIDAD', 'Documento de identidad de la persona con discapacidad', 'Copia legible por ambas caras.', 'PCD', 1),
  ('PCD_CERTIFICADO_DISCAPACIDAD', 'Certificado de discapacidad', 'Certificado vigente de discapacidad.', 'PCD', 2),
  ('PCD_AFILIACION_SUBSIDIADO', 'Soporte de afiliación al régimen subsidiado', 'Certificado de afiliación a salud en el régimen subsidiado.', 'PCD', 3),
  ('PCD_SISBEN', 'Soporte de clasificación en SISBÉN IV', 'Consulta o certificado del grupo SISBÉN IV (A, B o C).', 'PCD', 4),
  ('CUIDADOR_DOCUMENTO_IDENTIDAD', 'Documento de identidad del cuidador', 'Copia legible por ambas caras.', 'CUIDADOR', 5),
  ('CUIDADOR_SISBEN', 'Soporte de clasificación en SISBÉN IV del cuidador', 'Consulta o certificado del grupo SISBÉN IV (A, B o C).', 'CUIDADOR', 6),
  ('CUIDADOR_CARTA_CUIDADO', 'Carta de cuidado y contacto', 'Carta de cuidado o asistencia permanente completamente diligenciada.', 'CUIDADOR', 7),
  ('COMUN_CARTA_SOLICITUD', 'Carta de solicitud de preinscripción', 'Firmada por la persona con discapacidad y por el cuidador.', 'COMUN', 8);

-- ---------------------------------------------------------------------------------------------------------
-- Vigencias y cupos (RF-ADM-02, RF-ASG-03: registro de los cupos totales; el descuento por asignación es de la Entrega 2).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE vigencias (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anio          integer NOT NULL UNIQUE CHECK (anio BETWEEN 2020 AND 2100),
  fecha_inicio  date NOT NULL,
  fecha_fin     date NOT NULL,
  cupos_totales integer NOT NULL DEFAULT 0 CHECK (cupos_totales >= 0),
  activa        boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vigencias_fechas CHECK (fecha_fin >= fecha_inicio)
);
-- A la vez solo hay una vigencia activa: es la que recibe las preinscripciones.
CREATE UNIQUE INDEX uq_vigencia_activa ON vigencias (activa) WHERE activa;
CREATE TRIGGER vigencias_version BEFORE UPDATE ON vigencias
  FOR EACH ROW EXECUTE FUNCTION incrementar_version();
CREATE TRIGGER vigencias_historial AFTER INSERT OR UPDATE ON vigencias
  FOR EACH ROW EXECUTE FUNCTION guardar_version();

-- Vigencia inicial. Los cupos totales los registra la Gerencia (RF-ADM-02).
INSERT INTO vigencias (anio, fecha_inicio, fecha_fin, cupos_totales, activa)
VALUES (2026, '2026-01-01', '2026-12-31', 0, true);

-- ---------------------------------------------------------------------------------------------------------
-- Parámetros: se amplían con los de RF-ADM-02 y se agrega validación de formato y marca de «pendiente».
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE parametros ADD COLUMN patron text;
ALTER TABLE parametros ADD COLUMN pendiente_definicion boolean NOT NULL DEFAULT false;

INSERT INTO parametros (clave, grupo, descripcion, tipo, minimo, maximo, patron, pendiente_definicion) VALUES
  ('verificacion_correo_horas', 'Preinscripción', 'Horas de vigencia del enlace de verificación del correo; vencido, se puede reenviar (RF-PRE-04)', 'ENTERO', 1, 720, NULL, true),
  ('otp_vigencia_minutos', 'Preinscripción', 'Minutos de vigencia del código de un solo uso enviado al correo del ciudadano (RF-PRE-05)', 'ENTERO', 1, 60, NULL, false),
  ('archivo_max_mb', 'Documentos', 'Tamaño máximo por documento, en megabytes (RNF-06)', 'ENTERO', 1, 25, NULL, false),
  ('archivo_formatos', 'Documentos', 'Formatos de archivo permitidos, separados por coma (pdf, jpg, jpeg, png)', 'TEXTO', NULL, NULL, '^(pdf|jpg|jpeg|png)(,(pdf|jpg|jpeg|png))*$', false),
  ('plazo_subsanacion_dias', 'Verificación', 'Días calendario que tiene el ciudadano para subsanar (RN-12)', 'ENTERO', 1, 90, NULL, true),
  ('max_rondas_subsanacion', 'Verificación', 'Número máximo de rondas de subsanación (RF-VER-06)', 'ENTERO', 1, 10, NULL, true),
  ('plazo_descargos_dias', 'Beneficio', 'Días calendario para presentar descargos en una revocatoria (RF-BEN-04)', 'ENTERO', 1, 90, NULL, true),
  ('meta_beneficiarios', 'Programa', 'Meta de beneficiarios del programa, para el tablero de control (RF-SEG-03)', 'ENTERO', 1, 1000000, NULL, false);

INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES
  ('verificacion_correo_horas', '72', 'Valor inicial'),
  ('otp_vigencia_minutos', '10', 'Valor inicial'),
  ('archivo_max_mb', '5', 'Valor inicial según RNF-06 (PDF, JPG, PNG hasta 5 MB)'),
  ('archivo_formatos', 'pdf,jpg,png', 'Valor inicial según RNF-06'),
  ('plazo_subsanacion_dias', '10', 'Valor inicial'),
  ('max_rondas_subsanacion', '2', 'Valor inicial'),
  ('plazo_descargos_dias', '10', 'Valor inicial'),
  ('meta_beneficiarios', '3000', 'Meta del programa según la propuesta');

-- ---------------------------------------------------------------------------------------------------------
-- Texto de autorización de tratamiento de datos (RF-PRE-03): cada cambio genera una versión nueva; las
-- aceptaciones anteriores conservan la versión que aceptaron.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE textos_autorizacion (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version       integer NOT NULL UNIQUE,
  contenido     text NOT NULL CHECK (length(btrim(contenido)) BETWEEN 50 AND 20000),
  vigente_desde timestamptz NOT NULL DEFAULT now(),
  creado_por    integer REFERENCES usuarios (id),
  creado_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER textos_autorizacion_inmutable BEFORE UPDATE OR DELETE ON textos_autorizacion
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();

INSERT INTO textos_autorizacion (version, contenido) VALUES (1, $texto$AUTORIZACIÓN PARA EL TRATAMIENTO DE DATOS PERSONALES

De conformidad con la Ley 1581 de 2012 y sus decretos reglamentarios, autorizo de manera libre, previa, expresa e informada a la Alcaldía Distrital de Barranquilla, a través de la Gerencia de Desarrollo Social, para recolectar, almacenar, usar, consultar y circular mis datos personales y los de la persona con discapacidad que represento o a quien asisto, con la finalidad de gestionar el Estímulo Social de Transporte creado por el Acuerdo Distrital 0022 de 2025: preinscripción, verificación de requisitos, priorización, asignación, entrega y seguimiento del beneficio, y comunicaciones relacionadas con el proceso.

Autorizo de manera expresa el tratamiento de DATOS SENSIBLES, en particular los relacionados con la salud y la discapacidad, que son necesarios para verificar los requisitos del programa. Entiendo que no estoy obligado(a) a autorizar el tratamiento de datos sensibles, pero que sin ellos no es posible tramitar la solicitud.

Declaro que la información que suministro es veraz. Sé que puedo conocer, actualizar, rectificar y suprimir mis datos, y revocar esta autorización, mediante los canales de atención de la Alcaldía Distrital de Barranquilla, y que la preinscripción no equivale a la aprobación del beneficio.

(Texto inicial, pendiente de revisión y ajuste por la Oficina Jurídica. El administrador puede actualizarlo desde el portal interno; cada cambio genera una nueva versión.)$texto$);
