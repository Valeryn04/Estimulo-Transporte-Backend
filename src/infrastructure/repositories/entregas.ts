import type { RolBeneficiario, TipoReceptor } from '../../domain/entrega.js';
import type { Queryable } from '../db/pool.js';
import type { EstadoBeneficio } from './asignacion.js';
import type { EvidenciaGuardada } from './priorizacion.js';

export interface PersonaBeneficio {
  rol: RolBeneficiario;
  personaId: number;
  nombre: string;
  tipoIdentificacionId: number;
  tipoIdentificacion: string;
  numero: string;
}

export interface Entrega {
  id: number;
  rol: RolBeneficiario;
  tarjetaId: string;
  tipoTransporteId: number;
  tipoTransporte: string;
  fechaEntrega: string;
  receptorTipo: TipoReceptor;
  receptorNombre: string;
  receptorTipoIdentificacion: string | null;
  receptorNumero: string | null;
  funcionarioEntrega: string;
  terceroConAutorizacion: boolean | null;
  soporte: { nombre: string; tamanoBytes: number };
  vigente: boolean;
  registradoPor: string;
  registradoAt: Date;
}

export interface DetalleBeneficio {
  id: number;
  solicitudId: number;
  vigenciaId: number;
  radicado: string;
  correo: string;
  estado: EstadoBeneficio;
  personas: 1 | 2;
  asignadoAt: Date;
  /** Fecha de asignación en el calendario de Bogotá (AAAA-MM-DD). */
  asignadoDia: string;
  hoy: string;
  activadoAt: Date | null;
  pcdNombre: string;
}

