import type { EstadoSolicitud } from '../../domain/estados.js';
import type { Queryable } from '../db/pool.js';
import { ORDEN_OPCIONES } from './catalogos.js';

export interface VigenciaAbierta {
  id: number;
  anio: number;
  /** La fecha de hoy (America/Bogota) está dentro del rango de la vigencia. */
  abierta: boolean;
}

export interface SolicitudFila {
  id: number;
  vigenciaId: number;
  pcdId: number;
  cuidadorId: number | null;
  correo: string;
  estado: EstadoSolicitud;
  correoVerificadoAt: Date | null;
  createdAt: Date;
  pcdNombre: string;
}

interface Fila {
  id: number;
  vigencia_id: number;
  pcd_id: number;
  cuidador_id: number | null;
  correo: string;
  estado: EstadoSolicitud;
  correo_verificado_at: Date | null;
  created_at: Date;
  pcd_nombre: string;
}

const mapear = (f: Fila): SolicitudFila => ({
  id: f.id,
  vigenciaId: f.vigencia_id,
  pcdId: f.pcd_id,
  cuidadorId: f.cuidador_id,
  correo: f.correo,
  estado: f.estado,
  correoVerificadoAt: f.correo_verificado_at,
  createdAt: f.created_at,
  pcdNombre: f.pcd_nombre,
});

const SELECT = `SELECT s.id, s.vigencia_id, s.pcd_id, s.cuidador_id, s.correo, s.estado, s.correo_verificado_at,
                       s.created_at, p.nombre_completo AS pcd_nombre
                  FROM solicitudes s JOIN personas p ON p.id = s.pcd_id`;

export interface ItemPublico {
  id: number;
  codigo: string;
  nombre: string;
  padreId: number | null;
}

