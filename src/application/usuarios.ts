import { ACCION, MODULO } from '../domain/acciones.js';
import { validarPassword } from '../domain/passwords.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { rolesRepo } from '../infrastructure/repositories/roles.js';
import {
  usuariosRepo,
  type EstadoUsuario,
  type FiltroUsuarios,
  type RolAsignado,
  type UsuarioFila,
} from '../infrastructure/repositories/usuarios.js';
import { hashPassword } from '../infrastructure/security/passwords.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Código del rol que no puede perder el administrador principal. */
const ROL_ADMINISTRADOR = 'ADMINISTRADOR';

export interface UsuarioVista {
  id: number;
  usuario: string;
  nombres: string;
  correo: string;
  estado: EstadoUsuario;
  bloqueoTemporalHasta: string | null;
  debeCambiarPassword: boolean;
  protegido: boolean;
  ultimoLoginAt: string | null;
  creadoAt: string;
  rol: RolAsignado | null;
}

export interface DatosUsuario {
  nombres: string;
  correo: string;
  rolId: number;
}

function vista(u: UsuarioFila, rol: RolAsignado | null, ahora: Date): UsuarioVista {
  const bloqueoTemporal = u.bloqueadoHasta && u.bloqueadoHasta.getTime() > ahora.getTime();
  return {
    id: u.id,
    usuario: u.usuario,
    nombres: u.nombres,
    correo: u.correo,
    estado: u.estado,
    bloqueoTemporalHasta: bloqueoTemporal ? (u.bloqueadoHasta as Date).toISOString() : null,
    debeCambiarPassword: u.debeCambiarPassword,
    protegido: u.protegido,
    ultimoLoginAt: u.ultimoLoginAt?.toISOString() ?? null,
    creadoAt: u.createdAt.toISOString(),
    rol,
  };
}

/** Traduce las violaciones de unicidad de PostgreSQL a errores de campo comprensibles. */
function traducirUnicidad(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505') {
    if (e.constraint === 'uq_usuarios_usuario') {
      throw errorValidacion([
        { campo: 'usuario', mensaje: 'Usuario: ya existe una cuenta con ese usuario' },
      ]);
    }
    if (e.constraint === 'uq_usuarios_correo') {
      throw errorValidacion([
        {
          campo: 'correo',
          mensaje: 'Correo: ya está asociado a otra cuenta (las cuentas son personales)',
        },
      ]);
    }
  }
  throw error;
}

/** Administración de usuarios internos y del rol de cada uno (RF-ADM-01). */
export class ServicioUsuarios {
  constructor(private readonly deps: Dependencias) {}

  async listar(filtro: FiltroUsuarios) {
    const { filas, total } = await usuariosRepo.listar(this.deps.pool, filtro);
    const ahora = this.deps.ahora();
    return { total, items: filas.map((f) => vista(f, f.rol, ahora)) };
  }

