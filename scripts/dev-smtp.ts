import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

// Servidor SMTP SOLO PARA DESARROLLO: recibe los correos que envía la API y los guarda en ./dev-mail como
// archivos .eml y .txt, sin entregarlos a nadie (equivale a Mailpit/MailHog).
const puerto = Number(process.env.SMTP_PORT ?? 1026);
const carpeta = path.resolve('dev-mail');
mkdirSync(carpeta, { recursive: true });

const servidor = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const partes: Buffer[] = [];
    stream.on('data', (p: Buffer) => partes.push(p));
    stream.on('end', () => {
      const crudo = Buffer.concat(partes);
      simpleParser(crudo)
        .then((m) => {
          mkdirSync(carpeta, { recursive: true }); // la carpeta puede haberse borrado (db:reiniciar)
          const base = new Date().toISOString().replace(/[:.]/g, '-');
          const para = m.to && 'text' in m.to ? m.to.text : '';
          writeFileSync(path.join(carpeta, `${base}.eml`), crudo);
          writeFileSync(
            path.join(carpeta, `${base}.txt`),
            `Para: ${para}\nAsunto: ${m.subject}\n\n${m.text}\n`,
          );
          console.log(`✉  ${m.subject} → ${para}`);
          callback();
        })
        .catch(callback);
    });
  },
});
servidor.listen(puerto, '127.0.0.1', () =>
  console.log(`SMTP de desarrollo escuchando en 127.0.0.1:${puerto} (correos en ${carpeta})`),
);
