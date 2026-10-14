// Zusatzfenster, die direkt aus dem Chatfenster gesteuert werden (gleicher Ursprung):
//  - FloatingAvatar: freischwebende, freigestellte Figur auf dem Desktop
//  - OutputWindow: Antworten groß und formatiert wie in LM Studio
import { Avatar, avatarState } from './avatar.js';
import { renderMarkdown, addCopyButtons } from './markdown.js';
import { RubberBand } from './rubberband.js';
import { toDocx, toPrintHtml, fileBase } from './export.js';

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
  constructor({ onActivate, onClosed, onRotate }) {
    this.onRotate = onRotate;
    this.onActivate = onActivate;
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

  attachMouse(doc) {
    // Klick-durch: transparente Bereiche lassen Mausklicks zum Desktop durch,
    // solange die Figur nicht ausgewählt ist.
    let ignoring = true;
    const setIgnore = (v) => {
      if (v !== ignoring) {
        ignoring = v;
        desktop.avatarIgnoreMouse(v);
      }
    };
    this.band = new RubberBand(doc.body, this.avatar, {
      kind: 'window',
      desktop,
      onActivate: () => this.onActivate?.(),
      onRotate: (yaw, key) => this.onRotate?.(yaw, key),
      onSelect: (on) => setIgnore(!on && true),
    });
    doc.addEventListener('mousemove', (e) => {
      if (this.band.selected) return setIgnore(false);
      setIgnore(!this.avatar.hitTest(e.clientX, e.clientY));
    });
    doc.addEventListener('mouseleave', () => !this.band.selected && setIgnore(true));
    // Mausposition vom Hauptprozess (funktioniert auch, wenn Windows keine Mausbewegungen weiterreicht)
    desktop.onAvatarCursor?.(({ inside, x, y }) => {
      if (!this.avatar) return;
      if (!inside) return !this.band.selected && setIgnore(true);
      setIgnore(!(this.band.selected || this.avatar.hitTest(x, y)));
    });
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
    const current = () => this.entries[this.index];
    const done = (file) => {
      if (!file) return;
      this.flash(`Gespeichert: ${file.split(/[\\/]/).pop()}`, file);
    };
    const fail = (e) => this.flash(`Fehler beim Speichern: ${e.message}`);
    $('pdf').onclick = async () => {
      const e = current();
      if (!e) return;
      try {
        done(await desktop.exportPdf(fileBase(e.question), toPrintHtml({ question: e.question, answer: e.answer })));
      } catch (err) {
        fail(err);
      }
    };
    $('docx').onclick = async () => {
      const e = current();
      if (!e) return;
      try {
        const bytes = await toDocx({ question: e.question, answer: e.answer });
        done(await desktop.exportSave(fileBase(e.question), 'docx', 'Word-Dokument', bytes));
      } catch (err) {
        fail(err);
      }
    };
    $('save').onclick = async () => {
      const e = current();
      if (!e) return;
      const text = `# ${e.question.replace(/\n/g, ' ')}\n\n${e.answer}\n`;
      try {
        done(await desktop.exportSave(fileBase(e.question), 'md', 'Markdown-Text', new TextEncoder().encode(text)));
      } catch (err) {
        fail(err);
      }
    };
    w.document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.show(this.index - 1);
      if (e.key === 'ArrowRight') this.show(this.index + 1);
    });
    this.show(this.entries.length - 1);
  }

  /** Kurze Meldung im Ausgabefenster (mit "Im Ordner zeigen"). */
  flash(text, file) {
    if (!this.isOpen) return;
    const doc = this.win.document;
    let bar = doc.getElementById('flash');
    if (!bar) {
      bar = doc.createElement('div');
      bar.id = 'flash';
      bar.className = 'flash';
      doc.body.appendChild(bar);
    }
    bar.textContent = text + ' ';
    if (file) {
      const b = doc.createElement('button');
      b.textContent = 'Im Ordner zeigen';
      b.onclick = () => desktop.exportShow(file);
      bar.appendChild(b);
    }
    bar.hidden = false;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => (bar.hidden = true), 6000);
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
