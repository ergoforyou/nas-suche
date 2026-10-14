// Prüft nach dem Packen, dass die Laufzeit-Abhängigkeiten des Hauptprozesses im Programm enthalten sind.
import asar from '@electron/asar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
const files = asar.listPackage(archive).map((f) => f.replace(/\\/g, '/'));
const needed = ['/cloud.js', '/main.js', '/node_modules/@anthropic-ai/sdk/package.json', '/node_modules/openai/package.json'];
const missing = needed.filter((n) => !files.includes(n));
if (missing.length) {
  console.error('Fehlt im Programm:', missing.join(', '));
  process.exit(1);
}
console.log('Paket OK:', needed.join(', '));
