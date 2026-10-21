import { createHash, randomBytes } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import {
  erroresDePreguntas,
  indicadorSatisfaccion,
  resumirResultados,
  validarRespuestas,
  type DatosPregunta,
  type Respuestas,
} from '../domain/encuestas.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { encuestasRepo, type Encuesta } from '../infrastructure/repositories/encuestas.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import { errorValidacion } from './esquemas.js';

const FECHA = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export interface DatosEncuesta {
  titulo: string;
  descripcion: string;
  desde: string;
  hasta: string;
  preguntas: DatosPregunta[];
}

const vista = (e: Encuesta) => ({
  id: e.id,
  titulo: e.titulo,
  descripcion: e.descripcion,
  estado: e.estado,
  vigenteDesde: e.vigenteDesde,
  vigenteHasta: e.vigenteHasta,
  creadaPor: e.creadaPor,
  creadaAt: e.creadaAt.toISOString(),
  publicadaAt: e.publicadaAt?.toISOString() ?? null,
  cerradaAt: e.cerradaAt?.toISOString() ?? null,
  invitadas: e.invitadas,
  respondidas: e.respondidas,
});

/**
 * Encuestas de satisfacción (RF-NOV-04): el administrador las configura, al publicarlas se invita por correo a los
 * beneficiarios activos con un enlace personal, nadie responde dos veces y los resultados se analizan sin identificar a
 * quien respondió: la identidad vive solo en la invitación y las respuestas no la referencian.
 */
