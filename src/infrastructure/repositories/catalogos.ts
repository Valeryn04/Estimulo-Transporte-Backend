import type { Queryable } from '../db/pool.js';

export const CATALOGOS = [
  'TIPO_IDENTIFICACION',
  'LOCALIDAD',
  'BARRIO',
  'EPS',
  'TIPO_TRANSPORTE',
  'GENERO',
  'ESTADO_CIVIL',
  'ETNIA',
  'ESCOLARIDAD',
  'OCUPACION',
  'CAUSAL_BLOQUEO',
  'CAUSAL_REVOCATORIA',
] as const;
export type Catalogo = (typeof CATALOGOS)[number];

export interface ItemCatalogo {
  id: number;
  catalogo: Catalogo;
  codigo: string;
  nombre: string;
  padreId: number | null;
  padreNombre: string | null;
  orden: number;
  activo: boolean;
  version: number;
  updatedAt: Date;
}

interface Fila {
  id: number;
  catalogo: Catalogo;
  codigo: string;
  nombre: string;
  padre_id: number | null;
  padre_nombre: string | null;
  orden: number;
  activo: boolean;
  version: number;
  updated_at: Date;
}

const SELECT = `SELECT c.id, c.catalogo, c.codigo, c.nombre, c.padre_id, p.nombre AS padre_nombre,
                       c.orden, c.activo, c.version, c.updated_at
                  FROM catalogo_items c LEFT JOIN catalogo_items p ON p.id = c.padre_id`;

const mapear = (f: Fila): ItemCatalogo => ({
  id: f.id,
  catalogo: f.catalogo,
  codigo: f.codigo,
  nombre: f.nombre,
  padreId: f.padre_id,
  padreNombre: f.padre_nombre,
  orden: f.orden,
  activo: f.activo,
  version: f.version,
  updatedAt: f.updated_at,
});

export interface FiltroItems {
  q?: string;
  activo?: boolean;
  padreId?: number;
  orden?: number;
  limit: number;
  offset: number;
}

export interface VersionRegistro {
  version: number;
  snapshot: Record<string, unknown>;
  usuario: string | null;
  creadoAt: Date;
}

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * El orden de una lista es una posición propia (1, 2, 3…): nunca hay dos elementos con el mismo número.
 * Reescribe las posiciones de un grupo; si se indica `mover`, ese elemento queda en la posición pedida y los demás
 * se corren (la posición se ajusta al rango válido). La restricción única se revisa al final de la transacción.
 */
async function renumerar(
  db: Queryable,
  tabla: 'catalogo_items' | 'documentos_requeridos',
  donde: string,
  params: unknown[],
  mover?: { id: number; posicion: number },
): Promise<void> {
  const r = await db.query<{ id: number; orden: number }>(
    `SELECT id, orden FROM ${tabla} WHERE ${donde} ORDER BY orden, id FOR UPDATE`,
    params,
  );
  const actual = new Map(r.rows.map((x) => [x.id, x.orden]));
  let ids = r.rows.map((x) => x.id);
  if (mover) {
    ids = ids.filter((i) => i !== mover.id);
    ids.splice(Math.min(Math.max(mover.posicion, 1), ids.length + 1) - 1, 0, mover.id);
  }
  const cambios = ids
    .map((id, i) => ({ id, orden: i + 1 }))
    .filter((c) => actual.get(c.id) !== c.orden);
  if (cambios.length === 0) return;
  await db.query(
    `UPDATE ${tabla} t SET orden = v.orden
       FROM unnest($1::int[], $2::int[]) AS v(id, orden) WHERE t.id = v.id`,
    [cambios.map((c) => c.id), cambios.map((c) => c.orden)],
  );
}

/** Evita que dos personas reordenen la misma lista al mismo tiempo. */
async function bloquearOrden(db: Queryable, clave: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`orden:${clave}`]);
}

const GRUPO = 'catalogo = $1 AND padre_id IS NOT DISTINCT FROM $2::integer';

