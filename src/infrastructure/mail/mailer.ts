import nodemailer from 'nodemailer';

export interface MensajeCorreo {
  to: string;
  subject: string;
  text: string;
}

export interface ResultadoEnvio {
  messageId: string;
}

/** Error de envío. `permanente` indica que reintentar no sirve (destinatario inexistente o rechazado). */
export class ErrorEnvioCorreo extends Error {
  constructor(
    message: string,
    public readonly permanente: boolean,
  ) {
    super(message);
    this.name = 'ErrorEnvioCorreo';
  }
}

export interface Mailer {
  enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvio>;
}

export interface ConfigSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Nombre con el que se valida el certificado TLS si no es el del host. La validación nunca se desactiva. */
  tlsServername?: string;
}

/** Envío real por SMTP (el institucional de la Alcaldía o un proveedor transaccional). */
export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: ConfigSmtp) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      ...(config.tlsServername ? { tls: { servername: config.tlsServername } } : {}),
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvio> {
    try {
      const info = await this.transport.sendMail({ from: this.config.from, ...mensaje });
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        throw new ErrorEnvioCorreo(`Destinatario rechazado: ${info.rejected.join(', ')}`, true);
      }
      return { messageId: info.messageId };
    } catch (error) {
      if (error instanceof ErrorEnvioCorreo) throw error;
      const code = (error as { responseCode?: number }).responseCode;
      throw new ErrorEnvioCorreo((error as Error).message, typeof code === 'number' && code >= 500);
    }
  }
}

/** Correo en memoria para las pruebas automáticas. */
export class MemoryMailer implements Mailer {
  readonly enviados: MensajeCorreo[] = [];
  falla: ErrorEnvioCorreo | null = null;
  private contador = 0;

  async enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvio> {
    if (this.falla) throw this.falla;
    this.enviados.push(mensaje);
    this.contador += 1;
    return { messageId: `<prueba-${this.contador}@estimulo.test>` };
  }

  ultimo(): MensajeCorreo {
    const m = this.enviados.at(-1);
    if (!m) throw new Error('No se envió ningún correo');
    return m;
  }
}
