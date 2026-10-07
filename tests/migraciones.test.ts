import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { crearEntorno, type Entorno } from './helpers.js';

describe('migraciones versionadas', () => {
  let e: Entorno;
  beforeAll(async () => {
    e = await crearEntorno();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('son idempotentes: una segunda ejecución no aplica nada', async () => {
    expect(await runMigrations(e.pool)).toEqual([]);
  });

  it('detectan una migración ya aplicada que fue modificada', async () => {
    await e.pool.query("UPDATE schema_migrations SET checksum = repeat('0', 64)");
    await expect(runMigrations(e.pool)).rejects.toThrow(/cambió/);
  });
});
