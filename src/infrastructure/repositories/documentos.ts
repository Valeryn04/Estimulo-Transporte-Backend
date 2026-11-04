import type { FormatoDocumento, FormatoModelo } from '../../domain/archivos.js';
import type { DatosCarta } from '../../domain/cartas.js';
import type { Queryable } from '../db/pool.js';

export interface DocumentoExigido {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  aplicaA: 'PCD' | 'CUIDADOR' | 'COMUN';
  obligatorio: boolean;
  /** Carta que genera el sistema con los datos del formulario (no se sube). */
  generado: 'CARTA_SOLICITUD' | 'CARTA_CUIDADO' | null;
  /** Hojas que debe tener el documento (por ejemplo, el certificado de discapacidad trae dos). */
  hojasMinimas: number;
}

export interface ArchivoCargado {
  id: number;
  documentoId: number;
  estado: 'CARGADO' | 'REEMPLAZADO' | 'RECHAZADO';
  nombreOriginal: string;
  formato: FormatoDocumento;
  mime: string;
  tamanoBytes: number;
  sha256: string;
  ruta: string;
  cargadoAt: Date;
}

export interface ModeloDocumento {
  documentoId: number;
  nombreOriginal: string;
  formato: FormatoModelo;
  mime: string;
  tamanoBytes: number;
  sha256: string;
  ruta: string;
  cargadoAt: Date;
}

interface FilaArchivo {
  id: number;
  documento_id: number;
  estado: ArchivoCargado['estado'];
  nombre_original: string;
  formato: FormatoDocumento;
  mime: string;
  tamano_bytes: number;
  sha256: string;
  ruta: string;
  cargado_at: Date;
}

const mapearArchivo = (f: FilaArchivo): ArchivoCargado => ({
  id: f.id,
  documentoId: f.documento_id,
  estado: f.estado,
  nombreOriginal: f.nombre_original,
  formato: f.formato,
  mime: f.mime,
  tamanoBytes: f.tamano_bytes,
  sha256: f.sha256,
  ruta: f.ruta,
  cargadoAt: f.cargado_at,
});

const COLS_ARCHIVO = `id, documento_id, estado, nombre_original, formato, mime, tamano_bytes, sha256, ruta, cargado_at`;

