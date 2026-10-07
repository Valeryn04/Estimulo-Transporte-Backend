import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

/** Documentación OpenAPI de la API: `docs/openapi.yaml` (misma profundidad desde `src` y desde `dist`). */
const RUTA_ESPECIFICACION = new URL('../../../docs/openapi.yaml', import.meta.url);

export function cargarEspecificacion(): Record<string, unknown> {
  return parse(readFileSync(RUTA_ESPECIFICACION, 'utf8')) as Record<string, unknown>;
}

/** Publica la especificación en /api/docs (interfaz) y /api/docs/openapi.json (documento). */
export function publicarDocumentacion(app: Express): void {
  const especificacion = cargarEspecificacion();
  app.get('/api/docs/openapi.json', (_req, res) => {
    res.json(especificacion);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(especificacion, {
      customSiteTitle: 'API del Estímulo Social de Transporte',
      swaggerOptions: { persistAuthorization: false },
    }),
  );
}
