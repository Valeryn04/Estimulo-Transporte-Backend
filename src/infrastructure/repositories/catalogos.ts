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
  activo: boolean;
  version: number;
  updated_at: Date;
}

const SELECT = `SELECT c.id, c.catalogo, c.codigo, c.nombre, c.padre_id, p.nombre AS padre_nombre,
                       c.activo, c.version, c.updated_at
                  FROM catalogo_items c LEFT JOIN catalogo_items p ON p.id = c.padre_id`;

const mapear = (f: Fila): ItemCatalogo => ({
  id: f.id,
  catalogo: f.catalogo,
  codigo: f.codigo,
  nombre: f.nombre,
  padreId: f.padre_id,
  padreNombre: f.padre_nombre,
  activo: f.activo,
  version: f.version,
  updatedAt: f.updated_at,
});

export interface FiltroItems {
  q?: string;
  activo?: boolean;
  padreId?: number;
  limit: number;
  offset: number;
}

export interface VersionRegistro {
  version: number;
  snapshot: Record<string, unknown>;
  usuario: string | null;
  creadoAt: Date;
}

/**
 * Orden en que se muestran las opciones de un desplegable: las propias de la lista en el orden en que se crearon
 * (los barrios, de la A a la Z) y, siempre al final, «Otro», «Ninguna/Ninguno» y «N/A». Así una opción nueva
 * nunca queda después de esas.
 */
export const ORDEN_OPCIONES = (alias = '') => {
  const c = alias ? `${alias}.` : '';
  return `CASE ${c}codigo WHEN 'OTRO' THEN 1 WHEN 'NINGUNA' THEN 2 WHEN 'NINGUNO' THEN 2 WHEN 'NA' THEN 3 ELSE 0 END,
        CASE WHEN ${c}catalogo = 'BARRIO' THEN ${c}nombre END, ${c}id`;
};

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

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
    params.push(f.limit, f.offset);
    const r = await db.query<Fila & { total: number }>(
      `SELECT c.id, c.catalogo, c.codigo, c.nombre, c.padre_id, p.nombre AS padre_nombre,
              c.activo, c.version, c.updated_at, COUNT(*) OVER() AS total
         FROM catalogo_items c LEFT JOIN catalogo_items p ON p.id = c.padre_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${ORDEN_OPCIONES('c')}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(mapear), total: r.rows[0]?.total ?? 0 };
  },

  async porId(db: Queryable, id: number): Promise<ItemCatalogo | null> {
    const r = await db.query<Fila>(`${SELECT} WHERE c.id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async crear(
    db: Queryable,
    d: { catalogo: Catalogo; codigo: string; nombre: string; padreId: number | null },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO catalogo_items (catalogo, codigo, nombre, padre_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [d.catalogo, d.codigo, d.nombre, d.padreId],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(
    db: Queryable,
    id: number,
    d: { nombre: string; padreId: number | null },
  ): Promise<void> {
    await db.query(`UPDATE catalogo_items SET nombre = $2, padre_id = $3 WHERE id = $1`, [
      id,
      d.nombre,
      d.padreId,
    ]);
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
  activo: f.activo,
  version: f.version,
});

const COLS_DOC = 'id, codigo, nombre, descripcion, aplica_a, obligatorio, activo, version';

export interface DatosDocumento {
  nombre: string;
  descripcion: string;
  aplicaA: AplicaA;
  obligatorio: boolean;
}

export const documentosRepo = {
  async listar(db: Queryable): Promise<DocumentoRequerido[]> {
    const r = await db.query<FilaDoc>(
      `SELECT ${COLS_DOC} FROM documentos_requeridos ORDER BY activo DESC, id`,
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

  async crear(db: Queryable, codigo: string, d: DatosDocumento): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO documentos_requeridos (codigo, nombre, descripcion, aplica_a, obligatorio)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [codigo, d.nombre, d.descripcion, d.aplicaA, d.obligatorio],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(db: Queryable, id: number, d: DatosDocumento): Promise<void> {
    await db.query(
      `UPDATE documentos_requeridos
          SET nombre = $2, descripcion = $3, aplica_a = $4, obligatorio = $5 WHERE id = $1`,
      [id, d.nombre, d.descripcion, d.aplicaA, d.obligatorio],
    );
  },

  async fijarActivo(db: Queryable, id: number, activo: boolean): Promise<void> {
    await db.query(`UPDATE documentos_requeridos SET activo = $2 WHERE id = $1`, [id, activo]);
  },
};
