-- Migración 012 · Una persona puede no estar afiliada a ninguna EPS: se agrega la opción «Ninguna» a esa lista
-- (se muestra siempre al final). Las listas de género y estado civil solo llevan «N/A»; etnia, escolaridad y
-- ocupación ya tienen «Ninguna/Ninguno» y «N/A».
INSERT INTO catalogo_items (catalogo, codigo, nombre) VALUES ('EPS', 'NINGUNA', 'Ninguna')
ON CONFLICT DO NOTHING;
