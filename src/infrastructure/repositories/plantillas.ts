import type { Queryable } from '../db/pool.js';

export interface VersionPlantilla {
  version: number;
  asunto: string;
  cuerpo: string;
  justificacion: string | null;
  creadoPor: string | null;
  creadoAt: Date;
}

export interface Plantilla {
  codigo: string;
  nombre: string;
  descripcion: string;
  variablesPermitidas: string[];
  variablesObligatorias: string[];
}

interface FilaVersion {
  version: number;
  asunto: string;
  cuerpo: string;
  justificacion: string | null;
  creado_por: string | null;
  creado_at: Date;
}

const mapear = (f: FilaVersion): VersionPlantilla => ({
  version: f.version,
  asunto: f.asunto,
  cuerpo: f.cuerpo,
  justificacion: f.justificacion,
  creadoPor: f.creado_por,
  creadoAt: f.creado_at,
});

export const plantillasRepo = {
  async listar(db: Queryable): Promise<(Plantilla & { version: number; actualizadaAt: Date })[]> {
    const r = await db.query<{
      codigo: string;
      nombre: string;
      descripcion: string;
      variables_permitidas: string[];
      variables_obligatorias: string[];
      version: number;
      creado_at: Date;
    }>(
      `SELECT p.codigo, p.nombre, p.descripcion, p.variables_permitidas, p.variables_obligatorias,
              v.version, v.creado_at
         FROM plantillas_correo p
         JOIN LATERAL (SELECT version, creado_at FROM plantilla_versiones
                        WHERE plantilla_codigo = p.codigo ORDER BY version DESC LIMIT 1) v ON true
        ORDER BY p.nombre`,
    );
    return r.rows.map((x) => ({
      codigo: x.codigo,
      nombre: x.nombre,
      descripcion: x.descripcion,
      variablesPermitidas: x.variables_permitidas,
      variablesObligatorias: x.variables_obligatorias,
      version: x.version,
      actualizadaAt: x.creado_at,
    }));
  },

  async porCodigo(db: Queryable, codigo: string): Promise<Plantilla | null> {
    const r = await db.query<{
      codigo: string;
      nombre: string;
      descripcion: string;
      variables_permitidas: string[];
      variables_obligatorias: string[];
    }>(
      `SELECT codigo, nombre, descripcion, variables_permitidas, variables_obligatorias
         FROM plantillas_correo WHERE codigo = $1`,
      [codigo],
    );
    const f = r.rows[0];
    return f
      ? {
          codigo: f.codigo,
          nombre: f.nombre,
          descripcion: f.descripcion,
          variablesPermitidas: f.variables_permitidas,
          variablesObligatorias: f.variables_obligatorias,
        }
      : null;
  },

  async versiones(db: Queryable, codigo: string): Promise<VersionPlantilla[]> {
    const r = await db.query<FilaVersion>(
      `SELECT v.version, v.asunto, v.cuerpo, v.justificacion, u.usuario AS creado_por, v.creado_at
         FROM plantilla_versiones v LEFT JOIN usuarios u ON u.id = v.creado_por
        WHERE v.plantilla_codigo = $1 ORDER BY v.version DESC`,
      [codigo],
    );
    return r.rows.map(mapear);
  },

  /** Versión vigente (la más reciente) de una plantilla. */
  async vigente(
    db: Queryable,
    codigo: string,
  ): Promise<(VersionPlantilla & { version: number }) | null> {
    const r = await db.query<FilaVersion>(
      `SELECT v.version, v.asunto, v.cuerpo, v.justificacion, u.usuario AS creado_por, v.creado_at
         FROM plantilla_versiones v LEFT JOIN usuarios u ON u.id = v.creado_por
        WHERE v.plantilla_codigo = $1 ORDER BY v.version DESC LIMIT 1`,
      [codigo],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async crearVersion(
    db: Queryable,
    d: {
      codigo: string;
      asunto: string;
      cuerpo: string;
      justificacion: string | null;
      usuarioId: number;
    },
  ): Promise<number> {
    await db.query(`SELECT pg_advisory_xact_lock(7340004)`);
    const r = await db.query<{ version: number }>(
      `INSERT INTO plantilla_versiones (plantilla_codigo, version, asunto, cuerpo, justificacion, creado_por)
       VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM plantilla_versiones WHERE plantilla_codigo = $1),
               $2, $3, $4, $5)
       RETURNING version`,
      [d.codigo, d.asunto, d.cuerpo, d.justificacion, d.usuarioId],
    );
    return (r.rows[0] as { version: number }).version;
  },
};
