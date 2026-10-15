// Dialog „3D-Figur aus Bildern erstellen“: erzeugt mit bild2vrm lokal eine VRM-Figur (mit Mimik)
// aus einer Frontansicht, optional ergänzt um Rück- und Seitenansicht oder ein Turnaround-Blatt.
import { analyze, cutout, generate, splitSheet } from './bild2vrm/index.js';

const NAMES = ['head_top', 'neck', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
const FACE = ['left_eye_box', 'right_eye_box', 'mouth_box'];
const LINKS = [['head_top', 'neck'], ['neck', 'left_shoulder'], ['neck', 'right_shoulder'], ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'], ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'], ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'], ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle']];
// Lid- und Lippenkonturen aus der Gesichtserkennung (nur zur Anzeige)
const FACE_POINTS = [33, 246, 161, 160, 159, 158, 157, 173, 133, 7, 163, 144, 145, 153, 154, 155, 263, 466, 388, 387, 386, 385,
  384, 398, 362, 249, 390, 373, 374, 380, 381, 382, 61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 146, 91, 181, 84, 17, 314,
  405, 321, 375, 78, 13, 308, 14];
const COLORS = { left: '#e0605b', right: '#52c27a', center: '#5b9cf5', face: '#f0b440' };

const CSS = `
.b2v-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.b2v { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; width: min(920px, 96vw); max-height: 94vh;
  overflow: auto; padding: 16px; display: grid; grid-template-columns: 300px 1fr; gap: 16px; }
/* Handy: Einstellungen und Vorschau untereinander statt nebeneinander */
@media (max-width: 700px) { .b2v { grid-template-columns: 1fr; padding: 12px; max-height: 100vh; width: 100vw; border-radius: 0; } }
.b2v h2 { grid-column: 1 / -1; margin: 0; font-size: 17px; }
.b2v h4 { margin: 12px 0 4px; font-size: 13px; color: var(--muted); }
.b2v .b2v-slot { display: grid; grid-template-columns: 46px 1fr; gap: 8px; align-items: center; margin-top: 6px;
  padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
.b2v .b2v-thumb { width: 46px; height: 62px; border-radius: 6px; background: var(--panel-2) center / contain no-repeat;
  display: flex; align-items: center; justify-content: center; color: var(--muted); }
.b2v .b2v-slot b { font-size: 13px; }
.b2v label { display: block; margin-top: 8px; font-size: 13px; }
.b2v input[type=text], .b2v select { width: 100%; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px; }
.b2v input[type=range] { width: 100%; accent-color: var(--accent); }
.b2v .b2v-stage { background: repeating-conic-gradient(#ffffff10 0 25%, transparent 0 50%) 0 0 / 18px 18px; border-radius: 8px;
  min-height: 420px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.b2v canvas { display: block; max-width: 100%; touch-action: none; }
.b2v .b2v-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.b2v button.b2v-primary { background: var(--accent-2); border-color: var(--accent); font-weight: 600; }
.b2v .b2v-status { margin-top: 10px; font-size: 13px; min-height: 1.3em; }
.b2v .b2v-status.err { color: var(--danger); }
.b2v .b2v-legend { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.b2v .b2v-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin: 0 4px 0 10px; }
`;

/** Zeichnung (Canvas) -> Bild für bild2vrm */
function canvasToImage(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return { width: d.width, height: d.height, data: d.data };
}

/**
 * Dialog öffnen.
 * prepare(file) -> Promise<HTMLCanvasElement>: Bild laden und freistellen (Transparenz/einfarbig/KI) – liefert die App.
 * onCreated(bytes: Uint8Array, name: string) -> Promise: fertige VRM übernehmen.
 * detect(canvas) -> Promise<{ face, pose }> (optional): Gesichts-/Körpererkennung (MediaPipe) – liefert genaue Gelenke,
 *   Halbkörper-Erkennung und das Gesichts-Rig (Mimik durch Verformen des Fotos).
 */
