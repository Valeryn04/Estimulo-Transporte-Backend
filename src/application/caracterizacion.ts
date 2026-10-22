import { ACCION, MODULO } from '../domain/acciones.js';
import {
  CAMPOS,
  CATALOGO_DE_CAMPO,
  aplicarDependencias,
  calcularAvance,
  datosVacios,
  erroresDeConsistencia,
  type CampoDato,
  type DatosCaracterizacion,
  type ErrorCampo,
} from '../domain/caracterizacion.js';
import { ESTADOS } from '../domain/estados.js';
import { modoDeEdicion, vistaSubsanacion } from './subsanacion.js';
import { normalizarNombre } from '../domain/identificacion.js';
import { memoriaPublica } from '../infrastructure/cache.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import {
  caracterizacionRepo,
  correccionesRepo,
  type ItemCorreccion,
} from '../infrastructure/repositories/caracterizacion.js';
import { solicitudesRepo, type ItemPublico } from '../infrastructure/repositories/solicitudes.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { conflict, notFound } from '../shared/errors.js';
import { errorValidacion } from './esquemas.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';

/** Catálogos del formulario, con el nombre con que se envían a la pantalla. */
const CATALOGOS_FORMULARIO = {
  generos: 'GENERO',
  estadosCiviles: 'ESTADO_CIVIL',
  etnias: 'ETNIA',
  escolaridades: 'ESCOLARIDAD',
  ocupaciones: 'OCUPACION',
  eps: 'EPS',
  tiposTransporte: 'TIPO_TRANSPORTE',
} as const;

/** Lo que envía la pantalla al guardar: la versión que vio y solo los campos que cambiaron. */
export type CambiosCaracterizacion = Partial<DatosCaracterizacion> & {
  version: number;
  pcdNombre?: string;
  cuidadorNombre?: string;
};

/** La fecha de hoy en Barranquilla (AAAA-MM-DD), con el reloj de la aplicación. */
function hoyBogota(ahora: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(ahora);
}

/**
 * Caracterización de la persona con discapacidad y del cuidador (RF-CAR-01, RF-CAR-02) con guardado de avance
 * (RF-CAR-04). El ciudadano entra con la sesión que le da el enlace seguro del correo o el código de un solo uso, y
 * solo puede ver y editar su propia solicitud.
 */
export class ServicioCaracterizacion {
  private readonly cipher: DataCipher;

  constructor(private readonly deps: Dependencias) {
    this.cipher = new DataCipher(deps.env.encryption);
  }

  /** Formulario con los datos precargados de la preinscripción, lo ya guardado y el avance por secciones. */
  async obtener(solicitudId: number) {
    const { pool } = this.deps;
    const ctx = await caracterizacionRepo.contexto(pool, solicitudId);
    if (!ctx) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
    const guardada = await caracterizacionRepo.obtener(pool, solicitudId, this.cipher);
    const datos = guardada?.datos ?? datosVacios();
    // Sin cuidador registrado no hay pregunta sobre el servicio para el cuidador: la respuesta es «no».
    if (!ctx.cuidador) datos.requiereCuidador = false;
    const d = ESTADOS[ctx.estado];
    return {
      solicitud: {
        vigencia: ctx.anio,
        estado: { codigo: ctx.estado, nombre: d.nombre },
        editable: (await modoDeEdicion(pool, solicitudId, ctx.estado)).modo !== 'NINGUNO',
        explicacion: d.explicacion,
        siguientePaso: d.siguientePaso,
        radicado: ctx.radicado,
        radicadaAt: ctx.radicadaAt?.toISOString() ?? null,
      },
      pcd: {
        nombre: ctx.pcd.nombre,
        tipoIdentificacion: { codigo: ctx.pcd.tipoCodigo, nombre: ctx.pcd.tipoNombre },
        numero: ctx.pcd.numero,
        correo: ctx.correo,
      },
      cuidador: ctx.cuidador
        ? {
            nombre: ctx.cuidador.nombre,
            tipoIdentificacion: {
              codigo: ctx.cuidador.tipoCodigo,
              nombre: ctx.cuidador.tipoNombre,
            },
            numero: ctx.cuidador.numero,
            nombreEditable: !ctx.cuidadorEnOtrasSolicitudes,
          }
        : null,
      datos,
      subsanacion: await vistaSubsanacion(pool, solicitudId),
      avance: calcularAvance(datos),
      version: guardada?.version ?? 0,
      guardadoAt: guardada?.updatedAt.toISOString() ?? null,
      catalogos: await this.catalogos(datos),
    };
  }

