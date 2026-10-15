// Baut die Oberfläche nach dist/ und kopiert alle WASM-Laufzeitdateien lokal mit,
// damit Spracherkennung und Sprachausgabe ohne CDN funktionieren.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// --mobile: Android-App (Capacitor) nach dist-mobile/
const MOBILE = process.argv.includes('--mobile');
const dist = path.join(root, MOBILE ? 'dist-mobile' : 'dist');
const nm = path.join(root, 'node_modules');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: { app: MOBILE ? 'src/mobile/main.js' : 'src/app.js', 'stt-worker': 'src/stt-worker.js' },
  // Android: Modelle direkt von Hugging Face (auf dem PC über den Hauptprozess)
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version),
    ...(MOBILE ? { __HF_BASE__: '"https://huggingface.co/"' } : {}),
  },
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
if (MOBILE) {
  // Netzwerk: Claude, OpenAI, Hugging Face (https) und LM Studio im WLAN (http); Handy-Ansicht
  let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  html = html.replace("connect-src 'self' data: blob:", "connect-src 'self' data: blob: https: http:");
  html = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
  fs.writeFileSync(path.join(dist, 'index.html'), html);
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
  /^ort-wasm(-simd)?(-threaded)?\.wasm$/.test(f),
);
// Piper-Phonemizer (espeak-ng-Daten)
copyFiles(path.join(nm, '@diffusionstudio/piper-wasm/build'), path.join(dist, 'wasm/piper'), (f) =>
  /\.(wasm|data)$/.test(f),
);

// Gesichtserkennung (MediaPipe Face Landmarker, Apache-2.0): Laufzeit und Modell lokal mitliefern
copyFiles(path.join(nm, '@mediapipe/tasks-vision/wasm'), path.join(dist, 'wasm/mediapipe'), (f) => /^vision_wasm_internal\.(js|wasm)$/.test(f));
fs.copyFileSync(path.join(root, 'assets/face_landmarker.task'), path.join(dist, 'wasm/mediapipe/face_landmarker.task'));

console.log('Build fertig:', dist);
