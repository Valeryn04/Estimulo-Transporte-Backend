import type { Queryable } from '../db/pool.js';

// ---------------------------------------------------------------------------------------------------------
// Bitácora (RF-SEG-01)
// ---------------------------------------------------------------------------------------------------------

export interface FiltroBitacora {
  radicado?: string;
  solicitudId?: number;
  usuario?: string;
  modulo?: string;
  accion?: string;
  desde?: string;
  hasta?: string;
  limit: number;
  offset: number;
}

export interface FilaBitacora {
  id: number;
  creadoAt: Date;
  usuario: string | null;
  modulo: string;
  accion: string;
  entidad: string;
  entidadId: string | null;
  radicado: string | null;
  valorAnterior: unknown;
  valorNuevo: unknown;
  justificacion: string | null;
  detalle: unknown;
  ip: string | null;
}

const escaparLike = (t: string): string => t.replace(/[\\%_]/g, '\\$&');

export const bitacoraConsultaRepo = {
  async consultar(db: Queryable, f: FiltroBitacora): Promise<{ items: FilaBitacora[]; total: number }> {
    const params: unknown[] = [];
    const donde: string[] = ['true'];
    const agregar = (sql: string, valor: unknown) => {
      params.push(valor);
      donde.push(sql.replace('?', `$${params.length}`));
    };
    if (f.solicitudId) agregar('b.solicitud_id = ?', f.solicitudId);
    if (f.radicado) agregar('s.radicado = ?', f.radicado.toUpperCase());
    if (f.usuario) agregar(`u.usuario ILIKE ?`, `%${escaparLike(f.usuario)}%`);
    if (f.modulo) agregar('b.modulo = ?', f.modulo);
    if (f.accion) agregar('b.accion ILIKE ?', `${escaparLike(f.accion)}%`);
    if (f.desde) agregar(`b.creado_at >= (?::date)::timestamp AT TIME ZONE 'America/Bogota'`, f.desde);
    if (f.hasta) agregar(`b.creado_at < ((?::date) + 1)::timestamp AT TIME ZONE 'America/Bogota'`, f.hasta);
    params.push(f.limit, f.offset);
    const r = await db.query<{
      id: string;
      creado_at: Date;
      usuario: string | null;
      modulo: string;
      accion: string;
      entidad: string;
      entidad_id: string | null;
      radicado: string | null;
      valor_anterior: unknown;
      valor_nuevo: unknown;
      justificacion: string | null;
      detalle: unknown;
      ip: string | null;
      total: number;
    }>(
      `SELECT b.id, b.creado_at, u.usuario, b.modulo, b.accion, b.entidad, b.entidad_id, s.radicado,
              b.valor_anterior, b.valor_nuevo, b.justificacion, b.detalle, b.ip, COUNT(*) OVER()::int AS total
         FROM bitacora b
         LEFT JOIN usuarios u ON u.id = b.usuario_id
         LEFT JOIN solicitudes s ON s.id = b.solicitud_id
        WHERE ${donde.join(' AND ')}
        ORDER BY b.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total: r.rows[0]?.total ?? 0,
      items: r.rows.map((x) => ({
        id: Number(x.id),
        creadoAt: x.creado_at,
        usuario: x.usuario,
        modulo: x.modulo,
        accion: x.accion,
        entidad: x.entidad,
        entidadId: x.entidad_id,
        radicado: x.radicado,
        valorAnterior: x.valor_anterior,
        valorNuevo: x.valor_nuevo,
        justificacion: x.justificacion,
        detalle: x.detalle,
        ip: x.ip,
      })),
    };
  },

  async modulos(db: Queryable): Promise<string[]> {
    const r = await db.query<{ modulo: string }>(`SELECT DISTINCT modulo FROM bitacora ORDER BY modulo`);
    return r.rows.map((x) => x.modulo);
  },
};

// ---------------------------------------------------------------------------------------------------------
// Expediente integral (RF-SEG-03)
// ---------------------------------------------------------------------------------------------------------

export interface ResumenExpediente {
  solicitudId: number;
  radicado: string | null;
  estado: string;
  anio: number;
  correo: string;
  localidad: string | null;
  barrio: string | null;
  creadaAt: Date;
  correoVerificadoAt: Date | null;
  radicadaAt: Date | null;
  pcd: { id: number; nombre: string; tipo: string; numero: string };
  cuidador: { id: number; nombre: string; tipo: string; numero: string } | null;
  puntaje: { total: number; matrizVersion: number } | null;
  beneficio: { id: number; estado: string; asignadoAt: Date } | null;
}

export const expedienteRepo = {
  async buscar(
    db: Queryable,
    q: string,
    limit: number,
  ): Promise<{ solicitudId: number; radicado: string | null; estado: string; anio: number; pcdNombre: string }[]> {
    const texto = q.trim();
    const numero = texto.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = await db.query<{ id: number; radicado: string | null; estado: string; anio: number; nombre: string }>(
      `SELECT s.id, s.radicado, s.estado, v.anio, p.nombre_completo AS nombre
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         JOIN vigencias v ON v.id = s.vigencia_id
        WHERE s.radicado = $1 OR p.numero_identificacion = $2 OR p.nombre_completo ILIKE $3
        ORDER BY v.anio DESC, s.id DESC LIMIT $4`,
      [texto.toUpperCase(), numero, `%${escaparLike(texto)}%`, limit],
    );
    return r.rows.map((x) => ({ solicitudId: x.id, radicado: x.radicado, estado: x.estado, anio: x.anio, pcdNombre: x.nombre }));
  },

  async resumen(db: Queryable, solicitudId: number): Promise<ResumenExpediente | null> {
    const r = await db.query<{
      id: number;
      radicado: string | null;
      estado: string;
      anio: number;
      correo: string;
      localidad: string | null;
      barrio: string | null;
      created_at: Date;
      correo_verificado_at: Date | null;
      radicada_at: Date | null;
      pcd_id: number;
      pcd_nombre: string;
      pcd_tipo: string;
      pcd_numero: string;
      cui_id: number | null;
      cui_nombre: string | null;
      cui_tipo: string | null;
      cui_numero: string | null;
      puntaje: string | null;
      matriz: number | null;
      ben_id: string | null;
      ben_estado: string | null;
      ben_at: Date | null;
    }>(
      `SELECT s.id, s.radicado, s.estado, v.anio, s.correo, loc.nombre AS localidad, bar.nombre AS barrio,
              s.created_at, s.correo_verificado_at, s.radicada_at,
              p.id AS pcd_id, p.nombre_completo AS pcd_nombre, tp.nombre AS pcd_tipo, p.numero_identificacion AS pcd_numero,
              CASE WHEN c.requiere_cuidador THEN pc.id END AS cui_id,
              CASE WHEN c.requiere_cuidador THEN pc.nombre_completo END AS cui_nombre,
              CASE WHEN c.requiere_cuidador THEN tc.nombre END AS cui_tipo,
              CASE WHEN c.requiere_cuidador THEN pc.numero_identificacion END AS cui_numero,
              pr.puntaje, m.version AS matriz, b.id AS ben_id, b.estado AS ben_estado, b.asignado_at AS ben_at
         FROM solicitudes s
         JOIN vigencias v ON v.id = s.vigencia_id
         JOIN personas p ON p.id = s.pcd_id
         JOIN catalogo_items tp ON tp.id = p.tipo_identificacion_id
         JOIN personas pc ON pc.id = s.cuidador_id
         JOIN catalogo_items tc ON tc.id = pc.tipo_identificacion_id
         LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
         LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
         LEFT JOIN catalogo_items bar ON bar.id = s.barrio_id
         LEFT JOIN priorizaciones pr ON pr.solicitud_id = s.id AND pr.vigente
         LEFT JOIN matrices m ON m.id = pr.matriz_id
         LEFT JOIN beneficios b ON b.solicitud_id = s.id
        WHERE s.id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    if (!f) return null;
    return {
      solicitudId: f.id,
      radicado: f.radicado,
      estado: f.estado,
      anio: f.anio,
      correo: f.correo,
      localidad: f.localidad,
      barrio: f.barrio,
      creadaAt: f.created_at,
      correoVerificadoAt: f.correo_verificado_at,
      radicadaAt: f.radicada_at,
      pcd: { id: f.pcd_id, nombre: f.pcd_nombre, tipo: f.pcd_tipo, numero: f.pcd_numero },
      cuidador:
        f.cui_id === null
          ? null
          : { id: f.cui_id, nombre: f.cui_nombre as string, tipo: f.cui_tipo as string, numero: f.cui_numero as string },
      puntaje: f.puntaje === null ? null : { total: Number(f.puntaje), matrizVersion: f.matriz as number },
      beneficio: f.ben_id === null ? null : { id: Number(f.ben_id), estado: f.ben_estado as string, asignadoAt: f.ben_at as Date },
    };
  },

  /** Otras solicitudes de la misma persona con discapacidad, de otras vigencias. */
  async otrasVigencias(db: Queryable, personaId: number, excluirId: number) {
    const r = await db.query<{ id: number; radicado: string | null; estado: string; anio: number }>(
      `SELECT s.id, s.radicado, s.estado, v.anio FROM solicitudes s JOIN vigencias v ON v.id = s.vigencia_id
        WHERE s.pcd_id = $1 AND s.id <> $2 ORDER BY v.anio DESC`,
      [personaId, excluirId],
    );
    return r.rows.map((x) => ({ solicitudId: x.id, radicado: x.radicado, estado: x.estado, anio: x.anio }));
  },

  async eventosDeBitacora(db: Queryable, solicitudId: number) {
    const r = await db.query<{
      id: string;
      creado_at: Date;
      usuario: string | null;
      modulo: string;
      accion: string;
      justificacion: string | null;
      valor_anterior: Record<string, unknown> | null;
      valor_nuevo: Record<string, unknown> | null;
      detalle: Record<string, unknown>;
    }>(
      `SELECT b.id, b.creado_at, u.usuario, b.modulo, b.accion, b.justificacion, b.valor_anterior, b.valor_nuevo, b.detalle
         FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
        WHERE b.solicitud_id = $1 AND b.accion NOT IN ('EXPEDIENTE_CONSULTADO', 'BITACORA_CONSULTADA')
        ORDER BY b.id`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      fecha: x.creado_at,
      usuario: x.usuario,
      modulo: x.modulo,
      accion: x.accion,
      justificacion: x.justificacion,
      anterior: x.valor_anterior,
      nuevo: x.valor_nuevo,
      detalle: x.detalle,
    }));
  },

  async comunicaciones(db: Queryable, solicitudId: number) {
    const r = await db.query<{ id: string; tipo: string; asunto: string; estado: string; created_at: Date; enviado_at: Date | null }>(
      `SELECT id, tipo, asunto, estado, created_at, enviado_at FROM correos WHERE solicitud_id = $1 ORDER BY created_at, id`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      tipo: x.tipo,
      asunto: x.asunto,
      estado: x.estado,
      fecha: x.enviado_at ?? x.created_at,
    }));
  },

  async documentos(db: Queryable, solicitudId: number) {
    const r = await db.query<{ nombre: string; estado: string; version: number; nombre_original: string; origen: string; cargado_at: Date }>(
      `SELECT d.nombre, ds.estado, ROW_NUMBER() OVER (PARTITION BY ds.documento_id ORDER BY ds.id)::int AS version,
              ds.nombre_original, ds.origen, ds.cargado_at
         FROM documentos_solicitud ds JOIN documentos_requeridos d ON d.id = ds.documento_id
        WHERE ds.solicitud_id = $1 ORDER BY d.nombre, ds.id`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      documento: x.nombre,
      estado: x.estado,
      version: x.version,
      archivo: x.nombre_original,
      origen: x.origen,
      cargadoAt: x.cargado_at,
    }));
  },
};

