import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Almacenamiento de archivos en una carpeta fuera del código. Las rutas las genera el servidor (nunca salen del
 * nombre que envía el usuario) y un archivo nunca se sobrescribe ni se borra (RNF-06). Para otro repositorio de
 * objetos basta con otra clase con estos mismos métodos.
 */
export class AlmacenArchivos {
  constructor(private readonly raiz: string) {}

  /** Clave nueva y única para un archivo de la solicitud (o del conjunto indicado). */
  nuevaClave(carpeta: string): string {
    return `${carpeta}/${randomUUID()}.bin`;
  }

  private resolver(clave: string): string {
    const destino = path.resolve(this.raiz, clave);
    if (!destino.startsWith(path.resolve(this.raiz) + path.sep)) {
      throw new Error('Ruta de almacenamiento no válida');
    }
    return destino;
  }

  async guardar(clave: string, contenido: Buffer): Promise<void> {
    const destino = this.resolver(clave);
    await mkdir(path.dirname(destino), { recursive: true });
    // «wx»: falla si ya existe, nunca pisa un archivo.
    await writeFile(destino, contenido, { flag: 'wx' });
  }

  async leer(clave: string): Promise<Buffer> {
    return readFile(this.resolver(clave));
  }
}
