import PDFDocument from 'pdfkit';
import type { CartaGenerada } from '../../domain/cartas.js';

function aBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    const partes: Buffer[] = [];
    doc.on('data', (p: Buffer) => partes.push(p));
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.on('error', rechazar);
    doc.end();
  });
}

const AZUL = '#142334';

/** Dibuja la carta (membrete, texto, firmas y pie) en un PDF. */
export function renderCarta(c: CartaGenerada, creada: Date): Promise<Buffer> {
  // Con la misma carta y la misma fecha el archivo sale idéntico: así no se guarda una versión nueva por nada.
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 64,
    info: {
      Title: c.titulo,
      Author: 'Alcaldía de Barranquilla · Estímulo Social de Transporte',
      CreationDate: creada,
      ModDate: creada,
    },
  });
  doc
    .fillColor(AZUL)
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('ALCALDÍA DE BARRANQUILLA', { align: 'center' });
  doc
    .fontSize(10)
    .font('Helvetica')
    .text('Gerencia de Desarrollo Social · Estímulo Social de Transporte', { align: 'center' });
  doc.moveDown(1.5).fontSize(13).font('Helvetica-Bold').text(c.titulo, { align: 'center' });
  doc.moveDown(1.2).fontSize(11).font('Helvetica').fillColor('black');
  for (const p of c.parrafos) doc.text(p, { align: 'justify' }).moveDown(0.9);
  doc.moveDown(2.5);
  const ancho =
    (doc.page.width - doc.page.margins.left - doc.page.margins.right) /
    Math.max(1, c.firmas.length);
  const y = doc.y;
  c.firmas.forEach((f, i) => {
    const x = doc.page.margins.left + i * ancho;
    doc
      .moveTo(x + 8, y)
      .lineTo(x + ancho - 24, y)
      .stroke();
    doc.fontSize(9).text(f.nombre, x + 8, y + 4, { width: ancho - 32 });
    doc.text(f.detalle, x + 8, doc.y, { width: ancho - 32 });
  });
  doc
    .fontSize(8)
    .fillColor('gray')
    .text(c.pie, doc.page.margins.left, doc.page.height - 100, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
    });
  return aBuffer(doc);
}

export interface FilaActa {
  radicado: string;
  nombre: string;
  documento: string;
  rol: 'Persona con discapacidad' | 'Cuidador';
}

/**
 * Planilla de entrega para firmar el día de la entrega: una fila por persona que recibe, con espacio para el
 * identificador de la tarjeta, quién recibe y su firma. Después se fotografía o escanea y se adjunta al registrar.
 */
export function renderActaEntrega(d: {
  fecha: string;
  lugar: string;
  funcionario: string;
  prefijoTarjeta: string;
  filas: FilaActa[];
}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margin: 36,
    info: { Title: 'Acta de entrega de tarjetas', Author: 'Alcaldía de Barranquilla' },
  });
  const m = doc.page.margins.left;
  const ancho = doc.page.width - m * 2;
  const cols = [
    { t: 'N.º', w: 0.04 },
    { t: 'Beneficiario', w: 0.27 },
    { t: 'Documento', w: 0.12 },
    { t: 'Identificador de la tarjeta', w: 0.19 },
    { t: 'Recibe', w: 0.14 },
    { t: 'Firma', w: 0.24 },
  ];
  const cabecera = () => {
    doc
      .fillColor(AZUL)
      .font('Helvetica-Bold')
      .fontSize(13)
      .text('ACTA DE ENTREGA DE TARJETAS', m, doc.page.margins.top, {
        align: 'center',
        width: ancho,
      });
    doc.fontSize(9).font('Helvetica').fillColor('black');
    doc.text(
      'Estímulo Social de Transporte · Gerencia de Desarrollo Social · Alcaldía de Barranquilla',
      {
        align: 'center',
        width: ancho,
      },
    );
    doc.moveDown(0.5);
    doc.text(`Fecha: ${d.fecha}      Lugar: ${d.lugar}`, m, doc.y, { width: ancho });
    doc.text(`Funcionario que entrega: ${d.funcionario}`, m, doc.y, { width: ancho });
    doc.moveDown(0.6);
  };
  const encabezadoTabla = () => {
    let x = m;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5);
    for (const c of cols) {
      doc.rect(x, y, c.w * ancho, 20).fillAndStroke('#e8edf3', '#9aa5b1');
      doc.fillColor(AZUL).text(c.t, x + 4, y + 6, { width: c.w * ancho - 8 });
      x += c.w * ancho;
    }
    doc.y = y + 20;
    doc.fillColor('black').font('Helvetica');
  };
  cabecera();
  encabezadoTabla();
  const alto = 46;
  d.filas.forEach((f, i) => {
    if (doc.y + alto > doc.page.height - 70) {
      doc.addPage();
      cabecera();
      encabezadoTabla();
    }
    const y = doc.y;
    let x = m;
    const celdas = [
      String(i + 1),
      `${f.nombre}\n${f.rol} · ${f.radicado}`,
      f.documento,
      `${d.prefijoTarjeta}________`,
      '[  ] Persona\n[  ] Cuidador\n[  ] Tercero',
      '',
    ];
    cols.forEach((c, j) => {
      doc.rect(x, y, c.w * ancho, alto).stroke('#9aa5b1');
      doc
        .fontSize(8)
        .fillColor('black')
        .text(celdas[j] ?? '', x + 4, y + 5, { width: c.w * ancho - 8, height: alto - 8 });
      x += c.w * ancho;
    });
    doc.y = y + alto;
  });
  doc.moveDown(1).fontSize(8).fillColor('#444');
  doc.text(
    'Si recibe un tercero, debe presentar la autorización firmada de la persona; anote su nombre y documento al respaldo. ' +
      'El día de la entrega cada persona firma esta planilla; luego se fotografía o escanea (PDF, JPG o PNG) y se adjunta al registrar la entrega en el sistema.',
    m,
    doc.y,
    { width: ancho },
  );
  return aBuffer(doc);
}
