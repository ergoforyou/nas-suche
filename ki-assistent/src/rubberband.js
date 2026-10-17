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
/* Touch: größere Anfasser (Finger statt Maus) */
.mobile .rb i { width: 34px; height: 34px; border-radius: 8px; }
.mobile .rb .nw, .mobile .rb .ne { top: -10px; }
.mobile .rb .sw, .mobile .rb .se { bottom: -10px; }
.mobile .rb .nw, .mobile .rb .sw { left: -10px; }
.mobile .rb .ne, .mobile .rb .se { right: -10px; }
.rb i, .rb .fitbar, .rb-touch { touch-action: none; }
/* Schnellwahl: Größe und Ausrichtung mit einem Tipp */
.rb .fitbar { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); display: flex; gap: 4px;
              pointer-events: auto; background: rgba(20,24,32,.88); border: 1px solid rgba(91,156,245,.8);
              border-radius: 10px; padding: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.rb .fitbar button { all: unset; cursor: pointer; color: #fff; font: 600 12px "Segoe UI", sans-serif;
                     padding: 6px 9px; border-radius: 7px; background: rgba(91,156,245,.25); white-space: nowrap; }
.rb .fitbar button:hover, .rb .fitbar button.on { background: #5b9cf5; }
.mobile .rb .fitbar button { padding: 9px 11px; font-size: 13px; }
/* Verschiebe-Griff der freien Figur: zieht das Fenster mit der Fensterverwaltung von Windows selbst
   (zuverlässig, auch über mehrere Bildschirme mit unterschiedlicher Skalierung) */
.rb .move { position: absolute; left: 50%; top: 68%; transform: translate(-50%, -50%); pointer-events: auto;
            -webkit-app-region: drag; cursor: move; background: rgba(91,156,245,.92); color: #fff;
            border: 2px solid #fff; border-radius: 999px; padding: 6px 12px; font: 600 13px "Segoe UI", sans-serif;
            white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.4); user-select: none; }
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
    if (opts.kind === 'layout') {
      // Schnellwahl im Rahmen: ausfüllen, ganz zeigen, Ausrichtung, Standard
      const bar = this.doc.createElement('div');
      bar.className = 'fitbar';
      const items = [
        ['⛶ Füllen', 'Bühne ganz ausfüllen (Kopf bleibt oben sichtbar)', { mode: 'fuellen', align: 'oben' }],
        ['▣ Ganz', 'Ganze Figur so groß wie möglich', { mode: 'ganz', align: 'mitte' }],
        ['⤓ Unten', 'Ganze Figur, unten ausgerichtet', { mode: 'ganz', align: 'unten' }],
        ['⤒ Oben', 'Ganze Figur, oben ausgerichtet', { mode: 'ganz', align: 'oben' }],
        ['↺', 'Standard (wie beim ersten Start)', null],
      ];
      for (const [label, title, fit] of items) {
        const b = this.doc.createElement('button');
        b.textContent = label;
        b.title = title;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.applyFit(fit);
        });
        bar.appendChild(b);
      }
      this.el.appendChild(bar);
      this.fitbar = bar;
    }
    if (opts.kind === 'window') {
      const grip = this.doc.createElement('b');
      grip.className = 'move';
      grip.textContent = '✥ ziehen';
      grip.title = 'Hier festhalten und die Figur verschieben – auch auf einen anderen Bildschirm';
      this.el.appendChild(grip);
    }
    container.appendChild(this.el);

    const canvas = avatar.canvas;
    if (opts.kind === 'layout') canvas.classList.add('rb-touch'); // Wischgesten nicht als Scrollen deuten
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    // Zwei Finger: zoomen (wie bei Fotos) – überall auf der Bühne, auch ohne Rahmen
    this.touches = new Map();
    this.fingers = new Map();
    const lift = (e) => this.fingers.delete(e.pointerId);
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('dblclick', (e) => {
      if (opts.tapToTalk) return; // Handy: einfaches Antippen spricht bzw. stoppt schon
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
        this.opts.onManual?.();
        this.avatar.freeLayout?.();
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
    // Rahmen innerhalb der Fläche halten; auf dem Handy mit Abstand zum Rand, damit die großen Anfasser ganz
    // sichtbar sind und nicht in den Wisch-Gesten am Bildschirmrand landen
    const m = this.container.closest('.mobile') ? 22 : 1;
    const x = Math.max(m, r.x - pad);
    const y = Math.max(m, r.y - pad);
    const w = Math.min(c.clientWidth - x - m, r.w + pad * 2 - (x - (r.x - pad)));
    const h = Math.min(c.clientHeight - y - m, r.h + pad * 2 - (y - (r.y - pad)));
    Object.assign(this.el.style, { left: `${x + c.offsetLeft}px`, top: `${y + c.offsetTop}px`, width: `${w}px`, height: `${h}px` });
  }

  /** Einpassung setzen (null = Standard) und merken. */
  applyFit(fit) {
    if (fit) this.opts.onManual?.();
    this.avatar.fitMode = fit;
    if (!fit) this.avatar.layout = { ...(this.avatar.defaultLayout ?? { x: 0, y: 0, scale: 1 }) };
    this.markFit();
    this.opts.onFit?.(fit);
  }

  markFit() {
    const f = this.avatar.fitMode;
    this.fitbar?.querySelectorAll('button').forEach((b, i) => {
      const want = [['fuellen', 'oben'], ['ganz', 'mitte'], ['ganz', 'unten'], ['ganz', 'oben']][i];
      b.classList.toggle('on', !!f && !!want && f.mode === want[0] && f.align === want[1]);
    });
  }

  select(on) {
    if (this.selected === on) return;
    this.selected = on;
    this.el.hidden = !on;
    if (on) {
      this.place();
      this.markFit();
    }
    this.opts.onSelect?.(on);
  }

  down(e) {
    if (e.button !== 0) return;
    const p = this.local(e);
    if (this.opts.kind === 'layout' && e.pointerType === 'touch') {
      this.fingers.set(e.pointerId, p);
      if (this.fingers.size >= 2 && !this.pinching) {
        e.preventDefault();
        this.holdCancel?.();
        try {
          this.avatar.canvas.setPointerCapture(e.pointerId);
        } catch {}
        this.opts.onManual?.();
        this.avatar.freeLayout?.();
        this.markFit();
        this.touches = new Map([...this.fingers].slice(-2));
        return this.pinchStart();
      }
    }
    // zweiter Finger (darf neben der Figur liegen): Zoomen
    if (this.opts.kind === 'layout' && this.touches.size === 1 && e.pointerType === 'touch') {
      e.preventDefault();
      try {
        this.avatar.canvas.setPointerCapture(e.pointerId);
      } catch {}
      this.touches.set(e.pointerId, p);
      return this.pinchStart();
    }
    if (!this.avatar.hitTest(p.x, p.y)) return this.select(false);
    // Handy: Antippen = sprechen bzw. Sprachausgabe stoppen; der Rahmen zum Verschieben/Vergrößern erst nach
    // langem Drücken (sonst landete man beim Stoppen ständig im Rahmen mit den Größen-Knöpfen)
    if (this.opts.tapToTalk && !this.selected && e.pointerType !== 'mouse') return this.tapOrHold(e);
    // 3D-Figur: Umschalttaste + Ziehen dreht die Figur
    if (e.shiftKey && (this.avatar.layers?.[0]?.isVrm || this.avatar.parallax)) return this.rotateStart(e);
    this.select(true);
    e.preventDefault();
    const desktop = this.opts.desktop;
    if (this.opts.kind === 'window') {
      // Zeiger festhalten: Das Loslassen kommt dann auch an, wenn die Maus kurz außerhalb der Figur ist
      // (schnelles Ziehen, Wechsel auf einen anderen Bildschirm).
      const canvas = this.avatar.canvas;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      desktop.avatarDragStart();
      const end = () => {
        canvas.removeEventListener('pointerup', end);
        this.win.removeEventListener('pointerup', end);
        desktop.avatarDragEnd();
      };
      canvas.addEventListener('pointerup', end);
      this.win.addEventListener('pointerup', end);
      return;
    }
    // innerhalb der Bühne verschieben
    const canvas = this.avatar.canvas;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    this.opts.onManual?.();
    this.avatar.freeLayout?.();
    this.markFit();
    this.touches.set(e.pointerId, p);
    if (this.touches.size >= 2) return this.pinchStart();
    const start = { ...p, layout: { ...this.avatar.layout } };
    const dpr = this.avatar.dpr ?? (this.win.devicePixelRatio || 1);
    const move = (ev) => {
      if (this.pinching || ev.pointerId !== e.pointerId) return;
      const q = this.local(ev);
      this.avatar.layout = {
        ...start.layout,
        x: start.layout.x + ((q.x - start.x) * dpr) / canvas.width,
        y: start.layout.y + ((q.y - start.y) * dpr) / canvas.height,
      };
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      this.touches.delete(e.pointerId);
      if (!this.pinching) this.opts.onChange?.(this.avatar.layout);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  tapOrHold(e) {
    const canvas = this.avatar.canvas;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const done = () => {
      clearTimeout(timer);
      this.holdCancel = null;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
    };
    const timer = setTimeout(() => {
      done();
      if (moved) return;
      this.win.navigator.vibrate?.(15);
      this.select(true);
    }, 550);
    const move = (ev) => {
      if (ev.pointerId === e.pointerId && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 12) moved = true;
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      done();
      if (!moved) this.opts.onTap?.();
    };
    const cancel = () => done();
    // zweiter Finger: kein Antippen/Rahmen, sondern Zoomen
    this.holdCancel = () => {
      moved = true;
      done();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
  }

  /** Zwei-Finger-Zoom: Abstand der Finger ändert die Größe, die Mitte zwischen ihnen verschiebt. */
  pinchStart() {
    const canvas = this.avatar.canvas;
    const pts = () => [...this.touches.values()].slice(0, 2);
    const dist = ([a, b]) => Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const mid = ([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const d0 = dist(pts());
    const m0 = mid(pts());
    const L0 = { ...this.avatar.layout };
    const dpr = this.avatar.dpr ?? 1;
    this.pinching = true;
    const move = (ev) => {
      if (!this.touches.has(ev.pointerId)) return;
      this.touches.set(ev.pointerId, this.local(ev));
      if (this.touches.size < 2) return;
      const k = dist(pts()) / d0;
      const m = mid(pts());
      this.avatar.layout = {
        scale: Math.max(0.2, Math.min(5, L0.scale * k)),
        x: L0.x + ((m.x - m0.x) * dpr) / canvas.width,
        y: L0.y + ((m.y - m0.y) * dpr) / canvas.height,
      };
    };
    const up = (ev) => {
      this.touches.delete(ev.pointerId);
      if (this.touches.size) return;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      this.pinching = false;
      this.opts.onChange?.(this.avatar.layout);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  rotateStart(e) {
    e.preventDefault();
    const canvas = this.avatar.canvas;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    const x0 = e.clientX;
    // 3D-Figur: volle Drehung; Bild-Figur: nur leicht (±25°)
    const is3d = !!this.avatar.layers?.[0]?.isVrm;
    const key = is3d ? 'vrmYaw' : 'turnYaw';
    const yaw0 = this.avatar[key] ?? 0;
    const move = (ev) => {
      let yaw = yaw0 + (ev.clientX - x0) * (is3d ? 0.7 : 0.25);
      yaw = is3d ? ((((yaw + 180) % 360) + 360) % 360) - 180 : Math.max(-25, Math.min(25, yaw));
      this.avatar[key] = Math.round(yaw);
      this.opts.onRotating?.(this.avatar[key], key);
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      this.opts.onRotate?.(this.avatar[key], key);
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
    this.opts.onManual?.();
    this.avatar.freeLayout?.();
    this.markFit();
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