export const solicitudesRepo = {
  /** Vigencia activa y si hoy está dentro de sus fechas (la preinscripción solo se recibe en ese rango). */
  async vigenciaActiva(db: Queryable): Promise<VigenciaAbierta | null> {
    const r = await db.query<{ id: number; anio: number; abierta: boolean }>(
      `SELECT id, anio, (hoy_bogota() BETWEEN fecha_inicio AND fecha_fin) AS abierta
         FROM vigencias WHERE activa`,
    );
    return r.rows[0] ?? null;
  },

  /** Elementos activos de un catálogo, para los desplegables del formulario público. */
  async catalogoActivo(db: Queryable, catalogo: string): Promise<ItemPublico[]> {
    const r = await db.query<{
      id: number;
      codigo: string;
      nombre: string;
      padre_id: number | null;
    }>(
      `SELECT id, codigo, nombre, padre_id FROM catalogo_items
        WHERE catalogo = $1 AND activo
         ORDER BY ${ORDEN_OPCIONES()}`,
      [catalogo],
    );
    return r.rows.map((x) => ({
      id: x.id,
      codigo: x.codigo,
      nombre: x.nombre,
      padreId: x.padre_id,
    }));
  },

  async itemActivo(db: Queryable, id: number, catalogo: string): Promise<ItemPublico | null> {
    const r = await db.query<{
      id: number;
      codigo: string;
      nombre: string;
      padre_id: number | null;
    }>(
      `SELECT id, codigo, nombre, padre_id FROM catalogo_items WHERE id = $1 AND catalogo = $2 AND activo`,
      [id, catalogo],
    );
    const x = r.rows[0];
    return x ? { id: x.id, codigo: x.codigo, nombre: x.nombre, padreId: x.padre_id } : null;
  },

  /** Crea la persona o devuelve la existente: el tipo y número de identificación son llave única (RNF-10). */
  async personaParaIdentificacion(
    db: Queryable,
    tipoId: number,
    numero: string,
    nombre: string,
  ): Promise<number> {
    await db.query(
      `INSERT INTO personas (tipo_identificacion_id, numero_identificacion, nombre_completo)
       VALUES ($1, $2, $3) ON CONFLICT (tipo_identificacion_id, numero_identificacion) DO NOTHING`,
      [tipoId, numero, nombre],
    );
    const r = await db.query<{ id: number }>(
      `SELECT id FROM personas WHERE tipo_identificacion_id = $1 AND numero_identificacion = $2`,
      [tipoId, numero],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async idPersona(db: Queryable, tipoId: number, numero: string): Promise<number | null> {
    const r = await db.query<{ id: number }>(
      `SELECT id FROM personas WHERE tipo_identificacion_id = $1 AND numero_identificacion = $2`,
      [tipoId, numero],
    );
    return r.rows[0]?.id ?? null;
  },

  async crear(
    db: Queryable,
    d: {
      vigenciaId: number;
      pcdId: number;
      cuidadorId: number | null;
      cuidadorEsPcd?: boolean | null;
      diligenciadaPor?: 'PCD' | 'CUIDADOR' | null;
      direccion: string | null;
      localidadId: number | null;
      barrioId: number | null;
      correo: string;
    },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO solicitudes (vigencia_id, pcd_id, cuidador_id, direccion, localidad_id, barrio_id, correo, diligenciada_por, cuidador_es_pcd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        d.vigenciaId,
        d.pcdId,
        d.cuidadorId,
        d.direccion,
        d.localidadId,
        d.barrioId,
        d.correo,
        d.diligenciadaPor ?? null,
        d.cuidadorEsPcd ?? null,
      ],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async porId(db: Queryable, id: number): Promise<SolicitudFila | null> {
    const r = await db.query<Fila>(`${SELECT} WHERE s.id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async porPcd(db: Queryable, vigenciaId: number, pcdId: number): Promise<SolicitudFila | null> {
    const r = await db.query<Fila>(`${SELECT} WHERE s.vigencia_id = $1 AND s.pcd_id = $2`, [
      vigenciaId,
      pcdId,
    ]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async radicadoDe(db: Queryable, id: number): Promise<string | null> {
    const r = await db.query<{ radicado: string | null }>(
      `SELECT radicado FROM solicitudes WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.radicado ?? null;
  },

  /** Asigna el siguiente número de radicado del año y pasa la solicitud a «Radicada». */
  async radicar(
    db: Queryable,
    id: number,
    anio: number,
    ahora: Date,
  ): Promise<{ radicado: string; radicadaAt: Date }> {
    const r = await db.query<{ radicado: string; radicada_at: Date }>(
      `UPDATE solicitudes
          SET estado = 'RADICADA', radicado = siguiente_radicado($2), radicada_at = $3, updated_at = now()
        WHERE id = $1 AND estado = 'CORREO_VERIFICADO'
        RETURNING radicado, radicada_at`,
      [id, anio, ahora],
    );
    const f = r.rows[0] as { radicado: string; radicada_at: Date };
    return { radicado: f.radicado, radicadaAt: f.radicada_at };
  },

  async marcarCorreoVerificado(db: Queryable, id: number): Promise<void> {
    await db.query(
      `UPDATE solicitudes SET estado = 'CORREO_VERIFICADO', correo_verificado_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
  },

  async registrarAceptacion(
    db: Queryable,
    d: { solicitudId: number; version: number; ip: string | null; userAgent: string | null },
  ): Promise<void> {
    await db.query(
      `INSERT INTO aceptaciones_autorizacion (solicitud_id, version, ip, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [d.solicitudId, d.version, d.ip, d.userAgent],
    );
  },
};

export interface TokenFila {
  id: number;
  solicitudId: number;
  proposito: 'VERIFICACION_CORREO' | 'ENLACE_SEGURO';
  expiraAt: Date;
  usadoAt: Date | null;
}

export const tokensRepo = {
  async crear(
    db: Queryable,
    d: {
      solicitudId: number;
      proposito: TokenFila['proposito'];
      tokenHash: string;
      creadoAt: Date;
      expiraAt: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO solicitud_tokens (solicitud_id, proposito, token_hash, created_at, expira_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [d.solicitudId, d.proposito, d.tokenHash, d.creadoAt, d.expiraAt],
    );
  },

  async porHash(
    db: Queryable,
    tokenHash: string,
    proposito: TokenFila['proposito'],
  ): Promise<TokenFila | null> {
    const r = await db.query<{
      id: number;
      solicitud_id: number;
      proposito: TokenFila['proposito'];
      expira_at: Date;
      usado_at: Date | null;
    }>(
      `SELECT id, solicitud_id, proposito, expira_at, usado_at FROM solicitud_tokens
        WHERE token_hash = $1 AND proposito = $2`,
      [tokenHash, proposito],
    );
    const x = r.rows[0];
    return x
      ? {
          id: x.id,
          solicitudId: x.solicitud_id,
          proposito: x.proposito,
          expiraAt: x.expira_at,
          usadoAt: x.usado_at,
        }
      : null;
  },

  async marcarUsado(db: Queryable, id: number): Promise<void> {
    await db.query(`UPDATE solicitud_tokens SET usado_at = now() WHERE id = $1`, [id]);
  },

  /** Invalida los enlaces de verificación anteriores: solo sirve el último enviado. */
  async invalidarVerificaciones(db: Queryable, solicitudId: number): Promise<void> {
    await db.query(
      `UPDATE solicitud_tokens SET expira_at = LEAST(expira_at, now())
        WHERE solicitud_id = $1 AND proposito = 'VERIFICACION_CORREO' AND usado_at IS NULL`,
      [solicitudId],
    );
  },

  /** Instante del último envío y cuántos se enviaron en las últimas 24 horas (control de reenvíos). */
  async resumenVerificaciones(
    db: Queryable,
    solicitudId: number,
  ): Promise<{ ultimoAt: Date | null; ultimas24h: number }> {
    const r = await db.query<{ ultimo: Date | null; n: number }>(
      `SELECT MAX(created_at) AS ultimo,
              COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS n
         FROM solicitud_tokens WHERE solicitud_id = $1 AND proposito = 'VERIFICACION_CORREO'`,
      [solicitudId],
    );
    return { ultimoAt: r.rows[0]?.ultimo ?? null, ultimas24h: r.rows[0]?.n ?? 0 };
  },
};
