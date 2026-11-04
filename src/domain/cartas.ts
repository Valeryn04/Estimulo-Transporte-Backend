/**
 * Cartas que genera el sistema con los datos del formulario (la carta de solicitud de preinscripción y la carta de
 * cuidado y contacto). Son funciones puras: el texto es el mismo que muestra la vista previa del portal.
 */

export interface DatosCarta {
  vigencia: number;
  /** Fecha en que se aceptó la autorización de datos: es la fecha de la carta y no cambia. */
  fecha: Date | null;
  autorizacionVersion: number | null;
  radicado: string | null;
  pcd: {
    nombre: string;
    tipo: string;
    numero: string;
    celular: string | null;
    telefonoFijo: string | null;
  };
  cuidador: {
    nombre: string;
    tipo: string;
    numero: string;
    celular: string | null;
    telefonoFijo: string | null;
    correo: string | null;
  } | null;
  direccion: string | null;
  barrio: string | null;
  localidad: string | null;
  correo: string;
}

export interface CartaGenerada {
  titulo: string;
  /** Nombre con el que se guarda el documento. */
  archivo: string;
  parrafos: string[];
  firmas: { nombre: string; detalle: string }[];
  pie: string;
}

export const EN_BLANCO = '____________________';
const v = (t: string | null | undefined): string => (t && t.trim() ? t.trim() : EN_BLANCO);

const FECHA = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' });
const fechaDe = (d: Date | null): string =>
  d ? FECHA.format(d) : '____ de ____________ de ______';

/** «Calle 45 # 20 - 10, barrio Altamira, localidad Riomar» (lo que haya registrado). */
export function residencia(d: Pick<DatosCarta, 'direccion' | 'barrio' | 'localidad'>): string {
  const partes = [
    d.direccion?.trim() || null,
    d.barrio ? `barrio ${d.barrio}` : null,
    d.localidad ? `localidad ${d.localidad}` : null,
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(', ') : EN_BLANCO;
}

const contacto = (celular: string | null, fijo: string | null): string =>
  [celular ? `celular ${celular}` : null, fijo ? `teléfono fijo ${fijo}` : null]
    .filter(Boolean)
    .join(', ') || EN_BLANCO;

export function cartaSolicitud(d: DatosCarta): CartaGenerada {
  const p: string[] = [
    `Barranquilla, ${fechaDe(d.fecha)}`,
    'Señores\nGerencia de Desarrollo Social\nAlcaldía Distrital de Barranquilla',
    `Asunto: Solicitud de preinscripción al Estímulo Social de Transporte, vigencia ${d.vigencia}.`,
    `Yo, ${v(d.pcd.nombre)}, identificado(a) con ${v(d.pcd.tipo)} número ${v(d.pcd.numero)}, residente en ${residencia(d)}, ` +
      'solicito respetuosamente mi preinscripción al Estímulo Social de Transporte creado por el Acuerdo Distrital 0022 de 2025, ' +
      'dirigido a las personas con discapacidad que residen en el Distrito de Barranquilla.',
  ];
  if (d.cuidador) {
    p.push(
      `Solicito que el beneficio incluya a mi cuidador o asistente personal, ${v(d.cuidador.nombre)}, identificado(a) con ` +
        `${v(d.cuidador.tipo)} número ${v(d.cuidador.numero)}, quien me acompaña de manera permanente.`,
    );
  }
  p.push(
    'Declaro que la información que suministro es veraz y que sé que la preinscripción no equivale a la aprobación del beneficio: ' +
      'este se otorga una vez se verifiquen los requisitos y según los cupos disponibles.',
    `Autorizo el tratamiento de mis datos personales conforme a la Ley 1581 de 2012${d.autorizacionVersion ? ` (texto de autorización, versión ${d.autorizacionVersion})` : ''}.`,
    `Para notificaciones: correo electrónico ${v(d.correo)}; ${contacto(d.pcd.celular, d.pcd.telefonoFijo)}.`,
    'Atentamente,',
  );
  const firmas = [{ nombre: v(d.pcd.nombre), detalle: `${v(d.pcd.tipo)} ${v(d.pcd.numero)}` }];
  if (d.cuidador) {
    firmas.push({
      nombre: v(d.cuidador.nombre),
      detalle: `${v(d.cuidador.tipo)} ${v(d.cuidador.numero)}`,
    });
  }
  return {
    titulo: 'CARTA DE SOLICITUD DE PREINSCRIPCIÓN',
    archivo: 'carta-de-solicitud.pdf',
    parrafos: p,
    firmas,
    pie:
      'Carta generada por el sistema con los datos del formulario y presentada por medios electrónicos al aceptar la autorización de tratamiento de datos.' +
      (d.radicado ? ` Radicado ${d.radicado}.` : ''),
  };
}

export function cartaCuidado(d: DatosCarta): CartaGenerada {
  const c = d.cuidador;
  const p: string[] = [
    `Barranquilla, ${fechaDe(d.fecha)}`,
    'Señores\nGerencia de Desarrollo Social\nAlcaldía Distrital de Barranquilla',
    `Asunto: Carta de cuidado y contacto, Estímulo Social de Transporte, vigencia ${d.vigencia}.`,
    `Yo, ${v(c?.nombre)}, identificado(a) con ${v(c?.tipo)} número ${v(c?.numero)}, declaro que brindo cuidado o asistencia permanente a ` +
      `${v(d.pcd.nombre)}, identificado(a) con ${v(d.pcd.tipo)} número ${v(d.pcd.numero)}, persona con discapacidad que reside en ${residencia(d)}.`,
    'Me comprometo a acompañar a la persona con discapacidad y a usar el beneficio solo para su movilidad, sabiendo que es personal e intransferible.',
    `Datos de contacto del cuidador: ${contacto(c?.celular ?? null, c?.telefonoFijo ?? null)}; correo electrónico ${v(c?.correo)}.`,
    `Datos de contacto de la persona con discapacidad: ${contacto(d.pcd.celular, d.pcd.telefonoFijo)}; correo electrónico ${v(d.correo)}.`,
    'Esta carta debe ser revisada y autorizada por la Gerencia de Desarrollo Social.',
    'Atentamente,',
  ];
  return {
    titulo: 'CARTA DE CUIDADO Y CONTACTO',
    archivo: 'carta-de-cuidado-y-contacto.pdf',
    parrafos: p,
    firmas: [{ nombre: v(c?.nombre), detalle: `${v(c?.tipo)} ${v(c?.numero)} · cuidador` }],
    pie:
      'Carta generada por el sistema con los datos del formulario. Autorización de la Gerencia de Desarrollo Social: pendiente.' +
      (d.radicado ? ` Radicado ${d.radicado}.` : ''),
  };
}
