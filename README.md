# Estímulo Social de Transporte · Backend

API REST (`/api/v1`) del Estímulo Social de Transporte de la Alcaldía de Barranquilla.
Node 24, Express 5, TypeScript, PostgreSQL 15+.

```bash
npm install
cp .env.example .env     # complete los valores
npm run seed:admin       # crea el administrador principal
npm run dev:smtp         # correo de desarrollo (opcional)
npm run dev              # API en http://localhost:3100
```

Pruebas: `npm test`. Contrato de la API: `docs/openapi.yaml` (también en `/api/docs` fuera de producción).