export class ServicioEncuestas {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
  ) {}

  private validar(d: DatosEncuesta): void {
    const errores = erroresDePreguntas(d.preguntas);
    if (d.titulo.trim().length < 5)
      errores.push({ campo: 'titulo', mensaje: 'Título: escriba al menos 5 caracteres' });
    if (d.hasta < d.desde) {
      errores.push({
        campo: 'hasta',
        mensaje: 'Vigente hasta: no puede ser anterior a la fecha de inicio',
      });
    }
    if (errores.length > 0) throw errorValidacion(errores);
  }

  async listar() {
    return (await encuestasRepo.listar(this.deps.pool)).map(vista);
  }

  async obtener(id: number) {
    const { pool } = this.deps;
    const e = await encuestasRepo.porId(pool, id);
    if (!e) throw notFound('La encuesta no existe', 'ENCUESTA_NO_ENCONTRADA');
    return { ...vista(e), preguntas: await encuestasRepo.preguntas(pool, id) };
  }

  async crear(actor: Actor, d: DatosEncuesta, ctx: ContextoPeticion) {
    this.validar(d);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const nuevo = await encuestasRepo.crear(tx, {
        titulo: d.titulo.trim(),
        descripcion: d.descripcion.trim(),
        desde: d.desde,
        hasta: d.hasta,
        usuarioId: actor.id,
      });
      await encuestasRepo.reemplazarPreguntas(tx, nuevo, d.preguntas);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ENCUESTAS,
        accion: ACCION.ENCUESTA_CREADA,
        entidad: 'encuesta',
        entidadId: nuevo,
        valorNuevo: { titulo: d.titulo.trim(), preguntas: d.preguntas.length },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return this.obtener(id);
  }

  async actualizar(actor: Actor, id: number, d: DatosEncuesta, ctx: ContextoPeticion) {
    this.validar(d);
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const e = await encuestasRepo.porId(tx, id, true);
      if (!e) throw notFound('La encuesta no existe', 'ENCUESTA_NO_ENCONTRADA');
      if (e.estado !== 'BORRADOR') {
        throw conflict('ENCUESTA_NO_EDITABLE', 'Solo se puede modificar una encuesta en borrador.');
      }
      await encuestasRepo.actualizar(tx, id, {
        titulo: d.titulo.trim(),
        descripcion: d.descripcion.trim(),
        desde: d.desde,
        hasta: d.hasta,
      });
      await encuestasRepo.reemplazarPreguntas(tx, id, d.preguntas);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ENCUESTAS,
        accion: ACCION.ENCUESTA_MODIFICADA,
        entidad: 'encuesta',
        entidadId: id,
        valorAnterior: { titulo: e.titulo },
        valorNuevo: { titulo: d.titulo.trim(), preguntas: d.preguntas.length },
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /** Publica la encuesta e invita por correo a cada beneficiario activo con su enlace personal. */
  async publicar(actor: Actor, id: number, ctx: ContextoPeticion) {
    const resultado = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const e = await encuestasRepo.porId(tx, id, true);
      if (!e) throw notFound('La encuesta no existe', 'ENCUESTA_NO_ENCONTRADA');
      if (e.estado !== 'BORRADOR')
        throw conflict('ENCUESTA_YA_PUBLICADA', 'La encuesta ya se publicó.');
      const hoy = (await tx.query<{ d: string }>(`SELECT to_char(hoy_bogota(), 'YYYY-MM-DD') AS d`))
        .rows[0]!.d;
      if (e.vigenteHasta < hoy) {
        throw errorValidacion([
          {
            campo: 'hasta',
            mensaje: 'Vigente hasta: la fecha ya pasó, corríjala antes de publicar',
          },
        ]);
      }
      const preguntas = await encuestasRepo.preguntas(tx, id);
      if (preguntas.length === 0) {
        throw errorValidacion([
          { campo: 'preguntas', mensaje: 'Preguntas: agregue al menos una antes de publicar' },
        ]);
      }
      await encuestasRepo.fijarEstado(tx, id, 'PUBLICADA');
      const activos = await encuestasRepo.beneficiosActivos(tx);
      let invitados = 0;
      for (const b of activos) {
        const token = randomBytes(32).toString('base64url');
        if (!(await encuestasRepo.invitar(tx, id, b.beneficioId, sha256(token)))) continue;
        await this.correos.encolar(tx, {
          solicitudId: b.solicitudId,
          tipo: 'ENCUESTA_INVITACION',
          destinatario: b.correo,
          datos: {
            nombre: b.nombre,
            tituloEncuesta: e.titulo,
            fechaLimite: FECHA.format(new Date(`${e.vigenteHasta}T00:00:00Z`)),
            enlaceEncuesta: `${this.deps.env.frontendUrl}/encuesta?token=${token}`,
          },
        });
        invitados++;
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ENCUESTAS,
        accion: ACCION.ENCUESTA_PUBLICADA,
        entidad: 'encuesta',
        entidadId: id,
        valorAnterior: { estado: 'BORRADOR' },
        valorNuevo: { estado: 'PUBLICADA', invitados },
        ip: ctx.ip,
      });
      return invitados;
    });
    this.correos.despachar();
    return { ...(await this.obtener(id)), invitadosAhora: resultado };
  }

  async cerrar(actor: Actor, id: number, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const e = await encuestasRepo.porId(tx, id, true);
      if (!e) throw notFound('La encuesta no existe', 'ENCUESTA_NO_ENCONTRADA');
      if (e.estado !== 'PUBLICADA')
        throw conflict('ENCUESTA_NO_PUBLICADA', 'Solo se cierra una encuesta publicada.');
      await encuestasRepo.fijarEstado(tx, id, 'CERRADA');
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ENCUESTAS,
        accion: ACCION.ENCUESTA_CERRADA,
        entidad: 'encuesta',
        entidadId: id,
        valorAnterior: { estado: 'PUBLICADA' },
        valorNuevo: { estado: 'CERRADA' },
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /** Resultados anonimizados: conteos, promedios y textos sin identificar, y el indicador de satisfacción. */
  async resultados(id: number) {
    const { pool } = this.deps;
    const e = await encuestasRepo.porId(pool, id);
    if (!e) throw notFound('La encuesta no existe', 'ENCUESTA_NO_ENCONTRADA');
    const [preguntas, filas] = await Promise.all([
      encuestasRepo.preguntas(pool, id),
      encuestasRepo.respuestas(pool, id),
    ]);
    const respuestas = filas.map((f) => f.respuestas);
    const porLocalidad = new Map<string, number>();
    for (const f of filas)
      porLocalidad.set(
        f.localidad ?? 'Sin localidad',
        (porLocalidad.get(f.localidad ?? 'Sin localidad') ?? 0) + 1,
      );
    return {
      encuesta: vista(e),
      invitadas: e.invitadas,
      respondidas: filas.length,
      tasaRespuesta: e.invitadas > 0 ? Math.round((filas.length / e.invitadas) * 1000) / 10 : null,
      satisfaccion: indicadorSatisfaccion(preguntas, respuestas),
      porLocalidad: [...porLocalidad].map(([localidad, cantidad]) => ({ localidad, cantidad })),
      preguntas: resumirResultados(preguntas, respuestas),
    };
  }

  // ---------------------------------------------------------------- respuesta de la persona

  private async abrir(token: string) {
    const { pool } = this.deps;
    const inv = await encuestasRepo.invitacion(pool, sha256(token));
    if (!inv) throw notFound('El enlace de la encuesta no es válido', 'ENCUESTA_ENLACE_INVALIDO');
    const e = await encuestasRepo.porId(pool, inv.encuestaId);
    if (!e) throw notFound('El enlace de la encuesta no es válido', 'ENCUESTA_ENLACE_INVALIDO');
    return { inv, e };
  }

  private async estadoDisponible(e: Encuesta, respondida: boolean): Promise<void> {
    if (respondida)
      throw conflict(
        'ENCUESTA_YA_RESPONDIDA',
        'Ya respondió esta encuesta. ¡Gracias por su opinión!',
      );
    const hoy = (
      await this.deps.pool.query<{ d: string }>(`SELECT to_char(hoy_bogota(), 'YYYY-MM-DD') AS d`)
    ).rows[0]!.d;
    if (e.estado !== 'PUBLICADA' || hoy < e.vigenteDesde || hoy > e.vigenteHasta) {
      throw conflict('ENCUESTA_CERRADA', 'Esta encuesta ya no está disponible para responder.');
    }
  }

  /** Lo que ve la persona con su enlace: la encuesta y sus preguntas, si todavía puede responderla. */
  async paraResponder(token: string) {
    const { inv, e } = await this.abrir(token);
    await this.estadoDisponible(e, inv.respondida);
    return {
      titulo: e.titulo,
      descripcion: e.descripcion,
      vigenteHasta: e.vigenteHasta,
      preguntas: await encuestasRepo.preguntas(this.deps.pool, e.id),
    };
  }

  /** Guarda las respuestas sin identificar y marca la invitación: una sola respuesta por beneficiario. */
  async responder(token: string, crudo: Respuestas, ctx: ContextoPeticion) {
    const { pool } = this.deps;
    await withTransaction(pool, async (tx) => {
      const inv = await encuestasRepo.invitacion(tx, sha256(token), true);
      if (!inv) throw notFound('El enlace de la encuesta no es válido', 'ENCUESTA_ENLACE_INVALIDO');
      const e = (await encuestasRepo.porId(tx, inv.encuestaId)) as Encuesta;
      await this.estadoDisponible(e, inv.respondida);
      const preguntas = await encuestasRepo.preguntas(tx, e.id);
      const { respuestas, errores } = validarRespuestas(preguntas, crudo);
      if (errores.length > 0) throw errorValidacion(errores);
      await encuestasRepo.guardarRespuesta(
        tx,
        e.id,
        await encuestasRepo.localidadDeBeneficio(tx, inv.beneficioId),
        respuestas,
      );
      await encuestasRepo.marcarRespondida(tx, e.id, inv.beneficioId);
      // La bitácora registra que hubo una respuesta, no quién la dio.
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.ENCUESTAS,
        accion: ACCION.ENCUESTA_RESPONDIDA,
        entidad: 'encuesta',
        entidadId: e.id,
        ip: ctx.ip,
      });
    });
  }
}
