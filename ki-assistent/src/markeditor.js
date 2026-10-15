// Großer Markier-Editor für Mund und Augen: Vollbild, mit zwei Fingern (oder Mausrad) zoomen, Punkte als
// große Anfasser verschieben. Beim Ziehen zeigt eine Lupe vergrößert, was unter dem Finger liegt – so verdeckt
// der Finger nicht die Stelle, die er trifft. "Automatisch" übernimmt die Punkte aus der Gesichtserkennung.

const STYLE = `
#markEd { position: fixed; inset: 0; z-index: 3000; background: #0b0d11; display: flex; flex-direction: column; touch-action: none; }
#markEd .me-bar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; background: var(--panel, #171a21); border-bottom: 1px solid var(--border, #2b303b); }
#markEd .me-bar button { padding: 8px 10px; }
#markEd .me-bar .primary { background: var(--accent-2, #2f5ea8); border-color: var(--accent, #5b9cf5); }
#markEd .me-bar label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted, #9aa3b2); }
#markEd .me-bar input[type=range] { width: 120px; }
#markEd canvas { flex: 1; width: 100%; min-height: 0; display: block; touch-action: none; }
#markEd .me-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); background: rgba(0,0,0,.65); color: #fff;
  padding: 6px 12px; border-radius: 999px; font: 13px "Segoe UI", sans-serif; pointer-events: none; white-space: nowrap; max-width: 94vw;
  overflow: hidden; text-overflow: ellipsis; }
`;

const COLORS = { mouth: '#ff6b8a', eye0: '#5bd1f5', eye1: '#5bd1f5' };

/**
 * @param {{image: HTMLImageElement|HTMLCanvasElement, mouth?: {x,y,w}, eyes?: {x,y,r}[],
 *          detect?: () => Promise<{mouth, eyes}|null>, onDone: (m: {mouth, eyes}) => void}} opts
 */