export const entregasRepo = {
  async beneficio(db: Queryable, id: number, bloquear = false): Promise<DetalleBeneficio | null> {
    const r = await db.query<{
      id: string;
      solicitud_id: number;
      vigencia_id: number;
      radicado: string;
      correo: string;
      estado: EstadoBeneficio;
      personas: number;
      asignado_at: Date;
      asignado_dia: string;
      hoy: string;
      activado_at: Date | null;
      pcd_nombre: string;
    }>(
      `SELECT b.id, b.solicitud_id, b.vigencia_id, s.radicado, s.correo, b.estado, b.personas, b.asignado_at,
              to_char(b.asignado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS asignado_dia,
              to_char(hoy_bogota(), 'YYYY-MM-DD') AS hoy, b.activado_at, p.nombre_completo AS pcd_nombre
         FROM beneficios b
         JOIN solicitudes s ON s.id = b.solicitud_id
         JOIN personas p ON p.id = s.pcd_id
        WHERE b.id = $1 ${bloquear ? 'FOR UPDATE OF b' : ''}`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          id: Number(f.id),
          solicitudId: f.solicitud_id,
          vigenciaId: f.vigencia_id,
          radicado: f.radicado,
          correo: f.correo,
          estado: f.estado,
          personas: f.personas as 1 | 2,
          asignadoAt: f.asignado_at,
          asignadoDia: f.asignado_dia,
          hoy: f.hoy,
          activadoAt: f.activado_at,
          pcdNombre: f.pcd_nombre,
        }
      : null;
  },

  async personas(db: Queryable, beneficioId: number): Promise<PersonaBeneficio[]> {
    const r = await db.query<{
      rol: RolBeneficiario;
      persona_id: number;
      nombre: string;
      tipo_id: number;
      tipo: string;
      numero: string;
    }>(
      `SELECT bp.rol, bp.persona_id, p.nombre_completo AS nombre, p.tipo_identificacion_id AS tipo_id,
              t.nombre AS tipo, p.numero_identificacion AS numero
         FROM beneficio_personas bp
         JOIN personas p ON p.id = bp.persona_id
         JOIN catalogo_items t ON t.id = p.tipo_identificacion_id
        WHERE bp.beneficio_id = $1 ORDER BY bp.rol DESC`,
      [beneficioId],
    );
    return r.rows.map((x) => ({
      rol: x.rol,
      personaId: x.persona_id,
      nombre: x.nombre,
      tipoIdentificacionId: x.tipo_id,
      tipoIdentificacion: x.tipo,
      numero: x.numero,
    }));
  },

  async entregas(db: Queryable, beneficioId: number): Promise<Entrega[]> {
    const r = await db.query<{
      id: string;
      rol: RolBeneficiario;
      tarjeta_id: string;
      tipo_transporte_id: number;
      tipo_transporte: string;
      fecha_entrega: string;
      receptor_tipo: TipoReceptor;
      receptor_nombre: string;
      receptor_tipo_identificacion: string | null;
      receptor_numero: string | null;
      funcionario_entrega: string;
      tercero_con_autorizacion: boolean | null;
      soporte_nombre: string;
      soporte_tamano: number;
      vigente: boolean;
      usuario: string;
      registrado_at: Date;
    }>(
      `SELECT e.id, e.rol, e.tarjeta_id, e.tipo_transporte_id, tt.nombre AS tipo_transporte,
              to_char(e.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega, e.receptor_tipo, e.receptor_nombre,
              ti.nombre AS receptor_tipo_identificacion, e.receptor_numero, e.funcionario_entrega,
              e.tercero_con_autorizacion, e.soporte_nombre, e.soporte_tamano, e.vigente, u.usuario, e.registrado_at
         FROM entregas e
         JOIN catalogo_items tt ON tt.id = e.tipo_transporte_id
         LEFT JOIN catalogo_items ti ON ti.id = e.receptor_tipo_identificacion_id
         JOIN usuarios u ON u.id = e.registrado_por
        WHERE e.beneficio_id = $1 ORDER BY e.registrado_at, e.id`,
      [beneficioId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      rol: x.rol,
      tarjetaId: x.tarjeta_id,
      tipoTransporteId: x.tipo_transporte_id,
      tipoTransporte: x.tipo_transporte,
      fechaEntrega: x.fecha_entrega,
      receptorTipo: x.receptor_tipo,
      receptorNombre: x.receptor_nombre,
      receptorTipoIdentificacion: x.receptor_tipo_identificacion,
      receptorNumero: x.receptor_numero,
      funcionarioEntrega: x.funcionario_entrega,
      terceroConAutorizacion: x.tercero_con_autorizacion,
      soporte: { nombre: x.soporte_nombre, tamanoBytes: x.soporte_tamano },
      vigente: x.vigente,
      registradoPor: x.usuario,
      registradoAt: x.registrado_at,
    }));
  },

  async crear(
    db: Queryable,
    d: {
      beneficioId: number;
      rol: RolBeneficiario;
      tarjetaId: string;
      tipoTransporteId: number;
      fechaEntrega: string;
      receptorTipo: TipoReceptor;
      receptorNombre: string;
      receptorTipoIdentificacionId: number | null;
      receptorNumero: string | null;
      funcionarioEntrega: string;
      terceroConAutorizacion: boolean | null;
      soporte: EvidenciaGuardada;
      usuarioId: number;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO entregas (beneficio_id, rol, tarjeta_id, tipo_transporte_id, fecha_entrega, receptor_tipo,
                             receptor_nombre, receptor_tipo_identificacion_id, receptor_numero, funcionario_entrega,
                             soporte_ruta, soporte_nombre, soporte_mime, soporte_tamano, soporte_sha256, registrado_por,
                             tercero_con_autorizacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        d.beneficioId,
        d.rol,
        d.tarjetaId,
        d.tipoTransporteId,
        d.fechaEntrega,
        d.receptorTipo,
        d.receptorNombre,
        d.receptorTipoIdentificacionId,
        d.receptorNumero,
        d.funcionarioEntrega,
        d.soporte.ruta,
        d.soporte.nombre,
        d.soporte.mime,
        d.soporte.tamanoBytes,
        d.soporte.sha256,
        d.usuarioId,
        d.terceroConAutorizacion,
      ],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async soporte(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      soporte_ruta: string;
      soporte_nombre: string;
      soporte_mime: string;
      soporte_tamano: number;
      soporte_sha256: string;
    }>(
      `SELECT soporte_ruta, soporte_nombre, soporte_mime, soporte_tamano, soporte_sha256 FROM entregas WHERE id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          ruta: f.soporte_ruta,
          nombre: f.soporte_nombre,
          mime: f.soporte_mime,
          tamanoBytes: f.soporte_tamano,
          sha256: f.soporte_sha256,
        }
      : null;
  },

  async fijarEstado(
    db: Queryable,
    beneficioId: number,
    estado: EstadoBeneficio,
    activar: boolean,
  ): Promise<void> {
    await db.query(
      `UPDATE beneficios SET estado = $2, activado_at = CASE WHEN $3 THEN now() ELSE activado_at END WHERE id = $1`,
      [beneficioId, estado, activar],
    );
  },

  /** Tipos de transporte e identificación que se pueden elegir al registrar una entrega. */
  /** El tipo de transporte que la persona dijo usar al llenar la caracterización. */
  async transporteDeLaSolicitud(db: Queryable, solicitudId: number): Promise<number | null> {
    const r = await db.query<{ t: number | null }>(
      `SELECT tipo_transporte_id AS t FROM caracterizaciones WHERE solicitud_id = $1`,
      [solicitudId],
    );
    return r.rows[0]?.t ?? null;
  },

  async opciones(db: Queryable) {
    const r = await db.query<{ id: number; catalogo: string; nombre: string }>(
      `SELECT id, catalogo, nombre FROM catalogo_items
        WHERE catalogo IN ('TIPO_TRANSPORTE', 'TIPO_IDENTIFICACION') AND activo ORDER BY catalogo, nombre`,
    );
    const de = (c: string) =>
      r.rows.filter((x) => x.catalogo === c).map((x) => ({ id: x.id, nombre: x.nombre }));
    return {
      tiposTransporte: de('TIPO_TRANSPORTE'),
      tiposIdentificacion: de('TIPO_IDENTIFICACION'),
    };
  },

  async transporteExiste(db: Queryable, id: number): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM catalogo_items WHERE id = $1 AND catalogo = 'TIPO_TRANSPORTE' AND activo`,
      [id],
    );
    return r.rowCount === 1;
  },

  async identificacionExiste(db: Queryable, id: number): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM catalogo_items WHERE id = $1 AND catalogo = 'TIPO_IDENTIFICACION' AND activo`,
      [id],
    );
    return r.rowCount === 1;
  },

  async causalesRevocatoria(db: Queryable): Promise<string[]> {
    const r = await db.query<{ nombre: string }>(
      `SELECT nombre FROM catalogo_items WHERE catalogo = 'CAUSAL_REVOCATORIA' AND activo ORDER BY nombre`,
    );
    return r.rows.map((x) => x.nombre);
  },
};
