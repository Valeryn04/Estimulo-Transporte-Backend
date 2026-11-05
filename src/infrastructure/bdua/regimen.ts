/**
 * Consulta del régimen de salud (servicio BDUA / ADRES de la Alcaldía): dice si la persona está afiliada y activa (AC)
 * y si es del régimen subsidiado. Reemplaza el documento de afiliación que antes debía adjuntar la persona.
 */

export type EstadoRegimen = 'SUBSIDIADO' | 'NO_SUBSIDIADO' | 'NO_DISPONIBLE';

export interface ResultadoRegimen {
  estado: EstadoRegimen;
  /** Mensaje tal como lo devolvió el servicio (o la razón por la que no se pudo consultar). */
  mensaje: string;
}

export interface ConsultaRegimen {
  readonly activo: boolean;
  consultar(tipoDocumento: string, numero: string): Promise<ResultadoRegimen>;
}

export class RegimenDesactivado implements ConsultaRegimen {
  readonly activo = false;
  async consultar(): Promise<ResultadoRegimen> {
    return { estado: 'NO_DISPONIBLE', mensaje: 'La consulta automática no está configurada.' };
  }
}

export class RegimenHttp implements ConsultaRegimen {
  readonly activo = true;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly peticion: typeof fetch = fetch,
  ) {}

  async consultar(tipoDocumento: string, numero: string): Promise<ResultadoRegimen> {
    const destino = new URL(this.url);
    destino.searchParams.set('tdoc', tipoDocumento);
    destino.searchParams.set('doc', numero);
    try {
      const r = await this.peticion(destino, {
        headers: { 'x-access-token': this.token, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) {
        return {
          estado: 'NO_DISPONIBLE',
          mensaje: `El servicio respondió con el estado ${r.status}.`,
        };
      }
      const j = (await r.json()) as { subsidiado?: unknown; mensaje?: unknown };
      const mensaje = typeof j.mensaje === 'string' ? j.mensaje : '';
      const subsidiado = j.subsidiado === 1 || j.subsidiado === '1' || j.subsidiado === true;
      return { estado: subsidiado ? 'SUBSIDIADO' : 'NO_SUBSIDIADO', mensaje };
    } catch {
      return { estado: 'NO_DISPONIBLE', mensaje: 'El servicio de consulta no respondió.' };
    }
  }
}

export function crearConsultaRegimen(
  config: { url: string; token: string } | null,
): ConsultaRegimen {
  return config ? new RegimenHttp(config.url, config.token) : new RegimenDesactivado();
}