export function openMarkEditor({ image, mouth, eyes = [], detect, onDone }) {
  if (!document.getElementById('me-style')) {
    const st = document.createElement('style');
    st.id = 'me-style';
    st.textContent = STYLE;
    document.head.appendChild(st);
  }
  document.getElementById('markEd')?.remove();
  const root = document.createElement('div');
  root.id = 'markEd';
  root.innerHTML = `
    <div class="me-bar">
      <button data-act="auto">✨ Automatisch</button>
      <label>Mundbreite <input type="range" data-opt="mw" min="0.02" max="0.3" step="0.005"></label>
      <label>Augengröße <input type="range" data-opt="er" min="0.005" max="0.08" step="0.001"></label>
      <button data-act="fit">⤢ Ganzes Bild</button>
      <button data-act="cancel">Abbrechen</button>
      <button data-act="done" class="primary">✔ Übernehmen</button>
    </div>
    <canvas></canvas>
    <div class="me-hint">Punkte ziehen · mit zwei Fingern (oder Mausrad) zoomen · freie Fläche ziehen = verschieben</div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector('canvas');
  const g = canvas.getContext('2d');
  const hint = root.querySelector('.me-hint');
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  // Punkte in Bildkoordinaten (0..1)
  const pts = {
    mouth: { x: mouth?.x ?? 0.5, y: mouth?.y ?? 0.55, w: mouth?.w ?? 0.1 },
    eye0: { x: eyes[0]?.x ?? 0.42, y: eyes[0]?.y ?? 0.4, r: eyes[0]?.r ?? 0.03 },
    eye1: { x: eyes[1]?.x ?? 0.58, y: eyes[1]?.y ?? 0.4, r: eyes[1]?.r ?? eyes[0]?.r ?? 0.03 },
  };
  const mw = root.querySelector('[data-opt=mw]');
  const er = root.querySelector('[data-opt=er]');
  mw.value = pts.mouth.w;
  er.value = pts.eye0.r;
  mw.oninput = () => ((pts.mouth.w = +mw.value), draw());
  er.oninput = () => ((pts.eye0.r = pts.eye1.r = +er.value), draw());

  // Ansicht: Bildpunkt -> Bildschirm = (p * size) * scale + offset
  const view = { s: 1, ox: 0, oy: 0 };
  const dpr = () => window.devicePixelRatio || 1;
  const toScreen = (p) => ({ x: p.x * iw * view.s + view.ox, y: p.y * ih * view.s + view.oy });
  const toImage = (x, y) => ({ x: (x - view.ox) / view.s / iw, y: (y - view.oy) / view.s / ih });
  const fit = () => {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    view.s = Math.min(W / iw, H / ih) * 0.96;
    view.ox = (W - iw * view.s) / 2;
    view.oy = (H - ih * view.s) / 2;
  };
  // Start: auf das Gesicht gezoomt, wenn Punkte da sind
  const focusFace = () => {
    fit();
    if (!mouth && !eyes.length) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const cx = (pts.eye0.x + pts.eye1.x + pts.mouth.x) / 3;
    const cy = (pts.eye0.y + pts.eye1.y + pts.mouth.y) / 3;
    const span = Math.max(0.06, Math.abs(pts.eye1.x - pts.eye0.x), Math.abs(pts.mouth.y - (pts.eye0.y + pts.eye1.y) / 2));
    view.s = Math.min(W, H) / (span * 4.5 * Math.max(iw, ih));
    view.s = Math.max(view.s, Math.min(W / iw, H / ih));
    view.ox = W / 2 - cx * iw * view.s;
    view.oy = H / 2 - cy * ih * view.s;
  };

  let drag = null; // { key } beim Ziehen eines Punktes
  let lens = null; // Lupe { x, y } (Bildschirm)

  function draw() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr()) || canvas.height !== Math.round(H * dpr())) {
      canvas.width = Math.round(W * dpr());
      canvas.height = Math.round(H * dpr());
    }
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(image, view.ox, view.oy, iw * view.s, ih * view.s);
    drawMarks(g, (p) => toScreen(p), view.s);
    if (lens) drawLens(lens);
  }

  function drawMarks(ctx, map, s) {
    const m = map(pts.mouth);
    const half = (pts.mouth.w * iw * s) / 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.mouth;
    ctx.beginPath();
    ctx.moveTo(m.x - half, m.y);
    ctx.lineTo(m.x + half, m.y);
    ctx.stroke();
    for (const key of ['eye0', 'eye1']) {
      const e = map(pts[key]);
      ctx.strokeStyle = COLORS[key];
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(4, pts[key].r * iw * s), 0, Math.PI * 2);
      ctx.stroke();
    }
    // große Anfasser (gut mit dem Finger zu greifen), Mitte als feiner Punkt
    for (const key of ['mouth', 'eye0', 'eye1']) {
      const p = map(pts[key]);
      ctx.fillStyle = COLORS[key] + (drag?.key === key ? 'aa' : '55');
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Lupe: oben links oder rechts (weg vom Finger), dreifach vergrößert, mit Fadenkreuz
  function drawLens({ x, y }) {
    const R = 70;
    const Z = 3;
    const W = canvas.clientWidth;
    const cx = x < W / 2 ? W - R - 12 : R + 12;
    const cy = R + 12;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#000';
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const s = view.s * Z;
    const ox = cx - (x - view.ox) * Z;
    const oy = cy - (y - view.oy) * Z;
    g.drawImage(image, ox, oy, iw * s, ih * s);
    drawMarks(g, (p) => ({ x: p.x * iw * s + ox, y: p.y * ih * s + oy }), s);
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx - 10, cy);
    g.lineTo(cx + 10, cy);
    g.moveTo(cx, cy - 10);
    g.lineTo(cx, cy + 10);
    g.stroke();
    g.restore();
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
  }

  // ---- Eingabe: ein Finger auf Punkt = ziehen, sonst verschieben; zwei Finger = zoomen
  const touches = new Map();
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitKey = (p) => {
    let best = null;
    let bd = 34; // großzügiger Greifradius für Finger
    for (const key of ['mouth', 'eye0', 'eye1']) {
      const s = toScreen(pts[key]);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) {
        bd = d;
        best = key;
      }
    }
    return best;
  };
  let pan = null;
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    const p = local(e);
    touches.set(e.pointerId, p);
    if (touches.size === 2) {
      drag = null;
      lens = null;
      pan = null;
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ox: view.ox, oy: view.oy };
      return draw();
    }
    const key = hitKey(p);
    if (key) {
      // Versatz merken: der Punkt springt nicht unter den Finger, sondern bleibt, wo er gegriffen wurde
      const s = toScreen(pts[key]);
      drag = { key, dx: s.x - p.x, dy: s.y - p.y };
      lens = { x: s.x, y: s.y };
      hint.textContent = key === 'mouth' ? 'Mundmitte' : key === 'eye0' ? 'Linkes Auge (im Bild)' : 'Rechtes Auge (im Bild)';
    } else pan = { x: p.x, y: p.y, ox: view.ox, oy: view.oy };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const p = local(e);
    touches.set(e.pointerId, p);
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.max(0.05, Math.min(40, (pinch.s * d) / pinch.d));
      // Bildpunkt unter der Fingermitte bleibt unter der Fingermitte
      view.ox = mid.x - ((pinch.mid.x - pinch.ox) / pinch.s) * s;
      view.oy = mid.y - ((pinch.mid.y - pinch.oy) / pinch.s) * s;
      view.s = s;
    } else if (drag) {
      const q = { x: p.x + drag.dx, y: p.y + drag.dy };
      const ip = toImage(q.x, q.y);
      pts[drag.key].x = Math.max(0, Math.min(1, ip.x));
      pts[drag.key].y = Math.max(0, Math.min(1, ip.y));
      lens = q;
    } else if (pan) {
      view.ox = pan.ox + (p.x - pan.x);
      view.oy = pan.oy + (p.y - pan.y);
    }
    draw();
  });
  const up = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!touches.size) {
      drag = null;
      lens = null;
      pan = null;
      hint.textContent = 'Punkte ziehen · mit zwei Fingern (oder Mausrad) zoomen · freie Fläche ziehen = verschieben';
    }
    draw();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      const s = Math.max(0.05, Math.min(40, view.s * Math.exp(-e.deltaY * 0.0015)));
      view.ox = p.x - ((p.x - view.ox) / view.s) * s;
      view.oy = p.y - ((p.y - view.oy) / view.s) * s;
      view.s = s;
      draw();
    },
    { passive: false },
  );

  const close = () => {
    window.removeEventListener('resize', onResize);
    root.remove();
  };
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  const act = {
    auto: async () => {
      if (!detect) return;
      hint.textContent = 'Gesicht wird erkannt …';
      try {
        const m = await detect();
        if (!m) {
          hint.textContent = 'Kein Gesicht gefunden – bitte die Punkte von Hand ziehen.';
          return;
        }
        Object.assign(pts.mouth, m.mouth);
        if (m.eyes?.[0]) Object.assign(pts.eye0, m.eyes[0]);
        if (m.eyes?.[1]) Object.assign(pts.eye1, m.eyes[1]);
        mw.value = pts.mouth.w;
        er.value = pts.eye0.r;
        hint.textContent = 'Punkte aus der Gesichtserkennung übernommen – bei Bedarf nachziehen.';
        focusFace();
        draw();
      } catch (e) {
        hint.textContent = `Erkennung nicht möglich: ${e.message}`;
      }
    },
    fit: () => (fit(), draw()),
    cancel: close,
    done: () => {
      const r = (v) => +v.toFixed(4);
      onDone({
        mouth: { x: r(pts.mouth.x), y: r(pts.mouth.y), w: r(pts.mouth.w) },
        eyes: [pts.eye0, pts.eye1].map((e) => ({ x: r(e.x), y: r(e.y), r: r(e.r) })),
      });
      close();
    },
  };
  root.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act[b.dataset.act]()));
  // für Tests: Bildschirmposition eines Punktes (relativ zur Zeichenfläche)
  root.pointOnScreen = (key) => toScreen(pts[key]);
  requestAnimationFrame(() => {
    focusFace();
    draw();
  });
  return { close };
}