  private async catalogos(datos: DatosCaracterizacion) {
    const { pool } = this.deps;
    // Las listas se leen una vez cada pocos segundos para todos; cada petición trabaja con su propia copia.
    const base = await memoriaPublica.obtener('catalogos-caracterizacion', async () => {
      const r: Record<string, ItemPublico[]> = {};
      for (const [nombre, catalogo] of Object.entries(CATALOGOS_FORMULARIO)) {
        r[nombre] = await solicitudesRepo.catalogoActivo(pool, catalogo);
      }
      return r;
    });
    const resultado: Record<string, ItemPublico[]> = Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, [...v]]),
    );
    // Una opción que ya se eligió y luego se desactivó se sigue mostrando, para no perder lo diligenciado.
    const elegidos = (CAMPOS.filter((c) => c in CATALOGO_DE_CAMPO) as CampoDato[])
      .map((c) => datos[c])
      .filter((v): v is number => typeof v === 'number');
    const conocidos = new Set(Object.values(resultado).flatMap((l) => l.map((i) => i.id)));
    const faltan = elegidos.filter((id) => !conocidos.has(id));
    for (const item of await caracterizacionRepo.itemsPorId(pool, faltan)) {
      const nombre = Object.entries(CATALOGOS_FORMULARIO).find(([, c]) => c === item.catalogo)?.[0];
      if (nombre) {
        resultado[nombre]?.push({
          id: item.id,
          codigo: item.codigo,
          nombre: item.nombre,
          padreId: null,
        });
      }
    }
    return resultado as Record<keyof typeof CATALOGOS_FORMULARIO, ItemPublico[]>;
  }

  /**
   * Guarda el avance. Acepta datos incompletos (se puede retomar después) pero rechaza los que están mal escritos o
   * son incoherentes entre sí. Si nada cambió no crea una versión nueva, de modo que guardar de más es inofensivo.
   */
  async guardar(solicitudId: number, cambios: CambiosCaracterizacion, ctx: ContextoPeticion) {
    const { pool, ahora } = this.deps;
    await withTransaction(pool, async (tx) => {
      if (!(await caracterizacionRepo.bloquear(tx, solicitudId))) {
        throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      }
      const solicitud = await caracterizacionRepo.contexto(tx, solicitudId);
      if (!solicitud) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      const edicion = await modoDeEdicion(tx, solicitudId, solicitud.estado);
      if (edicion.modo === 'NINGUNO') {
        throw conflict(
          'SOLICITUD_NO_EDITABLE',
          'La solicitud ya no admite cambios desde este formulario.',
        );
      }
      if (edicion.modo === 'SUBSANACION') {
        // Con una subsanación vigente solo se modifica lo que el validador señaló (RF-CAR-06).
        const noPermitidos = [
          ...CAMPOS.filter((c) => c in cambios && !edicion.campos.has(c)),
          ...(['pcdNombre', 'cuidadorNombre'] as const).filter(
            (c) => c in cambios && cambios[c] !== undefined,
          ),
        ];
        if (noPermitidos.length > 0) {
          throw errorValidacion(
            noPermitidos.map((c) => ({
              campo: c,
              mensaje: 'Solo puede modificar lo que se le pidió corregir.',
            })),
          );
        }
      }
      const guardada = await caracterizacionRepo.obtener(tx, solicitudId, this.cipher);
      const versionActual = guardada?.version ?? 0;
      if (cambios.version !== versionActual) {
        throw conflict(
          'CONFLICTO_VERSION',
          'La información cambió en otra ventana o dispositivo. Recargue la página para ver lo último guardado.',
          { versionActual },
        );
      }
      const actual = guardada?.datos ?? datosVacios();
      const errores: ErrorCampo[] = [];

      // Se parte de lo guardado y se aplican solo los campos enviados.
      const enviados = CAMPOS.filter((c) => c in cambios);
      const combinado = { ...actual } as unknown as Record<string, unknown>;
      for (const c of enviados) {
        combinado[c] = (cambios as unknown as Record<string, unknown>)[c] ?? null;
      }
      if (
        cambios.hijosEdades &&
        cambios.hijosCantidad !== null &&
        cambios.hijosCantidad !== undefined &&
        cambios.hijosEdades.length !== cambios.hijosCantidad
      ) {
        errores.push({
          campo: 'hijosEdades',
          mensaje: 'Edades de los hijos: escriba una edad por cada hijo',
        });
      }
      // Sin cuidador registrado no hay servicio para el cuidador.
      if (!solicitud.cuidador) combinado.requiereCuidador = false;
      const datos = aplicarDependencias(combinado as unknown as DatosCaracterizacion);

      // Las listas son cerradas: solo se acepta una opción activa del catálogo (RNF-10).
      for (const c of enviados) {
        const catalogo = CATALOGO_DE_CAMPO[c];
        const valor = datos[c];
        if (!catalogo || typeof valor !== 'number' || valor === actual[c]) continue;
        if (!(await solicitudesRepo.itemActivo(tx, valor, catalogo))) {
          errores.push({ campo: c, mensaje: 'Elija una opción de la lista' });
        }
      }

      let generoCodigo: string | undefined;
      if (datos.generoId !== null) {
        generoCodigo = (await caracterizacionRepo.itemsPorId(tx, [datos.generoId]))[0]?.codigo;
      }
      errores.push(...erroresDeConsistencia(datos, { generoCodigo, hoy: hoyBogota(ahora()) }));

      // Los nombres viven en la persona: se corrigen conservando el historial (RNF-10).
      const correcciones: { personaId: number; cambio: ItemCorreccion }[] = [];
      if (cambios.pcdNombre !== undefined) {
        const nuevo = normalizarNombre(cambios.pcdNombre);
        if (nuevo !== solicitud.pcd.nombre) {
          correcciones.push({
            personaId: solicitud.pcd.id,
            cambio: { campo: 'nombre_completo', anterior: solicitud.pcd.nombre, nuevo },
          });
        }
      }
      if (cambios.cuidadorNombre !== undefined && solicitud.cuidador) {
        const nuevo = normalizarNombre(cambios.cuidadorNombre);
        if (nuevo !== solicitud.cuidador.nombre) {
          if (solicitud.cuidadorEnOtrasSolicitudes) {
            errores.push({
              campo: 'cuidadorNombre',
              mensaje:
                'Nombre del cuidador: no se puede cambiar desde este formulario porque esa persona ya figura en otra solicitud. Si hay un error, comuníquese con la Gerencia de Desarrollo Social',
            });
          } else {
            correcciones.push({
              personaId: solicitud.cuidador.id,
              cambio: { campo: 'nombre_completo', anterior: solicitud.cuidador.nombre, nuevo },
            });
          }
        }
      }
      if (errores.length > 0) throw errorValidacion(errores);

      const campos = CAMPOS.filter((c) => JSON.stringify(datos[c]) !== JSON.stringify(actual[c]));
      if (campos.length === 0 && correcciones.length === 0) return;

      for (const { personaId, cambio } of correcciones) {
        await caracterizacionRepo.actualizarNombrePersona(tx, personaId, cambio.nuevo as string);
        await correccionesRepo.registrar(
          tx,
          {
            solicitudId,
            entidad: 'persona',
            entidadId: personaId,
            cambios: [cambio],
            usuarioId: null,
            ip: ctx.ip,
          },
          this.cipher,
        );
      }
      if (campos.length > 0 || versionActual === 0) {
        const r = await caracterizacionRepo.guardar(
          tx,
          solicitudId,
          datos,
          versionActual,
          this.cipher,
        );
        if (!r) {
          throw conflict(
            'CONFLICTO_VERSION',
            'La información cambió en otra ventana o dispositivo. Recargue la página para ver lo último guardado.',
          );
        }
      }
      // La bitácora registra qué campos cambiaron, no sus valores: los datos sensibles no se copian.
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.CARACTERIZACION,
        accion: ACCION.CARACTERIZACION_GUARDADA,
        entidad: 'solicitud',
        entidadId: solicitudId,
        solicitudId,
        detalle: {
          campos: [
            ...campos,
            ...correcciones.map((c) =>
              c.personaId === solicitud.pcd.id ? 'pcdNombre' : 'cuidadorNombre',
            ),
          ],
        },
        ip: ctx.ip,
      });
    });
    const r = await this.obtener(solicitudId);
    return {
      version: r.version,
      guardadoAt: r.guardadoAt,
      datos: r.datos,
      avance: r.avance,
      pcdNombre: r.pcd.nombre,
      cuidadorNombre: r.cuidador?.nombre ?? null,
    };
  }

  /** Cuántas otras solicitudes de la vigencia tienen al mismo cuidador (RF-CAR-02). */
  async otrasSolicitudesDelCuidador(solicitudId: number): Promise<number> {
    return caracterizacionRepo.otrasSolicitudesDelCuidador(this.deps.pool, solicitudId);
  }

  /** Historial de correcciones de la solicitud (RNF-10). */
  async correcciones(solicitudId: number) {
    return correccionesRepo.porSolicitud(this.deps.pool, solicitudId, this.cipher);
  }
}