export const catalogosRepo = {
  async resumen(db: Queryable): Promise<{ catalogo: Catalogo; total: number; activos: number }[]> {
    const r = await db.query<{ catalogo: Catalogo; total: number; activos: number }>(
      `SELECT catalogo, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE activo)::int AS activos
         FROM catalogo_items GROUP BY catalogo`,
    );
    const porCatalogo = new Map(r.rows.map((x) => [x.catalogo, x]));
    return CATALOGOS.map((c) => porCatalogo.get(c) ?? { catalogo: c, total: 0, activos: 0 });
  },

  async listar(
    db: Queryable,
    catalogo: Catalogo,
    f: FiltroItems,
  ): Promise<{ items: ItemCatalogo[]; total: number }> {
    const params: unknown[] = [catalogo];
    const where = ['c.catalogo = $1'];
    if (f.q) {
      params.push(`%${escaparLike(f.q)}%`);
      where.push(`(c.nombre ILIKE $${params.length} OR c.codigo ILIKE $${params.length})`);
    }
    if (f.activo !== undefined) {
      params.push(f.activo);
      where.push(`c.activo = $${params.length}`);
    }
    if (f.padreId !== undefined) {
      params.push(f.padreId);
      where.push(`c.padre_id = $${params.length}`);
    }
    if (f.orden !== undefined) {
      params.push(f.orden);
      where.push(`c.orden = $${params.length}`);
    }
    params.push(f.limit, f.offset);
    const r = await db.query<Fila & { total: number }>(
      `SELECT c.id, c.catalogo, c.codigo, c.nombre, c.padre_id, p.nombre AS padre_nombre, c.orden,
              c.activo, c.version, c.updated_at, COUNT(*) OVER() AS total
         FROM catalogo_items c LEFT JOIN catalogo_items p ON p.id = c.padre_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.orden, c.nombre
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(mapear), total: r.rows[0]?.total ?? 0 };
  },

  async porId(db: Queryable, id: number): Promise<ItemCatalogo | null> {
    const r = await db.query<Fila>(`${SELECT} WHERE c.id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  /** Crea el elemento al final de su grupo; si se indica `orden`, lo coloca en esa posición. */
  async crear(
    db: Queryable,
    d: {
      catalogo: Catalogo;
      codigo: string;
      nombre: string;
      padreId: number | null;
      orden?: number;
    },
  ): Promise<number> {
    await bloquearOrden(db, `catalogo_items:${d.catalogo}`);
    const posicion = await db.query<{ p: number }>(
      `SELECT LEAST(COALESCE($3::integer, 2147483647), COALESCE(MAX(orden), 0) + 1) AS p
         FROM catalogo_items WHERE ${GRUPO}`,
      [d.catalogo, d.padreId, d.orden ?? null],
    );
    const p = (posicion.rows[0] as { p: number }).p;
    await db.query(
      `UPDATE catalogo_items SET orden = orden + 1 WHERE ${GRUPO} AND orden >= $3::integer`,
      [d.catalogo, d.padreId, p],
    );
    const r = await db.query<{ id: number }>(
      `INSERT INTO catalogo_items (catalogo, codigo, nombre, padre_id, orden)
       VALUES ($1, $2, $3, $4::integer, $5) RETURNING id`,
      [d.catalogo, d.codigo, d.nombre, d.padreId, p],
    );
    return (r.rows[0] as { id: number }).id;
  },

  /**
   * Actualiza el elemento. Con `orden` lo mueve a esa posición (los demás se corren); sin `orden` conserva su
   * posición, salvo que cambie de localidad: entonces queda al final del grupo nuevo.
   */
  async actualizar(
    db: Queryable,
    id: number,
    d: { nombre: string; padreId: number | null; orden?: number },
    previo: { catalogo: Catalogo; padreId: number | null },
  ): Promise<void> {
    await bloquearOrden(db, `catalogo_items:${previo.catalogo}`);
    const cambiaGrupo = previo.padreId !== d.padreId;
    if (cambiaGrupo) {
      await db.query(
        `UPDATE catalogo_items
            SET nombre = $2, padre_id = $3::integer,
                orden = (SELECT COALESCE(MAX(orden), 0) + 1 FROM catalogo_items
                          WHERE catalogo = $4 AND padre_id IS NOT DISTINCT FROM $3::integer)
          WHERE id = $1`,
        [id, d.nombre, d.padreId, previo.catalogo],
      );
      await renumerar(db, 'catalogo_items', GRUPO, [previo.catalogo, previo.padreId]);
    } else {
      await db.query(`UPDATE catalogo_items SET nombre = $2 WHERE id = $1`, [id, d.nombre]);
    }
    if (d.orden !== undefined) {
      await renumerar(db, 'catalogo_items', GRUPO, [previo.catalogo, d.padreId], {
        id,
        posicion: d.orden,
      });
    }
  },

  async fijarActivo(db: Queryable, id: number, activo: boolean): Promise<void> {
    await db.query(`UPDATE catalogo_items SET activo = $2 WHERE id = $1`, [id, activo]);
  },

  async contarHijosActivos(db: Queryable, id: number): Promise<number> {
    const r = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM catalogo_items WHERE padre_id = $1 AND activo`,
      [id],
    );
    return r.rows[0]?.n ?? 0;
  },

  /** Historial de versiones de un registro (catálogos, documentos exigidos y vigencias). */
  async versiones(db: Queryable, tabla: string, id: number): Promise<VersionRegistro[]> {
    const r = await db.query<{
      version: number;
      snapshot: Record<string, unknown>;
      usuario: string | null;
      creado_at: Date;
    }>(
      `SELECT h.version, h.snapshot, u.usuario, h.creado_at
         FROM historial_versiones h LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.tabla = $1 AND h.registro_id = $2 ORDER BY h.version DESC`,
      [tabla, id],
    );
    return r.rows.map((x) => ({
      version: x.version,
      snapshot: x.snapshot,
      usuario: x.usuario,
      creadoAt: x.creado_at,
    }));
  },
};

export type AplicaA = 'PCD' | 'CUIDADOR' | 'COMUN';

export interface DocumentoRequerido {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplicaA: AplicaA;
  obligatorio: boolean;
  orden: number;
  activo: boolean;
  version: number;
}

interface FilaDoc {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplica_a: AplicaA;
  obligatorio: boolean;
  orden: number;
  activo: boolean;
  version: number;
}

const mapearDoc = (f: FilaDoc): DocumentoRequerido => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  descripcion: f.descripcion,
  aplicaA: f.aplica_a,
  obligatorio: f.obligatorio,
  orden: f.orden,
  activo: f.activo,
  version: f.version,
});

const COLS_DOC = 'id, codigo, nombre, descripcion, aplica_a, obligatorio, orden, activo, version';

export interface DatosDocumento {
  nombre: string;
  descripcion: string;
  aplicaA: AplicaA;
  obligatorio: boolean;
  /** Posición en la lista (desde 1). Sin indicarla, el documento queda al final o conserva la suya. */
  orden?: number;
}

export const documentosRepo = {
  async listar(db: Queryable): Promise<DocumentoRequerido[]> {
    const r = await db.query<FilaDoc>(
      `SELECT ${COLS_DOC} FROM documentos_requeridos ORDER BY activo DESC, orden, id`,
    );
    return r.rows.map(mapearDoc);
  },

  async porId(db: Queryable, id: number): Promise<DocumentoRequerido | null> {
    const r = await db.query<FilaDoc>(
      `SELECT ${COLS_DOC} FROM documentos_requeridos WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? mapearDoc(r.rows[0]) : null;
  },

  /** Crea el documento al final de la lista; si se indica `orden`, lo coloca en esa posición. */
  async crear(db: Queryable, codigo: string, d: DatosDocumento): Promise<number> {
    await bloquearOrden(db, 'documentos_requeridos');
    const posicion = await db.query<{ p: number }>(
      `SELECT LEAST(COALESCE($1::integer, 2147483647), COALESCE(MAX(orden), 0) + 1) AS p
         FROM documentos_requeridos`,
      [d.orden ?? null],
    );
    const p = (posicion.rows[0] as { p: number }).p;
    await db.query(
      `UPDATE documentos_requeridos SET orden = orden + 1 WHERE orden >= $1::integer`,
      [p],
    );
    const r = await db.query<{ id: number }>(
      `INSERT INTO documentos_requeridos (codigo, nombre, descripcion, aplica_a, obligatorio, orden)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [codigo, d.nombre, d.descripcion, d.aplicaA, d.obligatorio, p],
    );
    return (r.rows[0] as { id: number }).id;
  },

  /** Con `orden` mueve el documento a esa posición (los demás se corren); sin `orden` conserva la suya. */
  async actualizar(db: Queryable, id: number, d: DatosDocumento): Promise<void> {
    await bloquearOrden(db, 'documentos_requeridos');
    await db.query(
      `UPDATE documentos_requeridos
          SET nombre = $2, descripcion = $3, aplica_a = $4, obligatorio = $5 WHERE id = $1`,
      [id, d.nombre, d.descripcion, d.aplicaA, d.obligatorio],
    );
    if (d.orden !== undefined) {
      await renumerar(db, 'documentos_requeridos', 'TRUE', [], { id, posicion: d.orden });
    }
  },

  async fijarActivo(db: Queryable, id: number, activo: boolean): Promise<void> {
    await db.query(`UPDATE documentos_requeridos SET activo = $2 WHERE id = $1`, [id, activo]);
  },
};
