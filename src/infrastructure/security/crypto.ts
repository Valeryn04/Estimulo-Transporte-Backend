import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import type { EncryptionKeys } from '../../config/env.js';

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Token aleatorio URL-safe (recuperación de contraseña). */
export function tokenAleatorio(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Código numérico de un solo uso de seis dígitos. */
export function codigoNumerico(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Cifrado en reposo con AES-256-GCM (RNF-06). El sobre incluye el id de la llave usada, de modo que
 * se pueden agregar llaves nuevas (rotación) sin perder la capacidad de descifrar datos antiguos.
 * Formato: [versión:1][largo id:1][id][iv:12][tag:16][texto cifrado]
 */
export class DataCipher {
  constructor(private readonly keys: EncryptionKeys) {}

  cifrarJson(valor: unknown): Buffer {
    return this.cifrarBytes(Buffer.from(JSON.stringify(valor), 'utf8'));
  }

  descifrarJson<T>(sobre: Buffer): T {
    return JSON.parse(this.descifrarBytes(sobre).toString('utf8')) as T;
  }

  /** Cifra un contenido cualquiera (por ejemplo, un documento cargado). */
  cifrarBytes(contenido: Buffer): Buffer {
    const id = this.keys.activeId;
    const key = this.keys.keys.get(id) as Buffer;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const cifrado = Buffer.concat([cipher.update(contenido), cipher.final()]);
    const idBuf = Buffer.from(id, 'utf8');
    return Buffer.concat([
      Buffer.from([VERSION, idBuf.length]),
      idBuf,
      iv,
      cipher.getAuthTag(),
      cifrado,
    ]);
  }

  descifrarBytes(sobre: Buffer): Buffer {
    if (sobre[0] !== VERSION) throw new Error('Formato de dato cifrado no soportado');
    const idLen = sobre[1] as number;
    const id = sobre.subarray(2, 2 + idLen).toString('utf8');
    const key = this.keys.keys.get(id);
    if (!key) throw new Error(`No se encuentra la llave de cifrado «${id}»`);
    let offset = 2 + idLen;
    const iv = sobre.subarray(offset, (offset += IV_LENGTH));
    const tag = sobre.subarray(offset, (offset += TAG_LENGTH));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sobre.subarray(offset)), decipher.final()]);
  }
}
