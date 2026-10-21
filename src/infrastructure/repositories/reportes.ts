import type { Queryable } from '../db/pool.js';

export const REPORTES = [
  { codigo: 'SOLICITUDES_POR_ESTADO', nombre: 'Solicitudes por estado y localidad' },
  { codigo: 'LISTADO_PRIORIZADO', nombre: 'Listado priorizado' },
  { codigo: 'BENEFICIARIOS', nombre: 'Beneficiarios asignados' },
  { codigo: 'ENTREGAS', nombre: 'Entregas de tarjeta' },
  { codigo: 'NOVEDADES_REVOCATORIAS', nombre: 'Novedades y revocatorias' },
  { codigo: 'EXCEPCIONES', nombre: 'Excepciones de priorización' },
  { codigo: 'ENCUESTAS', nombre: 'Encuestas de satisfacción' },
] as const;

export type CodigoReporte = (typeof REPORTES)[number]['codigo'];

/** Filtros comunes a todos los reportes (RF-SEG-05). */
export interface FiltroReporte {
  vigenciaId: number;
  desde?: string;
  hasta?: string;
  localidadId?: number;
  estado?: string;
  poblacion?: 'CON_CUIDADOR' | 'SIN_CUIDADOR';
}

export type Celda = string | number | null;
export interface Columna {
  clave: string;
  titulo: string;
}
export interface TablaReporte {
  columnas: Columna[];
  filas: Record<string, Celda>[];
}

/** Opciones que controlan cuánto se expone de los datos personales. */
export interface OpcionesReporte {
  verSensibles: boolean;
}

const LIMITE_FILAS = 50000;

function condiciones(f: FiltroReporte, params: unknown[]): string {
  const donde: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  donde.push(`s.vigencia_id = ${p(f.vigenciaId)}`);
  if (f.desde) donde.push(`s.created_at >= (${p(f.desde)}::date)::timestamp AT TIME ZONE 'America/Bogota'`);
  if (f.hasta)
    donde.push(`s.created_at < ((${p(f.hasta)}::date) + 1)::timestamp AT TIME ZONE 'America/Bogota'`);
  if (f.localidadId) donde.push(`s.localidad_id = ${p(f.localidadId)}`);
  if (f.estado) donde.push(`s.estado = ${p(f.estado)}`);
  if (f.poblacion)
    donde.push(f.poblacion === 'CON_CUIDADOR' ? 'c.requiere_cuidador IS TRUE' : 'c.requiere_cuidador IS NOT TRUE');
  return donde.join(' AND ');
}

const DESDE = `FROM solicitudes s
  JOIN personas p ON p.id = s.pcd_id
  LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
  LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id`;

/** Con datos sensibles se entrega el documento completo; sin ellos, solo los tres últimos caracteres. */
const documento = (o: OpcionesReporte) =>
  o.verSensibles ? 'p.numero_identificacion' : `'***' || right(p.numero_identificacion, 3)`;

type Fila = Record<string, Celda>;
const fecha = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : v;
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

