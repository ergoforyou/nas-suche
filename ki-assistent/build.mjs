// Baut die Oberfläche nach dist/ und kopiert alle WASM-Laufzeitdateien lokal mit,
// damit Spracherkennung und Sprachausgabe ohne CDN funktionieren.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const nm = path.join(root, 'node_modules');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: { app: 'src/app.js', 'stt-worker': 'src/stt-worker.js' },
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  splitting: false,
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  absWorkingDir: root,
  // Node-Zweige im Emscripten-Code von Piper werden im Browser nie ausgeführt.
  external: ['fs', 'path'],
});

for (const f of ['index.html', 'style.css', 'avatar.html', 'output.html', 'output.css', 'default-avatar.svg', 'default-figur.svg']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(dist, f));
}

function copyFiles(fromDir, toDir, filter) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of fs.readdirSync(fromDir).filter(filter)) {
    fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
  }
}

// ONNX-Runtime für Whisper (Version passend zu transformers.js)
copyFiles(path.join(nm, '@huggingface/transformers/dist'), path.join(dist, 'wasm/tf'), (f) =>
  /^ort-wasm.*\.(wasm|mjs)$/.test(f),
);
// ONNX-Runtime 1.18 für Piper
copyFiles(path.join(nm, 'onnxruntime-web/dist'), path.join(dist, 'wasm/ort18'), (f) =>
  /^ort-wasm(-simd)?\.wasm$/.test(f),
);
// Piper-Phonemizer (espeak-ng-Daten)
copyFiles(path.join(nm, '@diffusionstudio/piper-wasm/build'), path.join(dist, 'wasm/piper'), (f) =>
  /\.(wasm|data)$/.test(f),
);

console.log('Build fertig:', dist);
