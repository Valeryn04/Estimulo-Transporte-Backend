import {
  MARCADOR_CONTRASENA,
  renderizar,
  valoresDeCorreo,
  type DatosCorreo,
  type TipoCorreo,
} from '../domain/correos.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { plantillasRepo } from '../infrastructure/repositories/plantillas.js';
import { type Queryable } from '../infrastructure/db/pool.js';
import { correosRepo } from '../infrastructure/repositories/correos.js';
import { ErrorEnvioCorreo } from '../infrastructure/mail/mailer.js';
import { logger } from '../shared/logger.js';
import type { Dependencias } from './contexto.js';

/** Minutos de espera antes de cada reintento (1.º fallo, 2.º, ...). Agotados, el correo queda «fallido». */
const ESPERAS_MINUTOS = [1, 5, 15, 60];
const MAX_INTENTOS = ESPERAS_MINUTOS.length + 1;
const MINUTOS_RESERVA = 5;
const LOTE = 20;

/**
 * Notificaciones por correo (RF-COM-01, RNF-13). Cada correo se registra primero (con el texto exacto) en la misma transacción del hecho que lo origina, y luego se envía con reintentos
 * automáticos. Nunca se pierde un correo porque el servidor de correo esté caído.
 */
export class ServicioCorreos {
  private activo: Promise<void> | null = null;
  private otraVuelta = false;
  private readonly cipher: DataCipher;

  constructor(private readonly deps: Dependencias) {
    this.cipher = new DataCipher(deps.env.encryption);
  }

  /**
   * Registra el correo en la bandeja de salida con la versión vigente de su plantilla. Guarda el texto final y la
   * versión usada: así siempre se sabe qué se envió exactamente (RF-COM-02).
   */
  async encolar(
    db: Queryable,
    d: {
      solicitudId: number | null;
      tipo: TipoCorreo;
      destinatario: string;
      datos: DatosCorreo;
    },
  ): Promise<number> {
    const plantilla = await plantillasRepo.vigente(db, d.tipo);
    if (!plantilla) throw new Error(`La plantilla ${d.tipo} no tiene versiones`);
    const valores = valoresDeCorreo(d.datos);
    // La contraseña temporal no se guarda en el texto del correo: va cifrada aparte hasta que el correo sale.
    const secretos =
      d.datos.contrasenaTemporal === undefined
        ? null
        : this.cipher.cifrarJson({ contrasenaTemporal: d.datos.contrasenaTemporal });
    return correosRepo.encolar(db, {
      solicitudId: d.solicitudId,
      tipo: d.tipo,
      plantillaVersion: plantilla.version,
      destinatario: d.destinatario,
      asunto: renderizar(plantilla.asunto, valores, true),
      cuerpo: renderizar(plantilla.cuerpo, valores),
      secretos,
    });
  }

  /**
   * Dispara el envío sin esperar a que termine (se llama después de confirmar la transacción). Solo hay un envío a la
   * vez: si llega otro aviso mientras se envía, se hace una vuelta más al terminar. Así un pico de solicitudes no
   * lanza cientos de envíos que compiten con las peticiones por las conexiones a la base de datos.
   */
  despachar(): void {
    if (this.activo) {
      this.otraVuelta = true;
      return;
    }
    const tarea: Promise<void> = (async () => {
      do {
        this.otraVuelta = false;
        try {
          await this.procesarPendientes();
        } catch (error) {
          logger.error({ error }, 'Falló el envío de correos');
        }
      } while (this.otraVuelta);
    })().finally(() => {
      this.activo = null;
    });
    this.activo = tarea;
  }

  /** Para las pruebas y el apagado ordenado: espera a que terminen los envíos en curso. */
  async esperarDespachos(): Promise<void> {
    while (this.activo) await this.activo;
  }

  /** Envía los correos pendientes. Devuelve cuántos salieron. */
  async procesarPendientes(): Promise<number> {
    const { pool, mailer } = this.deps;
    let enviados = 0;
    for (;;) {
      const lote = await correosRepo.reservarPendientes(pool, LOTE, MINUTOS_RESERVA);
      if (lote.length === 0) return enviados;
      for (const c of lote) {
        try {
          const r = await mailer.enviar({
            to: c.destinatario,
            subject: c.asunto,
            text: this.textoParaEnviar(c.cuerpo, c.secretos),
          });
          await correosRepo.marcarEnviado(pool, c.id, r.messageId);
          enviados += 1;
        } catch (error) {
          const mensaje = (error as Error).message;
          if (error instanceof ErrorEnvioCorreo && error.permanente) {
            // El servidor rechazó la dirección: es un rebote, reintentar no sirve.
            await correosRepo.marcarFinal(pool, c.id, 'REBOTADO', mensaje);
          } else if (c.intentos + 1 >= MAX_INTENTOS) {
            await correosRepo.marcarFinal(pool, c.id, 'FALLIDO', mensaje);
          } else {
            const espera = ESPERAS_MINUTOS[
              Math.min(c.intentos, ESPERAS_MINUTOS.length - 1)
            ] as number;
            await correosRepo.programarReintento(pool, c.id, mensaje, espera);
          }
          logger.warn({ correoId: c.id, error: mensaje }, 'No se pudo enviar el correo');
        }
      }
    }
  }

  /** Pone la contraseña temporal (descifrada) en el lugar del marcador; solo existe en memoria al enviar. */
  private textoParaEnviar(cuerpo: string, secretos: Buffer | null): string {
    if (!secretos) return cuerpo;
    const { contrasenaTemporal } = this.cipher.descifrarJson<{ contrasenaTemporal: string }>(
      secretos,
    );
    return cuerpo.split(MARCADOR_CONTRASENA).join(contrasenaTemporal);
  }

  /** Reporte de entrega o rebote del proveedor de correo (RNF-13). */
  registrarEventoEntrega(d: {
    messageId: string;
    evento: 'ENTREGADO' | 'REBOTADO';
    detalle?: string;
  }): Promise<boolean> {
    return correosRepo.registrarEvento(this.deps.pool, d.messageId, d.evento, d.detalle ?? null);
  }
}
