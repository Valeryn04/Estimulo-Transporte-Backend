import type { Queryable } from '../db/pool.js';

export type AplicaACruce = 'PCD' | 'CUIDADOR' | 'AMBOS';

export interface CargaResumen {
  id: number;
  archivoNombre: string;
  filasTotal: number;
  filasValidas: number;
  filasError: number;
  vigente: boolean;
  cargadoPor: string;
  cargadoAt: Date;
}

export interface Estructura {
  id: number;
  codigo: string;
  nombre: string;
  entidad: string;
  descripcion: string;
  columnaIdentificacion: string;
  columnaDetalle: string | null;
  aplicaA: AplicaACruce;
  activo: boolean;
  version: number;
  vigente: CargaResumen | null;
}

export interface DatosEstructura {
  nombre: string;
  entidad: string;
  descripcion: string;
  columnaIdentificacion: string;
  columnaDetalle: string | null;
  aplicaA: AplicaACruce;
}

interface FilaEstructura {
  id: number;
  codigo: string;
  nombre: string;
  entidad: string;
  descripcion: string;
  columna_identificacion: string;
  columna_detalle: string | null;
  aplica_a: AplicaACruce;
  activo: boolean;
  version: number;
}

interface FilaCarga {
  id: string;
  archivo_nombre: string;
  filas_total: number;
  filas_validas: number;
  filas_error: number;
  vigente: boolean;
  cargado_por: string;
  cargado_at: Date;
}

const mapearCarga = (f: FilaCarga): CargaResumen => ({
  id: Number(f.id),
  archivoNombre: f.archivo_nombre,
  filasTotal: f.filas_total,
  filasValidas: f.filas_validas,
  filasError: f.filas_error,
  vigente: f.vigente,
  cargadoPor: f.cargado_por,
  cargadoAt: f.cargado_at,
});

const SELECT_CARGAS = `SELECT c.id, c.archivo_nombre, c.filas_total, c.filas_validas, c.filas_error, c.vigente,
                              u.usuario AS cargado_por, c.cargado_at
                         FROM cruce_cargas c JOIN usuarios u ON u.id = c.cargado_por`;

const mapearEstructura = (f: FilaEstructura, vigente: CargaResumen | null): Estructura => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  entidad: f.entidad,
  descripcion: f.descripcion,
  columnaIdentificacion: f.columna_identificacion,
  columnaDetalle: f.columna_detalle,
  aplicaA: f.aplica_a,
  activo: f.activo,
  version: f.version,
  vigente,
});

export interface Coincidencia {
  huella: string;
  detalle: string;
  cargadoAt: Date;
}

