import type { EstadoSolicitud } from '../../domain/estados.js';
import type {
  DecisionValidacion,
  ItemChequeo,
  ResultadoRequisito,
} from '../../domain/validacion.js';
import type { Queryable } from '../db/pool.js';
import type { Requisito } from './requisitos.js';

// ---------------------------------------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------------------------------------

export interface FilaBandeja {
  solicitudId: number;
  radicado: string;
  radicadaAt: Date;
  estado: EstadoSolicitud;
  pcdNombre: string;
  /** Días calendario desde la radicación. */
  dias: number;
  asignadoA: { id: number; nombre: string } | null;
  enRevisionPor: { id: number; nombre: string } | null;
  subsanado: boolean;
  ronda: number;
  /** Plazo de la subsanación abierta, si la hay. */
  subsanacionVenceAt: Date | null;
  subsanacionVencida: boolean;
}

export interface FiltroBandeja {
  estado?: EstadoSolicitud | 'TODOS';
  /** 'mios', 'sin' (sin asignar) o el id de un validador. */
  asignado?: 'mios' | 'sin' | number;
  q?: string;
  soloVencidas?: boolean;
  tiempoMaxDias: number;
  orden: 'radicado' | 'fecha' | 'nombre' | 'estado' | 'dias';
  direccion: 'asc' | 'desc';
  actorId: number;
  limit: number;
  offset: number;
}

const COLUMNA_ORDEN: Record<FiltroBandeja['orden'], string> = {
  radicado: 's.radicado',
  fecha: 's.radicada_at',
  nombre: 'lower(p.nombre_completo)',
  estado: 's.estado',
  dias: 's.radicada_at',
};

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------------------------------------------------------------------------------------------------------
// Caso
// ---------------------------------------------------------------------------------------------------------

export interface CasoBase {
  solicitudId: number;
  estado: EstadoSolicitud;
  radicado: string | null;
  radicadaAt: Date | null;
  anio: number;
  correo: string;
  direccion: string | null;
  localidad: string | null;
  barrio: string | null;
  pcd: { id: number; nombre: string; tipo: string; numero: string };
  cuidador: { id: number; nombre: string; tipo: string; numero: string } | null;
}

export interface ValidacionFila {
  solicitudId: number;
  asignadoA: number | null;
  asignadoNombre: string | null;
  tomadaPor: number | null;
  tomadaNombre: string | null;
  tomadaAt: Date | null;
  ronda: number;
  subsanado: boolean;
}

export interface ItemFila extends ItemChequeo {
  requisitoId: number;
  codigo: string;
  descripcion: string;
  aplicaA: string;
  fuenteSugerida: string;
  cruceCodigo: string | null;
  registradoPor: string | null;
  registradoAt: Date | null;
  version: number;
}

interface FilaItem {
  id: number;
  requisito_id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplica_a: string;
  fuente_sugerida: string;
  documento_id: number | null;
  campos: string[];
  cruce_codigo: string | null;
  resultado: ResultadoRequisito;
  fuente: string;
  observacion: string;
  evidencia: string;
  registrado_por: string | null;
  registrado_at: Date | null;
  version: number;
}

const mapearItem = (f: FilaItem): ItemFila => ({
  id: Number(f.id),
  requisitoId: f.requisito_id,
  codigo: f.codigo,
  nombre: f.nombre,
  descripcion: f.descripcion,
  aplicaA: f.aplica_a,
  fuenteSugerida: f.fuente_sugerida,
  documentoId: f.documento_id,
  campos: f.campos,
  cruceCodigo: f.cruce_codigo,
  resultado: f.resultado,
  fuente: f.fuente,
  observacion: f.observacion,
  evidencia: f.evidencia,
  registradoPor: f.registrado_por,
  registradoAt: f.registrado_at,
  version: f.version,
});

