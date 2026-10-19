import type { Queryable } from '../db/pool.js';

export type AplicaARequisito = 'PCD' | 'CUIDADOR' | 'COMUN';

export interface Requisito {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplicaA: AplicaARequisito;
  fuenteSugerida: string;
  documentoId: number | null;
  documentoNombre: string | null;
  campos: string[];
  cruceCodigo: string | null;
  activo: boolean;
  version: number;
}

interface Fila {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplica_a: AplicaARequisito;
  fuente_sugerida: string;
  documento_id: number | null;
  documento_nombre: string | null;
  campos: string[];
  cruce_codigo: string | null;
  activo: boolean;
  version: number;
}

const mapear = (f: Fila): Requisito => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  descripcion: f.descripcion,
  aplicaA: f.aplica_a,
  fuenteSugerida: f.fuente_sugerida,
  documentoId: f.documento_id,
  documentoNombre: f.documento_nombre,
  campos: f.campos,
  cruceCodigo: f.cruce_codigo,
  activo: f.activo,
  version: f.version,
});

const SELECT = `SELECT r.id, r.codigo, r.nombre, r.descripcion, r.aplica_a, r.fuente_sugerida, r.documento_id,
                       d.nombre AS documento_nombre, r.campos, r.cruce_codigo, r.activo, r.version
                  FROM requisitos_validacion r LEFT JOIN documentos_requeridos d ON d.id = r.documento_id`;

export interface DatosRequisito {
  nombre: string;
  descripcion: string;
  aplicaA: AplicaARequisito;
  fuenteSugerida: string;
  documentoId: number | null;
  campos: string[];
  cruceCodigo: string | null;
}

export const requisitosRepo = {
  async listar(db: Queryable): Promise<Requisito[]> {
    const r = await db.query<Fila>(`${SELECT} ORDER BY r.activo DESC, r.id`);
    return r.rows.map(mapear);
  },

  async porId(db: Queryable, id: number): Promise<Requisito | null> {
    const r = await db.query<Fila>(`${SELECT} WHERE r.id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  /** Requisitos activos que se le piden al caso (los del cuidador solo si requiere el servicio para él). */
  async aplicables(db: Queryable, requiereCuidador: boolean): Promise<Requisito[]> {
    const r = await db.query<Fila>(
      `${SELECT} WHERE r.activo AND ($1 OR r.aplica_a <> 'CUIDADOR') ORDER BY r.id`,
      [requiereCuidador],
    );
    return r.rows.map(mapear);
  },

  async documentoExiste(db: Queryable, id: number): Promise<boolean> {
    const r = await db.query(`SELECT 1 FROM documentos_requeridos WHERE id = $1`, [id]);
    return r.rowCount === 1;
  },

  async crear(db: Queryable, codigo: string, d: DatosRequisito): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO requisitos_validacion
         (codigo, nombre, descripcion, aplica_a, fuente_sugerida, documento_id, campos, cruce_codigo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        codigo,
        d.nombre,
        d.descripcion,
        d.aplicaA,
        d.fuenteSugerida,
        d.documentoId,
        d.campos,
        d.cruceCodigo,
      ],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(db: Queryable, id: number, d: DatosRequisito): Promise<void> {
    await db.query(
      `UPDATE requisitos_validacion
          SET nombre = $2, descripcion = $3, aplica_a = $4, fuente_sugerida = $5, documento_id = $6,
              campos = $7, cruce_codigo = $8
        WHERE id = $1`,
      [
        id,
        d.nombre,
        d.descripcion,
        d.aplicaA,
        d.fuenteSugerida,
        d.documentoId,
        d.campos,
        d.cruceCodigo,
      ],
    );
  },

  async fijarActivo(db: Queryable, id: number, activo: boolean): Promise<void> {
    await db.query(`UPDATE requisitos_validacion SET activo = $2 WHERE id = $1`, [id, activo]);
  },
};
