import { ACCION, MODULO } from '../domain/acciones.js';
import { validarPassword } from '../domain/passwords.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { sesionesRepo, type SesionFila } from '../infrastructure/repositories/sesiones.js';
import { usuariosRepo, type UsuarioFila } from '../infrastructure/repositories/usuarios.js';
import { sha256Hex, tokenAleatorio } from '../infrastructure/security/crypto.js';
import {
  hashPassword,
  verificarContraSenuelo,
  verificarPassword,
} from '../infrastructure/security/passwords.js';
import { AppError, forbidden, unauthorized } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Duración del token de acceso: corto, porque se renueva en silencio con el refresh token. */
const MINUTOS_TOKEN_ACCESO = 10;
/** Si dos pestañas renuevan casi a la vez, la segunda usa el secreto anterior: se tolera este margen. */
const SEGUNDOS_GRACIA_ROTACION = 10;
/** Cada cuánto se registra la actividad de una sesión (evita escribir en cada petición). */
const SEGUNDOS_ENTRE_REGISTROS_DE_USO = 30;

export interface SesionIniciada {
  /** Token de acceso: el navegador lo guarda solo en memoria. */
  token: string;
  perfil: PerfilUsuario;
  /** Minutos sin actividad tras los cuales la sesión se cierra (para avisar a la persona). */
  inactividadMinutos: number;
  /** Refresh token: viaja en una cookie HttpOnly y nunca en el cuerpo de la respuesta. */
  refresh?: string;
}

export interface PerfilUsuario {
  id: number;
  usuario: string;
  nombres: string;
  correo: string;
  roles: { id: number; codigo: string; nombre: string }[];
  permisos: string[];
  debeCambiarPassword: boolean;
}

export class ServicioAutenticacion {
  constructor(private readonly deps: Dependencias) {}

  /**
   * Carga el usuario con los permisos de su rol: un cambio de rol, de los permisos del rol o un bloqueo se aplica de
   * inmediato (RF-ADM-01). Devuelve null si el usuario no está activo o no tiene rol. El perfil conserva la lista
   * `roles` (de un solo elemento) para no cambiar el contrato con el portal.
   */
  async cargarActor(usuarioId: number): Promise<{ actor: Actor; usuario: UsuarioFila } | null> {
    const { pool } = this.deps;
    const usuario = await usuariosRepo.porId(pool, usuarioId);
    if (!usuario || usuario.estado !== 'ACTIVO') return null;
    const [rol, permisos] = await Promise.all([
      usuariosRepo.rolAsignado(pool, usuarioId),
      usuariosRepo.permisos(pool, usuarioId),
    ]);
    if (!rol) return null;
    return {
      usuario,
      actor: {
        id: usuario.id,
        usuario: usuario.usuario,
        nombres: usuario.nombres,
        correo: usuario.correo,
        roles: [{ id: rol.id, codigo: rol.codigo, nombre: rol.nombre }],
        permisos: new Set(permisos),
      },
    };
  }

  perfil(actor: Actor, debeCambiarPassword: boolean): PerfilUsuario {
    return {
      id: actor.id,
      usuario: actor.usuario,
      nombres: actor.nombres,
      correo: actor.correo,
      roles: actor.roles,
      permisos: [...actor.permisos].sort(),
      debeCambiarPassword,
    };
  }

  private inactividadMinutos(): Promise<number> {
    return parametrosRepo.entero(this.deps.pool, 'sesion_inactividad_minutos');
  }

  private firmarAcceso(u: UsuarioFila, cambiarPassword: boolean, sesionId: string): string {
    return this.deps.tokens.firmarInterno(
      { sub: u.id, tv: u.tokenVersion, cambiarPassword, sid: sesionId },
      MINUTOS_TOKEN_ACCESO,
    );
  }

  /** Abre una sesión nueva: devuelve el token de acceso y el refresh token (cookie). */
  private async abrirSesion(
    u: UsuarioFila,
    cargado: { actor: Actor },
    cambiarPassword: boolean,
  ): Promise<SesionIniciada> {
    const secreto = tokenAleatorio();
    const id = await sesionesRepo.crear(
      this.deps.pool,
      u.id,
      sha256Hex(secreto),
      this.deps.ahora(),
    );
    return {
      token: this.firmarAcceso(u, cambiarPassword, id),
      perfil: this.perfil(cargado.actor, cambiarPassword),
      inactividadMinutos: await this.inactividadMinutos(),
      refresh: `${id}.${secreto}`,
    };
  }

