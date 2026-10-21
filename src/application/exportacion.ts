import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Celda, TablaReporte } from '../infrastructure/repositories/reportes.js';

export interface EncabezadoReporte {
  titulo: string;
  /** Filtros aplicados, ya legibles: aparecen en el encabezado del archivo. */
  filtros: string[];
  generadoPor: string;
  generadoAt: Date;
}

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

const texto = (c: Celda): string => (c === null ? '' : String(c));

export async function aExcel(tabla: TablaReporte, enc: EncabezadoReporte): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = enc.generadoPor;
  libro.created = enc.generadoAt;
  const hoja = libro.addWorksheet(enc.titulo.slice(0, 31));
  const columnas = tabla.columnas.length;
  const lineas = [enc.titulo, ...enc.filtros, `Generado por ${enc.generadoPor} el ${FORMATO_FECHA.format(enc.generadoAt)}`];
  lineas.forEach((l, i) => {
    hoja.addRow([l]);
    hoja.mergeCells(i + 1, 1, i + 1, Math.max(columnas, 1));
  });
  hoja.getRow(1).font = { bold: true, size: 14 };
  hoja.addRow([]);
  const cabecera = hoja.addRow(tabla.columnas.map((c) => c.titulo));
  cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecera.eachCell((celda) => {
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  });
  for (const fila of tabla.filas) hoja.addRow(tabla.columnas.map((c) => fila[c.clave] ?? null));
  tabla.columnas.forEach((c, i) => {
    const mayor = tabla.filas.reduce((m, f) => Math.max(m, texto(f[c.clave] ?? null).length), c.titulo.length);
    hoja.getColumn(i + 1).width = Math.min(Math.max(mayor + 2, 10), 60);
  });
  hoja.views = [{ state: 'frozen', ySplit: lineas.length + 2 }];
  return Buffer.from(await libro.xlsx.writeBuffer());
}

export function aPdf(tabla: TablaReporte, enc: EncabezadoReporte): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: enc.titulo, Author: enc.generadoPor } });
    const partes: Buffer[] = [];
    doc.on('data', (p: Buffer) => partes.push(p));
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.on('error', rechazar);

    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colAncho = ancho / Math.max(tabla.columnas.length, 1);
    const encabezar = () => {
      doc.font('Helvetica-Bold').fontSize(14).text(enc.titulo);
      doc.font('Helvetica').fontSize(8);
      for (const f of enc.filtros) doc.text(f);
      doc.text(`Generado por ${enc.generadoPor} el ${FORMATO_FECHA.format(enc.generadoAt)}`);
      doc.moveDown(0.5);
    };
    const fila = (celdas: string[], negrita: boolean) => {
      const y = doc.y;
      doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const alto = Math.max(...celdas.map((t) => doc.heightOfString(t, { width: colAncho - 4 })), 10);
      if (y + alto > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        return fila(celdas, negrita);
      }
      celdas.forEach((t, i) =>
        doc.text(t, doc.page.margins.left + i * colAncho, y, { width: colAncho - 4, height: alto }),
      );
      doc.y = y + alto + 3;
      if (negrita) doc.moveTo(doc.page.margins.left, doc.y - 1).lineTo(doc.page.margins.left + ancho, doc.y - 1).stroke();
    };

    encabezar();
    fila(tabla.columnas.map((c) => c.titulo), true);
    for (const f of tabla.filas) fila(tabla.columnas.map((c) => texto(f[c.clave] ?? null)), false);
    if (tabla.filas.length === 0) doc.moveDown().font('Helvetica-Oblique').text('Sin registros para los filtros indicados.');
    doc.end();
  });
}

/** CSV con separador `;` y BOM, para que Excel lo abra en español sin configurar nada. */
export function aCsv(columnas: { clave: string; titulo: string }[], filas: Record<string, Celda>[]): string {
  const esc = (c: Celda) => {
    const t = texto(c);
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lineas = [columnas.map((c) => esc(c.titulo)).join(';'), ...filas.map((f) => columnas.map((c) => esc(f[c.clave] ?? null)).join(';'))];
  return String.fromCharCode(0xfeff) + lineas.join('\r\n') + '\r\n';
}
