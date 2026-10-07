/** Convierte un nombre en un código estable: MAYÚSCULAS, sin tildes, con guion bajo. */
export function codigoDesdeNombre(nombre: string, prefijo = '', max = 40): string {
  const base = nombre
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefijo}${base}`.slice(0, max).replace(/_+$/, '');
}
