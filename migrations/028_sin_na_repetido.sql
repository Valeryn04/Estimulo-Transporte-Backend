-- Migración 028 · En etnia, escolaridad y ocupación «Ninguna/Ninguno» y «N/A» significaban lo mismo: queda solo
-- «Ninguna/Ninguno». Género y estado civil siguen con «N/A». La opción se desactiva y no se borra: las respuestas
-- ya guardadas (si las hay) conservan su valor y el formulario sigue mostrándolo.
UPDATE catalogo_items SET activo = false
 WHERE codigo = 'NA' AND catalogo IN ('ETNIA', 'ESCOLARIDAD', 'OCUPACION');
