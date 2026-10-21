import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { autenticarInterno, requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';
import { rutasConfiguracion } from './configuracion.js';
import { rutasCruces } from './cruces.js';
import { rutasAsignacion } from './asignacion.js';
import { rutasEncuestas } from './encuestas.js';
import { rutasSeguimiento } from './seguimiento.js';
import { rutasNovedades } from './novedades.js';
import { rutasMatriz } from './matriz.js';
import { rutasPriorizacion } from './priorizacion.js';
import { rutasValidacion } from './validacion.js';

const rolIdSchema = z
  .number({ error: 'Rol: elija un rol de la lista' })
  .int('Rol: elija un rol de la lista')
  .positive('Rol: elija un rol de la lista');

const rolSchema = z.object({
  nombre: z
    .string({ error: 'Nombre del rol: escríbalo' })
    .trim()
    .min(3, 'Nombre del rol: escriba al menos 3 caracteres')
    .max(60, 'Nombre del rol: máximo 60 caracteres'),
  descripcion: z
    .string({ error: 'Descripción: escríbala' })
    .trim()
    .min(3, 'Descripción: escriba al menos 3 caracteres')
    .max(250, 'Descripción: máximo 250 caracteres'),
  permisos: z
    .array(z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/, 'Permisos: permiso inválido'), {
      error: 'Permisos: envíe la lista de permisos',
    })
    .max(100)
    .transform((p) => [...new Set(p)]),
});

const nombresSchema = z
  .string({ error: 'Nombres: escríbalos' })
  .trim()
  .min(3, 'Nombres: escriba al menos 3 caracteres')
  .max(150, 'Nombres: máximo 150 caracteres');

const correoSchema = z
  .string({ error: 'Correo: escríbalo' })
  .trim()
  .max(150)
  .pipe(
    z.email({ error: 'Correo: escriba un correo válido, por ejemplo nombre@barranquilla.gov.co' }),
  );

const crearSchema = z.object({
  usuario: z
    .string({ error: 'Usuario: escríbalo' })
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9._-]{3,40}$/,
      'Usuario: use de 3 a 40 letras minúsculas, números, punto, guion o guion bajo',
    ),
  nombres: nombresSchema,
  correo: correoSchema,
  rolId: rolIdSchema,
});

const actualizarSchema = z.object({
  nombres: nombresSchema,
  correo: correoSchema,
  rolId: rolIdSchema,
});

const motivoSchema = z.object({
  motivo: z
    .string({ error: 'Motivo: explique la razón' })
    .trim()
    .min(5, 'Motivo: explique la razón (mínimo 5 caracteres)')
    .max(500),
});

const disponibilidadSchema = z.object({
  usuario: z.string().trim().max(40).optional(),
  correo: z.string().trim().max(150).optional(),
  excluirId: z.coerce.number().int().positive().optional(),
});

const filtroSchema = paginacionSchema.extend({
  q: z.string().trim().max(100).optional(),
  estado: z.enum(['ACTIVO', 'BLOQUEADO', 'BAJA']).optional(),
  rolId: z.coerce.number().int().positive().optional(),
});

