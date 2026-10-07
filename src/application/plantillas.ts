import { ACCION, MODULO } from '../domain/acciones.js';
import {
  VARIABLES,
  renderizarVistaPrevia,
  validarPlantilla,
  valoresDeEjemplo,
  variablesUsadas,
} from '../domain/correos.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { plantillasRepo } from '../infrastructure/repositories/plantillas.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Plantillas de correo configurables, con variables, vista previa y versiones (RF-COM-02). */
export class ServicioPlantillas {
  constructor(private readonly deps: Dependencias) {}

  listar() {
    return plantillasRepo.listar(this.deps.pool);
  }

  async obtener(codigo: string) {
    const plantilla = await plantillasRepo.porCodigo(this.deps.pool, codigo);
    if (!plantilla) throw notFound('La plantilla no existe', 'PLANTILLA_NO_ENCONTRADA');
    const versiones = await plantillasRepo.versiones(this.deps.pool, codigo);
    return {
      ...plantilla,
      variables: plantilla.variablesPermitidas.map((v) => ({
        nombre: v,
        descripcion: VARIABLES[v]?.descripcion ?? '',
        obligatoria: plantilla.variablesObligatorias.includes(v),
      })),
      vigente: versiones[0] as (typeof versiones)[number],
      versiones,
    };
  }

  /** Vista previa con datos de ejemplo. Señala los problemas sin impedir ver el resultado. */
  async vistaPrevia(codigo: string, d: { asunto: string; cuerpo: string }) {
    const plantilla = await plantillasRepo.porCodigo(this.deps.pool, codigo);
    if (!plantilla) throw notFound('La plantilla no existe', 'PLANTILLA_NO_ENCONTRADA');
    const ejemplo = valoresDeEjemplo();
    return {
      asunto: renderizarVistaPrevia(d.asunto, ejemplo, true),
      cuerpo: renderizarVistaPrevia(d.cuerpo, ejemplo),
      variablesUsadas: variablesUsadas(`${d.asunto}\n${d.cuerpo}`),
      problemas: validarPlantilla(
        {
          permitidas: plantilla.variablesPermitidas,
          obligatorias: plantilla.variablesObligatorias,
        },
        d.asunto,
        d.cuerpo,
      ),
    };
  }

  async nuevaVersion(
    actor: Actor,
    codigo: string,
    d: { asunto: string; cuerpo: string; justificacion: string | null },
    ctx: ContextoPeticion,
  ) {
    const plantilla = await plantillasRepo.porCodigo(this.deps.pool, codigo);
    if (!plantilla) throw notFound('La plantilla no existe', 'PLANTILLA_NO_ENCONTRADA');
    const problemas = validarPlantilla(
      { permitidas: plantilla.variablesPermitidas, obligatorias: plantilla.variablesObligatorias },
      d.asunto,
      d.cuerpo,
    );
    if (problemas.length > 0) {
      throw errorValidacion(problemas.map((mensaje) => ({ campo: 'cuerpo', mensaje })));
    }
    const version = await withTransaction(this.deps.pool, async (tx) => {
      const actual = (await plantillasRepo.versiones(tx, codigo))[0];
      if (actual && actual.asunto === d.asunto && actual.cuerpo === d.cuerpo) {
        throw conflict('SIN_CAMBIO', 'El texto es igual al de la versión vigente');
      }
      const nueva = await plantillasRepo.crearVersion(tx, { codigo, ...d, usuarioId: actor.id });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PLANTILLAS,
        accion: ACCION.PLANTILLA_VERSION_CREADA,
        entidad: 'plantilla_correo',
        entidadId: codigo,
        valorAnterior: actual ? { version: actual.version, asunto: actual.asunto } : null,
        valorNuevo: { version: nueva, asunto: d.asunto },
        justificacion: d.justificacion,
        ip: ctx.ip,
      });
      return nueva;
    });
    return { version };
  }
}