export const reportesRepo = {
  async generar(db: Queryable, codigo: CodigoReporte, f: FiltroReporte, o: OpcionesReporte): Promise<TablaReporte> {
    const params: unknown[] = [];
    const donde = condiciones(f, params);
    switch (codigo) {
      case 'SOLICITUDES_POR_ESTADO': {
        const r = await db.query<{ localidad: string | null; estado: string; cantidad: number }>(
          `SELECT COALESCE(loc.nombre, 'Sin localidad') AS localidad, s.estado, COUNT(*)::int AS cantidad
             ${DESDE} WHERE ${donde} GROUP BY 1, 2 ORDER BY 1, 2`,
          params,
        );
        return {
          columnas: [
            { clave: 'localidad', titulo: 'Localidad' },
            { clave: 'estado', titulo: 'Estado' },
            { clave: 'cantidad', titulo: 'Solicitudes' },
          ],
          filas: r.rows,
        };
      }
      case 'LISTADO_PRIORIZADO': {
        const r = await db.query<Fila>(
          `SELECT ROW_NUMBER() OVER (ORDER BY pr.puntaje DESC, s.radicada_at, s.id)::int AS posicion,
                  s.radicado, p.nombre_completo AS nombre, ${documento(o)} AS documento,
                  COALESCE(loc.nombre, 'Sin localidad') AS localidad, pr.puntaje::float AS puntaje, s.estado
             ${DESDE}
             JOIN priorizaciones pr ON pr.solicitud_id = s.id AND pr.vigente
            WHERE ${donde} ORDER BY posicion LIMIT ${LIMITE_FILAS}`,
          params,
        );
        return {
          columnas: [
            { clave: 'posicion', titulo: 'Posición' },
            { clave: 'radicado', titulo: 'Radicado' },
            { clave: 'nombre', titulo: 'Persona con discapacidad' },
            { clave: 'documento', titulo: 'Documento' },
            { clave: 'localidad', titulo: 'Localidad' },
            { clave: 'puntaje', titulo: 'Puntaje' },
            { clave: 'estado', titulo: 'Estado' },
          ],
          filas: r.rows,
        };
      }
      case 'BENEFICIARIOS': {
        const r = await db.query<{
          radicado: string;
          nombre: string;
          documento: string;
          localidad: string;
          estado: string;
          posicion: number;
          puntaje: number;
          valor: string;
          asignado_at: Date;
        }>(
          `SELECT s.radicado, p.nombre_completo AS nombre, ${documento(o)} AS documento,
                  COALESCE(loc.nombre, 'Sin localidad') AS localidad, b.estado, b.posicion,
                  b.puntaje_final::float AS puntaje, b.valor_comprometido AS valor, b.asignado_at
             ${DESDE} JOIN beneficios b ON b.solicitud_id = s.id
            WHERE ${donde} ORDER BY b.posicion LIMIT ${LIMITE_FILAS}`,
          params,
        );
        return {
          columnas: [
            { clave: 'radicado', titulo: 'Radicado' },
            { clave: 'nombre', titulo: 'Persona con discapacidad' },
            { clave: 'documento', titulo: 'Documento' },
            { clave: 'localidad', titulo: 'Localidad' },
            { clave: 'estado', titulo: 'Estado del beneficio' },
            { clave: 'posicion', titulo: 'Posición' },
            { clave: 'puntaje', titulo: 'Puntaje' },
            { clave: 'valor', titulo: 'Valor comprometido' },
            { clave: 'asignado', titulo: 'Asignado el' },
          ],
          filas: r.rows.map((x) => ({
            radicado: x.radicado,
            nombre: x.nombre,
            documento: x.documento,
            localidad: x.localidad,
            estado: x.estado,
            posicion: x.posicion,
            puntaje: x.puntaje,
            valor: num(x.valor),
            asignado: fecha(x.asignado_at),
          })),
        };
      }
      case 'ENTREGAS': {
        const r = await db.query<{
          radicado: string;
          rol: string;
          tarjeta: string;
          transporte: string;
          fecha_entrega: Date;
          receptor: string;
          funcionario: string;
          vigente: boolean;
        }>(
          `SELECT s.radicado, e.rol, e.tarjeta_id AS tarjeta, t.nombre AS transporte, e.fecha_entrega,
                  e.receptor_nombre AS receptor, e.funcionario_entrega AS funcionario, e.vigente
             ${DESDE} JOIN beneficios b ON b.solicitud_id = s.id
             JOIN entregas e ON e.beneficio_id = b.id
             JOIN catalogo_items t ON t.id = e.tipo_transporte_id
            WHERE ${donde} ORDER BY e.fecha_entrega, e.id LIMIT ${LIMITE_FILAS}`,
          params,
        );
        return {
          columnas: [
            { clave: 'radicado', titulo: 'Radicado' },
            { clave: 'rol', titulo: 'Titular de la tarjeta' },
            { clave: 'tarjeta', titulo: 'Tarjeta' },
            { clave: 'transporte', titulo: 'Transporte' },
            { clave: 'fecha', titulo: 'Fecha de entrega' },
            { clave: 'receptor', titulo: 'Recibió' },
            { clave: 'funcionario', titulo: 'Entregó' },
            { clave: 'vigente', titulo: 'Vigente' },
          ],
          filas: r.rows.map((x) => ({
            radicado: x.radicado,
            rol: x.rol === 'PCD' ? 'Persona con discapacidad' : 'Cuidador',
            tarjeta: x.tarjeta,
            transporte: x.transporte,
            fecha: fecha(x.fecha_entrega),
            receptor: x.receptor,
            funcionario: x.funcionario,
            vigente: x.vigente ? 'Sí' : 'No',
          })),
        };
      }
      case 'NOVEDADES_REVOCATORIAS': {
        const r = await db.query<{ radicado: string; clase: string; tipo: string; causal: string | null; fecha: Date }>(
          `SELECT s.radicado, 'Novedad' AS clase, n.tipo, ca.nombre AS causal, n.fecha_efectiva AS fecha
             ${DESDE} JOIN beneficios b ON b.solicitud_id = s.id
             JOIN novedades n ON n.beneficio_id = b.id
             LEFT JOIN catalogo_items ca ON ca.id = n.causal_id
            WHERE ${donde}
           UNION ALL
           SELECT s.radicado, 'Revocatoria', COALESCE(rv.resultado, rv.estado), ca.nombre,
                  COALESCE(rv.decidida_at, rv.created_at)::date
             ${DESDE} JOIN beneficios b ON b.solicitud_id = s.id
             JOIN revocatorias rv ON rv.beneficio_id = b.id
             JOIN catalogo_items ca ON ca.id = rv.causal_id
            WHERE ${donde}
            ORDER BY 5, 1 LIMIT ${LIMITE_FILAS}`,
          params,
        );
        return {
          columnas: [
            { clave: 'radicado', titulo: 'Radicado' },
            { clave: 'clase', titulo: 'Clase' },
            { clave: 'tipo', titulo: 'Tipo o resultado' },
            { clave: 'causal', titulo: 'Causal' },
            { clave: 'fecha', titulo: 'Fecha' },
          ],
          filas: r.rows.map((x) => ({ ...x, fecha: fecha(x.fecha) })),
        };
      }
      case 'EXCEPCIONES': {
        const r = await db.query<{
          radicado: string;
          ajuste: string;
          estado: string;
          justificacion: string;
          propuesta: string;
          decidida: string | null;
          propuesta_at: Date;
        }>(
          `SELECT s.radicado, x.ajuste, x.estado, x.justificacion, up.usuario AS propuesta, ud.usuario AS decidida,
                  x.propuesta_at
             ${DESDE} JOIN priorizacion_excepciones x ON x.solicitud_id = s.id
             JOIN usuarios up ON up.id = x.propuesta_por
             LEFT JOIN usuarios ud ON ud.id = x.decidida_por
            WHERE ${donde} ORDER BY x.propuesta_at, x.id LIMIT ${LIMITE_FILAS}`,
          params,
        );
        return {
          columnas: [
            { clave: 'radicado', titulo: 'Radicado' },
            { clave: 'ajuste', titulo: 'Ajuste' },
            { clave: 'estado', titulo: 'Estado' },
            { clave: 'justificacion', titulo: 'Justificación' },
            { clave: 'propuesta', titulo: 'Propuesta por' },
            { clave: 'decidida', titulo: 'Decidida por' },
            { clave: 'fecha', titulo: 'Fecha' },
          ],
          filas: r.rows.map((x) => ({
            radicado: x.radicado,
            ajuste: num(x.ajuste),
            estado: x.estado,
            justificacion: x.justificacion,
            propuesta: x.propuesta,
            decidida: x.decidida,
            fecha: fecha(x.propuesta_at),
          })),
        };
      }
      case 'ENCUESTAS': {
        // Las encuestas no se relacionan con una solicitud: solo aplican las fechas de los filtros.
        const eParams: unknown[] = [];
        const eDonde: string[] = ['true'];
        if (f.desde) {
          eParams.push(f.desde);
          eDonde.push(`e.vigente_hasta >= $${eParams.length}::date`);
        }
        if (f.hasta) {
          eParams.push(f.hasta);
          eDonde.push(`e.vigente_desde <= $${eParams.length}::date`);
        }
        const r = await db.query<{
          titulo: string;
          estado: string;
          desde: Date;
          hasta: Date;
          invitadas: number;
          respondidas: number;
        }>(
          `SELECT e.titulo, e.estado, e.vigente_desde AS desde, e.vigente_hasta AS hasta,
                  (SELECT COUNT(*)::int FROM encuesta_invitaciones i WHERE i.encuesta_id = e.id) AS invitadas,
                  (SELECT COUNT(*)::int FROM encuesta_respuestas r WHERE r.encuesta_id = e.id) AS respondidas
             FROM encuestas e WHERE ${eDonde.join(' AND ')} ORDER BY e.id`,
          eParams,
        );
        return {
          columnas: [
            { clave: 'titulo', titulo: 'Encuesta' },
            { clave: 'estado', titulo: 'Estado' },
            { clave: 'desde', titulo: 'Vigente desde' },
            { clave: 'hasta', titulo: 'Vigente hasta' },
            { clave: 'invitadas', titulo: 'Invitadas' },
            { clave: 'respondidas', titulo: 'Respondidas' },
            { clave: 'tasa', titulo: 'Tasa de respuesta (%)' },
          ],
          filas: r.rows.map((x) => ({
            titulo: x.titulo,
            estado: x.estado,
            desde: fecha(x.desde),
            hasta: fecha(x.hasta),
            invitadas: x.invitadas,
            respondidas: x.respondidas,
            tasa: x.invitadas === 0 ? 0 : Math.round((x.respondidas / x.invitadas) * 1000) / 10,
          })),
        };
      }
    }
  },
};

