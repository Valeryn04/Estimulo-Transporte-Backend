import type { Queryable } from '../db/pool.js';

export type TipoParametro = 'ENTERO' | 'TEXTO' | 'BOOLEANO';

export interface VersionParametro {
  id: number;
  valor: string;
  vigenteDesde: Date;
  aprobadoPor: string | null;
  justificacion: string | null;
  creadoAt: Date;
}

export interface Parametro {
  clave: string;
  grupo: string;
  descripcion: string;
  tipo: TipoParametro;
  minimo: number | null;
  maximo: number | null;
  patron: string | null;
  pendienteDefinicion: boolean;
  /** Versión que rige hoy. */
  vigente: VersionParametro;
  /** Versión programada para una fecha futura, si existe. */
  programada: VersionParametro | null;
}

interface FilaParametro {
  clave: string;
  grupo: string;
  descripcion: string;
  tipo: TipoParametro;
  minimo: number | null;
  maximo: number | null;
  patron: string | null;
  pendiente_definicion: boolean;
}

interface FilaVersion {
  id: number;
  clave: string;
  valor: string;
  vigente_desde: Date;
  aprobado_por: string | null;
  justificacion: string | null;
  creado_at: Date;
}

const mapearVersion = (f: FilaVersion): VersionParametro => ({
  id: f.id,
  valor: f.valor,
  vigenteDesde: f.vigente_desde,
  aprobadoPor: f.aprobado_por,
  justificacion: f.justificacion,
  creadoAt: f.creado_at,
});

const SELECT_VERSION = `SELECT v.id, v.clave, v.valor, v.vigente_desde, u.usuario AS aprobado_por,
                               v.justificacion, v.creado_at
                          FROM parametro_versiones v LEFT JOIN usuarios u ON u.id = v.aprobado_por`;

