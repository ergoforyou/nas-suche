// Prüft nach dem Packen, dass die Laufzeit-Abhängigkeiten des Hauptprozesses im Programm enthalten sind.
import asar from '@electron/asar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const edition = process.argv[2] || 'cloud';
const archive = path.join(root, 'release', edition, 'win-unpacked', 'resources', 'app.asar');
const files = asar.listPackage(archive).map((f) => f.replace(/\\/g, '/'));
const needed = ['/cloud.js', '/google.js', '/main.js', '/node_modules/@anthropic-ai/sdk/package.json', '/node_modules/openai/package.json'];
const missing = needed.filter((n) => !files.includes(n));
if (missing.length) {
  console.error('Fehlt im Programm:', missing.join(', '));
  process.exit(1);
}
// Ausgabe-Kennung im verpackten package.json prüfen
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
if (pkg.edition !== edition) {
  console.error(`Falsche Ausgabe im Paket: ${pkg.edition} statt ${edition}`);
  process.exit(1);
}
console.log(`Paket "${edition}" OK:`, needed.join(', '));