  async obtener(id: number): Promise<UsuarioVista> {
    const u = await usuariosRepo.porId(this.deps.pool, id);
    if (!u) throw notFound('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
    return vista(u, await usuariosRepo.rolAsignado(this.deps.pool, id), this.deps.ahora());
  }

  private async validarRol(db: Queryable, rolId: number): Promise<void> {
    const existentes = await rolesRepo.idsExistentes(db, [rolId]);
    if (!existentes.has(rolId)) {
      throw errorValidacion([{ campo: 'rolId', mensaje: 'Rol: elija un rol de la lista' }]);
    }
  }

  /** El administrador principal conserva siempre el rol de administrador. */
  private async validarProtegido(db: Queryable, u: UsuarioFila, rolId: number) {
    if (!u.protegido) return;
    const admin = (
      await db.query<{ id: number }>(`SELECT id FROM roles WHERE codigo = $1`, [ROL_ADMINISTRADOR])
    ).rows[0];
    if (rolId !== admin?.id) {
      throw badRequest(
        'USUARIO_PROTEGIDO',
        'El administrador principal debe conservar el rol de administrador',
      );
    }
  }

  async crear(
    actor: Actor,
    d: DatosUsuario & { usuario: string; password: string },
    ctx: ContextoPeticion,
  ): Promise<UsuarioVista> {
    const errores = validarPassword(d.password, d.usuario);
    if (errores.length > 0) {
      throw errorValidacion(
        errores.map((e) => ({ campo: 'password', mensaje: `Contraseña inicial: ${e}` })),
      );
    }
    const hash = await hashPassword(d.password);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      await this.validarRol(tx, d.rolId);
      let nuevo: number;
      try {
        nuevo = await usuariosRepo.crear(tx, {
          usuario: d.usuario,
          nombres: d.nombres,
          correo: d.correo,
          passwordHash: hash,
        });
      } catch (error) {
        traducirUnicidad(error);
      }
      await usuariosRepo.asignarRol(tx, nuevo, d.rolId);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.USUARIOS,
        accion: ACCION.USUARIO_CREADO,
        entidad: 'usuario',
        entidadId: nuevo,
        valorNuevo: {
          usuario: d.usuario,
          nombres: d.nombres,
          correo: d.correo,
          rol: await usuariosRepo.rolAsignado(tx, nuevo),
        },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return this.obtener(id);
  }

  async actualizar(
    actor: Actor,
    id: number,
    d: DatosUsuario,
    ctx: ContextoPeticion,
  ): Promise<UsuarioVista> {
    await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      const u = await usuariosRepo.porId(tx, id);
      if (!u) throw notFound('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
      if (u.estado === 'BAJA') {
        throw conflict('USUARIO_DE_BAJA', 'Un usuario dado de baja no puede modificarse');
      }
      await this.validarRol(tx, d.rolId);
      await this.validarProtegido(tx, u, d.rolId);
      const anterior = {
        nombres: u.nombres,
        correo: u.correo,
        rol: await usuariosRepo.rolAsignado(tx, id),
      };
      try {
        await usuariosRepo.actualizarDatos(tx, id, { nombres: d.nombres, correo: d.correo });
      } catch (error) {
        traducirUnicidad(error);
      }
      await usuariosRepo.asignarRol(tx, id, d.rolId);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.USUARIOS,
        accion: ACCION.USUARIO_MODIFICADO,
        entidad: 'usuario',
        entidadId: id,
        valorAnterior: anterior,
        valorNuevo: {
          nombres: d.nombres,
          correo: d.correo,
          rol: await usuariosRepo.rolAsignado(tx, id),
        },
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /** Bloqueo y baja exigen motivo; el desbloqueo solo aplica a un usuario bloqueado. */
  async cambiarEstado(
    actor: Actor,
    id: number,
    nuevo: EstadoUsuario,
    motivo: string | null,
    ctx: ContextoPeticion,
  ): Promise<UsuarioVista> {
    await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.bloquearAdministracion(tx);
      const u = await usuariosRepo.porId(tx, id);
      if (!u) throw notFound('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
      if (u.estado === 'BAJA') {
        throw conflict('USUARIO_DE_BAJA', 'El usuario ya fue dado de baja');
      }
      if (nuevo !== 'ACTIVO' && u.protegido) {
        throw badRequest(
          'USUARIO_PROTEGIDO',
          'El administrador principal no puede bloquearse ni darse de baja',
        );
      }
      if (nuevo !== 'ACTIVO' && u.id === actor.id) {
        throw badRequest('AUTO_BLOQUEO', 'No puede bloquear ni dar de baja su propia cuenta');
      }
      if (nuevo === 'BLOQUEADO' && u.estado === 'BLOQUEADO') {
        throw conflict('YA_BLOQUEADO', 'El usuario ya está bloqueado');
      }
      if (nuevo === 'ACTIVO' && u.estado !== 'BLOQUEADO') {
        throw conflict('NO_BLOQUEADO', 'El usuario no está bloqueado');
      }
      await usuariosRepo.fijarEstado(tx, id, nuevo);
      if (nuevo !== 'ACTIVO') {
        await tx.query(
          `UPDATE sesiones_internas SET revocada_at = now(), motivo_revocacion = $2
            WHERE usuario_id = $1 AND revocada_at IS NULL`,
          [id, nuevo === 'BAJA' ? 'BAJA' : 'BLOQUEO'],
        );
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.USUARIOS,
        accion:
          nuevo === 'BAJA'
            ? ACCION.USUARIO_DADO_DE_BAJA
            : nuevo === 'BLOQUEADO'
              ? ACCION.USUARIO_BLOQUEADO
              : ACCION.USUARIO_DESBLOQUEADO,
        entidad: 'usuario',
        entidadId: id,
        valorAnterior: { estado: u.estado },
        valorNuevo: { estado: nuevo },
        justificacion: motivo,
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /** El administrador fija una contraseña temporal; la persona debe cambiarla al ingresar. */
  async restablecerPassword(
    actor: Actor,
    id: number,
    password: string,
    ctx: ContextoPeticion,
  ): Promise<void> {
    const u = await usuariosRepo.porId(this.deps.pool, id);
    if (!u) throw notFound('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
    if (u.estado === 'BAJA') {
      throw conflict('USUARIO_DE_BAJA', 'Un usuario dado de baja no puede modificarse');
    }
    const errores = validarPassword(password, u.usuario);
    if (errores.length > 0) {
      throw errorValidacion(
        errores.map((e) => ({ campo: 'password', mensaje: `Contraseña temporal: ${e}` })),
      );
    }
    const hash = await hashPassword(password);
    await withTransaction(this.deps.pool, async (tx) => {
      await usuariosRepo.fijarPassword(tx, id, hash, true);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.USUARIOS,
        accion: ACCION.USUARIO_PASSWORD_RESTABLECIDA,
        entidad: 'usuario',
        entidadId: id,
        ip: ctx.ip,
      });
    });
  }
}
