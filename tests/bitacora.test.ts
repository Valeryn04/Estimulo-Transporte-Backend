import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bitacoraRepo } from '../src/infrastructure/repositories/bitacora.js';
import { crearEntorno, type Entorno } from './helpers.js';

describe('bitácora de auditoría (RNF-07, RF-SEG-01)', () => {
  let e: Entorno;
  beforeAll(async () => {
    e = await crearEntorno();
    await bitacoraRepo.registrar(e.pool, {
      modulo: 'parametros',
      accion: 'PARAMETRO_MODIFICADO',
      entidad: 'parametro',
      entidadId: 'plazo_subsanacion',
      valorAnterior: { dias: 5 },
      valorNuevo: { dias: 8 },
      justificacion: 'Ajuste del manual operativo',
      ip: '10.0.0.1',
    });
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('registra usuario, acción, valores anterior y nuevo, justificación e IP', async () => {
    const { rows } = await e.pool.query('SELECT * FROM bitacora');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      modulo: 'parametros',
      accion: 'PARAMETRO_MODIFICADO',
      valor_anterior: { dias: 5 },
      valor_nuevo: { dias: 8 },
      justificacion: 'Ajuste del manual operativo',
      ip: '10.0.0.1',
    });
    expect(rows[0].creado_at).toBeInstanceOf(Date);
  });

  it('no permite editar registros', async () => {
    await expect(e.pool.query("UPDATE bitacora SET accion = 'OTRA'")).rejects.toThrow(/inmutable/);
  });

  it('no permite borrar registros', async () => {
    await expect(e.pool.query('DELETE FROM bitacora')).rejects.toThrow(/inmutable/);
  });

  it('no permite vaciar la tabla', async () => {
    await expect(e.pool.query('TRUNCATE bitacora')).rejects.toThrow(/inmutable/);
  });

  it('rechaza acciones o módulos vacíos', async () => {
    await expect(
      bitacoraRepo.registrar(e.pool, { modulo: 'x', accion: '  ', entidad: 'y' }),
    ).rejects.toThrow();
  });
});
