import type { EstadoSolicitud } from '../../domain/estados.js';
import {
  CAMPOS_SENSIBLES,
  datosVacios,
  esSensible,
  type CampoDato,
  type DatosCaracterizacion,
  type Embarazo,
} from '../../domain/caracterizacion.js';
import type { Queryable } from '../db/pool.js';
import type { DataCipher } from '../security/crypto.js';

/** Columnas de los datos que no son sensibles. */
const COLUMNAS: [CampoDato, string][] = [
  ['generoId', 'pcd_genero_id'],
  ['telefonoFijo', 'pcd_telefono_fijo'],
  ['celular', 'pcd_celular'],
  ['fechaNacimiento', 'pcd_fecha_nacimiento'],
  ['estadoCivilId', 'pcd_estado_civil_id'],
  ['tieneHijos', 'tiene_hijos'],
  ['hijosCantidad', 'hijos_cantidad'],
  ['hijosEdades', 'hijos_edades'],
  ['escolaridadId', 'pcd_escolaridad_id'],
  ['ocupacionId', 'pcd_ocupacion_id'],
  ['tipoTransporteId', 'tipo_transporte_id'],
  ['justificacionTransporte', 'justificacion_transporte'],
  ['requiereCuidador', 'requiere_cuidador'],
  ['cuidadorGeneroId', 'cuidador_genero_id'],
  ['cuidadorTelefonoFijo', 'cuidador_telefono_fijo'],
  ['cuidadorCelular', 'cuidador_celular'],
  ['cuidadorCorreo', 'cuidador_correo'],
];

interface Sensibles {
  etniaId: number | null;
  epsId: number | null;
  embarazo: Embarazo | null;
  semanasGestacion: number | null;
  recibeSubsidios: boolean | null;
  subsidioCual: string | null;
}

export interface CaracterizacionGuardada {
  version: number;
  datos: DatosCaracterizacion;
  updatedAt: Date;
}

/** Datos de la solicitud que el formulario muestra precargados y las reglas que dependen de ellos. */
export interface ContextoSolicitud {
  id: number;
  estado: EstadoSolicitud;
  correo: string;
  anio: number;
  radicado: string | null;
  radicadaAt: Date | null;
  pcd: { id: number; nombre: string; tipoCodigo: string; tipoNombre: string; numero: string };
  cuidador: { id: number; nombre: string; tipoCodigo: string; tipoNombre: string; numero: string };
  /** El cuidador figura en otra solicitud: su nombre no se puede cambiar desde este formulario. */
  cuidadorEnOtrasSolicitudes: boolean;
}

export interface ItemCorreccion {
  campo: string;
  anterior: string | null;
  nuevo: string | null;
}

export interface CorreccionFila {
  id: number;
  entidad: string;
  campo: string;
  valorAnterior: string | null;
  valorNuevo: string | null;
  usuarioId: number | null;
  origen: 'CIUDADANO' | 'FUNCIONARIO';
  creadoAt: Date;
}