export interface Exportacion {
  id: number;
  usuario: string;
  reporte: string;
  formato: string;
  filtros: unknown;
  filas: number;
  archivoNombre: string;
  archivoSha256: string;
  creadaAt: Date;
}

export const exportacionesRepo = {
  async registrar(
    db: Queryable,
    e: {
      usuarioId: number;
      reporte: string;
      formato: 'XLSX' | 'PDF' | 'CSV';
      filtros: unknown;
      filas: number;
      archivoNombre: string;
      archivoSha256: string;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO exportaciones (usuario_id, reporte, formato, filtros, filas, archivo_nombre, archivo_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [e.usuarioId, e.reporte, e.formato, JSON.stringify(e.filtros), e.filas, e.archivoNombre, e.archivoSha256],
    );
    return Number(r.rows[0]!.id);
  },

  async listar(db: Queryable, limite: number): Promise<Exportacion[]> {
    const r = await db.query<{
      id: string;
      usuario: string;
      reporte: string;
      formato: string;
      filtros: unknown;
      filas: number;
      archivo_nombre: string;
      archivo_sha256: string;
      creada_at: Date;
    }>(
      `SELECT x.id, u.usuario, x.reporte, x.formato, x.filtros, x.filas, x.archivo_nombre, x.archivo_sha256, x.creada_at
         FROM exportaciones x JOIN usuarios u ON u.id = x.usuario_id ORDER BY x.id DESC LIMIT $1`,
      [limite],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      usuario: x.usuario,
      reporte: x.reporte,
      formato: x.formato,
      filtros: x.filtros,
      filas: x.filas,
      archivoNombre: x.archivo_nombre,
      archivoSha256: x.archivo_sha256,
      creadaAt: x.creada_at,
    }));
  },
};
