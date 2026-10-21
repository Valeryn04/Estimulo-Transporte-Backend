/**
 * Versión con estilo de un correo: se arma a partir del mismo texto que queda guardado en el expediente (la fuente de
 * verdad sigue siendo el texto plano). Los enlaces solos en una línea se vuelven botones, los códigos y contraseñas
 * temporales se destacan, las líneas «Dato: valor» se ordenan en una tabla y las listas con guion en viñetas.
 */

const AZUL = '#142334';
const VERDE = '#1f8a4c';
const GRIS = '#4b5563';

const escapar = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const URL_SUELTA = /^(https?:\/\/\S+)$/;
const URL_EN_TEXTO = /(https?:\/\/[^\s<]+)/g;
const CODIGO = /^\d{6}$/;
const DATO = /^([^:\n]{2,40}): (.+)$/;

/** Texto con enlaces: los enlaces quedan activos. */
function enLinea(t: string): string {
  return escapar(t).replace(
    URL_EN_TEXTO,
    (u) => `<a href="${u}" style="color:${VERDE};word-break:break-all">${u}</a>`,
  );
}

function boton(url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="background:${AZUL};border-radius:8px"><a href="${escapar(url)}" style="display:inline-block;padding:14px 28px;font-weight:bold;font-size:16px;color:#ffffff;text-decoration:none">Abrir enlace</a></td></tr></table>
<p style="margin:0 0 20px;font-size:12px;color:${GRIS};word-break:break-all">Si el botón no funciona, copie esta dirección en el navegador:<br><a href="${escapar(url)}" style="color:${GRIS}">${escapar(url)}</a></p>`;
}

function destacado(valor: string): string {
  return `<p style="margin:8px 0 20px;padding:16px 20px;text-align:center;background:#f1f5f9;border:2px dashed ${AZUL};border-radius:10px;font-family:Consolas,'Courier New',monospace;font-size:28px;font-weight:bold;letter-spacing:4px;color:${AZUL};word-break:break-all">${escapar(valor)}</p>`;
}

function bloque(texto: string, destacar: readonly string[]): string {
  const lineas = texto.split('\n').map((l) => l.trimEnd());
  if (lineas.length === 1) {
    const l = lineas[0] as string;
    if (destacar.includes(l) || CODIGO.test(l)) return destacado(l);
    if (URL_SUELTA.test(l)) return boton(l);
  }
  if (lineas.every((l) => l.startsWith('- '))) {
    const items = lineas
      .map((l) => `<li style="margin:0 0 6px">${enLinea(l.slice(2))}</li>`)
      .join('');
    return `<ul style="margin:0 0 20px;padding-left:22px;font-size:15px;line-height:1.5;color:${AZUL}">${items}</ul>`;
  }
  if (lineas.length >= 1 && lineas.every((l) => DATO.test(l) && !/^https?:/.test(l))) {
    const filas = lineas
      .map((l) => {
        const m = DATO.exec(l) as RegExpExecArray;
        return `<tr><td style="padding:6px 12px 6px 0;font-size:14px;color:${GRIS};vertical-align:top;white-space:nowrap">${escapar(m[1] as string)}</td><td style="padding:6px 0;font-size:15px;font-weight:bold;color:${AZUL}">${enLinea(m[2] as string)}</td></tr>`;
      })
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;padding:10px 16px;background:#f8fafc;border-left:4px solid ${VERDE};border-radius:6px">${filas}</table>`;
  }
  // Una línea que termina en «: URL» o «:» seguida de un enlace: el texto y, debajo, el botón.
  const partes: string[] = [];
  let acumulado: string[] = [];
  const cerrar = () => {
    if (acumulado.length > 0) {
      partes.push(
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${AZUL}">${acumulado.map(enLinea).join('<br>')}</p>`,
      );
      acumulado = [];
    }
  };
  for (const l of lineas) {
    const m = /^(.*?):?\s*(https?:\/\/\S+)$/.exec(l);
    if (m && URL_SUELTA.test(l) === false && (m[1] ?? '').length > 0) {
      acumulado.push(`${m[1]}:`);
      cerrar();
      partes.push(boton(m[2] as string));
    } else if (URL_SUELTA.test(l)) {
      cerrar();
      partes.push(boton(l));
    } else acumulado.push(l);
  }
  cerrar();
  return partes.join('');
}

export function correoEnHtml(
  asunto: string,
  texto: string,
  opciones: { destacar?: readonly string[] } = {},
): string {
  const destacar = opciones.destacar ?? [];
  const bloques = texto
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((b) => bloque(b.trim(), destacar))
    .join('\n');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapar(asunto)}</title></head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${AZUL};padding:20px 28px;border-bottom:4px solid ${VERDE}">
<div style="font-size:13px;letter-spacing:1px;color:#cbd5e1;text-transform:uppercase">Alcaldía de Barranquilla</div>
<div style="font-size:20px;font-weight:bold;color:#ffffff;margin-top:4px">Estímulo Social de Transporte</div>
</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:${AZUL}">${escapar(asunto)}</h1>
${bloques}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;font-size:12px;line-height:1.5;color:${GRIS}">Este es un mensaje automático de la Gerencia de Desarrollo Social de la Alcaldía de Barranquilla. Por favor no responda a este correo.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
