// Zusatzfenster, die direkt aus dem Chatfenster gesteuert werden (gleicher Ursprung):
//  - FloatingAvatar: freischwebende, freigestellte Figur auf dem Desktop
//  - OutputWindow: Antworten groß und formatiert wie in LM Studio
import { Avatar, avatarState } from './avatar.js';
import { renderMarkdown, addCopyButtons } from './markdown.js';

const desktop = window.desktop;

function openChild(url, name) {
  const w = window.open(url, name);
  if (!w) return Promise.reject(new Error('Fenster konnte nicht geöffnet werden'));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      try {
        if (w.closed) return reject(new Error('Fenster wurde geschlossen'));
        if (w.location.href.endsWith(url) && w.document.readyState === 'complete') return resolve(w);
      } catch {}
      if (Date.now() - t0 > 15000) return reject(new Error('Fenster lädt nicht'));
      setTimeout(check, 50);
    };
    check();
  });
}

export class FloatingAvatar {
  constructor({ onClick, onClosed }) {
    this.onClick = onClick;
    this.onClosed = onClosed;
    this.win = null;
    this.avatar = null;
  }

  get isOpen() {
    return !!this.win && !this.win.closed;
  }

  async open(config) {
    if (this.isOpen) return this.setConfig(config);
    const w = await openChild('avatar.html', 'avatar');
    this.win = w;
    const doc = w.document;
    this.avatar = new Avatar(doc.getElementById('c'), { transparent: true });
    this.pill = doc.getElementById('pill');
    await this.setConfig(config);
    this.attachMouse(doc);
    // Schließen (z. B. Alt+F4) erkennen
    this.closeWatch = setInterval(() => {
      if (w.closed) {
        clearInterval(this.closeWatch);
        this.avatar?.destroy();
        this.win = null;
        this.avatar = null;
        this.onClosed?.();
      }
    }, 500);
  }

  async setConfig(config) {
    if (!this.avatar) return;
    await this.avatar.setConfig(config);
    // Fenster an das Seitenverhältnis der Figur anpassen
    desktop.avatarResize(1, this.avatar.w / this.avatar.h);
  }

  close() {
    if (!this.isOpen) return;
    clearInterval(this.closeWatch);
    this.avatar?.destroy();
    this.win.close();
    this.win = null;
    this.avatar = null;
  }

  setBadge(text, listening) {
    if (!this.pill) return;
    this.pill.textContent = text;
    this.pill.hidden = !text;
    this.pill.classList.toggle('listening', !!listening);
  }

  /** Ist an dieser Stelle die Figur (nicht transparent)? */
  hit(x, y) {
    const c = this.avatar?.canvas;
    if (!c) return false;
    const dpr = this.win.devicePixelRatio || 1;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
    return this.avatar.ctx.getImageData(px, py, 1, 1).data[3] > 30;
  }

  attachMouse(doc) {
    let ignoring = true;
    let down = null;
    const setIgnore = (v) => {
      if (v !== ignoring) {
        ignoring = v;
        desktop.avatarIgnoreMouse(v);
      }
    };
    doc.addEventListener('mousemove', (e) => {
      if (!down) setIgnore(!this.hit(e.clientX, e.clientY));
    });
    doc.addEventListener('mouseleave', () => !down && setIgnore(true));
    doc.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.screenX, y: e.screenY };
      desktop.avatarDragStart();
    });
    doc.defaultView.addEventListener('mouseup', (e) => {
      if (!down || e.button !== 0) return;
      desktop.avatarDragEnd();
      const moved = Math.hypot(e.screenX - down.x, e.screenY - down.y);
      down = null;
      if (moved < 4) this.onClick?.();
    });
    doc.addEventListener('dblclick', () => desktop.show());
    doc.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        desktop.avatarResize(e.deltaY < 0 ? 1.08 : 1 / 1.08, this.avatar ? this.avatar.w / this.avatar.h : 0);
      },
      { passive: false },
    );
    doc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      desktop.avatarMenu({ listening: avatarState.listening });
    });
  }
}

export class OutputWindow {
  constructor() {
    this.win = null;
    this.entries = []; // { question, answer }
    this.index = -1;
    this.streaming = false;
  }

  get isOpen() {
    return !!this.win && !this.win.closed;
  }

  async open() {
    if (this.isOpen) {
      this.win.focus();
      return;
    }
    const w = await openChild('output.html', 'output');
    this.win = w;
    const $ = (id) => w.document.getElementById(id);
    $('prev').onclick = () => this.show(this.index - 1);
    $('next').onclick = () => this.show(this.index + 1);
    $('copy').onclick = () => {
      const e = this.entries[this.index];
      if (e) w.navigator.clipboard.writeText(e.answer);
      $('copy').textContent = 'Kopiert ✓';
      setTimeout(() => ($('copy').textContent = 'Kopieren'), 1500);
    };
    $('save').onclick = () => {
      const e = this.entries[this.index];
      if (!e) return;
      const text = `# ${e.question.replace(/\n/g, ' ')}\n\n${e.answer}\n`;
      const a = w.document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      a.download = `Antwort-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    w.document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.show(this.index - 1);
      if (e.key === 'ArrowRight') this.show(this.index + 1);
    });
    this.show(this.entries.length - 1);
  }

  /** Verlauf setzen (aus der Chat-Historie). */
  setHistory(messages) {
    this.entries = [];
    let question = '';
    for (const m of messages) {
      if (m.role === 'user') question = m.content;
      else if (m.role === 'assistant') this.entries.push({ question, answer: m.content });
    }
    this.show(this.entries.length - 1);
  }

  /** Neue Antwort beginnt. */
  begin(question) {
    this.entries.push({ question, answer: '' });
    this.streaming = true;
    this.show(this.entries.length - 1);
  }

  /** Laufende Antwort aktualisieren. */
  update(answer, done = false) {
    const e = this.entries[this.entries.length - 1];
    if (!e) return;
    e.answer = answer;
    if (done) {
      this.streaming = false;
      if (!answer.trim()) this.entries.pop();
    }
    // Nur neu zeichnen, wenn gerade die neueste Antwort angezeigt wird
    if (this.index >= this.entries.length - 1 || done) this.show(this.entries.length - 1, true);
  }

  show(i, keepScroll = false) {
    if (!this.isOpen) {
      this.index = Math.max(0, Math.min(this.entries.length - 1, i));
      return;
    }
    const doc = this.win.document;
    const $ = (id) => doc.getElementById(id);
    const content = $('content');
    if (!this.entries.length) {
      this.index = -1;
      $('question').textContent = '';
      content.innerHTML = '<p class="empty">Hier erscheinen die Antworten ausführlich und formatiert.</p>';
      $('pos').textContent = '';
      $('prev').disabled = $('next').disabled = true;
      return;
    }
    this.index = Math.max(0, Math.min(this.entries.length - 1, i));
    const e = this.entries[this.index];
    const atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 40;
    $('question').textContent = e.question.length > 300 ? e.question.slice(0, 300) + ' …' : e.question;
    content.innerHTML = renderMarkdown(e.answer);
    const live = this.streaming && this.index === this.entries.length - 1;
    content.classList.toggle('typing', live);
    addCopyButtons(content);
    if (!keepScroll) content.scrollTop = 0;
    else if (live && atBottom) content.scrollTop = content.scrollHeight;
    $('pos').textContent = `${this.index + 1} / ${this.entries.length}`;
    $('prev').disabled = this.index <= 0;
    $('next').disabled = this.index >= this.entries.length - 1;
  }
}
