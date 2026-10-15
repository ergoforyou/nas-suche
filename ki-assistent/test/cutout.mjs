// Freistellen bei einfarbigem Hintergrund: Auch eingeschlossene Flächen (zwischen Arm und Körper, zwischen
// den Beinen) müssen verschwinden, ein helles Hemd mit Falten muss bleiben.
import { chromium } from 'playwright';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/cutout.js'], bundle: true, format: 'iife', globalName: 'CUT', write: false });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ content: outputFiles[0].text });
const r = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f2';
  g.fillRect(0, 0, 300, 400);
  // Figur: Arme in die Hüfte gestemmt (Loch), Beine stehen unten auf einer Platte (Loch dazwischen)
  g.fillStyle = '#f0d0b0';
  g.beginPath();
  g.arc(150, 60, 35, 0, 7);
  g.fill();
  g.fillStyle = '#3a6fd0';
  g.fillRect(110, 100, 80, 130);
  g.strokeStyle = '#3a6fd0';
  g.lineWidth = 18;
  for (const [a, b] of [[112, 60], [188, 240]]) {
    g.beginPath();
    g.moveTo(a, 110);
    g.lineTo(b, 170);
    g.lineTo(a, 210);
    g.stroke();
  }
  // helles Hemd mit Falten (Streifen in Wandnähe) – muss bleiben
  for (let y = 120; y < 200; y++) {
    const v = 236 - (y % 9) * 5;
    g.fillStyle = `rgb(${v},${v},${v - 4})`;
    g.fillRect(135, y, 30, 1);
  }
  g.fillStyle = '#25283a';
  g.fillRect(115, 230, 28, 150);
  g.fillRect(157, 230, 28, 150);
  g.fillRect(115, 360, 70, 25);
  // leichtes Rauschen wie bei Fotos
  const id = g.getImageData(0, 0, 300, 400);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 8;
    id.data[i] += n;
    id.data[i + 1] += n;
    id.data[i + 2] += n;
  }
  g.putImageData(id, 0, 0);
  const { canvas, crop } = CUT.removeBackground(c, { tolerance: 30 });
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const a = (x, y) => d[((y - crop.y) * canvas.width + (x - crop.x)) * 4 + 3];
  return { armHole: a(95, 170), legGap: a(150, 300), shirt: Math.min(a(150, 160), a(150, 165), a(150, 171)), body: a(120, 150) };
});
await browser.close();
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✔' : '✘'} ${what}`);
  if (!ok) failed++;
};
console.log(JSON.stringify(r));
check(r.armHole === 0, 'Fläche zwischen Arm und Körper entfernt');
check(r.legGap === 0, 'Fläche zwischen den Beinen entfernt');
check(r.shirt > 240 && r.body > 240, 'Helles Hemd und Körper bleiben');
process.exit(failed ? 1 : 0);
