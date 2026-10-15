import type { Queryable } from '../db/pool.js';

export type EstadoUsuario = 'ACTIVO' | 'BLOQUEADO' | 'BAJA';

export interface UsuarioFila {
  id: number;
  usuario: string;
  nombres: string;
  correo: string;
  passwordHash: string;
  estado: EstadoUsuario;
  debeCambiarPassword: boolean;
  intentosFallidos: number;
  bloqueadoHasta: Date | null;
  tokenVersion: number;
  ultimoLoginAt: Date | null;
  createdAt: Date;
  /** Administrador principal: no se puede bloquear ni dar de baja, ni quitarle el rol de administrador. */
  protegido: boolean;
}

/** El rol del usuario: cada usuario interno tiene uno solo. */
export interface RolAsignado {
  id: number;
  codigo: string;
  nombre: string;
}

interface FilaBD {
  id: number;
  usuario: string;
  nombres: string;
  correo: string;
  password_hash: string;
  estado: EstadoUsuario;
  debe_cambiar_password: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
  token_version: number;
  ultimo_login_at: Date | null;
  created_at: Date;
  protegido: boolean;
}

const COLUMNAS = `id, usuario, nombres, correo, password_hash, estado, debe_cambiar_password,
  intentos_fallidos, bloqueado_hasta, token_version, ultimo_login_at, created_at, protegido`;

const mapear = (f: FilaBD): UsuarioFila => ({
  id: f.id,
  usuario: f.usuario,
  nombres: f.nombres,
  correo: f.correo,
  passwordHash: f.password_hash,
  estado: f.estado,
  debeCambiarPassword: f.debe_cambiar_password,
  intentosFallidos: f.intentos_fallidos,
  bloqueadoHasta: f.bloqueado_hasta,
  tokenVersion: f.token_version,
  ultimoLoginAt: f.ultimo_login_at,
  createdAt: f.created_at,
  protegido: f.protegido,
});

export interface FiltroUsuarios {
  q?: string;
  estado?: EstadoUsuario;
  rolId?: number;
  limit: number;
  offset: number;
}

