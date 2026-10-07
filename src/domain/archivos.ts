/** Formatos de los documentos que carga la ciudadanía (RNF-06). Los parámetros dicen cuáles se aceptan. */
export type FormatoDocumento = 'pdf' | 'jpg' | 'png';

export const MIME: Record<FormatoDocumento, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
};

/** Formatos de los modelos de carta que publica la Gerencia. */
export type FormatoModelo = 'pdf' | 'docx' | 'odt';

export const MIME_MODELO: Record<FormatoModelo, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
};

/**
 * Formato real del archivo según sus primeros bytes. No se confía en la extensión ni en el tipo que declara el
 * navegador: un archivo renombrado no pasa por otro.
 */
export function detectarFormato(b: Buffer): FormatoDocumento | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  return null;
}

/** Formato de un modelo de carta: PDF, o un paquete ZIP (DOCX y ODT) cuyo nombre de contenido lo distingue. */
export function detectarFormatoModelo(b: Buffer): FormatoModelo | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const cabeza = b.subarray(0, Math.min(b.length, 4096)).toString('latin1');
    if (cabeza.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return 'odt';
    if (cabeza.includes('[Content_Types].xml') || cabeza.includes('word/')) return 'docx';
  }
  return null;
}

/** Extensión en minúsculas sin punto; «jpeg» cuenta como «jpg». */
export function extensionDe(nombre: string): string {
  const e = /\.([A-Za-z0-9]{1,6})$/.exec(nombre)?.[1]?.toLowerCase() ?? '';
  return e === 'jpeg' ? 'jpg' : e;
}

/** Nombre apto para guardarlo y mostrarlo: sin rutas ni caracteres de control, de hasta 150 caracteres. */
export function nombreSeguro(nombre: string): string {
  const sinControl = [...nombre]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('');
  const limpio = sinControl.split(/[\\/]/).pop() ?? '';
  const recortado = limpio.trim().replace(/\s+/g, ' ');
  if (recortado.length <= 150) return recortado || 'archivo';
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(recortado)?.[0] ?? '';
  return recortado.slice(0, 150 - ext.length) + ext;
}

/** «jpg,png,pdf» → «PDF, JPG y PNG» para los mensajes. */
export function listarFormatos(formatos: string[]): string {
  const f = formatos.map((x) => x.toUpperCase());
  if (f.length <= 1) return f.join('');
  return `${f.slice(0, -1).join(', ')} y ${f.at(-1)}`;
}

export const formatearTamano = (bytes: number): string =>
  bytes < 1_048_576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} MB`;
