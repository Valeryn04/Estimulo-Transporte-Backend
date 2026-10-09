-- Migración 013 · La EPS es una respuesta obligatoria del formulario y no lleva «Ninguna» ni «N/A»
-- (la propuesta solo las incluye en género, estado civil, etnia, escolaridad y ocupación). La opción que agregó la
-- migración 012 se desactiva (no se borra: la EPS elegida se guarda cifrada y no se puede saber si alguien la usó).
UPDATE catalogo_items SET activo = false WHERE catalogo = 'EPS' AND codigo = 'NINGUNA';