const SELECT_ITEMS = `SELECT i.id, i.requisito_id, i.codigo, i.nombre, i.descripcion, i.aplica_a, i.fuente_sugerida,
                             i.documento_id, i.campos, i.cruce_codigo, i.resultado, i.fuente, i.observacion,
                             i.evidencia, u.usuario AS registrado_por, i.registrado_at, i.version
                        FROM validacion_items i LEFT JOIN usuarios u ON u.id = i.registrado_por`;

export interface DatosItem {
  resultado: ResultadoRequisito;
  fuente: string;
  observacion: string;
  evidencia: string;
}

export interface SubsanacionFila {
  id: number;
  solicitudId: number;
  decisionId: number;
  items: ItemSubsanacion[];
  venceAt: Date;
  estado: 'ABIERTA' | 'RESPONDIDA';
  respondidaAt: Date | null;
  createdAt: Date;
}

export interface ItemSubsanacion {
  itemId: number;
  requisitoId: number;
  nombre: string;
  observacion: string;
  documentoId: number | null;
  campos: string[];
}

export interface DecisionFila {
  id: number;
  ronda: number;
  decision: DecisionValidacion;
  motivacion: string;
  items: unknown;
  decididoPor: string;
  decididoAt: Date;
}

export const validacionRepo = {
  // ---------------------------------------------------------------- bandeja

  async bandeja(db: Queryable, f: FiltroBandeja): Promise<{ items: FilaBandeja[]; total: number }> {
    const params: unknown[] = [];
    const tiempoMax = Math.trunc(Number(f.tiempoMaxDias));
    // «Todos»: cualquier solicitud ya radicada, en el estado que esté. Si no, solo lo pendiente de revisar.
    const where: string[] =
      f.estado === 'TODOS'
        ? [`s.estado NOT IN ('PREINSCRITA', 'CORREO_VERIFICADO')`]
        : [
            `(s.estado IN ('RADICADA', 'SUBSANADA', 'EN_REVISION')
        OR (s.estado = 'EN_SUBSANACION' AND ($${params.push(f.estado === 'EN_SUBSANACION')} OR sub.vence_at < now())))`,
          ];
    if (f.estado && f.estado !== 'TODOS') {
      params.push(f.estado);
      where.push(`s.estado = $${params.length}`);
    }
    if (f.asignado === 'mios') {
      params.push(f.actorId);
      where.push(`v.asignado_a = $${params.length}`);
    } else if (f.asignado === 'sin') {
      where.push(`v.asignado_a IS NULL`);
    } else if (typeof f.asignado === 'number') {
      params.push(f.asignado);
      where.push(`v.asignado_a = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${escaparLike(f.q)}%`);
      where.push(
        `(s.radicado ILIKE $${params.length} OR p.nombre_completo ILIKE $${params.length})`,
      );
    }
    if (f.soloVencidas) {
      where.push(
        `(s.radicada_at IS NOT NULL AND (hoy_bogota() - (s.radicada_at AT TIME ZONE 'America/Bogota')::date) > ${tiempoMax})`,
      );
    }
    params.push(f.limit, f.offset);
    const dir = f.direccion === 'desc' ? 'DESC' : 'ASC';
    const r = await db.query<{
      id: number;
      radicado: string;
      radicada_at: Date;
      estado: EstadoSolicitud;
      pcd_nombre: string;
      dias: number;
      asignado_a: number | null;
      asignado_nombre: string | null;
      tomada_por: number | null;
      tomada_nombre: string | null;
      subsanado: boolean | null;
      ronda: number | null;
      vence_at: Date | null;
      vencida: boolean | null;
      total: number;
    }>(
      `SELECT s.id, s.radicado, s.radicada_at, s.estado, p.nombre_completo AS pcd_nombre,
              (hoy_bogota() - (s.radicada_at AT TIME ZONE 'America/Bogota')::date)::int AS dias,
              v.asignado_a, ua.nombres AS asignado_nombre, v.tomada_por, ut.nombres AS tomada_nombre,
              v.subsanado, v.ronda, sub.vence_at, (sub.vence_at < now()) AS vencida,
              COUNT(*) OVER()::int AS total
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         LEFT JOIN validaciones v ON v.solicitud_id = s.id
         LEFT JOIN usuarios ua ON ua.id = v.asignado_a
         LEFT JOIN usuarios ut ON ut.id = v.tomada_por
         LEFT JOIN LATERAL (SELECT vence_at FROM subsanaciones x
                             WHERE x.solicitud_id = s.id AND x.estado = 'ABIERTA'
                             ORDER BY x.created_at DESC LIMIT 1) sub ON true
        WHERE ${where.join(' AND ')}
        ORDER BY ${COLUMNA_ORDEN[f.orden]} ${dir}, s.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: r.rows.map((x) => ({
        solicitudId: x.id,
        radicado: x.radicado,
        radicadaAt: x.radicada_at,
        estado: x.estado,
        pcdNombre: x.pcd_nombre,
        dias: x.dias,
        asignadoA: x.asignado_a ? { id: x.asignado_a, nombre: x.asignado_nombre ?? '' } : null,
        enRevisionPor: x.tomada_por ? { id: x.tomada_por, nombre: x.tomada_nombre ?? '' } : null,
        subsanado: x.subsanado ?? false,
        ronda: x.ronda ?? 1,
        subsanacionVenceAt: x.vence_at,
        subsanacionVencida: x.vencida ?? false,
      })),
      total: r.rows[0]?.total ?? 0,
    };
  },

  // ---------------------------------------------------------------- caso

  async casoBase(db: Queryable, solicitudId: number): Promise<CasoBase | null> {
    const r = await db.query<{
      id: number;
      estado: EstadoSolicitud;
      radicado: string | null;
      radicada_at: Date | null;
      anio: number;
      correo: string;
      direccion: string | null;
      localidad: string | null;
      barrio: string | null;
      pcd_id: number;
      pcd_nombre: string;
      pcd_tipo: string;
      pcd_numero: string;
      cui_id: number | null;
      cui_nombre: string | null;
      cui_tipo: string | null;
      cui_numero: string | null;
    }>(
      `SELECT s.id, s.estado, s.radicado, s.radicada_at, v.anio, s.correo, s.direccion,
              l.nombre AS localidad, b.nombre AS barrio,
              p.id AS pcd_id, p.nombre_completo AS pcd_nombre, tp.codigo AS pcd_tipo, p.numero_identificacion AS pcd_numero,
              c.id AS cui_id, c.nombre_completo AS cui_nombre, tc.codigo AS cui_tipo, c.numero_identificacion AS cui_numero
         FROM solicitudes s
         JOIN vigencias v ON v.id = s.vigencia_id
         JOIN personas p ON p.id = s.pcd_id
         JOIN catalogo_items tp ON tp.id = p.tipo_identificacion_id
         LEFT JOIN personas c ON c.id = s.cuidador_id
         LEFT JOIN catalogo_items tc ON tc.id = c.tipo_identificacion_id
         LEFT JOIN catalogo_items l ON l.id = s.localidad_id
         LEFT JOIN catalogo_items b ON b.id = s.barrio_id
        WHERE s.id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    if (!f) return null;
    return {
      solicitudId: f.id,
      estado: f.estado,
      radicado: f.radicado,
      radicadaAt: f.radicada_at,
      anio: f.anio,
      correo: f.correo,
      direccion: f.direccion,
      localidad: f.localidad,
      barrio: f.barrio,
      pcd: { id: f.pcd_id, nombre: f.pcd_nombre, tipo: f.pcd_tipo, numero: f.pcd_numero },
      cuidador:
        f.cui_id === null
          ? null
          : {
              id: f.cui_id,
              nombre: f.cui_nombre as string,
              tipo: f.cui_tipo as string,
              numero: f.cui_numero as string,
            },
    };
  },

  /** Crea la fila de la validación si no existe y la deja bloqueada para la transacción. */
  async asegurarYBloquear(db: Queryable, solicitudId: number): Promise<ValidacionFila> {
    await db.query(
      `INSERT INTO validaciones (solicitud_id) VALUES ($1) ON CONFLICT (solicitud_id) DO NOTHING`,
      [solicitudId],
    );
    await db.query(`SELECT 1 FROM validaciones WHERE solicitud_id = $1 FOR UPDATE`, [solicitudId]);
    return (await this.validacion(db, solicitudId)) as ValidacionFila;
  },

  async validacion(db: Queryable, solicitudId: number): Promise<ValidacionFila | null> {
    const r = await db.query<{
      solicitud_id: number;
      asignado_a: number | null;
      asignado_nombre: string | null;
      tomada_por: number | null;
      tomada_nombre: string | null;
      tomada_at: Date | null;
      ronda: number;
      subsanado: boolean;
    }>(
      `SELECT v.solicitud_id, v.asignado_a, ua.nombres AS asignado_nombre, v.tomada_por, ut.nombres AS tomada_nombre,
              v.tomada_at, v.ronda, v.subsanado
         FROM validaciones v
         LEFT JOIN usuarios ua ON ua.id = v.asignado_a
         LEFT JOIN usuarios ut ON ut.id = v.tomada_por
        WHERE v.solicitud_id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    return f
      ? {
          solicitudId: f.solicitud_id,
          asignadoA: f.asignado_a,
          asignadoNombre: f.asignado_nombre,
          tomadaPor: f.tomada_por,
          tomadaNombre: f.tomada_nombre,
          tomadaAt: f.tomada_at,
          ronda: f.ronda,
          subsanado: f.subsanado,
        }
      : null;
  },

  async asignar(
    db: Queryable,
    solicitudId: number,
    validadorId: number | null,
    porId: number,
  ): Promise<void> {
    // Reasignar quita la revisión en curso de quien la tenía.
    await db.query(
      `UPDATE validaciones
          SET asignado_a = $2, asignado_por = $3, asignado_at = now(), tomada_por = NULL, tomada_at = NULL,
              updated_at = now()
        WHERE solicitud_id = $1`,
      [solicitudId, validadorId, porId],
    );
  },

  async tomar(db: Queryable, solicitudId: number, usuarioId: number): Promise<void> {
    await db.query(
      `UPDATE validaciones SET tomada_por = $2, tomada_at = now(), updated_at = now() WHERE solicitud_id = $1`,
      [solicitudId, usuarioId],
    );
  },

  async liberar(db: Queryable, solicitudId: number, quitarAsignacion = false): Promise<void> {
    await db.query(
      `UPDATE validaciones
          SET tomada_por = NULL, tomada_at = NULL, updated_at = now(),
              asignado_a = CASE WHEN $2 THEN NULL ELSE asignado_a END,
              asignado_por = CASE WHEN $2 THEN NULL ELSE asignado_por END,
              asignado_at = CASE WHEN $2 THEN NULL ELSE asignado_at END
        WHERE solicitud_id = $1`,
      [solicitudId, quitarAsignacion],
    );
  },

  async fijarSubsanado(
    db: Queryable,
    solicitudId: number,
    subsanado: boolean,
    sumarRonda = false,
  ): Promise<void> {
    await db.query(
      `UPDATE validaciones SET subsanado = $2, ronda = ronda + $3, updated_at = now() WHERE solicitud_id = $1`,
      [solicitudId, subsanado, sumarRonda ? 1 : 0],
    );
  },

  async fijarEstado(db: Queryable, solicitudId: number, estado: EstadoSolicitud): Promise<void> {
    await db.query(`UPDATE solicitudes SET estado = $2, updated_at = now() WHERE id = $1`, [
      solicitudId,
      estado,
    ]);
  },

  // ---------------------------------------------------------------- lista de chequeo

  /** Copia al caso los requisitos que todavía no tiene (la lista del caso no cambia aunque cambie la general). */
  async asegurarItems(db: Queryable, solicitudId: number, requisitos: Requisito[]): Promise<void> {
    for (const q of requisitos) {
      await db.query(
        `INSERT INTO validacion_items
           (solicitud_id, requisito_id, requisito_version, codigo, nombre, descripcion, aplica_a, fuente_sugerida,
            documento_id, campos, cruce_codigo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (solicitud_id, requisito_id) DO NOTHING`,
        [
          solicitudId,
          q.id,
          q.version,
          q.codigo,
          q.nombre,
          q.descripcion,
          q.aplicaA,
          q.fuenteSugerida,
          q.documentoId,
          q.campos,
          q.cruceCodigo,
        ],
      );
    }
  },

  async items(db: Queryable, solicitudId: number): Promise<ItemFila[]> {
    const r = await db.query<FilaItem>(`${SELECT_ITEMS} WHERE i.solicitud_id = $1 ORDER BY i.id`, [
      solicitudId,
    ]);
    return r.rows.map(mapearItem);
  },

  async item(db: Queryable, solicitudId: number, itemId: number): Promise<ItemFila | null> {
    const r = await db.query<FilaItem>(`${SELECT_ITEMS} WHERE i.solicitud_id = $1 AND i.id = $2`, [
      solicitudId,
      itemId,
    ]);
    return r.rows[0] ? mapearItem(r.rows[0]) : null;
  },

  async actualizarItem(
    db: Queryable,
    itemId: number,
    d: DatosItem,
    usuarioId: number,
  ): Promise<void> {
    await db.query(
      `UPDATE validacion_items
          SET resultado = $2, fuente = $3, observacion = $4, evidencia = $5,
              registrado_por = $6, registrado_at = now()
        WHERE id = $1`,
      [itemId, d.resultado, d.fuente, d.observacion, d.evidencia, usuarioId],
    );
  },

  // ---------------------------------------------------------------- datos para la priorización

  async variables(db: Queryable, solicitudId: number): Promise<Record<string, string>> {
    const r = await db.query<{ variable: string; valor: string }>(
      `SELECT variable, valor FROM validacion_variables WHERE solicitud_id = $1`,
      [solicitudId],
    );
    return Object.fromEntries(r.rows.map((x) => [x.variable, x.valor]));
  },

  async fijarVariable(
    db: Queryable,
    solicitudId: number,
    variable: string,
    valor: string,
    usuarioId: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO validacion_variables (solicitud_id, variable, valor, registrado_por)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (solicitud_id, variable)
       DO UPDATE SET valor = EXCLUDED.valor, registrado_por = EXCLUDED.registrado_por, registrado_at = now()`,
      [solicitudId, variable, valor, usuarioId],
    );
  },

  // ---------------------------------------------------------------- decisiones y subsanaciones

  async crearDecision(
    db: Queryable,
    d: {
      solicitudId: number;
      ronda: number;
      decision: DecisionValidacion;
      motivacion: string;
      items: unknown;
      decididoPor: number;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO validacion_decisiones (solicitud_id, ronda, decision, motivacion, items, decidido_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [d.solicitudId, d.ronda, d.decision, d.motivacion, JSON.stringify(d.items), d.decididoPor],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async decisiones(db: Queryable, solicitudId: number): Promise<DecisionFila[]> {
    const r = await db.query<{
      id: string;
      ronda: number;
      decision: DecisionValidacion;
      motivacion: string;
      items: unknown;
      usuario: string;
      decidido_at: Date;
    }>(
      `SELECT d.id, d.ronda, d.decision, d.motivacion, d.items, u.usuario, d.decidido_at
         FROM validacion_decisiones d JOIN usuarios u ON u.id = d.decidido_por
        WHERE d.solicitud_id = $1 ORDER BY d.decidido_at, d.id`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      ronda: x.ronda,
      decision: x.decision,
      motivacion: x.motivacion,
      items: x.items,
      decididoPor: x.usuario,
      decididoAt: x.decidido_at,
    }));
  },

  async contarSubsanaciones(db: Queryable, solicitudId: number): Promise<number> {
    const r = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM validacion_decisiones WHERE solicitud_id = $1 AND decision = 'SUBSANAR'`,
      [solicitudId],
    );
    return r.rows[0]?.n ?? 0;
  },

  async crearSubsanacion(
    db: Queryable,
    d: { solicitudId: number; decisionId: number; items: ItemSubsanacion[]; plazoDias: number },
  ): Promise<Date> {
    // El plazo vence al terminar el último día (hora de Barranquilla).
    const r = await db.query<{ vence_at: Date }>(
      `INSERT INTO subsanaciones (solicitud_id, decision_id, items, vence_at)
       VALUES ($1, $2, $3,
               ((hoy_bogota() + $4::integer + 1)::timestamp AT TIME ZONE 'America/Bogota') - interval '1 second')
       RETURNING vence_at`,
      [d.solicitudId, d.decisionId, JSON.stringify(d.items), d.plazoDias],
    );
    return (r.rows[0] as { vence_at: Date }).vence_at;
  },

  /** La subsanación más reciente de la solicitud (abierta o respondida). */
  async ultimaSubsanacion(
    db: Queryable,
    solicitudId: number,
    soloAbierta = false,
  ): Promise<(SubsanacionFila & { vencida: boolean }) | null> {
    const r = await db.query<{
      id: string;
      solicitud_id: number;
      decision_id: string;
      items: ItemSubsanacion[];
      vence_at: Date;
      estado: 'ABIERTA' | 'RESPONDIDA';
      respondida_at: Date | null;
      created_at: Date;
      vencida: boolean;
    }>(
      `SELECT id, solicitud_id, decision_id, items, vence_at, estado, respondida_at, created_at,
              (estado = 'ABIERTA' AND vence_at < now()) AS vencida
         FROM subsanaciones
        WHERE solicitud_id = $1 ${soloAbierta ? `AND estado = 'ABIERTA'` : ''}
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [solicitudId],
    );
    const f = r.rows[0];
    return f
      ? {
          id: Number(f.id),
          solicitudId: f.solicitud_id,
          decisionId: Number(f.decision_id),
          items: f.items,
          venceAt: f.vence_at,
          estado: f.estado,
          respondidaAt: f.respondida_at,
          createdAt: f.created_at,
          vencida: f.vencida,
        }
      : null;
  },

  async marcarRespondida(db: Queryable, subsanacionId: number): Promise<void> {
    await db.query(
      `UPDATE subsanaciones SET estado = 'RESPONDIDA', respondida_at = now() WHERE id = $1`,
      [subsanacionId],
    );
  },

  /** Usuarios con un permiso (por ejemplo, los validadores), para asignar casos. */
  async usuariosConPermiso(
    db: Queryable,
    permiso: string,
    sinAdministradores = false,
  ): Promise<{ id: number; usuario: string; nombres: string }[]> {
    const r = await db.query<{ id: number; usuario: string; nombres: string }>(
      `SELECT DISTINCT u.id, u.usuario, u.nombres
         FROM usuarios u
         JOIN usuario_rol ur ON ur.usuario_id = u.id
         JOIN rol_permiso rp ON rp.rol_id = ur.rol_id
        WHERE rp.permiso_codigo = $1 AND u.estado = 'ACTIVO'
          AND ($2::boolean = false OR NOT EXISTS (
                SELECT 1 FROM usuario_rol x JOIN roles r ON r.id = x.rol_id
                 WHERE x.usuario_id = u.id AND r.codigo = 'ADMINISTRADOR'))
        ORDER BY u.nombres`,
      [permiso, sinAdministradores],
    );
    return r.rows;
  },

  async tienePermiso(db: Queryable, usuarioId: number, permiso: string): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM usuarios u
         JOIN usuario_rol ur ON ur.usuario_id = u.id
         JOIN rol_permiso rp ON rp.rol_id = ur.rol_id
        WHERE u.id = $1 AND u.estado = 'ACTIVO' AND rp.permiso_codigo = $2`,
      [usuarioId, permiso],
    );
    return r.rowCount === 1;
  },
};