/** Administración de usuarios y roles (RF-ADM-01). Las restricciones se aplican en la API, no solo en pantalla. */
export function rutasAdmin(s: Servicios): Router {
  const r = Router();
  r.use(autenticarInterno(s.autenticacion));

  const usuariosPermiso = requierePermisos('usuarios.administrar');

  // ---- roles y permisos
  r.get('/roles', usuariosPermiso, async (_req, res) => {
    res.json({ items: await s.roles.listar() });
  });

  r.get('/permisos', usuariosPermiso, async (_req, res) => {
    res.json({ items: await s.roles.permisos() });
  });

  r.post('/roles', usuariosPermiso, async (req, res) => {
    const d = rolSchema.parse(req.body);
    res.status(201).json(await s.roles.crear(req.actor!, d, contexto(req)));
  });

  r.put('/roles/:id', usuariosPermiso, async (req, res) => {
    const d = rolSchema.parse(req.body);
    res.json(await s.roles.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  r.delete('/roles/:id', usuariosPermiso, async (req, res) => {
    await s.roles.eliminar(req.actor!, idParam(req), contexto(req));
    res.status(204).end();
  });

  // ---- usuarios
  r.get('/usuarios', requierePermisos('usuarios.administrar'), async (req, res) => {
    const f = filtroSchema.parse(req.query);
    const { items, total } = await s.usuarios.listar({
      q: f.q || undefined,
      estado: f.estado,
      rolId: f.rolId,
      limit: f.tamano,
      offset: (f.pagina - 1) * f.tamano,
    });
    res.json({ items, total, pagina: f.pagina, tamano: f.tamano });
  });

  /** Si el usuario o el correo ya los usa otra cuenta (se consulta mientras se llena el formulario). */
  r.get('/usuarios/disponibilidad', requierePermisos('usuarios.administrar'), async (req, res) => {
    const f = disponibilidadSchema.parse(req.query);
    res.json(await s.usuarios.disponibilidad(f));
  });

  r.get('/usuarios/:id', requierePermisos('usuarios.administrar'), async (req, res) => {
    res.json(await s.usuarios.obtener(idParam(req)));
  });

  r.post('/usuarios', requierePermisos('usuarios.administrar'), async (req, res) => {
    const d = crearSchema.parse(req.body);
    res.status(201).json(await s.usuarios.crear(req.actor!, d, contexto(req)));
  });

  r.put('/usuarios/:id', requierePermisos('usuarios.administrar'), async (req, res) => {
    const d = actualizarSchema.parse(req.body);
    res.json(await s.usuarios.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  r.post('/usuarios/:id/bloquear', requierePermisos('usuarios.administrar'), async (req, res) => {
    const { motivo } = motivoSchema.parse(req.body);
    res.json(
      await s.usuarios.cambiarEstado(req.actor!, idParam(req), 'BLOQUEADO', motivo, contexto(req)),
    );
  });

  r.post(
    '/usuarios/:id/desbloquear',
    requierePermisos('usuarios.administrar'),
    async (req, res) => {
      res.json(
        await s.usuarios.cambiarEstado(req.actor!, idParam(req), 'ACTIVO', null, contexto(req)),
      );
    },
  );

  r.post('/usuarios/:id/baja', requierePermisos('usuarios.administrar'), async (req, res) => {
    const { motivo } = motivoSchema.parse(req.body);
    res.json(
      await s.usuarios.cambiarEstado(req.actor!, idParam(req), 'BAJA', motivo, contexto(req)),
    );
  });

  r.post(
    '/usuarios/:id/restablecer-password',
    requierePermisos('usuarios.administrar'),
    async (req, res) => {
      await s.usuarios.restablecerPassword(req.actor!, idParam(req), contexto(req));
      res.status(204).end();
    },
  );

  r.use('/validacion', rutasValidacion(s));
  r.use('/cruces', rutasCruces(s));
  r.use('/matriz', rutasMatriz(s));
  r.use('/priorizacion', rutasPriorizacion(s));
  r.use('/asignacion', rutasAsignacion(s));
  r.use('/novedades', rutasNovedades(s));
  r.use('/encuestas', rutasEncuestas(s));
  r.use(rutasSeguimiento(s));

  // ---- avisos internos: cada persona ve los dirigidos a los permisos de su rol
  r.get('/alertas', async (req, res) => {
    // Los avisos por plazos (bloqueos por levantar, descargos y decisiones vencidos) se generan al consultar.
    if (req.actor!.permisos.has('novedades.gestionar')) await s.novedades.revisarPlazos();
    res.json({ items: await s.asignacion.alertas(req.actor!) });
  });

  r.post('/alertas/:id/atender', async (req, res) => {
    await s.asignacion.atenderAlerta(req.actor!, idParam(req), contexto(req));
    res.status(204).end();
  });
  r.use(rutasConfiguracion(s));

  return r;
}