  /** La sesión vence por inactividad o al llegar al tope absoluto (`sesion_maxima_horas`). */
  private async validarVigencia(s: SesionFila): Promise<void> {
    const { pool, ahora } = this.deps;
    const ahoraMs = ahora().getTime();
    const [inactividad, maximaHoras] = await Promise.all([
      this.inactividadMinutos(),
      parametrosRepo.entero(pool, 'sesion_maxima_horas'),
    ]);
    if (
      ahoraMs - s.ultimoUsoAt.getTime() > inactividad * 60_000 ||
      ahoraMs - s.inicioAt.getTime() > maximaHoras * 3_600_000
    ) {
      await sesionesRepo.revocar(pool, s.id, 'VENCIDA', ahora());
      throw unauthorized('La sesión expiró, inicie sesión de nuevo', 'SESION_EXPIRADA');
    }
  }

  private async registrarActividad(s: SesionFila): Promise<void> {
    const ahora = this.deps.ahora();
    if (ahora.getTime() - s.ultimoUsoAt.getTime() > SEGUNDOS_ENTRE_REGISTROS_DE_USO * 1000) {
      await sesionesRepo.registrarUso(this.deps.pool, s.id, ahora);
    }
  }

  private separarRefresh(valor: string | undefined): { id: string; secreto: string } {
    const [id, secreto] = (valor ?? '').split('.');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!id || !secreto || !uuid.test(id) || secreto.length > 100) {
      throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    }
    return { id, secreto };
  }

  /**
   * Renueva la sesión con el refresh token de la cookie. Cada uso entrega un secreto nuevo (rotación): si
   * alguien presenta uno ya usado, se asume robo y se revoca toda la sesión.
   */
  async renovarSesion(
    valorCookie: string | undefined,
    ctx: ContextoPeticion,
  ): Promise<SesionIniciada> {
    const { pool, ahora } = this.deps;
    const { id, secreto } = this.separarRefresh(valorCookie);
    const hash = sha256Hex(secreto);
    let sesion = await sesionesRepo.porId(pool, id);
    if (!sesion || sesion.revocada) throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    await this.validarVigencia(sesion);

    let refresh: string | undefined;
    if (hash === sesion.tokenHash) {
      const nuevo = tokenAleatorio();
      if (await sesionesRepo.rotar(pool, id, hash, sha256Hex(nuevo), ahora())) {
        refresh = `${id}.${nuevo}`;
      } else {
        sesion = (await sesionesRepo.porId(pool, id)) ?? sesion; // otra petición rotó primero
      }
    }
    if (!refresh) {
      const reciente =
        sesion.anteriorHash === hash &&
        ahora().getTime() - sesion.rotadoAt.getTime() <= SEGUNDOS_GRACIA_ROTACION * 1000;
      if (!reciente) {
        await sesionesRepo.revocar(pool, id, 'REUTILIZACION', ahora());
        await bitacoraRepo.registrar(pool, {
          usuarioId: sesion.usuarioId,
          modulo: MODULO.SEGURIDAD,
          accion: ACCION.SESION_REUTILIZADA,
          entidad: 'usuario',
          entidadId: sesion.usuarioId,
          ip: ctx.ip,
        });
        throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
      }
      // Dos pestañas renovando a la vez: la cookie nueva ya la tiene el navegador, aquí solo se da acceso.
    }

    const cargado = await this.cargarActor(sesion.usuarioId);
    if (!cargado) {
      await sesionesRepo.revocar(pool, id, 'USUARIO_INACTIVO', ahora());
      throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    }
    const cambiar = cargado.usuario.debeCambiarPassword;
    return {
      token: this.firmarAcceso(cargado.usuario, cambiar, id),
      perfil: this.perfil(cargado.actor, cambiar),
      inactividadMinutos: await this.inactividadMinutos(),
      refresh,
    };
  }

  /** Cierra la sesión del refresh token indicado. Es idempotente: si ya no existe, no hace nada. */
  async cerrarSesion(valorCookie: string | undefined, ctx: ContextoPeticion): Promise<void> {
    const { pool, ahora } = this.deps;
    let partes: { id: string; secreto: string };
    try {
      partes = this.separarRefresh(valorCookie);
    } catch {
      return;
    }
    const sesion = await sesionesRepo.porId(pool, partes.id);
    const hash = sha256Hex(partes.secreto);
    if (!sesion || sesion.revocada || (hash !== sesion.tokenHash && hash !== sesion.anteriorHash)) {
      return;
    }
    await sesionesRepo.revocar(pool, sesion.id, 'CIERRE', ahora());
    await bitacoraRepo.registrar(pool, {
      usuarioId: sesion.usuarioId,
      modulo: MODULO.SEGURIDAD,
      accion: ACCION.LOGOUT,
      entidad: 'usuario',
      entidadId: sesion.usuarioId,
      ip: ctx.ip,
    });
  }

  async login(usuarioIngresado: string, password: string, ctx: ContextoPeticion) {
    const { pool, ahora } = this.deps;
    const [maxIntentos, minutosBloqueo] = await Promise.all([
      parametrosRepo.entero(pool, 'login_max_intentos'),
      parametrosRepo.entero(pool, 'login_bloqueo_minutos'),
    ]);
    const u = await usuariosRepo.porUsuario(pool, usuarioIngresado.trim());
    const credencialesInvalidas = () =>
      new AppError(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos');
    const registrar = (
      usuarioId: number | null,
      accion: string,
      detalle: Record<string, unknown>,
    ) =>
      bitacoraRepo.registrar(pool, {
        usuarioId,
        modulo: MODULO.SEGURIDAD,
        accion,
        entidad: 'usuario',
        entidadId: usuarioId,
        detalle,
        ip: ctx.ip,
      });

    if (!u) {
      await verificarContraSenuelo(password);
      await registrar(null, ACCION.LOGIN_FALLIDO, {
        usuario: usuarioIngresado.trim().slice(0, 60),
        motivo: 'USUARIO_INEXISTENTE',
      });
      throw credencialesInvalidas();
    }

    if (u.bloqueadoHasta && u.bloqueadoHasta.getTime() > ahora().getTime()) {
      await registrar(u.id, ACCION.LOGIN_BLOQUEADO, {});
      throw new AppError(
        429,
        'CUENTA_BLOQUEADA',
        'La cuenta está bloqueada temporalmente por intentos fallidos. Intente de nuevo más tarde.',
      );
    }

    const correcta = await verificarPassword(u.passwordHash, password);
    if (!correcta || u.estado !== 'ACTIVO') {
      const bloqueada = correcta
        ? false
        : await usuariosRepo.registrarFallo(pool, u.id, maxIntentos, minutosBloqueo);
      await registrar(u.id, ACCION.LOGIN_FALLIDO, {
        motivo: correcta ? `USUARIO_${u.estado}` : 'PASSWORD_INCORRECTA',
        bloqueada,
      });
      throw credencialesInvalidas();
    }

    const cargado = await this.cargarActor(u.id);
    if (!cargado) {
      await registrar(u.id, ACCION.LOGIN_FALLIDO, { motivo: 'SIN_ROL' });
      throw forbidden(
        'Su cuenta no tiene un rol asignado. Comuníquese con el administrador.',
        'ACCESO_NO_VIGENTE',
      );
    }
    await usuariosRepo.registrarLoginOk(pool, u.id);
    await registrar(u.id, ACCION.LOGIN_OK, {});
    return this.abrirSesion(u, cargado, u.debeCambiarPassword);
  }

  async cambiarPassword(
    actor: Actor,
    actual: string,
    nueva: string,
    ctx: ContextoPeticion,
    /** Cambio obligatorio con la contraseña temporal: no se vuelve a pedir la actual. */
    forzado = false,
  ) {
    const { pool } = this.deps;
    const u = await usuariosRepo.porId(pool, actor.id);
    if (!u || (!forzado && !(await verificarPassword(u.passwordHash, actual)))) {
      throw errorValidacion([
        { campo: 'passwordActual', mensaje: 'Contraseña actual: no es correcta' },
      ]);
    }
    const errores = validarPassword(nueva, u.usuario);
    if (await verificarPassword(u.passwordHash, nueva))
      errores.push('Debe ser diferente a la contraseña actual');
    if (errores.length > 0) {
      throw errorValidacion(
        errores.map((e) => ({ campo: 'passwordNueva', mensaje: `Nueva contraseña: ${e}` })),
      );
    }
    await withTransaction(pool, async (tx) => {
      await usuariosRepo.fijarPassword(tx, u.id, await hashPassword(nueva), false);
      await bitacoraRepo.registrar(tx, {
        usuarioId: u.id,
        modulo: MODULO.SEGURIDAD,
        accion: ACCION.PASSWORD_CAMBIADA,
        entidad: 'usuario',
        entidadId: u.id,
        ip: ctx.ip,
      });
    });
    // Cambiar la contraseña cerró todas las sesiones; se abre una nueva para esta persona.
    const actualizado = (await usuariosRepo.porId(pool, u.id)) as UsuarioFila;
    const cargado = await this.cargarActor(u.id);
    if (!cargado) throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    return this.abrirSesion(actualizado, cargado, false);
  }

  /** Verifica el token, que la sesión siga vigente y que el usuario esté activo con la misma versión. */
  async autenticar(token: string): Promise<{
    actor: Actor;
    usuario: UsuarioFila;
    cambiarPassword: boolean;
  }> {
    const datos = this.deps.tokens.verificarInterno(token);
    const sesion = datos.sid ? await sesionesRepo.porId(this.deps.pool, datos.sid) : null;
    if (!sesion || sesion.revocada || sesion.usuarioId !== datos.sub) {
      throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    }
    await this.validarVigencia(sesion);
    const cargado = await this.cargarActor(datos.sub);
    if (!cargado || cargado.usuario.tokenVersion !== datos.tv) {
      throw unauthorized('Sesión inválida', 'SESION_INVALIDA');
    }
    await this.registrarActividad(sesion);
    return { ...cargado, cambiarPassword: cargado.usuario.debeCambiarPassword };
  }
}
