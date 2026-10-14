import { PERMISOS_SOLO_ADMINISTRADOR } from '../../domain/limites.js';
import type { Queryable } from '../db/pool.js';

export interface RolFila {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  /** Roles del documento (numeral 3.2): no se eliminan ni se renombran. */
  sistema: boolean;
  permisos: string[];
  /** Usuarios que tienen este rol. */
  usuarios: number;
}

export interface PermisoFila {
  codigo: string;
  modulo: string;
  descripcion: string;
  /** Solo lo tiene el administrador: no se puede asignar a otros roles. */
  soloAdministrador: boolean;
}

export interface DatosRol {
  nombre: string;
  descripcion: string;
  permisos: string[];
}

const SELECT = `SELECT r.id, r.codigo, r.nombre, r.descripcion, r.sistema,
       COALESCE(array_agg(DISTINCT rp.permiso_codigo) FILTER (WHERE rp.permiso_codigo IS NOT NULL), '{}') AS permisos,
       (SELECT count(*)::int FROM usuario_rol ur WHERE ur.rol_id = r.id) AS usuarios
  FROM roles r LEFT JOIN rol_permiso rp ON rp.rol_id = r.id`;

export const rolesRepo = {
  async listar(db: Queryable): Promise<RolFila[]> {
    const r = await db.query<RolFila>(`${SELECT} GROUP BY r.id ORDER BY r.sistema DESC, r.nombre`);
    return r.rows.map((f) => ({ ...f, permisos: [...f.permisos].sort() }));
  },

  async porId(db: Queryable, id: number): Promise<RolFila | null> {
    const r = await db.query<RolFila>(`${SELECT} WHERE r.id = $1 GROUP BY r.id`, [id]);
    const f = r.rows[0];
    return f ? { ...f, permisos: [...f.permisos].sort() } : null;
  },

  async idsExistentes(db: Queryable, ids: number[]): Promise<Set<number>> {
    const r = await db.query<{ id: number }>(`SELECT id FROM roles WHERE id = ANY($1::int[])`, [
      ids,
    ]);
    return new Set(r.rows.map((x) => x.id));
  },

  async permisos(db: Queryable): Promise<PermisoFila[]> {
    const r = await db.query<Omit<PermisoFila, 'soloAdministrador'>>(
      `SELECT codigo, modulo, descripcion FROM permisos ORDER BY modulo, codigo`,
    );
    return r.rows.map((f) => ({
      ...f,
      soloAdministrador: PERMISOS_SOLO_ADMINISTRADOR.includes(f.codigo),
    }));
  },

  async crear(db: Queryable, codigo: string, d: DatosRol): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO roles (codigo, nombre, descripcion, sistema) VALUES ($1, $2, $3, false) RETURNING id`,
      [codigo, d.nombre, d.descripcion],
    );
    const id = (r.rows[0] as { id: number }).id;
    await this.fijarPermisos(db, id, d.permisos);
    return id;
  },

  async actualizar(db: Queryable, id: number, d: DatosRol, conNombre: boolean): Promise<void> {
    await db.query(
      `UPDATE roles SET ${conNombre ? 'nombre = $3, ' : ''}descripcion = $2, updated_at = now() WHERE id = $1`,
      conNombre ? [id, d.descripcion, d.nombre] : [id, d.descripcion],
    );
    await this.fijarPermisos(db, id, d.permisos);
  },

  async fijarPermisos(db: Queryable, id: number, permisos: string[]): Promise<void> {
    await db.query(`DELETE FROM rol_permiso WHERE rol_id = $1`, [id]);
    if (permisos.length > 0) {
      await db.query(
        `INSERT INTO rol_permiso (rol_id, permiso_codigo) SELECT $1, unnest($2::text[])`,
        [id, permisos],
      );
    }
  },

  async eliminar(db: Queryable, id: number): Promise<void> {
    await db.query(`DELETE FROM roles WHERE id = $1`, [id]);
  },
};