// ---------------------------------------------------------------------------------------------------------
// Tablero (RF-SEG-04)
// ---------------------------------------------------------------------------------------------------------

export interface FiltroTablero {
  vigenciaId: number;
  localidadId?: number;
  poblacion?: 'CON_CUIDADOR' | 'SIN_CUIDADOR';
  etapa?: string[];
}

export interface Indicadores {
  preinscritos: number;
  caracterizados: number;
  validados: number;
  rechazados: number;
  priorizados: number;
  lista_espera: number;
  asignados: number;
  asignados_vigentes: number;
  activos: number;
  entregas: number;
  bloqueos: number;
  levantamientos: number;
  revocatorias: number;
}

export const tableroRepo = {
  async indicadores(db: Queryable, f: FiltroTablero): Promise<Indicadores> {
    const params: unknown[] = [f.vigenciaId];
    const donde = ['s.vigencia_id = $1'];
    if (f.localidadId) {
      params.push(f.localidadId);
      donde.push(`s.localidad_id = $${params.length}`);
    }
    if (f.poblacion) donde.push(f.poblacion === 'CON_CUIDADOR' ? 'c.requiere_cuidador IS TRUE' : 'c.requiere_cuidador IS NOT TRUE');
    if (f.etapa) {
      params.push(f.etapa);
      donde.push(`s.estado = ANY($${params.length}::text[])`);
    }
    const base = `FROM solicitudes s LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id WHERE ${donde.join(' AND ')}`;
    const r = await db.query<Indicadores>(
      `WITH base AS (SELECT s.id, s.estado, s.radicada_at ${base})
       SELECT
         (SELECT COUNT(*) FROM base)::int AS preinscritos,
         (SELECT COUNT(*) FROM base WHERE radicada_at IS NOT NULL)::int AS caracterizados,
         (SELECT COUNT(*) FROM base WHERE estado IN ('VALIDADA', 'PRIORIZADA', 'EN_LISTA_ESPERA', 'ASIGNADA'))::int AS validados,
         (SELECT COUNT(*) FROM base WHERE estado = 'NO_CUMPLE')::int AS rechazados,
         (SELECT COUNT(*) FROM base b JOIN priorizaciones p ON p.solicitud_id = b.id AND p.vigente)::int AS priorizados,
         (SELECT COUNT(*) FROM base WHERE estado = 'EN_LISTA_ESPERA')::int AS lista_espera,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id)::int AS asignados,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id WHERE be.estado <> 'FINALIZADO')::int AS asignados_vigentes,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id WHERE be.estado = 'ACTIVO')::int AS activos,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id JOIN entregas e ON e.beneficio_id = be.id)::int AS entregas,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id JOIN novedades n ON n.beneficio_id = be.id WHERE n.tipo IN ('BLOQUEO', 'SUSPENSION'))::int AS bloqueos,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id JOIN novedades n ON n.beneficio_id = be.id WHERE n.tipo = 'LEVANTAMIENTO')::int AS levantamientos,
         (SELECT COUNT(*) FROM base b JOIN beneficios be ON be.solicitud_id = b.id JOIN revocatorias r ON r.beneficio_id = be.id WHERE r.resultado = 'REVOCADA')::int AS revocatorias`,
      params,
    );
    return r.rows[0]!;
  },

  async tiempos(db: Queryable, f: FiltroTablero) {
    const params: unknown[] = [f.vigenciaId];
    const donde = ['s.vigencia_id = $1'];
    if (f.localidadId) {
      params.push(f.localidadId);
      donde.push(`s.localidad_id = $${params.length}`);
    }
    if (f.poblacion) donde.push(f.poblacion === 'CON_CUIDADOR' ? 'c.requiere_cuidador IS TRUE' : 'c.requiere_cuidador IS NOT TRUE');
    const r = await db.query<{ validacion: string | null; priorizacion: string | null; asignacion: string | null; entrega: string | null }>(
      `WITH casos AS (
         SELECT s.id, s.radicada_at,
                (SELECT MIN(d.decidido_at) FROM validacion_decisiones d WHERE d.solicitud_id = s.id) AS primera_decision,
                (SELECT MIN(d.decidido_at) FROM validacion_decisiones d WHERE d.solicitud_id = s.id AND d.decision = 'APROBAR') AS aprobada_at,
                (SELECT MIN(p.calculado_at) FROM priorizaciones p WHERE p.solicitud_id = s.id) AS puntaje_at,
                b.asignado_at,
                (SELECT MIN(e.registrado_at) FROM entregas e WHERE e.beneficio_id = b.id) AS entrega_at
           FROM solicitudes s
           LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
           LEFT JOIN beneficios b ON b.solicitud_id = s.id
          WHERE ${donde.join(' AND ')})
       SELECT ROUND(AVG(EXTRACT(EPOCH FROM (primera_decision - radicada_at)) / 86400)::numeric, 1) AS validacion,
              ROUND(AVG(EXTRACT(EPOCH FROM (puntaje_at - aprobada_at)) / 86400)::numeric, 1) AS priorizacion,
              ROUND(AVG(EXTRACT(EPOCH FROM (asignado_at - puntaje_at)) / 86400)::numeric, 1) AS asignacion,
              ROUND(AVG(EXTRACT(EPOCH FROM (entrega_at - asignado_at)) / 86400)::numeric, 1) AS entrega
         FROM casos`,
      params,
    );
    const x = r.rows[0];
    const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    return { validacion: n(x?.validacion), priorizacion: n(x?.priorizacion), asignacion: n(x?.asignacion), entrega: n(x?.entrega) };
  },

  async presupuesto(db: Queryable, vigenciaId: number) {
    const r = await db.query<{ total: string; cupos: number; comprometido: string }>(
      `SELECT v.presupuesto_total AS total, v.cupos_totales AS cupos,
              COALESCE((SELECT SUM(b.valor_comprometido) FROM beneficios b
                         WHERE b.vigencia_id = v.id AND b.estado <> 'FINALIZADO'), 0) AS comprometido
         FROM vigencias v WHERE v.id = $1`,
      [vigenciaId],
    );
    const x = r.rows[0];
    return x ? { total: Number(x.total), cupos: x.cupos, comprometido: Number(x.comprometido) } : null;
  },

  async ultimaEncuestaConRespuestas(db: Queryable): Promise<number | null> {
    const r = await db.query<{ id: number }>(
      `SELECT encuesta_id AS id FROM encuesta_respuestas ORDER BY id DESC LIMIT 1`,
    );
    return r.rows[0]?.id ?? null;
  },

  async porLocalidad(db: Queryable, vigenciaId: number) {
    const r = await db.query<{ localidad: string | null; solicitudes: number; asignados: number }>(
      `SELECT loc.nombre AS localidad, COUNT(s.id)::int AS solicitudes,
              COUNT(b.id)::int AS asignados
         FROM solicitudes s
         LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
         LEFT JOIN beneficios b ON b.solicitud_id = s.id
        WHERE s.vigencia_id = $1 GROUP BY loc.nombre ORDER BY solicitudes DESC`,
      [vigenciaId],
    );
    return r.rows.map((x) => ({ localidad: x.localidad ?? 'Sin localidad', solicitudes: x.solicitudes, asignados: x.asignados }));
  },
};