export const caracterizacionRepo = {
  /** Bloquea la fila de la solicitud mientras se guarda, para que dos guardados simultáneos se ordenen. */
  async bloquear(db: Queryable, solicitudId: number): Promise<boolean> {
    const r = await db.query(`SELECT 1 FROM solicitudes WHERE id = $1 FOR UPDATE`, [solicitudId]);
    return r.rows.length > 0;
  },

  async contexto(db: Queryable, solicitudId: number): Promise<ContextoSolicitud | null> {
    const r = await db.query<{
      id: number;
      estado: EstadoSolicitud;
      correo: string;
      anio: number;
      radicado: string | null;
      radicada_at: Date | null;
      pcd_id: number;
      pcd_nombre: string;
      pcd_tipo_codigo: string;
      pcd_tipo_nombre: string;
      pcd_numero: string;
      cui_id: number;
      cui_nombre: string;
      cui_tipo_codigo: string;
      cui_tipo_nombre: string;
      cui_numero: string;
      en_otras: boolean;
    }>(
      `SELECT s.id, s.estado, s.correo, v.anio, s.radicado, s.radicada_at,
              p.id AS pcd_id, p.nombre_completo AS pcd_nombre, tp.codigo AS pcd_tipo_codigo,
              tp.nombre AS pcd_tipo_nombre, p.numero_identificacion AS pcd_numero,
              c.id AS cui_id, c.nombre_completo AS cui_nombre, tc.codigo AS cui_tipo_codigo,
              tc.nombre AS cui_tipo_nombre, c.numero_identificacion AS cui_numero,
              EXISTS (SELECT 1 FROM solicitudes o
                       WHERE o.id <> s.id AND (o.cuidador_id = c.id OR o.pcd_id = c.id)) AS en_otras
         FROM solicitudes s
         JOIN vigencias v ON v.id = s.vigencia_id
         JOIN personas p ON p.id = s.pcd_id
         JOIN catalogo_items tp ON tp.id = p.tipo_identificacion_id
         JOIN personas c ON c.id = s.cuidador_id
         JOIN catalogo_items tc ON tc.id = c.tipo_identificacion_id
        WHERE s.id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    if (!f) return null;
    return {
      id: f.id,
      estado: f.estado,
      correo: f.correo,
      anio: f.anio,
      radicado: f.radicado,
      radicadaAt: f.radicada_at,
      pcd: {
        id: f.pcd_id,
        nombre: f.pcd_nombre,
        tipoCodigo: f.pcd_tipo_codigo,
        tipoNombre: f.pcd_tipo_nombre,
        numero: f.pcd_numero,
      },
      cuidador: {
        id: f.cui_id,
        nombre: f.cui_nombre,
        tipoCodigo: f.cui_tipo_codigo,
        tipoNombre: f.cui_tipo_nombre,
        numero: f.cui_numero,
      },
      cuidadorEnOtrasSolicitudes: f.en_otras,
    };
  },

  async obtener(
    db: Queryable,
    solicitudId: number,
    cipher: DataCipher,
  ): Promise<CaracterizacionGuardada | null> {
    const r = await db.query<Record<string, unknown>>(
      `SELECT * FROM caracterizaciones WHERE solicitud_id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    if (!f) return null;
    const datos = datosVacios();
    const destino = datos as unknown as Record<string, unknown>;
    for (const [campo, columna] of COLUMNAS) destino[campo] = f[columna] ?? null;
    const sobre = f['datos_sensibles'] as Buffer | null;
    if (sobre) {
      const s = cipher.descifrarJson<Sensibles>(sobre);
      for (const campo of CAMPOS_SENSIBLES)
        destino[campo] = (s as unknown as Record<string, unknown>)[campo] ?? null;
    }
    return { version: f['version'] as number, datos, updatedAt: f['updated_at'] as Date };
  },

  /**
   * Guarda los datos si la versión que vio quien los edita sigue siendo la vigente. Devuelve la versión nueva o
   * `null` si otra pestaña guardó antes (la versión 0 es «todavía no hay registro»).
   */
  async guardar(
    db: Queryable,
    solicitudId: number,
    d: DatosCaracterizacion,
    versionEsperada: number,
    cipher: DataCipher,
  ): Promise<{ version: number; updatedAt: Date } | null> {
    const origen = d as unknown as Record<string, unknown>;
    const sensibles: Record<string, unknown> = {};
    for (const c of CAMPOS_SENSIBLES) sensibles[c] = origen[c];
    const hayDatosSensibles = Object.values(sensibles).some((v) => v !== null);
    const sobre = hayDatosSensibles ? cipher.cifrarJson(sensibles) : null;
    const valores = COLUMNAS.map(([campo]) => origen[campo] ?? null);

    if (versionEsperada === 0) {
      const columnas = COLUMNAS.map(([, c]) => c);
      const marcas = [...columnas, 'datos_sensibles'].map((_, i) => `$${i + 2}`);
      const r = await db.query<{ version: number; updated_at: Date }>(
        `INSERT INTO caracterizaciones (solicitud_id, ${columnas.join(', ')}, datos_sensibles)
         VALUES ($1, ${marcas.join(', ')})
         ON CONFLICT (solicitud_id) DO NOTHING
         RETURNING version, updated_at`,
        [solicitudId, ...valores, sobre],
      );
      const f = r.rows[0];
      return f ? { version: f.version, updatedAt: f.updated_at } : null;
    }
    const asignaciones = [...COLUMNAS.map(([, c]) => c), 'datos_sensibles'].map(
      (c, i) => `${c} = $${i + 3}`,
    );
    const r = await db.query<{ version: number; updated_at: Date }>(
      `UPDATE caracterizaciones SET ${asignaciones.join(', ')}, version = version + 1, updated_at = now()
        WHERE solicitud_id = $1 AND version = $2
        RETURNING version, updated_at`,
      [solicitudId, versionEsperada, ...valores, sobre],
    );
    const f = r.rows[0];
    return f ? { version: f.version, updatedAt: f.updated_at } : null;
  },

  async actualizarNombrePersona(db: Queryable, personaId: number, nombre: string): Promise<void> {
    await db.query(`UPDATE personas SET nombre_completo = $2, updated_at = now() WHERE id = $1`, [
      personaId,
      nombre,
    ]);
  },

  /** Nombre y código de elementos de catálogo, para mostrar los que ya se eligieron aunque se hayan desactivado. */
  async itemsPorId(
    db: Queryable,
    ids: number[],
  ): Promise<{ id: number; catalogo: string; codigo: string; nombre: string }[]> {
    if (ids.length === 0) return [];
    const r = await db.query<{ id: number; catalogo: string; codigo: string; nombre: string }>(
      `SELECT id, catalogo, codigo, nombre FROM catalogo_items WHERE id = ANY($1::int[])`,
      [ids],
    );
    return r.rows;
  },

  /** Cuántas otras solicitudes de la misma vigencia tienen a este mismo cuidador (RF-CAR-02, RN-01). */
  async otrasSolicitudesDelCuidador(db: Queryable, solicitudId: number): Promise<number> {
    const r = await db.query<{ n: number }>(
      `SELECT COALESCE(max(otras_solicitudes), 0)::int AS n
         FROM solicitudes_cuidador_compartido WHERE solicitud_id = $1`,
      [solicitudId],
    );
    return r.rows[0]?.n ?? 0;
  },
};

export const correccionesRepo = {
  /**
   * Conserva el valor anterior y el nuevo de cada dato corregido, con quién lo hizo y cuándo (RNF-10). Los valores
   * de los datos sensibles se guardan cifrados.
   */
  async registrar(
    db: Queryable,
    d: {
      solicitudId: number | null;
      entidad: 'persona' | 'caracterizacion';
      entidadId: number;
      cambios: ItemCorreccion[];
      usuarioId: number | null;
      ip: string | null;
    },
    cipher: DataCipher,
  ): Promise<void> {
    const cifrar = (v: string | null) =>
      v === null ? null : cipher.cifrarJson(v).toString('base64');
    for (const c of d.cambios) {
      const sensible = esSensible(c.campo);
      await db.query(
        `INSERT INTO historial_correcciones
           (solicitud_id, entidad, entidad_id, campo, valor_anterior, valor_nuevo, sensible, usuario_id, origen, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          d.solicitudId,
          d.entidad,
          d.entidadId,
          c.campo,
          sensible ? cifrar(c.anterior) : c.anterior,
          sensible ? cifrar(c.nuevo) : c.nuevo,
          sensible,
          d.usuarioId,
          d.usuarioId === null ? 'CIUDADANO' : 'FUNCIONARIO',
          d.ip,
        ],
      );
    }
  },

  /** Historial de una solicitud, del más reciente al más antiguo; descifra los valores sensibles. */
  async porSolicitud(
    db: Queryable,
    solicitudId: number,
    cipher: DataCipher,
  ): Promise<CorreccionFila[]> {
    const r = await db.query<{
      id: number;
      entidad: string;
      campo: string;
      valor_anterior: string | null;
      valor_nuevo: string | null;
      sensible: boolean;
      usuario_id: number | null;
      origen: 'CIUDADANO' | 'FUNCIONARIO';
      creado_at: Date;
    }>(
      `SELECT id, entidad, campo, valor_anterior, valor_nuevo, sensible, usuario_id, origen, creado_at
         FROM historial_correcciones WHERE solicitud_id = $1 ORDER BY id DESC`,
      [solicitudId],
    );
    const claro = (v: string | null, sensible: boolean) =>
      v !== null && sensible ? cipher.descifrarJson<string>(Buffer.from(v, 'base64')) : v;
    return r.rows.map((f) => ({
      id: f.id,
      entidad: f.entidad,
      campo: f.campo,
      valorAnterior: claro(f.valor_anterior, f.sensible),
      valorNuevo: claro(f.valor_nuevo, f.sensible),
      usuarioId: f.usuario_id,
      origen: f.origen,
      creadoAt: f.creado_at,
    }));
  },
};
