// Auswahlrahmen ("Gummiband") um die Figur: Klick auf die Figur zeigt einen Rahmen mit
// Eckanfassern. Ziehen verschiebt, Ecken ändern die Größe, Doppelklick = Sprechen.
//
// kind 'layout': Figur innerhalb der Bühne im Chatfenster (Position/Größe werden gespeichert)
// kind 'window': freischwebende Figur – verschoben/skaliert wird das transparente Fenster selbst

const STYLE = `
.rb { position: absolute; border: 1.5px dashed rgba(91,156,245,.95); box-shadow: 0 0 0 1px rgba(0,0,0,.35);
      pointer-events: none; z-index: 5; box-sizing: border-box; }
.rb[hidden] { display: none; }
.rb i { position: absolute; width: 18px; height: 18px; background: #5b9cf5; border: 2px solid #fff;
        border-radius: 4px; pointer-events: auto; box-sizing: border-box; }
.rb .nw { left: -2px; top: -2px; cursor: nwse-resize; }
.rb .ne { right: -2px; top: -2px; cursor: nesw-resize; }
.rb .sw { left: -2px; bottom: -2px; cursor: nesw-resize; }
.rb .se { right: -2px; bottom: -2px; cursor: nwse-resize; }
`;

export class RubberBand {
  /**
   * @param {HTMLElement} container Element (position: relative), das die Leinwand enthält
   * @param {import('./avatar.js').Avatar} avatar
   * @param {{kind: 'layout'|'window', onChange?: Function, onActivate?: Function, onSelect?: Function, desktop?: any}} opts
   */
  constructor(container, avatar, opts) {
    this.container = container;
    this.avatar = avatar;
    this.opts = opts;
    this.doc = container.ownerDocument;
    this.win = this.doc.defaultView;
    this.selected = false;

    if (!this.doc.getElementById('rb-style')) {
      const st = this.doc.createElement('style');
      st.id = 'rb-style';
      st.textContent = STYLE;
      this.doc.head.appendChild(st);
    }
    this.el = this.doc.createElement('div');
    this.el.className = 'rb';
    this.el.hidden = true;
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const h = this.doc.createElement('i');
      h.className = c;
      h.addEventListener('pointerdown', (e) => this.resizeStart(e, c));
      this.el.appendChild(h);
    }
    container.appendChild(this.el);

    const canvas = avatar.canvas;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('dblclick', (e) => {
      const p = this.local(e);
      if (this.avatar.hitTest(p.x, p.y)) opts.onActivate?.();
    });
    this.doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return this.select(false);
      if (!this.selected) return;
      const grow = e.key === '+' || e.key === 'ArrowUp';
      const shrink = e.key === '-' || e.key === 'ArrowDown';
      if (!grow && !shrink) return;
      e.preventDefault();
      const f = grow ? 1.08 : 1 / 1.08;
      if (this.opts.kind === 'window') this.opts.desktop.avatarResize(f, this.avatar.w / this.avatar.h);
      else {
        const L = this.avatar.layout;
        this.avatar.layout = { ...L, scale: Math.max(0.2, Math.min(4, L.scale * f)) };
        this.opts.onChange?.(this.avatar.layout);
      }
    });
    if (opts.kind === 'window') this.win.addEventListener('blur', () => this.select(false));

    const loop = () => {
      if (this.selected) this.place();
      if (this.avatar.active) this.win.requestAnimationFrame(loop);
    };
    this.win.requestAnimationFrame(loop);
  }

  local(e) {
    const r = this.avatar.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  place() {
    const r = this.avatar.rect;
    if (!r) return;
    const c = this.avatar.canvas;
    const pad = 3;
    // im transparenten Fenster den Rahmen innerhalb der Fensterfläche halten
    const x = Math.max(1, r.x - pad);
    const y = Math.max(1, r.y - pad);
    const w = Math.min(c.clientWidth - x - 1, r.w + pad * 2);
    const h = Math.min(c.clientHeight - y - 1, r.h + pad * 2);
    Object.assign(this.el.style, { left: `${x + c.offsetLeft}px`, top: `${y + c.offsetTop}px`, width: `${w}px`, height: `${h}px` });
  }

  select(on) {
    if (this.selected === on) return;
    this.selected = on;
    this.el.hidden = !on;
    if (on) this.place();
    this.opts.onSelect?.(on);
  }

  down(e) {
    if (e.button !== 0) return;
    const p = this.local(e);
    if (!this.avatar.hitTest(p.x, p.y)) return this.select(false);
    this.select(true);
    e.preventDefault();
    const desktop = this.opts.desktop;
    if (this.opts.kind === 'window') {
      desktop.avatarDragStart();
      this.win.addEventListener('pointerup', () => desktop.avatarDragEnd(), { once: true });
      return;
    }
    // innerhalb der Bühne verschieben
    const canvas = this.avatar.canvas;
    canvas.setPointerCapture(e.pointerId);
    const start = { ...p, layout: { ...this.avatar.layout } };
    const dpr = this.win.devicePixelRatio || 1;
    const move = (ev) => {
      const q = this.local(ev);
      this.avatar.layout = {
        ...start.layout,
        x: start.layout.x + ((q.x - start.x) * dpr) / canvas.width,
        y: start.layout.y + ((q.y - start.y) * dpr) / canvas.height,
      };
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      this.opts.onChange?.(this.avatar.layout);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  }

  resizeStart(e, corner) {
    e.preventDefault();
    e.stopPropagation();
    const desktop = this.opts.desktop;
    const aspect = this.avatar.w / this.avatar.h;
    if (this.opts.kind === 'window') {
      desktop.avatarResizeStart(corner, aspect);
      this.win.addEventListener('pointerup', () => desktop.avatarDragEnd(), { once: true });
      return;
    }
    const handle = e.target;
    handle.setPointerCapture(e.pointerId);
    const r = { ...this.avatar.rect };
    // gegenüberliegende Ecke bleibt fest
    const ax = corner.includes('w') ? r.x + r.w : r.x;
    const ay = corner.includes('n') ? r.y + r.h : r.y;
    const move = (ev) => {
      const q = this.local(ev);
      const h = Math.max(40, Math.max(Math.abs(q.y - ay), Math.abs(q.x - ax) / aspect));
      const w = h * aspect;
      this.avatar.setRect({ x: corner.includes('w') ? ax - w : ax, y: corner.includes('n') ? ay - h : ay, w, h });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      this.opts.onChange?.(this.avatar.layout);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }
}
