import { modoDeEdicion } from './subsanacion.js';
import { ARCHIVO_MAX_MB_ABSOLUTO } from '../domain/limites.js';
import { createHash } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import {
  MIME,
  MIME_MODELO,
  detectarFormato,
  detectarFormatoModelo,
  extensionDe,
  formatearTamano,
  listarFormatos,
  nombreSeguro,
  type FormatoDocumento,
} from '../domain/archivos.js';
import { PDFDocument } from 'pdf-lib';
import { cartaCuidado, cartaSolicitud, type CartaGenerada } from '../domain/cartas.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { renderCarta } from '../infrastructure/pdf/documentos.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { caracterizacionRepo } from '../infrastructure/repositories/caracterizacion.js';
import {
  documentosSolicitudRepo,
  modelosRepo,
  type ArchivoCargado,
  type DocumentoExigido,
} from '../infrastructure/repositories/documentos.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { AlmacenArchivos } from '../infrastructure/storage/almacen.js';
import { AppError, conflict, notFound } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Cuántas hojas tiene un PDF; null si no se puede leer. */
async function contarHojas(contenido: Buffer): Promise<number | null> {
  try {
    const pdf = await PDFDocument.load(contenido, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

export interface ArchivoEntrada {
  contenido: Buffer;
  nombre: string;
}

/** Un archivo de evidencia ya guardado (cifrado, con su hash). */
export interface EvidenciaArchivo {
  ruta: string;
  nombre: string;
  mime: string;
  tamanoBytes: number;
  sha256: string;
}

export type EstadoDocumento = 'PENDIENTE' | 'CARGADO' | 'RECHAZADO';

/** Tamaño máximo de un modelo de carta publicado por la Gerencia. */
const MAX_MODELO_BYTES = 10 * 1_048_576;

const FORMATOS_CONOCIDOS: readonly FormatoDocumento[] = ['pdf', 'jpg', 'png'];

/**
 * Documentos soporte de la solicitud (RF-CAR-03, RNF-06). Cada archivo se valida por su contenido real, se guarda
 * cifrado fuera de la base de datos con su hash SHA-256, y nunca se borra: al reemplazarlo el anterior queda como
 * «reemplazado».
 */
export class ServicioDocumentos {
  private readonly cipher: DataCipher;
  private readonly almacen: AlmacenArchivos;

  constructor(private readonly deps: Dependencias) {
    this.cipher = new DataCipher(deps.env.encryption);
    this.almacen = new AlmacenArchivos(deps.env.storageDir);
  }

  /** Formatos y tamaño máximo vigentes (parámetros, RNF-12). */
  async reglas(): Promise<{ formatos: FormatoDocumento[]; maxMb: number; maxBytes: number }> {
    const { pool } = this.deps;
    const [texto, maxMb] = await Promise.all([
      parametrosRepo.texto(pool, 'archivo_formatos'),
      parametrosRepo.entero(pool, 'archivo_max_mb'),
    ]);
    const formatos = [
      ...new Set(
        texto
          .split(',')
          .map((f) => f.trim().toLowerCase().replace('jpeg', 'jpg'))
          .filter((f): f is FormatoDocumento => FORMATOS_CONOCIDOS.includes(f as FormatoDocumento)),
      ),
    ];
    // Aunque el parámetro llegara a decir otra cosa, nunca se acepta más del tope absoluto.
    const tope = Math.min(maxMb, ARCHIVO_MAX_MB_ABSOLUTO);
    return { formatos, maxMb: tope, maxBytes: tope * 1_048_576 };
  }

  private async requiereCuidador(solicitudId: number): Promise<boolean> {
    const g = await caracterizacionRepo.obtener(this.deps.pool, solicitudId, this.cipher);
    return g?.datos.requiereCuidador === true;
  }

  private entrada(
    d: DocumentoExigido,
    archivo: ArchivoCargado | undefined,
    reemplazos: number,
    tieneModelo: boolean,
  ) {
    return {
      id: d.id,
      codigo: d.codigo,
      nombre: d.nombre,
      descripcion: d.descripcion,
      aplicaA: d.aplicaA,
      obligatorio: d.obligatorio,
      estado: (archivo?.estado ?? 'PENDIENTE') as EstadoDocumento,
      reemplazos,
      archivo: archivo
        ? {
            nombre: archivo.nombreOriginal,
            formato: archivo.formato,
            tamanoBytes: archivo.tamanoBytes,
            sha256: archivo.sha256,
            cargadoAt: archivo.cargadoAt.toISOString(),
          }
        : null,
      tieneModelo,
      generado: d.generado !== null,
      hojasMinimas: d.hojasMinimas,
    };
  }

  /** Documentos que le corresponden a la solicitud, con su estado, y las reglas de carga (RF-CAR-03). */
  async listar(solicitudId: number) {
    const { pool } = this.deps;
    const ctx = await caracterizacionRepo.contexto(pool, solicitudId);
    if (!ctx) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
    const [exigidos, vigentes, reemplazos, conModelo, reglas] = await Promise.all([
      this.requiereCuidador(solicitudId).then((c) => documentosSolicitudRepo.exigidos(pool, c)),
      documentosSolicitudRepo.vigentes(pool, solicitudId),
      documentosSolicitudRepo.conteoReemplazos(pool, solicitudId),
      modelosRepo.idsConModelo(pool),
      this.reglas(),
    ]);
    const edicion = await modoDeEdicion(pool, solicitudId, ctx.estado);
    const porDoc = new Map(vigentes.map((a) => [a.documentoId, a]));
    const documentos = exigidos.map((d) =>
      this.entrada(d, porDoc.get(d.id), reemplazos.get(d.id) ?? 0, conModelo.has(d.id)),
    );
    // Las cartas las genera el sistema al enviar la solicitud: no son algo que falte cargar.
    const obligatorios = documentos.filter((d) => d.obligatorio && !d.generado);
    return {
      editable: edicion.modo !== 'NINGUNO',
      // Con una subsanación vigente solo se cargan los documentos señalados.
      documentosEditables:
        edicion.modo === 'SUBSANACION'
          ? [...edicion.documentos]
          : edicion.modo === 'TODO'
            ? null
            : [],
      reglas: { formatos: reglas.formatos, maxMb: reglas.maxMb },
      documentos,
      resumen: {
        obligatorios: obligatorios.length,
        cargados: obligatorios.filter((d) => d.estado === 'CARGADO').length,
        completo: obligatorios.every((d) => d.estado === 'CARGADO'),
      },
    };
  }

  /** Documentos obligatorios que todavía no tienen un archivo vigente (los que impiden radicar). */
  async faltantes(solicitudId: number) {
    const lista = await this.listar(solicitudId);
    return lista.documentos.filter((d) => d.obligatorio && !d.generado && d.estado !== 'CARGADO');
  }

  /** Valida el archivo por su contenido real, su tamaño y los formatos vigentes. */
  private async validar(
    archivo: ArchivoEntrada,
    hojasMinimas = 1,
  ): Promise<{
    formato: FormatoDocumento;
    nombre: string;
  }> {
    const reglas = await this.reglas();
    const campo = 'archivo';
    if (archivo.contenido.length === 0) {
      throw errorValidacion([{ campo, mensaje: 'El archivo está vacío. Seleccione otro.' }]);
    }
    if (archivo.contenido.length > reglas.maxBytes) {
      throw errorValidacion([
        {
          campo,
          mensaje: `El archivo pesa ${formatearTamano(archivo.contenido.length)} y el máximo permitido es ${reglas.maxMb} MB. Reduzca su tamaño o tome una foto con menor calidad.`,
        },
      ]);
    }
    const formato = detectarFormato(archivo.contenido);
    const permitidos = `Solo se aceptan archivos ${listarFormatos(reglas.formatos)}.`;
    if (!formato || !reglas.formatos.includes(formato)) {
      throw errorValidacion([
        { campo, mensaje: `El formato del archivo no es válido. ${permitidos}` },
      ]);
    }
    const ext = extensionDe(archivo.nombre);
    if (ext && ext !== formato) {
      throw errorValidacion([
        {
          campo,
          mensaje: `El archivo no corresponde a su extensión (.${ext}): su contenido es ${formato.toUpperCase()}. Revise que sea el documento correcto.`,
        },
      ]);
    }
    if (hojasMinimas > 1) {
      if (formato !== 'pdf') {
        throw errorValidacion([
          {
            campo,
            mensaje: `Este documento debe tener ${hojasMinimas} hojas: cárguelo en un solo PDF que las incluya todas.`,
          },
        ]);
      }
      const hojas = await contarHojas(archivo.contenido);
      if (hojas === null) {
        throw errorValidacion([
          {
            campo,
            mensaje:
              'No pudimos leer el PDF para contar sus hojas. Revise que no esté dañado ni protegido con contraseña.',
          },
        ]);
      }
      if (hojas < hojasMinimas) {
        throw errorValidacion([
          {
            campo,
            mensaje: `El archivo tiene ${hojas} hoja(s) y este documento debe tener ${hojasMinimas}: cárguelo completo, con todas sus hojas en un solo PDF (por ejemplo, el certificado de discapacidad trae dos y la segunda lleva un código QR).`,
          },
        ]);
      }
    }
    return { formato, nombre: nombreSeguro(archivo.nombre) };
  }

  /**
   * Guarda un archivo de evidencia (excepciones de priorización, novedades, entregas): se valida por su contenido, se
   * cifra y se guarda con su hash. Quien llama conserva los datos devueltos junto a su registro.
   */
  async guardarEvidencia(carpeta: string, archivo: ArchivoEntrada): Promise<EvidenciaArchivo> {
    const { formato, nombre } = await this.validar(archivo);
    const sha256 = createHash('sha256').update(archivo.contenido).digest('hex');
    const ruta = this.almacen.nuevaClave(carpeta);
    await this.almacen.guardar(ruta, this.cipher.cifrarBytes(archivo.contenido));
    return { ruta, nombre, mime: MIME[formato], tamanoBytes: archivo.contenido.length, sha256 };
  }

  /** Entrega una evidencia descifrada y verificada contra su hash. */
  async leerEvidencia(e: EvidenciaArchivo) {
    const contenido = this.cipher.descifrarBytes(await this.almacen.leer(e.ruta));
    if (createHash('sha256').update(contenido).digest('hex') !== e.sha256) {
      throw new AppError(
        500,
        'INTEGRIDAD_DOCUMENTO',
        'El archivo no superó la verificación de integridad. Comuníquese con la Gerencia de Desarrollo Social.',
      );
    }
    return { nombre: e.nombre, mime: e.mime, contenido };
  }

  /** Carga o reemplaza el documento de la solicitud (RF-CAR-03). */
  async cargar(
    solicitudId: number,
    documentoId: number,
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const solicitud = await caracterizacionRepo.contexto(pool, solicitudId);
    if (!solicitud) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
    const edicionPrevia = await modoDeEdicion(pool, solicitudId, solicitud.estado);
    if (edicionPrevia.modo === 'NINGUNO') {
      throw conflict(
        'SOLICITUD_NO_EDITABLE',
        'La solicitud ya no admite cambios desde este formulario.',
      );
    }
    if (edicionPrevia.modo === 'SUBSANACION' && !edicionPrevia.documentos.has(documentoId)) {
      throw conflict(
        'DOCUMENTO_NO_SENALADO',
        'Solo puede cargar los documentos que se le pidió corregir.',
      );
    }
    const documento = await documentosSolicitudRepo.exigidoPorId(pool, documentoId);
    if (!documento || !documento.activo) {
      throw notFound('Ese documento no se solicita', 'DOCUMENTO_NO_ENCONTRADO');
    }
    if (documento.aplicaA === 'CUIDADOR' && !(await this.requiereCuidador(solicitudId))) {
      throw conflict(
        'DOCUMENTO_NO_APLICA',
        'Ese documento no se pide porque no requiere el servicio para el cuidador.',
      );
    }
    if (documento.generado) {
      throw conflict(
        'DOCUMENTO_GENERADO',
        'Ese documento lo genera el sistema con sus datos: no tiene que cargarlo.',
      );
    }
    const { formato, nombre } = await this.validar(archivo, documento.hojasMinimas);
    const sha256 = createHash('sha256').update(archivo.contenido).digest('hex');
    const ruta = this.almacen.nuevaClave(`solicitudes/${solicitudId}`);
    await this.almacen.guardar(ruta, this.cipher.cifrarBytes(archivo.contenido));

    await withTransaction(pool, async (tx) => {
      if (!(await caracterizacionRepo.bloquear(tx, solicitudId))) {
        throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      }
      const actual = await caracterizacionRepo.contexto(tx, solicitudId);
      const edicion = actual ? await modoDeEdicion(tx, solicitudId, actual.estado) : null;
      if (!edicion || edicion.modo === 'NINGUNO') {
        throw conflict(
          'SOLICITUD_NO_EDITABLE',
          'La solicitud ya no admite cambios desde este formulario.',
        );
      }
      if (edicion.modo === 'SUBSANACION' && !edicion.documentos.has(documentoId)) {
        throw conflict(
          'DOCUMENTO_NO_SENALADO',
          'Solo puede cargar los documentos que se le pidió corregir.',
        );
      }
      const r = await documentosSolicitudRepo.reemplazar(tx, {
        solicitudId,
        documentoId,
        nombreOriginal: nombre,
        formato,
        mime: MIME[formato],
        tamanoBytes: archivo.contenido.length,
        sha256,
        ruta,
        ip: ctx.ip,
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.DOCUMENTOS,
        accion: ACCION.DOCUMENTO_CARGADO,
        entidad: 'documento_solicitud',
        entidadId: r.id,
        solicitudId,
        valorNuevo: {
          documento: documento.codigo,
          archivo: nombre,
          formato,
          tamanoBytes: archivo.contenido.length,
          sha256,
        },
        detalle: { reemplazaA: r.reemplazaA },
        ip: ctx.ip,
      });
    });
    const lista = await this.listar(solicitudId);
    return lista.documentos.find((d) => d.id === documentoId);
  }

  // ---- cartas que genera el sistema con los datos del formulario

  private async construirCarta(
    solicitudId: number,
    tipo: 'CARTA_SOLICITUD' | 'CARTA_CUIDADO',
  ): Promise<{ carta: CartaGenerada; fecha: Date }> {
    const datos = await documentosSolicitudRepo.datosCartas(this.deps.pool, solicitudId);
    if (!datos) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
    return {
      carta: tipo === 'CARTA_SOLICITUD' ? cartaSolicitud(datos) : cartaCuidado(datos),
      fecha: datos.fecha ?? new Date(0),
    };
  }

  private async pdfDeCarta(solicitudId: number, tipo: 'CARTA_SOLICITUD' | 'CARTA_CUIDADO') {
    const { carta, fecha } = await this.construirCarta(solicitudId, tipo);
    return { carta, contenido: await renderCarta(carta, fecha) };
  }

  /** La carta tal como queda hoy con los datos escritos (para verla mientras se llena el formulario). */
  async vistaPreviaCarta(solicitudId: number, documentoId: number) {
    const documento = await documentosSolicitudRepo.exigidoPorId(this.deps.pool, documentoId);
    if (!documento?.activo || !documento.generado) {
      throw notFound('Ese documento no lo genera el sistema', 'DOCUMENTO_NO_GENERADO');
    }
    const { carta, contenido } = await this.pdfDeCarta(solicitudId, documento.generado);
    return { nombre: carta.archivo, mime: MIME.pdf, contenido };
  }

  /**
   * Genera y adjunta las cartas del sistema con los datos actuales. Si los datos no cambiaron, la carta vigente se
   * conserva; si cambiaron, la anterior queda como «reemplazada».
   */
  async generarCartas(solicitudId: number, ctx: ContextoPeticion): Promise<void> {
    const { pool } = this.deps;
    const exigidos = (
      await documentosSolicitudRepo.exigidos(pool, await this.requiereCuidador(solicitudId))
    ).filter((d) => d.generado);
    for (const d of exigidos) {
      const { carta, contenido } = await this.pdfDeCarta(solicitudId, d.generado!);
      const sha256 = createHash('sha256').update(contenido).digest('hex');
      const vigente = await documentosSolicitudRepo.vigente(pool, solicitudId, d.id);
      if (vigente?.sha256 === sha256) continue;
      const ruta = this.almacen.nuevaClave(`solicitudes/${solicitudId}`);
      await this.almacen.guardar(ruta, this.cipher.cifrarBytes(contenido));
      await withTransaction(pool, async (tx) => {
        const r = await documentosSolicitudRepo.reemplazar(tx, {
          solicitudId,
          documentoId: d.id,
          nombreOriginal: carta.archivo,
          formato: 'pdf',
          mime: MIME.pdf,
          tamanoBytes: contenido.length,
          sha256,
          ruta,
          ip: ctx.ip,
        });
        await bitacoraRepo.registrar(tx, {
          modulo: MODULO.DOCUMENTOS,
          accion: ACCION.DOCUMENTO_CARGADO,
          entidad: 'documento_solicitud',
          entidadId: r.id,
          solicitudId,
          valorNuevo: {
            documento: d.codigo,
            archivo: carta.archivo,
            formato: 'pdf',
            tamanoBytes: contenido.length,
            sha256,
          },
          detalle: { reemplazaA: r.reemplazaA, generadoPorElSistema: true },
          ip: ctx.ip,
        });
      });
    }
  }

  /** Entrega a la persona el archivo que cargó, descifrado y verificado contra su hash (RNF-06). */
  async descargar(solicitudId: number, documentoId: number) {
    const { pool } = this.deps;
    const archivo =
      (await documentosSolicitudRepo.vigente(pool, solicitudId, documentoId)) ??
      (await documentosSolicitudRepo.historial(pool, solicitudId, documentoId))[0];
    if (!archivo) throw notFound('Todavía no cargó ese documento', 'DOCUMENTO_NO_CARGADO');
    const contenido = this.cipher.descifrarBytes(await this.almacen.leer(archivo.ruta));
    if (createHash('sha256').update(contenido).digest('hex') !== archivo.sha256) {
      throw new AppError(
        500,
        'INTEGRIDAD_DOCUMENTO',
        'El documento no superó la verificación de integridad. Comuníquese con la Gerencia de Desarrollo Social.',
      );
    }
    return { nombre: archivo.nombreOriginal, mime: archivo.mime, contenido };
  }

  // ---- modelos de carta (RF-CAR-03)

  /** Modelo descargable de un documento, si la Gerencia lo publicó. */
  async modelo(documentoId: number) {
    const { pool } = this.deps;
    const modelo = await modelosRepo.porDocumento(pool, documentoId);
    if (!modelo) throw notFound('Ese documento no tiene un modelo para descargar', 'SIN_MODELO');
    const contenido = await this.almacen.leer(modelo.ruta);
    return { nombre: modelo.nombreOriginal, mime: modelo.mime, contenido };
  }

  /** La Gerencia publica o reemplaza el modelo de un documento (PDF, DOCX u ODT). */
  async guardarModelo(
    actorId: number,
    documentoId: number,
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const documento = await documentosSolicitudRepo.exigidoPorId(pool, documentoId);
    if (!documento) throw notFound('El documento no existe', 'DOCUMENTO_NO_ENCONTRADO');
    const campo = 'archivo';
    if (archivo.contenido.length === 0) {
      throw errorValidacion([{ campo, mensaje: 'El archivo está vacío. Seleccione otro.' }]);
    }
    if (archivo.contenido.length > MAX_MODELO_BYTES) {
      throw errorValidacion([
        {
          campo,
          mensaje: `El archivo pesa ${formatearTamano(archivo.contenido.length)} y el máximo para un modelo es 10 MB.`,
        },
      ]);
    }
    const formato = detectarFormatoModelo(archivo.contenido);
    if (!formato) {
      throw errorValidacion([
        { campo, mensaje: 'El formato no es válido. Solo se aceptan modelos en PDF, DOCX u ODT.' },
      ]);
    }
    const sha256 = createHash('sha256').update(archivo.contenido).digest('hex');
    const ruta = this.almacen.nuevaClave('modelos');
    await this.almacen.guardar(ruta, archivo.contenido);
    const anterior = await modelosRepo.porDocumento(pool, documentoId);
    const nombre = nombreSeguro(archivo.nombre);
    await withTransaction(pool, async (tx) => {
      await modelosRepo.guardar(tx, {
        documentoId,
        nombreOriginal: nombre,
        formato,
        mime: MIME_MODELO[formato],
        tamanoBytes: archivo.contenido.length,
        sha256,
        ruta,
        cargadoPor: actorId,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actorId,
        modulo: MODULO.DOCUMENTOS,
        accion: ACCION.MODELO_DOCUMENTO_GUARDADO,
        entidad: 'documento_requerido',
        entidadId: documentoId,
        valorAnterior: anterior
          ? { archivo: anterior.nombreOriginal, sha256: anterior.sha256 }
          : null,
        valorNuevo: { archivo: nombre, formato, sha256 },
        ip: ctx.ip,
      });
    });
    return { documentoId, nombre, formato, tamanoBytes: archivo.contenido.length };
  }
}
