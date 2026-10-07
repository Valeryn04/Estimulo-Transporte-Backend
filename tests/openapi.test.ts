import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cargarEspecificacion } from '../src/presentation/http/documentacion.js';
import { crearEntorno, type Entorno } from './helpers.js';

// La documentación OpenAPI (docs/openapi.yaml) es un entregable. Estas pruebas la mantienen honesta:
// toda ruta real debe estar documentada y toda ruta documentada debe existir.

interface Operacion {
  tags?: string[];
  summary?: string;
  security?: unknown[];
  responses?: Record<string, unknown>;
}
type Especificacion = {
  openapi: string;
  paths: Record<string, Record<string, Operacion | unknown>>;
  components: Record<string, Record<string, unknown>>;
};

const METODOS = ['get', 'post', 'put', 'delete', 'patch'];
const spec = cargarEspecificacion() as unknown as Especificacion;

/** Rutas reales: se leen de los archivos de rutas (cada archivo tiene su prefijo de montaje). */
function rutasDelCodigo(): Set<string> {
  const fuentes = [
    { archivo: 'src/presentation/http/routes/publico.ts', prefijo: '/publico' },
    { archivo: 'src/presentation/http/routes/auth.ts', prefijo: '/auth' },
    { archivo: 'src/presentation/http/routes/admin.ts', prefijo: '/admin' },
    { archivo: 'src/presentation/http/routes/configuracion.ts', prefijo: '/admin' },
    { archivo: 'src/presentation/http/app.ts', prefijo: '' },
  ];
  const rutas = new Set<string>();
  for (const { archivo, prefijo } of fuentes) {
    const codigo = readFileSync(archivo, 'utf8');
    // Admite la ruta en la misma línea o en la siguiente (código formateado por Prettier).
    for (const m of codigo.matchAll(/\b(?:r|v1)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      rutas.add(`${m[1]!.toUpperCase()} ${prefijo}${m[2]!.replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  return rutas;
}

function rutasDocumentadas(): Set<string> {
  const rutas = new Set<string>();
  for (const [ruta, item] of Object.entries(spec.paths)) {
    for (const metodo of METODOS) if (metodo in item) rutas.add(`${metodo.toUpperCase()} ${ruta}`);
  }
  return rutas;
}

describe('documentación OpenAPI de la API', () => {
  it('el escaneo del código encuentra las rutas (guarda contra un escaneo vacío)', () => {
    expect(rutasDelCodigo().size).toBeGreaterThanOrEqual(14);
  });

  it('toda ruta del código está documentada', () => {
    const faltantes = [...rutasDelCodigo()].filter((r) => !rutasDocumentadas().has(r));
    expect(faltantes, `Rutas sin documentar: ${faltantes.join(', ')}`).toEqual([]);
  });

  it('toda ruta documentada existe en el código', () => {
    const sobrantes = [...rutasDocumentadas()].filter((r) => !rutasDelCodigo().has(r));
    expect(sobrantes, `Rutas documentadas que no existen: ${sobrantes.join(', ')}`).toEqual([]);
  });

  it('cada operación tiene etiqueta, resumen y respuestas; las de /admin declaran seguridad', () => {
    for (const [ruta, item] of Object.entries(spec.paths)) {
      for (const metodo of METODOS.filter((m) => m in item)) {
        const op = (item as Record<string, Operacion>)[metodo]!;
        const nombre = `${metodo.toUpperCase()} ${ruta}`;
        expect(op.tags?.length, `${nombre}: sin etiqueta`).toBeGreaterThan(0);
        expect(op.summary, `${nombre}: sin resumen`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${nombre}: sin respuestas`).toBeGreaterThan(
          0,
        );
        if (ruta.startsWith('/admin')) {
          expect(op.security?.length, `${nombre}: debe declarar seguridad`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('todas las referencias ($ref) apuntan a algo que existe', () => {
    const texto = readFileSync('docs/openapi.yaml', 'utf8');
    const refs = [...texto.matchAll(/\$ref:\s*'#\/components\/(\w+)\/(\w+)'/g)];
    expect(refs.length).toBeGreaterThan(20);
    for (const [, tipo, nombre] of refs) {
      expect(spec.components[tipo!]?.[nombre!], `$ref roto: ${tipo}/${nombre}`).toBeDefined();
    }
  });
});

describe('publicación de la documentación', () => {
  let e: Entorno;
  beforeAll(async () => {
    e = await crearEntorno();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('sirve la especificación en JSON y la interfaz de Swagger', async () => {
    const json = await request(e.app).get('/api/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.0.3');
    const ui = await request(e.app).get('/api/docs/').redirects(1);
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
