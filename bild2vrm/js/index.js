// bild2vrm (JavaScript): erzeugt lokal aus einem Ganzkörperbild eine geriggte VRM-Figur mit Mimik.
// Läuft im Browser bzw. im Electron-Renderer, ohne Abhängigkeiten.
//
//   import { loadImage, analyze, generate } from './bild2vrm/index.js';
//   const front = await loadImage(file);
//   const { keypoints } = analyze(front);            // optional: Punkte anzeigen/korrigieren
//   const { vrm } = await generate(front, { name: 'Lisa' }, keypoints, { back, sides: [{ image: side }] });
//   // vrm ist ein Uint8Array (.vrm-Datei)
export { DEFAULT_OPTIONS, analyze, cutout, generate, loadImage, splitSheet, KEYPOINT_NAMES, FACE_BOXES } from './avatar.js';
export { encodePNG } from './image.js';
