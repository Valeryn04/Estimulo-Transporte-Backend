import { ACCION, MODULO } from '../domain/acciones.js';
import { codigoDesdeNombre } from '../domain/texto.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { rolesRepo, type DatosRol, type RolFila } from '../infrastructure/repositories/roles.js';
import { usuariosRepo } from '../infrastructure/repositories/usuarios.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** El rol del administrador conserva siempre todos los permisos: nadie puede dejar el sistema sin quién lo administre. */
const ROL_ADMINISTRADOR = 'ADMINISTRADOR';

function traducirUnicidad(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505') {
    throw errorValidacion([
      { campo: 'nombre', mensaje: 'Nombre: ya existe un rol con ese nombre o muy parecido' },
    ]);
  }
  throw error;
}

const resumen = (r: RolFila) => ({
  nombre: r.nombre,
  descripcion: r.descripcion,
  permisos: r.permisos,
});

/**
 * Roles y permisos (RF-ADM-01). Los roles del documento vienen de fábrica y no se eliminan ni se renombran; el
 * administrador puede crear roles propios y elegir qué permisos tiene cada uno. Cada usuario tiene un solo rol, y un
 * cambio en los permisos de un rol se aplica de inmediato a quienes lo tienen.
 */
export class ServicioRoles {
  constructor(private readonly deps: Dependencias) {}

  listar() {
    return rolesRepo.listar(this.deps.pool);
  }

  permisos() {
    return rolesRepo.permisos(this.deps.pool);
  }

  private async validarPermisos(permisos: string[]): Promise<void> {
    const conocidos = new Set((await rolesRepo.permisos(this.deps.pool)).map((p) => p.codigo));
    if (permisos.some((p) => !conocidos.has(p))) {
      throw errorValidacion([
        { campo: 'permisos', mensaje: 'Permisos: hay un permiso que no existe' },
      ]);
    }
  }

  async crear(actor: Actor, d: DatosRol, ctx: ContextoPeticion): Promise<RolFila> {
    await this.validarPermisos(d.permisos);
    let codigo = codigoDesdeNombre(d.nombre, '', 40);
    if (codigo.length < 3) codigo = `ROL_${codigo}`.slice(0, 40);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      let nuevo: number;
      try {
        nuevo = await rolesRepo.crear(tx, codigo, d);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ROLES,
        accion: ACCION.ROL_CREADO,
        entidad: 'rol',
        entidadId: nuevo,
        valorNuevo: { codigo, ...d, permisos: [...d.permisos].sort() },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return (await rolesRepo.porId(this.deps.pool, id)) as RolFila;
  }

  async actualizar(actor: Actor, id: number, d: DatosRol, ctx: ContextoPeticion): Promise<RolFila> {
    await this.validarPermisos(d.permisos);
    await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      const actual = await rolesRepo.porId(tx, id);
      if (!actual) throw notFound('El rol no existe', 'ROL_NO_ENCONTRADO');
      if (actual.codigo === ROL_ADMINISTRADOR) {
        throw conflict(
          'ROL_PROTEGIDO',
          'El rol de administrador no se puede modificar: siempre tiene todos los permisos.',
        );
      }
      if (actual.sistema && d.nombre.trim() !== actual.nombre) {
        throw errorValidacion([
          {
            campo: 'nombre',
            mensaje: 'Nombre: el nombre de un rol del sistema no se puede cambiar',
          },
        ]);
      }
      try {
        await rolesRepo.actualizar(tx, id, d, !actual.sistema);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ROLES,
        accion: ACCION.ROL_MODIFICADO,
        entidad: 'rol',
        entidadId: id,
        valorAnterior: resumen(actual),
        valorNuevo: { ...d, permisos: [...d.permisos].sort() },
        detalle: { usuariosAfectados: actual.usuarios },
        ip: ctx.ip,
      });
    });
    return (await rolesRepo.porId(this.deps.pool, id)) as RolFila;
  }

  async eliminar(actor: Actor, id: number, ctx: ContextoPeticion): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      const actual = await rolesRepo.porId(tx, id);
      if (!actual) throw notFound('El rol no existe', 'ROL_NO_ENCONTRADO');
      if (actual.sistema) {
        throw conflict('ROL_DEL_SISTEMA', 'Los roles del sistema no se pueden eliminar.');
      }
      if (actual.usuarios > 0) {
        throw conflict(
          'ROL_EN_USO',
          `El rol lo tienen ${actual.usuarios} usuario${actual.usuarios === 1 ? '' : 's'}: cámbieles el rol antes de eliminarlo.`,
        );
      }
      await rolesRepo.eliminar(tx, id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ROLES,
        accion: ACCION.ROL_ELIMINADO,
        entidad: 'rol',
        entidadId: id,
        valorAnterior: { codigo: actual.codigo, ...resumen(actual) },
        ip: ctx.ip,
      });
    });
  }
}