export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const usuariosRepo = {
  async porId(db: Queryable, id: number): Promise<UsuarioFila | null> {
    const r = await db.query<FilaBD>(`SELECT ${COLUMNAS} FROM usuarios WHERE id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async porUsuario(db: Queryable, usuario: string): Promise<UsuarioFila | null> {
    const r = await db.query<FilaBD>(
      `SELECT ${COLUMNAS} FROM usuarios WHERE lower(usuario) = lower($1)`,
      [usuario],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async listar(
    db: Queryable,
    f: FiltroUsuarios,
  ): Promise<{ filas: (UsuarioFila & { rol: RolAsignado | null })[]; total: number }> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.q) {
      params.push(`%${escaparLike(f.q)}%`);
      where.push(
        `(u.usuario ILIKE $${params.length} OR u.nombres ILIKE $${params.length} OR u.correo ILIKE $${params.length})`,
      );
    }
    if (f.estado) {
      params.push(f.estado);
      where.push(`u.estado = $${params.length}`);
    }
    if (f.rolId !== undefined) {
      params.push(f.rolId);
      where.push(
        `EXISTS (SELECT 1 FROM usuario_rol x WHERE x.usuario_id = u.id AND x.rol_id = $${params.length})`,
      );
    }
    params.push(f.limit, f.offset);
    const r = await db.query<FilaBD & { total: number }>(
      `SELECT u.id, u.usuario, u.nombres, u.correo, u.password_hash, u.estado, u.debe_cambiar_password,
              u.intentos_fallidos, u.bloqueado_hasta, u.token_version, u.ultimo_login_at, u.created_at,
              u.protegido, COUNT(*) OVER() AS total
         FROM usuarios u
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY u.nombres, u.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const filas = await Promise.all(
      r.rows.map(async (x) => ({ ...mapear(x), rol: await this.rolAsignado(db, x.id) })),
    );
    return { filas, total: r.rows[0]?.total ?? 0 };
  },

  async crear(
    db: Queryable,
    d: { usuario: string; nombres: string; correo: string; passwordHash: string },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO usuarios (usuario, nombres, correo, password_hash, debe_cambiar_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [d.usuario, d.nombres, d.correo, d.passwordHash],
    );
    return (r.rows[0] as { id: number }).id;
  },

  /** ¿Quién usa ya ese usuario o ese correo? (sin distinguir mayúsculas; se puede excluir a la persona que se edita). */
  async quienUsa(
    db: Queryable,
    campo: 'usuario' | 'correo',
    valor: string,
    excluirId: number | null,
  ): Promise<{ usuario: string; estado: string } | null> {
    const columna = campo === 'usuario' ? 'usuario' : 'correo';
    const r = await db.query<{ usuario: string; estado: string }>(
      `SELECT usuario, estado FROM usuarios
        WHERE lower(${columna}) = lower($1) AND ($2::integer IS NULL OR id <> $2)
        LIMIT 1`,
      [valor, excluirId],
    );
    return r.rows[0] ?? null;
  },

  async actualizarDatos(
    db: Queryable,
    id: number,
    d: { nombres: string; correo: string },
  ): Promise<void> {
    await db.query(
      `UPDATE usuarios SET nombres = $2, correo = $3, updated_at = now() WHERE id = $1`,
      [id, d.nombres, d.correo],
    );
  },

  /** Cambia el estado e invalida los tokens vigentes si deja de estar activo. */
  async fijarEstado(db: Queryable, id: number, estado: EstadoUsuario): Promise<void> {
    await db.query(
      `UPDATE usuarios
          SET estado = $2, updated_at = now(),
              baja_at = CASE WHEN $2 = 'BAJA' THEN now() ELSE baja_at END,
              token_version = token_version + CASE WHEN $2 = 'ACTIVO' THEN 0 ELSE 1 END,
              intentos_fallidos = 0, bloqueado_hasta = NULL
        WHERE id = $1`,
      [id, estado],
    );
  },

  async fijarPassword(
    db: Queryable,
    id: number,
    passwordHash: string,
    debeCambiar: boolean,
  ): Promise<void> {
    await db.query(
      `UPDATE usuarios
          SET password_hash = $2, debe_cambiar_password = $3, password_cambiada_at = now(),
              token_version = token_version + 1, intentos_fallidos = 0, bloqueado_hasta = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, passwordHash, debeCambiar],
    );
    // Una contraseña nueva cierra todas las sesiones abiertas de la persona.
    await db.query(
      `UPDATE sesiones_internas SET revocada_at = now(), motivo_revocacion = 'PASSWORD'
        WHERE usuario_id = $1 AND revocada_at IS NULL`,
      [id],
    );
  },

  /** Cuenta un intento fallido; al llegar al máximo bloquea temporalmente. Devuelve si quedó bloqueada. */
  async registrarFallo(
    db: Queryable,
    id: number,
    maxIntentos: number,
    minutosBloqueo: number,
  ): Promise<boolean> {
    const r = await db.query<{ bloqueado: boolean }>(
      `UPDATE usuarios
          SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= $2 THEN 0 ELSE intentos_fallidos + 1 END,
              bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= $2
                                     THEN now() + make_interval(mins => $3) ELSE bloqueado_hasta END
        WHERE id = $1
        RETURNING (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado`,
      [id, maxIntentos, minutosBloqueo],
    );
    return r.rows[0]?.bloqueado ?? false;
  },

  async registrarLoginOk(db: Queryable, id: number): Promise<void> {
    await db.query(
      `UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login_at = now() WHERE id = $1`,
      [id],
    );
  },

  /** El rol del usuario (o null si no tiene). */
  async rolAsignado(db: Queryable, usuarioId: number): Promise<RolAsignado | null> {
    const r = await db.query<RolAsignado>(
      `SELECT r.id, r.codigo, r.nombre
         FROM usuario_rol ur JOIN roles r ON r.id = ur.rol_id
        WHERE ur.usuario_id = $1`,
      [usuarioId],
    );
    return r.rows[0] ?? null;
  },

  /** Permisos efectivos: los del rol del usuario (mínimo privilegio). Un cambio en el rol se aplica de inmediato. */
  async permisos(db: Queryable, usuarioId: number): Promise<string[]> {
    const r = await db.query<{ permiso_codigo: string }>(
      `SELECT DISTINCT rp.permiso_codigo
         FROM usuario_rol ur JOIN rol_permiso rp ON rp.rol_id = ur.rol_id
        WHERE ur.usuario_id = $1
        ORDER BY 1`,
      [usuarioId],
    );
    return r.rows.map((x) => x.permiso_codigo);
  },

  /** Asigna el rol al usuario, reemplazando el anterior. */
  async asignarRol(db: Queryable, usuarioId: number, rolId: number): Promise<void> {
    await db.query(`DELETE FROM usuario_rol WHERE usuario_id = $1`, [usuarioId]);
    await db.query(`INSERT INTO usuario_rol (usuario_id, rol_id) VALUES ($1, $2)`, [
      usuarioId,
      rolId,
    ]);
  },

  /** Serializa los cambios de administración (evita carreras al validar reglas globales). */
  async bloquearAdministracion(db: Queryable): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(7340002)`);
  },
};