export const parametrosAdminRepo = {
  async listar(db: Queryable): Promise<Parametro[]> {
    const params = await db.query<FilaParametro>(
      `SELECT clave, grupo, descripcion, tipo, minimo, maximo, patron, pendiente_definicion
         FROM parametros ORDER BY grupo, clave`,
    );
    // «Rige» se calcula con el reloj de la base de datos, el mismo que fija `vigente_desde` al crear la versión.
    const versiones = await db.query<FilaVersion & { rige: boolean }>(
      `SELECT v.id, v.clave, v.valor, v.vigente_desde, u.usuario AS aprobado_por, v.justificacion, v.creado_at,
              (v.vigente_desde <= now()) AS rige
         FROM parametro_versiones v LEFT JOIN usuarios u ON u.id = v.aprobado_por
        ORDER BY v.vigente_desde DESC, v.id DESC`,
    );
    const porClave = new Map<string, (FilaVersion & { rige: boolean })[]>();
    for (const v of versiones.rows) porClave.set(v.clave, [...(porClave.get(v.clave) ?? []), v]);
    return params.rows.map((p) => {
      const lista = porClave.get(p.clave) ?? [];
      const vigente = lista.find((v) => v.rige) as FilaVersion;
      const programada = [...lista].reverse().find((v) => !v.rige);
      return {
        clave: p.clave,
        grupo: p.grupo,
        descripcion: p.descripcion,
        tipo: p.tipo,
        minimo: p.minimo,
        maximo: p.maximo,
        patron: p.patron,
        pendienteDefinicion: p.pendiente_definicion,
        vigente: mapearVersion(vigente),
        programada: programada ? mapearVersion(programada) : null,
      };
    });
  },

  async definicion(
    db: Queryable,
    clave: string,
  ): Promise<Pick<
    Parametro,
    'clave' | 'tipo' | 'minimo' | 'maximo' | 'patron' | 'descripcion'
  > | null> {
    const r = await db.query<FilaParametro>(
      `SELECT clave, grupo, descripcion, tipo, minimo, maximo, patron, pendiente_definicion
         FROM parametros WHERE clave = $1`,
      [clave],
    );
    const f = r.rows[0];
    return f
      ? {
          clave: f.clave,
          tipo: f.tipo,
          minimo: f.minimo,
          maximo: f.maximo,
          patron: f.patron,
          descripcion: f.descripcion,
        }
      : null;
  },

  async historial(db: Queryable, clave: string): Promise<VersionParametro[]> {
    const r = await db.query<FilaVersion>(
      `${SELECT_VERSION} WHERE v.clave = $1 ORDER BY v.vigente_desde DESC, v.id DESC`,
      [clave],
    );
    return r.rows.map(mapearVersion);
  },

  async crearVersion(
    db: Queryable,
    d: {
      clave: string;
      valor: string;
      vigenteDesde: Date | null;
      aprobadoPor: number;
      justificacion: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO parametro_versiones (clave, valor, vigente_desde, aprobado_por, justificacion)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5)`,
      [d.clave, d.valor, d.vigenteDesde, d.aprobadoPor, d.justificacion],
    );
    // Al definir un valor, deja de estar «pendiente de definición».
    await db.query(`UPDATE parametros SET pendiente_definicion = false WHERE clave = $1`, [
      d.clave,
    ]);
  },
};

export interface Vigencia {
  id: number;
  anio: number;
  fechaInicio: string;
  fechaFin: string;
  cuposTotales: number;
  activa: boolean;
  version: number;
}

interface FilaVigencia {
  id: number;
  anio: number;
  fecha_inicio: string;
  fecha_fin: string;
  cupos_totales: number;
  activa: boolean;
  version: number;
}

const mapearVigencia = (f: FilaVigencia): Vigencia => ({
  id: f.id,
  anio: f.anio,
  fechaInicio: f.fecha_inicio,
  fechaFin: f.fecha_fin,
  cuposTotales: f.cupos_totales,
  activa: f.activa,
  version: f.version,
});

const COLS_VIGENCIA = 'id, anio, fecha_inicio, fecha_fin, cupos_totales, activa, version';

export const vigenciasRepo = {
  async listar(db: Queryable): Promise<Vigencia[]> {
    const r = await db.query<FilaVigencia>(
      `SELECT ${COLS_VIGENCIA} FROM vigencias ORDER BY anio DESC`,
    );
    return r.rows.map(mapearVigencia);
  },

  async porId(db: Queryable, id: number): Promise<Vigencia | null> {
    const r = await db.query<FilaVigencia>(`SELECT ${COLS_VIGENCIA} FROM vigencias WHERE id = $1`, [
      id,
    ]);
    return r.rows[0] ? mapearVigencia(r.rows[0]) : null;
  },

  async crear(
    db: Queryable,
    d: { anio: number; fechaInicio: string; fechaFin: string; cuposTotales: number },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO vigencias (anio, fecha_inicio, fecha_fin, cupos_totales)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [d.anio, d.fechaInicio, d.fechaFin, d.cuposTotales],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(
    db: Queryable,
    id: number,
    d: { fechaInicio: string; fechaFin: string; cuposTotales: number },
  ): Promise<void> {
    await db.query(
      `UPDATE vigencias SET fecha_inicio = $2, fecha_fin = $3, cupos_totales = $4 WHERE id = $1`,
      [id, d.fechaInicio, d.fechaFin, d.cuposTotales],
    );
  },

  /** Deja activa solo la vigencia indicada. */
  async activar(db: Queryable, id: number): Promise<void> {
    await db.query(`UPDATE vigencias SET activa = false WHERE activa AND id <> $1`, [id]);
    await db.query(`UPDATE vigencias SET activa = true WHERE id = $1 AND NOT activa`, [id]);
  },
};

export interface TextoAutorizacion {
  version: number;
  contenido: string;
  vigenteDesde: Date;
  creadoPor: string | null;
}

export const autorizacionRepo = {
  async listar(db: Queryable): Promise<TextoAutorizacion[]> {
    const r = await db.query<{
      version: number;
      contenido: string;
      vigente_desde: Date;
      creado_por: string | null;
    }>(
      `SELECT t.version, t.contenido, t.vigente_desde, u.usuario AS creado_por
         FROM textos_autorizacion t LEFT JOIN usuarios u ON u.id = t.creado_por
        ORDER BY t.version DESC`,
    );
    return r.rows.map((x) => ({
      version: x.version,
      contenido: x.contenido,
      vigenteDesde: x.vigente_desde,
      creadoPor: x.creado_por,
    }));
  },

  async crear(db: Queryable, contenido: string, usuarioId: number): Promise<number> {
    await db.query(`SELECT pg_advisory_xact_lock(7340003)`);
    const r = await db.query<{ version: number }>(
      `INSERT INTO textos_autorizacion (version, contenido, creado_por)
       VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM textos_autorizacion), $1, $2)
       RETURNING version`,
      [contenido, usuarioId],
    );
    return (r.rows[0] as { version: number }).version;
  },
};
