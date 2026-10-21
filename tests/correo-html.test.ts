import { describe, expect, it } from 'vitest';
import { correoEnHtml } from '../src/domain/correo-html.js';

describe('correo con estilo', () => {
  it('destaca el código, vuelve botón el enlace y escapa el HTML', () => {
    const html = correoEnHtml(
      'Su código <script>',
      'Hola Ana:\n\nSu código es:\n\n482915\n\nEscríbalo en:\n\nhttps://portal.test/consulta?token=abc&x=1\n\n- Uno <b>\n- Dos',
    );
    expect(html).toContain('482915');
    expect(html).toContain('letter-spacing:4px');
    expect(html).toContain('>Abrir enlace</a>');
    expect(html).toContain('href="https://portal.test/consulta?token=abc&amp;x=1"');
    expect(html).toContain('<li style="margin:0 0 6px">Uno &lt;b&gt;</li>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Alcaldía de Barranquilla');
  });

  it('destaca la contraseña temporal que se le indica', () => {
    const html = correoEnHtml('Acceso', 'Su contraseña temporal es:\n\nKp7#mXw2Rq9a', {
      destacar: ['Kp7#mXw2Rq9a'],
    });
    expect(html).toContain('font-size:28px');
    expect(html).toContain('Kp7#mXw2Rq9a');
  });

  it('ordena las líneas «Dato: valor» en una tabla', () => {
    const html = correoEnHtml('Radicada', 'Número de radicado: EST-2026-000001\nEstado: Radicada');
    expect(html).toContain('Número de radicado');
    expect(html).toContain('<table');
    expect(html).toContain('EST-2026-000001');
  });
});