// ---------------------------------------------------------------------------------------------------------
// BI (RF-SEG-07)
// ---------------------------------------------------------------------------------------------------------

export interface EventoBi {
  eventoId: number;
  ocurridoAt: Date;
  tipoEvento: string;
  etapa: string;
  estado: string | null;
  localidad: string | null;
  vigencia: number | null;
  usuarioRef: number | null;
  casoRef: string | null;
}

export const biRepo = {
  async eventos(
    db: Queryable,
    f: { desde?: string; hasta?: string; despuesDe?: number; limite: number },
  ): Promise<EventoBi[]> {
    const params: unknown[] = [];
    const donde = ['true'];
    if (f.despuesDe) {
      params.push(f.despuesDe);
      donde.push(`evento_id > $${params.length}`);
    }
    if (f.desde) {
      params.push(f.desde);
      donde.push(`ocurrido_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'America/Bogota'`);
    }
    if (f.hasta) {
      params.push(f.hasta);
      donde.push(`ocurrido_at < (($${params.length}::date) + 1)::timestamp AT TIME ZONE 'America/Bogota'`);
    }
    params.push(f.limite);
    const r = await db.query<{
      evento_id: string;
      ocurrido_at: Date;
      tipo_evento: string;
      etapa: string;
      estado: string | null;
      localidad: string | null;
      vigencia: number | null;
      usuario_ref: string | null;
      caso_ref: string | null;
    }>(
      `SELECT * FROM bi_eventos WHERE ${donde.join(' AND ')} ORDER BY evento_id LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((x) => ({
      eventoId: Number(x.evento_id),
      ocurridoAt: x.ocurrido_at,
      tipoEvento: x.tipo_evento,
      etapa: x.etapa,
      estado: x.estado,
      localidad: x.localidad,
      vigencia: x.vigencia,
      usuarioRef: x.usuario_ref === null ? null : Number(x.usuario_ref),
      casoRef: x.caso_ref,
    }));
  },
};