export const crucesRepo = {
  async listar(db: Queryable): Promise<Estructura[]> {
    const e = await db.query<FilaEstructura>(
      `SELECT id, codigo, nombre, entidad, descripcion, columna_identificacion, columna_detalle, aplica_a, activo, version
         FROM cruce_estructuras ORDER BY activo DESC, id`,
    );
    const v = await db.query<FilaCarga & { estructura_id: number }>(
      `${SELECT_CARGAS.replace('SELECT c.id', 'SELECT c.estructura_id, c.id')} WHERE c.vigente`,
    );
    const porEstructura = new Map(v.rows.map((f) => [f.estructura_id, mapearCarga(f)]));
    return e.rows.map((f) => mapearEstructura(f, porEstructura.get(f.id) ?? null));
  },

  async porId(db: Queryable, id: number): Promise<Estructura | null> {
    return (await this.listar(db)).find((e) => e.id === id) ?? null;
  },

  async crear(db: Queryable, codigo: string, d: DatosEstructura): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO cruce_estructuras (codigo, nombre, entidad, descripcion, columna_identificacion, columna_detalle, aplica_a)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        codigo,
        d.nombre,
        d.entidad,
        d.descripcion,
        d.columnaIdentificacion,
        d.columnaDetalle,
        d.aplicaA,
      ],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(db: Queryable, id: number, d: DatosEstructura): Promise<void> {
    await db.query(
      `UPDATE cruce_estructuras SET nombre = $2, entidad = $3, descripcion = $4, columna_identificacion = $5,
              columna_detalle = $6, aplica_a = $7 WHERE id = $1`,
      [
        id,
        d.nombre,
        d.entidad,
        d.descripcion,
        d.columnaIdentificacion,
        d.columnaDetalle,
        d.aplicaA,
      ],
    );
  },

  async fijarActivo(db: Queryable, id: number, activo: boolean): Promise<void> {
    await db.query(`UPDATE cruce_estructuras SET activo = $2 WHERE id = $1`, [id, activo]);
  },

  async cargas(db: Queryable, estructuraId: number): Promise<CargaResumen[]> {
    const r = await db.query<FilaCarga>(
      `${SELECT_CARGAS} WHERE c.estructura_id = $1 ORDER BY c.cargado_at DESC, c.id DESC LIMIT 100`,
      [estructuraId],
    );
    return r.rows.map(mapearCarga);
  },

  async carga(
    db: Queryable,
    id: number,
  ): Promise<(CargaResumen & { estructuraId: number }) | null> {
    const r = await db.query<FilaCarga & { estructura_id: number }>(
      `${SELECT_CARGAS.replace('SELECT c.id', 'SELECT c.estructura_id, c.id')} WHERE c.id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f ? { ...mapearCarga(f), estructuraId: f.estructura_id } : null;
  },

  async errores(db: Queryable, cargaId: number): Promise<{ fila: number; mensaje: string }[]> {
    const r = await db.query<{ fila: number; mensaje: string }>(
      `SELECT fila, mensaje FROM cruce_errores WHERE carga_id = $1 ORDER BY fila, mensaje`,
      [cargaId],
    );
    return r.rows;
  },

  /** Guarda la carga, deja las anteriores como historia y la deja vigente. */
  async registrarCarga(
    db: Queryable,
    d: {
      estructuraId: number;
      archivoNombre: string;
      archivoHash: string;
      total: number;
      huellas: { huella: string; detalle: string }[];
      errores: { fila: number; mensaje: string }[];
      usuarioId: number;
    },
  ): Promise<number> {
    await db.query(`UPDATE cruce_cargas SET vigente = false WHERE estructura_id = $1 AND vigente`, [
      d.estructuraId,
    ]);
    const r = await db.query<{ id: string }>(
      `INSERT INTO cruce_cargas (estructura_id, archivo_nombre, archivo_hash, filas_total, filas_validas, filas_error, cargado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        d.estructuraId,
        d.archivoNombre,
        d.archivoHash,
        d.total,
        d.huellas.length,
        d.errores.length,
        d.usuarioId,
      ],
    );
    const cargaId = Number((r.rows[0] as { id: string }).id);
    for (let i = 0; i < d.huellas.length; i += 5000) {
      const lote = d.huellas.slice(i, i + 5000);
      await db.query(
        `INSERT INTO cruce_registros (carga_id, identificacion_huella, detalle)
         SELECT $1, h, t FROM unnest($2::text[], $3::text[]) AS x (h, t)`,
        [cargaId, lote.map((x) => x.huella), lote.map((x) => x.detalle)],
      );
    }
    for (let i = 0; i < d.errores.length; i += 5000) {
      const lote = d.errores.slice(i, i + 5000);
      await db.query(
        `INSERT INTO cruce_errores (carga_id, fila, mensaje)
         SELECT $1, f, m FROM unnest($2::int[], $3::text[]) AS x (f, m) ON CONFLICT DO NOTHING`,
        [cargaId, lote.map((x) => x.fila), lote.map((x) => x.mensaje)],
      );
    }
    return cargaId;
  },

  /** Busca las huellas en la carga vigente del cruce activo con ese código. */
  async coincidencias(
    db: Queryable,
    codigo: string,
    huellas: string[],
  ): Promise<{ estructura: Estructura | null; coincidencias: Coincidencia[] }> {
    const e = (await this.listar(db)).find((x) => x.codigo === codigo && x.activo) ?? null;
    if (!e?.vigente || huellas.length === 0) return { estructura: e, coincidencias: [] };
    const r = await db.query<{ identificacion_huella: string; detalle: string }>(
      `SELECT identificacion_huella, detalle FROM cruce_registros
        WHERE carga_id = $1 AND identificacion_huella = ANY($2::text[])`,
      [e.vigente.id, huellas],
    );
    return {
      estructura: e,
      coincidencias: r.rows.map((f) => ({
        huella: f.identificacion_huella,
        detalle: f.detalle,
        cargadoAt: (e.vigente as CargaResumen).cargadoAt,
      })),
    };
  },

  async codigoExiste(db: Queryable, codigo: string): Promise<boolean> {
    const r = await db.query(`SELECT 1 FROM cruce_estructuras WHERE codigo = $1 AND activo`, [
      codigo,
    ]);
    return r.rowCount === 1;
  },
};