export const documentosSolicitudRepo = {
  /** Documentos que debe cargar esta solicitud: los de la PCD, los comunes y, si requiere cuidador, los suyos (RF-CAR-02). */
  async exigidos(db: Queryable, requiereCuidador: boolean): Promise<DocumentoExigido[]> {
    const r = await db.query<{
      id: number;
      codigo: string;
      nombre: string;
      descripcion: string;
      aplica_a: DocumentoExigido['aplicaA'];
      obligatorio: boolean;
      generado: DocumentoExigido['generado'];
      hojas_minimas: number;
    }>(
      `SELECT id, codigo, nombre, descripcion, aplica_a, obligatorio, generado, hojas_minimas
         FROM documentos_requeridos
        WHERE activo AND (aplica_a <> 'CUIDADOR' OR $1::boolean)
        ORDER BY id`,
      [requiereCuidador],
    );
    return r.rows.map((f) => ({
      id: f.id,
      codigo: f.codigo,
      nombre: f.nombre,
      descripcion: f.descripcion,
      aplicaA: f.aplica_a,
      obligatorio: f.obligatorio,
      generado: f.generado,
      hojasMinimas: f.hojas_minimas,
    }));
  },

  async exigidoPorId(
    db: Queryable,
    id: number,
  ): Promise<(DocumentoExigido & { activo: boolean }) | null> {
    const r = await db.query<{
      id: number;
      codigo: string;
      nombre: string;
      descripcion: string;
      aplica_a: DocumentoExigido['aplicaA'];
      obligatorio: boolean;
      activo: boolean;
      generado: DocumentoExigido['generado'];
      hojas_minimas: number;
    }>(
      `SELECT id, codigo, nombre, descripcion, aplica_a, obligatorio, activo, generado, hojas_minimas
         FROM documentos_requeridos WHERE id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          id: f.id,
          codigo: f.codigo,
          nombre: f.nombre,
          descripcion: f.descripcion,
          aplicaA: f.aplica_a,
          obligatorio: f.obligatorio,
          activo: f.activo,
          generado: f.generado,
          hojasMinimas: f.hojas_minimas,
        }
      : null;
  },

  /** Datos que llevan las cartas que genera el sistema: lo que la persona escribió en el formulario. */
  async datosCartas(db: Queryable, solicitudId: number): Promise<DatosCarta | null> {
    const r = await db.query<{
      anio: number;
      radicado: string | null;
      direccion: string | null;
      localidad: string | null;
      barrio: string | null;
      correo: string;
      version: number | null;
      aceptada_at: Date | null;
      pcd_nombre: string;
      pcd_tipo: string;
      pcd_numero: string;
      pcd_celular: string | null;
      pcd_fijo: string | null;
      cui_nombre: string | null;
      cui_tipo: string | null;
      cui_numero: string | null;
      cui_celular: string | null;
      cui_fijo: string | null;
      cui_correo: string | null;
      requiere_cuidador: boolean | null;
    }>(
      `SELECT v.anio, s.radicado, s.direccion, loc.nombre AS localidad, bar.nombre AS barrio, s.correo,
              a.version, a.aceptada_at,
              p.nombre_completo AS pcd_nombre, tp.nombre AS pcd_tipo, p.numero_identificacion AS pcd_numero,
              c.pcd_celular, c.pcd_telefono_fijo AS pcd_fijo,
              pc.nombre_completo AS cui_nombre, tc.nombre AS cui_tipo, pc.numero_identificacion AS cui_numero,
              c.cuidador_celular AS cui_celular, c.cuidador_telefono_fijo AS cui_fijo, c.cuidador_correo AS cui_correo,
              c.requiere_cuidador
         FROM solicitudes s
         JOIN vigencias v ON v.id = s.vigencia_id
         JOIN personas p ON p.id = s.pcd_id
         JOIN catalogo_items tp ON tp.id = p.tipo_identificacion_id
         LEFT JOIN personas pc ON pc.id = s.cuidador_id
         LEFT JOIN catalogo_items tc ON tc.id = pc.tipo_identificacion_id
         LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
         LEFT JOIN aceptaciones_autorizacion a ON a.solicitud_id = s.id
         LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
         LEFT JOIN catalogo_items bar ON bar.id = s.barrio_id
        WHERE s.id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    if (!f) return null;
    return {
      vigencia: f.anio,
      fecha: f.aceptada_at,
      autorizacionVersion: f.version,
      radicado: f.radicado,
      pcd: {
        nombre: f.pcd_nombre,
        tipo: f.pcd_tipo,
        numero: f.pcd_numero,
        celular: f.pcd_celular,
        telefonoFijo: f.pcd_fijo,
      },
      cuidador:
        f.cui_nombre && f.requiere_cuidador !== false
          ? {
              nombre: f.cui_nombre,
              tipo: f.cui_tipo as string,
              numero: f.cui_numero as string,
              celular: f.cui_celular,
              telefonoFijo: f.cui_fijo,
              correo: f.cui_correo,
            }
          : null,
      direccion: f.direccion,
      barrio: f.barrio,
      localidad: f.localidad,
      correo: f.correo,
    };
  },

  /** Archivo vigente (cargado) de cada documento de la solicitud, más el último rechazado si lo hay. */
  async vigentes(db: Queryable, solicitudId: number): Promise<ArchivoCargado[]> {
    const r = await db.query<FilaArchivo>(
      `SELECT DISTINCT ON (documento_id) ${COLS_ARCHIVO}
         FROM documentos_solicitud
        WHERE solicitud_id = $1 AND estado IN ('CARGADO', 'RECHAZADO')
        ORDER BY documento_id, (estado = 'CARGADO') DESC, cargado_at DESC, id DESC`,
      [solicitudId],
    );
    return r.rows.map(mapearArchivo);
  },

  async vigente(
    db: Queryable,
    solicitudId: number,
    documentoId: number,
  ): Promise<ArchivoCargado | null> {
    const r = await db.query<FilaArchivo>(
      `SELECT ${COLS_ARCHIVO} FROM documentos_solicitud
        WHERE solicitud_id = $1 AND documento_id = $2 AND estado = 'CARGADO'`,
      [solicitudId, documentoId],
    );
    return r.rows[0] ? mapearArchivo(r.rows[0]) : null;
  },

  /** Cuántas veces se reemplazó cada documento (el anterior queda guardado como «reemplazado»). */
  async conteoReemplazos(db: Queryable, solicitudId: number): Promise<Map<number, number>> {
    const r = await db.query<{ documento_id: number; n: number }>(
      `SELECT documento_id, count(*)::int AS n FROM documentos_solicitud
        WHERE solicitud_id = $1 AND estado = 'REEMPLAZADO' GROUP BY documento_id`,
      [solicitudId],
    );
    return new Map(r.rows.map((f) => [f.documento_id, f.n]));
  },

  async historial(
    db: Queryable,
    solicitudId: number,
    documentoId: number,
  ): Promise<ArchivoCargado[]> {
    const r = await db.query<FilaArchivo>(
      `SELECT ${COLS_ARCHIVO} FROM documentos_solicitud
        WHERE solicitud_id = $1 AND documento_id = $2 ORDER BY cargado_at DESC, id DESC`,
      [solicitudId, documentoId],
    );
    return r.rows.map(mapearArchivo);
  },

  /** Marca como reemplazado el archivo vigente y registra el nuevo, en una sola operación. */
  async reemplazar(
    db: Queryable,
    d: {
      solicitudId: number;
      documentoId: number;
      nombreOriginal: string;
      formato: FormatoDocumento;
      mime: string;
      tamanoBytes: number;
      sha256: string;
      ruta: string;
      ip: string | null;
    },
  ): Promise<{ id: number; reemplazaA: number | null }> {
    const anterior = await db.query<{ id: number }>(
      `UPDATE documentos_solicitud SET estado = 'REEMPLAZADO'
        WHERE solicitud_id = $1 AND documento_id = $2 AND estado = 'CARGADO' RETURNING id`,
      [d.solicitudId, d.documentoId],
    );
    const r = await db.query<{ id: number }>(
      `INSERT INTO documentos_solicitud
         (solicitud_id, documento_id, nombre_original, formato, mime, tamano_bytes, sha256, ruta, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        d.solicitudId,
        d.documentoId,
        d.nombreOriginal,
        d.formato,
        d.mime,
        d.tamanoBytes,
        d.sha256,
        d.ruta,
        d.ip,
      ],
    );
    return { id: (r.rows[0] as { id: number }).id, reemplazaA: anterior.rows[0]?.id ?? null };
  },
};

export const modelosRepo = {
  async porDocumento(db: Queryable, documentoId: number): Promise<ModeloDocumento | null> {
    const r = await db.query<{
      documento_id: number;
      nombre_original: string;
      formato: FormatoModelo;
      mime: string;
      tamano_bytes: number;
      sha256: string;
      ruta: string;
      cargado_at: Date;
    }>(`SELECT * FROM documento_modelos WHERE documento_id = $1`, [documentoId]);
    const f = r.rows[0];
    return f
      ? {
          documentoId: f.documento_id,
          nombreOriginal: f.nombre_original,
          formato: f.formato,
          mime: f.mime,
          tamanoBytes: f.tamano_bytes,
          sha256: f.sha256,
          ruta: f.ruta,
          cargadoAt: f.cargado_at,
        }
      : null;
  },

  /** Resumen del modelo de cada documento que lo tiene, para el portal interno. */
  async resumenes(
    db: Queryable,
  ): Promise<
    Map<number, { nombre: string; formato: FormatoModelo; tamanoBytes: number; cargadoAt: string }>
  > {
    const r = await db.query<{
      documento_id: number;
      nombre_original: string;
      formato: FormatoModelo;
      tamano_bytes: number;
      cargado_at: Date;
    }>(
      `SELECT documento_id, nombre_original, formato, tamano_bytes, cargado_at FROM documento_modelos`,
    );
    return new Map(
      r.rows.map((f) => [
        f.documento_id,
        {
          nombre: f.nombre_original,
          formato: f.formato,
          tamanoBytes: f.tamano_bytes,
          cargadoAt: f.cargado_at.toISOString(),
        },
      ]),
    );
  },

  async idsConModelo(db: Queryable): Promise<Set<number>> {
    const r = await db.query<{ documento_id: number }>(
      `SELECT documento_id FROM documento_modelos`,
    );
    return new Set(r.rows.map((f) => f.documento_id));
  },

  async guardar(
    db: Queryable,
    d: Omit<ModeloDocumento, 'cargadoAt'> & { cargadoPor: number },
  ): Promise<void> {
    await db.query(
      `INSERT INTO documento_modelos
         (documento_id, nombre_original, formato, mime, tamano_bytes, sha256, ruta, cargado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (documento_id) DO UPDATE SET
         nombre_original = EXCLUDED.nombre_original, formato = EXCLUDED.formato, mime = EXCLUDED.mime,
         tamano_bytes = EXCLUDED.tamano_bytes, sha256 = EXCLUDED.sha256, ruta = EXCLUDED.ruta,
         cargado_por = EXCLUDED.cargado_por, cargado_at = now()`,
      [
        d.documentoId,
        d.nombreOriginal,
        d.formato,
        d.mime,
        d.tamanoBytes,
        d.sha256,
        d.ruta,
        d.cargadoPor,
      ],
    );
  },
};