export function openBild2VrmDialog({ prepare, onCreated, detect = null, defaultName = 'Meine Figur' }) {
  if (!document.getElementById('b2v-style')) {
    const st = document.createElement('style');
    st.id = 'b2v-style';
    st.textContent = CSS;
    document.head.append(st);
  }
  const overlay = document.createElement('div');
  overlay.className = 'b2v-overlay';
  overlay.innerHTML = `
    <div class="b2v" role="dialog" aria-label="3D-Figur aus Bildern erstellen">
      <h2>3D-Figur aus Bildern erstellen</h2>
      <div>
        <p class="hint" style="margin:0">Ganzkörperbild, Figur frontal und stehend, Arme etwas vom Körper weg.
          Rück- und Seitenansicht sind optional und machen die Figur deutlich besser. Alles bleibt auf diesem Rechner.</p>
        <div class="b2v-slot"><div class="b2v-thumb" data-thumb="front">＋</div>
          <div><b>Frontansicht</b> (nötig)<div class="row"><button data-pick="front">Auswählen …</button></div></div></div>
        <div class="b2v-slot"><div class="b2v-thumb" data-thumb="back">＋</div>
          <div><b>Rückansicht</b><div class="row"><button data-pick="back">Auswählen …</button><button data-clear="back" hidden>Entfernen</button></div></div></div>
        <div class="b2v-slot"><div class="b2v-thumb" data-thumb="side">＋</div>
          <div><b>Seitenansicht</b> (Profil)<div class="row"><button data-pick="side">Auswählen …</button><button data-clear="side" hidden>Entfernen</button></div></div></div>
        <div class="row" style="margin-top:8px"><button data-pick="sheet">Turnaround-Blatt laden …</button></div>
        <p class="hint">Blatt = Front, Seite und Rücken nebeneinander in einem Bild; wird automatisch aufgeteilt.</p>
        <h4>Einstellungen</h4>
        <label>Name <input type="text" data-opt="name"></label>
        <label>Körperdicke <span data-val="depth">1.0</span><input type="range" min="0.2" max="2.5" step="0.1" value="1" data-opt="depth"></label>
        <label class="check"><input type="checkbox" checked data-opt="expressions"> Mimik (Blinzeln, Mundformen, Lächeln)</label>
        <div class="b2v-actions">
          <button class="b2v-primary" data-act="create" disabled>Figur erstellen</button>
          <button data-act="save" hidden>Als .vrm speichern …</button>
          <button data-act="close">Abbrechen</button>
        </div>
        <div class="b2v-status"></div>
      </div>
      <div>
        <div class="b2v-legend">Punkte prüfen und bei Bedarf verschieben:<i style="background:${COLORS.left}"></i>linke Körperseite (im Bild rechts)<i style="background:${COLORS.right}"></i>rechte<i style="background:${COLORS.face}"></i>Augen/Mund (Mitte ziehen = verschieben, Ecke = Größe)</div>
        <div class="row" style="margin-bottom:6px"><button data-act="markface" hidden>Gesicht markieren …</button>
          <span class="hint" data-hint="mark"></span></div>
        <div class="b2v-stage"><span>Noch kein Bild</span></div>
      </div>
      <input type="file" accept="image/*" hidden>
    </div>`;
  document.body.append(overlay);
  const q = (s) => overlay.querySelector(s);
  const fileInput = q('input[type=file]');
  const statusEl = q('.b2v-status');
  const setStatus = (t, err = false) => { statusEl.textContent = t; statusEl.classList.toggle('err', err); };
  q('[data-opt=name]').value = defaultName;
  q('[data-opt=depth]').oninput = (e) => (q('[data-val=depth]').textContent = (+e.target.value).toFixed(1));

  const state = { front: null, back: null, side: null, kp: null, vrm: null, busy: false };
  const close = () => overlay.remove();
  q('[data-act=close]').onclick = close;
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && !state.busy && close());

  const setThumb = (slot, canvas) => {
    const t = q(`[data-thumb=${slot}]`);
    t.style.backgroundImage = canvas ? `url(${canvas.toDataURL('image/png')})` : '';
    t.textContent = canvas ? '' : '＋';
    const clr = q(`[data-clear=${slot}]`);
    if (clr) clr.hidden = !canvas;
  };
  const toCanvas = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  };

  /** Frontansicht übernehmen; gibt die Analyse zurück (inkl. Hinweisen). Rückansichten wandern ins Rückenfeld. */
  async function setFront(canvas) {
    const image = canvasToImage(canvas);
    let lm = null;
    if (detect) {
      setStatus('Gesicht und Körper werden erkannt …');
      try { lm = await detect(canvas); } catch (err) { console.warn('Erkennung fehlgeschlagen', err); }
    }
    const a = analyze(image, { background: 'alpha' }, lm);
    state.vrm = null;
    q('[data-act=save]').hidden = true;
    if (a.backView) {
      state.back = image;
      setThumb('back', canvas);
      return a;
    }
    state.front = image;
    state.frontCanvas = canvas;
    state.lm = lm;
    q('[data-act=markface]').hidden = !detect;
    state.kp = a.keypoints;
    state.cut = toCanvas(cutout(image, a.mask));
    setThumb('front', canvas);
    editor.show();
    q('[data-act=create]').disabled = false;
    return a;
  }
  const hints = (a) => (a.warnings.length ? ` Hinweis: ${a.warnings.join(' ')}` : '')
    + (a.faceMode === 'none' && detect ? ' Mit „Gesicht markieren“ kannst du den Gesichtsbereich von Hand einrahmen.' : '');

  // Gesicht von Hand markieren: Rahmen aufziehen -> Erkennung genau dort; findet sie nichts, einfache Mimik mit
  // Augen-/Mundkästen aus dem Rahmen (die Kästen lassen sich danach noch verschieben)
  q('[data-act=markface]').onclick = () => {
    q('[data-hint=mark]').textContent = 'Rahmen um das Gesicht ziehen (Stirn bis Kinn).';
    editor.startMark(async (box) => {
      q('[data-hint=mark]').textContent = '';
      setStatus('Gesicht wird im markierten Bereich gesucht …');
      let face = null;
      try { face = (await detect(state.frontCanvas, { faceBox: box })).face; } catch (err) { console.warn(err); }
      for (const k of FACE) delete state.kp[k];
      if (face) {
        state.lm = { ...(state.lm ?? {}), face };
        setStatus('Gesicht erkannt – die Figur bekommt Mimik aus der Gesichtserkennung.');
      } else {
        state.lm = state.lm ? { ...state.lm, face: null } : null;
        const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
        const at = (cx, cy, bw, bh) => [x0 + (cx - bw / 2) * w, y0 + (cy - bh / 2) * h, x0 + (cx + bw / 2) * w, y0 + (cy + bh / 2) * h];
        state.kp.left_eye_box = at(0.7, 0.42, 0.24, 0.14); // linkes Auge der Figur = im Bild rechts
        state.kp.right_eye_box = at(0.3, 0.42, 0.24, 0.14);
        state.kp.mouth_box = at(0.5, 0.77, 0.36, 0.13);
        setStatus('Im Rahmen wurde kein Gesicht erkannt – einfache Mimik. Bitte die Kästen genau auf Augen und Mund schieben.');
      }
      editor.show();
    });
  };

  let pickSlot = null;
  overlay.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => { pickSlot = b.dataset.pick; fileInput.click(); }));
  overlay.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = () => { state[b.dataset.clear] = null; setThumb(b.dataset.clear, null); }));
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file || state.busy) return;
    state.busy = true;
    try {
      setStatus('Bild wird freigestellt …');
      const canvas = await prepare(file);
      if (pickSlot === 'sheet') {
        const figs = splitSheet(canvasToImage(canvas), 'alpha');
        const names = { front: 'Front', side: 'Seite', back: 'Rücken' };
        const front = figs.find((f) => f.role === 'front');
        const back = figs.find((f) => f.role === 'back');
        const side = figs.find((f) => f.role === 'side');
        state.back = back ? back.image : null; setThumb('back', back ? toCanvas(back.image) : null);
        state.side = side ? side.image : null; setThumb('side', side ? toCanvas(side.image) : null);
        if (!front) throw new Error('Im Blatt wurde keine Frontansicht erkannt – bitte die Frontansicht einzeln laden.');
        const a = await setFront(toCanvas(front.image));
        setStatus(`${figs.length} Figuren erkannt: ${figs.map((f) => names[f.role]).join(', ')}. Punkte prüfen, dann „Figur erstellen“.${hints(a)}`);
      } else if (pickSlot === 'front') {
        const a = await setFront(canvas);
        if (a.backView) setStatus('Das Bild zeigt die Figur von hinten – es wurde als Rückansicht übernommen. Bitte noch eine Frontansicht laden.', true);
        else setStatus(`Punkte prüfen und ggf. verschieben, dann „Figur erstellen“.${hints(a)}`);
      } else {
        state[pickSlot] = canvasToImage(canvas);
        setThumb(pickSlot, canvas);
        setStatus(pickSlot === 'back' ? 'Rückansicht übernommen.' : 'Seitenansicht übernommen.');
      }
    } catch (err) {
      setStatus(`Fehler: ${err.message}`, true);
    } finally {
      state.busy = false;
    }
  };

  q('[data-act=create]').onclick = async () => {
    if (!state.front || state.busy) return;
    state.busy = true;
    const btn = q('[data-act=create]');
    btn.disabled = true;
    setStatus('3D-Figur wird erstellt …');
    await new Promise((r) => setTimeout(r, 30)); // Statustext zuerst anzeigen
    try {
      const name = q('[data-opt=name]').value.trim() || 'Figur';
      const res = await generate(state.front, {
        background: 'alpha', vrmVersion: '1', name, depth: +q('[data-opt=depth]').value,
        expressions: q('[data-opt=expressions]').checked,
      }, state.kp, { back: state.back, sides: state.side ? [{ image: state.side }] : [] }, state.lm);
      state.vrm = { bytes: res.vrm, name };
      await onCreated(res.vrm, `${name}.vrm`);
      q('[data-act=save]').hidden = false;
      q('[data-act=close]').textContent = 'Schließen';
      const face = { landmarks: 'Mimik aus der Gesichtserkennung', boxes: 'einfache Mimik', none: 'ohne Mimik (kein Gesicht erkannt)' }[res.stats.faceMode];
      setStatus(`Fertig: „${name}“ ist jetzt die 3D-Figur – ${face}${res.stats.halfBody ? ', als Brustbild' : ''}`
        + `${res.stats.backView ? ', mit Rückansicht' : ''}${res.stats.sideViews ? ', mit Seitenprofil' : ''}.`);
    } catch (err) {
      setStatus(`Fehler: ${err.message}`, true);
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  };
  q('[data-act=save]').onclick = async () => {
    if (!state.vrm) return;
    // Android-App: echter „Speichern unter …“-Dialog (ein Download-Link tut dort nichts)
    if (window.desktop?.saveFileAs) {
      const r = await window.desktop.saveFileAs(`${state.vrm.name}.vrm`, state.vrm.bytes);
      if (r?.ok) setStatus(r.shared ? 'Zum Speichern geteilt.' : 'Gespeichert – über „VRM-Datei laden“ jederzeit wieder verwendbar.');
      else if (!r?.cancelled) setStatus(`Speichern nicht möglich: ${r?.message ?? ''}`, true);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([state.vrm.bytes], { type: 'application/octet-stream' }));
    a.download = `${state.vrm.name}.vrm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ---------- Punkte-Editor
  const editor = (() => {
    const stageEl = q('.b2v-stage');
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    let scale = 1, drag = null, marking = null, markRect = null;
    const color = (n) => (n.endsWith('_box') ? COLORS.face : n.startsWith('left') ? COLORS.left : n.startsWith('right') ? COLORS.right : COLORS.center);
    function draw() {
      const { kp, cut } = state;
      if (!cut) return;
      const maxW = stageEl.clientWidth || 560, maxH = Math.min(600, window.innerHeight * 0.75);
      scale = Math.min(maxW / cut.width, maxH / cut.height);
      const dpr = window.devicePixelRatio || 1;
      cv.style.width = `${cut.width * scale}px`; cv.style.height = `${cut.height * scale}px`;
      cv.width = Math.round(cut.width * scale * dpr); cv.height = Math.round(cut.height * scale * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(cut, 0, 0, cut.width * scale, cut.height * scale);
      const P = (n) => [kp[n][0] * scale, kp[n][1] * scale];
      ctx.lineWidth = 3;
      for (const [a, b] of LINKS) {
        ctx.strokeStyle = color(a === 'head_top' || a === 'neck' ? b : a);
        ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
      }
      if (state.lm?.face) {
        ctx.fillStyle = COLORS.face;
        for (const i of FACE_POINTS) { const [x, y] = state.lm.face[i]; ctx.fillRect(x * scale - 1, y * scale - 1, 2, 2); }
      }
      for (const n of FACE) {
        if (!kp[n]) continue;
        const [x0, y0, x1, y1] = kp[n].map((v) => v * scale);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = COLORS.face; ctx.lineWidth = 2;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
        ctx.fillStyle = COLORS.face; ctx.fillRect(x1 - 4, y1 - 4, 8, 8);
        ctx.beginPath(); ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      for (const n of NAMES) {
        const [x, y] = P(n);
        ctx.fillStyle = color(n); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, drag?.name === n ? 8 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (markRect) {
        const [x0, y0, x1, y1] = markRect.map((v) => v * scale);
        ctx.setLineDash([6, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.setLineDash([]);
      }
    }
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };
    cv.addEventListener('pointerdown', (e) => {
      const kp = state.kp;
      if (!kp) return;
      if (marking) {
        const [x, y] = pos(e);
        markRect = [x, y, x, y];
        cv.setPointerCapture(e.pointerId);
        return;
      }
      const [x, y] = pos(e), tol = 12 / scale;
      let hit = null;
      for (const n of FACE) {
        if (!kp[n]) continue;
        const [x0, y0, x1, y1] = kp[n];
        if (Math.hypot(x - x1, y - y1) < tol) { hit = { name: n, mode: 'resize' }; break; }
        if (Math.hypot(x - (x0 + x1) / 2, y - (y0 + y1) / 2) < tol) { hit = { name: n, mode: 'move', start: [x, y], box: [...kp[n]] }; break; }
      }
      if (!hit) {
        let best = 16 / scale;
        for (const n of NAMES) { const d = Math.hypot(kp[n][0] - x, kp[n][1] - y); if (d < best) { best = d; hit = { name: n, mode: 'point' }; } }
      }
      if (hit) { drag = hit; cv.setPointerCapture(e.pointerId); draw(); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (marking && markRect) { const [x, y] = pos(e); markRect[2] = x; markRect[3] = y; draw(); return; }
      if (!drag) return;
      const [x, y] = pos(e), kp = state.kp, b = kp[drag.name];
      if (drag.mode === 'point') kp[drag.name] = [x, y];
      else if (drag.mode === 'resize') { b[2] = Math.max(b[0] + 4, x); b[3] = Math.max(b[1] + 4, y); }
      else { const dx = x - drag.start[0], dy = y - drag.start[1]; kp[drag.name] = [drag.box[0] + dx, drag.box[1] + dy, drag.box[2] + dx, drag.box[3] + dy]; }
      draw();
    });
    cv.addEventListener('pointerup', () => {
      if (marking && markRect) {
        const [ax, ay, bx, by] = markRect, box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
        const done = marking;
        marking = null; markRect = null; cv.style.cursor = '';
        draw();
        if (box[2] - box[0] > 6 && box[3] - box[1] > 6) done(box);
        return;
      }
      drag = null; draw();
    });
    return {
      show: () => { stageEl.replaceChildren(cv); draw(); },
      startMark: (cb) => { marking = cb; markRect = null; cv.style.cursor = 'crosshair'; },
    };
  })();

  return { close };
}
