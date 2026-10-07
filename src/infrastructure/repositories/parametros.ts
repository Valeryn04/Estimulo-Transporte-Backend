import type { Queryable } from '../db/pool.js';

/** Valor vigente de un parámetro: la última versión cuya vigencia ya comenzó (RNF-12). */
export const parametrosRepo = {
  async texto(db: Queryable, clave: string): Promise<string> {
    const r = await db.query<{ valor: string }>(
      `SELECT valor FROM parametro_versiones
        WHERE clave = $1 AND vigente_desde <= now()
        ORDER BY vigente_desde DESC, id DESC LIMIT 1`,
      [clave],
    );
    const fila = r.rows[0];
    if (!fila) throw new Error(`El parámetro «${clave}» no tiene un valor vigente`);
    return fila.valor;
  },

  async entero(db: Queryable, clave: string): Promise<number> {
    const n = Number(await this.texto(db, clave));
    if (!Number.isInteger(n)) throw new Error(`El parámetro «${clave}» no es un entero`);
    return n;
  },
};
