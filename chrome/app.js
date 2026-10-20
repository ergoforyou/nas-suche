'use strict';
// ERGOFORYOU NAS-Suche – Oberfläche in Chrome. Die Arbeit (Index, Verschieben, NAS-Zugriff)
// erledigt das Programm NasSuche im Hintergrund; diese Seite spricht über NAS.api mit ihm.

const PANEL = new URLSearchParams(location.search).has('panel');
const T = 'application/x-nassuche';
const ROW_H = 26;
const SPRING_MS = 600;
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Dateitypen (wie im Programm) ----------

const CAT = { PDF: 1, IMAGE: 2, OFFICE: 3, FOLDER: 4, OTHER: 5 };
const FILTERS = [
  { bit: 2, cat: CAT.PDF, label: 'PDF' },
  { bit: 4, cat: CAT.IMAGE, label: 'Bilder' },
  { bit: 8, cat: CAT.OFFICE, label: 'Office' },
  { bit: 16, cat: CAT.FOLDER, label: 'Ordner' },
];
const TYPE_NAMES = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', docm: 'Word', dot: 'Word', dotx: 'Word', odt: 'Text (ODT)', rtf: 'Text (RTF)',
  xls: 'Excel', xlsx: 'Excel', xlsm: 'Excel', xlsb: 'Excel', xlt: 'Excel', xltx: 'Excel', csv: 'CSV', ods: 'Tabelle (ODS)',
  ppt: 'PowerPoint', pptx: 'PowerPoint', pptm: 'PowerPoint', pps: 'PowerPoint', ppsx: 'PowerPoint', odp: 'Präsentation',
  msg: 'E-Mail', eml: 'E-Mail', vsd: 'Visio', vsdx: 'Visio', one: 'OneNote',
  jpg: 'Bild (JPG)', jpeg: 'Bild (JPG)', png: 'Bild (PNG)', gif: 'Bild (GIF)', bmp: 'Bild (BMP)', tif: 'Bild (TIF)',
  tiff: 'Bild (TIF)', heic: 'Bild (HEIC)', webp: 'Bild (WEBP)', svg: 'Grafik (SVG)', psd: 'Photoshop',
  zip: 'ZIP-Archiv', rar: 'RAR-Archiv', '7z': '7-Zip-Archiv', txt: 'Text', mp4: 'Video', mov: 'Video',
  mp3: 'Audio', wav: 'Audio', exe: 'Programm', dwg: 'CAD (DWG)', dxf: 'CAD (DXF)',
};
const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', msg: 'application/vnd.ms-outlook', eml: 'message/rfc822',
};
const ext = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
function typeLabel(e) {
  if (e.isDir) return 'Ordner';
  const x = ext(e.name);
  return TYPE_NAMES[x] || (x ? x.toUpperCase() + '-Datei' : 'Datei');
}

const ICON_COLORS = { 1: '#D32F2F', 2: '#2E7D32', 3: '#1565C0', 5: '#78909C' };
function iconSVG(cat, isDir) {
  if (isDir) {
    return '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 3.5C1 2.7 1.7 2 2.5 2h3.6l1.5 1.6h5.9c.8 0 1.5.7 1.5 1.5v7.4c0 .8-.7 1.5-1.5 1.5h-11C1.7 14 1 13.3 1 12.5z" fill="#F4B63F"/><path d="M1 5.5h14v7c0 .8-.7 1.5-1.5 1.5h-11C1.7 14 1 13.3 1 12.5z" fill="#FFCD57"/></svg>';
  }
  const c = ICON_COLORS[cat] || ICON_COLORS[5];
  const mark = cat === 2 ? '<circle cx="6.2" cy="8.3" r="1.2" fill="#fff"/><path d="M4 12.5l2.6-2.6 1.6 1.4 2.1-2.4 1.7 3.6z" fill="#fff"/>'
    : cat === 1 ? '<rect x="4" y="9" width="8" height="1.3" fill="#fff"/><rect x="4" y="11.2" width="5.5" height="1.3" fill="#fff"/>'
      : cat === 3 ? '<rect x="4" y="8" width="8" height="1.1" fill="#fff"/><rect x="4" y="10" width="8" height="1.1" fill="#fff"/><rect x="4" y="12" width="6" height="1.1" fill="#fff"/>'
        : '';
  return `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 1h6.5L13 4.5V14c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1z" fill="${c}"/><path d="M9.5 1v3.5H13z" fill="#fff" opacity=".55"/>${mark}</svg>`;
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1 << 20) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
  if (n < 1 << 30) return (n / (1 << 20)).toFixed(1).replace('.', ',') + ' MB';
  return (n / (1 << 30)).toFixed(2).replace('.', ',') + ' GB';
}
const pad = (n) => String(n).padStart(2, '0');
function formatDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const thousands = (n) => n.toLocaleString('de-DE');

// ---------- Pfade ----------

let SEP = '\\';
const joinPath = (dir, name) => (dir.endsWith(SEP) ? dir + name : dir + SEP + name);
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const sameP = (a, b) => (SEP === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);
function isInside(child, parent) {
  const c = SEP === '\\' ? child.toLowerCase() : child;
  let p = SEP === '\\' ? parent.toLowerCase() : parent;
  if (!p.endsWith(SEP)) p += SEP;
  return c.startsWith(p);
}
function parentOf(p) {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (i < 0) return '';
  const par = t.slice(0, i);
  if (/^[A-Za-z]:$/.test(par)) return par + '\\';
  if (par === '') return SEP === '/' ? '/' : '';
  if (/^\\\\[^\\]+$/.test(par)) return ''; // \\server allein ist kein Ordner
  return par;
}
function crumbsOf(p) {
  const out = [];
  if (SEP === '\\') {
    let m = p.match(/^(\\\\[^\\]+\\[^\\]+)(.*)$/);
    let rest;
    if (m) { out.push({ label: m[1], path: m[1] }); rest = m[2]; }
    else {
      m = p.match(/^([A-Za-z]:)\\?(.*)$/);
      if (!m) return [{ label: p, path: p }];
      out.push({ label: m[1], path: m[1] + '\\' });
      rest = m[2];
    }
    let cur = out[0].path.replace(/\\$/, '');
    for (const part of rest.split('\\').filter(Boolean)) { cur += '\\' + part; out.push({ label: part, path: cur }); }
  } else {
    out.push({ label: '/', path: '/' });
    let cur = '';
    for (const part of p.split('/').filter(Boolean)) { cur += '/' + part; out.push({ label: part, path: cur }); }
  }
  return out;
}

const toEntry = (r) => ({ name: r[0], dir: r[1], isDir: r[2] === 1, size: r[3], mod: r[4], cat: r[5], path: joinPath(r[1], r[0]) });

// Sortierung wie im Programm: Ordner zuerst bei Name/Ordner/Typ
function sortEntries(list, key, desc) {
  const foldersFirst = key === 0 || key === 1 || key === 4;
  const cmp = (a, b) => {
    switch (key) {
      case 1: return collator.compare(a.dir, b.dir) || collator.compare(a.name, b.name);
      case 2: return (a.size - b.size) || collator.compare(a.name, b.name);
      case 3: return (a.mod - b.mod) || collator.compare(a.name, b.name);
      case 4: return collator.compare(ext(a.name), ext(b.name)) || collator.compare(a.name, b.name);
      default: return collator.compare(a.name, b.name);
    }
  };
  list.sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return desc ? cmp(b, a) : cmp(a, b);
  });
  return list;
}

// ---------- Menüs und Dialoge ----------

const Menu = {
  stack: [],
  close() { this.stack.forEach((m) => m.remove()); this.stack = []; },
  show(x, y, items, level = 0) {
    while (this.stack.length > level) this.stack.pop().remove();
    const m = el('div', 'menu');
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { m.append(el('div', 'sep')); continue; }
      if (it.head) { m.append(el('div', 'head', it.head)); continue; }
      const mi = el('div', 'mi' + (it.disabled ? ' dis' : '') + (it.checked ? ' chk' : ''));
      mi.append(el('span', 'lb', it.label));
      if (it.key) mi.append(el('span', 'key', it.key));
      if (it.sub) mi.append(el('span', 'arrow', '›'));
      if (it.title) mi.title = it.title;
      mi.addEventListener('mouseenter', () => {
        m.querySelectorAll('.mi.open').forEach((o) => o.classList.remove('open'));
        if (it.sub && !it.disabled) {
          mi.classList.add('open');
          const r = mi.getBoundingClientRect();
          this.show(r.right - 4, r.top - 5, it.sub, level + 1);
        } else {
          while (this.stack.length > level + 1) this.stack.pop().remove();
        }
      });
      mi.addEventListener('mousedown', (e) => e.preventDefault());
      mi.addEventListener('click', () => {
        if (it.disabled || it.sub) return;
        this.close();
        it.action && it.action();
      });
      m.append(mi);
    }
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    this.stack.push(m);
  },
};
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) Menu.close(); }, true);
addEventListener('blur', () => Menu.close());
addEventListener('resize', () => Menu.close());

function modal(title, build, buttons) {
  return new Promise((resolve) => {
    const bg = el('div', 'modal-bg');
    const box = el('div', 'modal');
    box.append(el('h2', '', title));
    const ctx = { close: (v) => { bg.remove(); resolve(v); } };
    build(box, ctx);
    const bar = el('div', 'buttons');
    for (const b of buttons) {
      const bt = el('button', b.primary ? 'primary' : '', b.label);
      bt.addEventListener('click', () => ctx.close(b.value === undefined ? (ctx.value ? ctx.value() : null) : b.value));
      bar.append(bt);
      if (b.primary) ctx.primary = bt;
    }
    box.append(bar);
    bg.append(box);
    bg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); ctx.close(null); }
      if (e.key === 'Enter' && ctx.primary && e.target.tagName !== 'BUTTON') { e.preventDefault(); ctx.primary.click(); }
    });
    document.body.append(bg);
    (box.querySelector('input') || box.querySelector('button.primary') || box).focus();
  });
}

function askText(title, text, value) {
  return modal(title, (box, ctx) => {
    if (text) box.append(el('p', '', text));
    const inp = el('input');
    inp.type = 'text';
    inp.value = value || '';
    box.append(inp);
    ctx.value = () => inp.value.trim() || null;
    setTimeout(() => inp.select(), 0);
  }, [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true }]);
}

function confirmBox(title, text, okLabel) {
  return modal(title, (box) => box.append(el('p', '', text)),
    [{ label: 'Abbrechen', value: false }, { label: okLabel || 'OK', primary: true, value: true }]);
}

// Ordner auswählen: Baum wie in der Navigationsleiste + Pfad eintippen
function pickFolder(title, start) {
  return modal(title, (box, ctx) => {
    const inp = el('input');
    inp.type = 'text';
    inp.placeholder = 'Pfad eintippen oder unten auswählen';
    inp.value = start || '';
    const tree = el('div', 'picker');
    box.append(tree, inp);
    const nav = new NavTree(tree, { picker: true, onSelect: (p) => { inp.value = p; } });
    nav.load();
    ctx.value = () => inp.value.trim() || null;
  }, [{ label: 'Abbrechen', value: null }, { label: 'Auswählen', primary: true }]);
}

// ---------- Navigationsbaum (Schnellzugriff, Netzlaufwerke, Dieser PC) ----------

class NavTree {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.nodes = [];
    this.active = null;
    this.dropNode = null;
    this.springTimer = null;
    this.springNode = null;
    if (!opts.picker) this.bindDrop();
  }

  async load() {
    let r;
    try { r = await NAS.api('nav'); } catch (e) { return; }
    const keepOpen = new Set(this.flat().filter((n) => n.open).map((n) => n.key));
    this.nodes = r.groups.map((g) => ({
      key: 'g:' + g.id, name: g.name, group: g.id, depth: 0, open: g.id !== 'pc' || keepOpen.has('g:pc'), children:
        g.items.map((it) => ({ key: g.id + ':' + it.path, name: it.name, path: it.path, depth: 1, open: false, children: null, groupId: g.id })),
    }));
    if (keepOpen.size) this.nodes.forEach((n) => { if (keepOpen.has(n.key) !== n.open && n.group !== 'pc') n.open = keepOpen.has(n.key) || n.open; });
    this.render();
  }

  flat() {
    const out = [];
    const walk = (list) => list.forEach((n) => { out.push(n); if (n.open && n.children) walk(n.children); });
    walk(this.nodes);
    return out;
  }

  async expand(n, open = true) {
    if (open && n.path && n.children === null) {
      try {
        const r = await NAS.api('subdirs?dir=' + encodeURIComponent(n.path));
        n.children = r.dirs.map((d) => {
          const p = joinPath(n.path, d);
          return { key: 'd:' + p, name: d, path: p, depth: n.depth + 1, open: false, children: null };
        });
      } catch (e) { n.children = []; }
    }
    n.open = open;
    this.render();
  }

  render() {
    const frag = document.createDocumentFragment();
    for (const n of this.flat()) {
      const row = el('div', 'nav-item');
      row.style.paddingLeft = (4 + n.depth * 14) + 'px';
      const hasKids = n.group || n.children === null || n.children.length > 0;
      const tw = el('span', 'tw', hasKids ? (n.open ? '▾' : '▸') : '');
      tw.addEventListener('mousedown', (e) => { e.stopPropagation(); if (hasKids) this.expand(n, !n.open); });
      row.append(tw);
      if (!n.group) {
        const ic = el('span', 'ic');
        ic.innerHTML = iconSVG(4, true);
        row.append(ic);
      }
      row.append(el('span', 'nm', n.name));
      row.title = n.path || '';
      if (n === this.active) row.classList.add('active');
      if (n === this.dropNode) row.classList.add('drop');
      row._node = n;
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (n.group) { this.expand(n, !n.open); return; }
        this.active = n;
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(n.path);
        else App.activePane().openFolder(n.path);
      });
      row.addEventListener('dblclick', () => { if (!n.group) this.expand(n, !n.open); });
      if (!this.opts.picker) row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(n, e); });
      frag.append(row);
    }
    this.root.replaceChildren(frag);
  }

  contextMenu(n, e) {
    if (n.group) return;
    const pinned = App.isPinned(n.path);
    Menu.show(e.clientX, e.clientY, [
      { label: 'In linker Ansicht öffnen', action: () => App.panes[0].openFolder(n.path) },
      { label: 'In rechter Ansicht öffnen', action: () => { App.setSecond(true); App.panes[1].openFolder(n.path); } },
      { label: `Im ${App.explorer} öffnen`, action: () => App.reveal(n.path) },
      { sep: true },
      pinned ? { label: 'Vom Schnellzugriff lösen', action: () => App.unpin(n.path) }
        : { label: 'An Schnellzugriff anheften', action: () => App.pin(n.path) },
    ]);
  }

  nodeAt(e) {
    const row = e.target.closest && e.target.closest('.nav-item');
    return row ? row._node : null;
  }

  setDrop(n) {
    if (this.dropNode === n) return;
    this.dropNode = n;
    this.root.querySelectorAll('.nav-item').forEach((r) => r.classList.toggle('drop', r._node === n));
  }

  bindDrop() {
    this.root.addEventListener('dragover', (e) => {
      const kind = App.dragKind(e);
      const n = this.nodeAt(e);
      let target = null;
      if (kind && n) {
        if (n.group === 'quick' && kind === 'nas') target = n; // Ordner anheften
        else if (n.path) target = n;
      }
      if (target && kind === 'nas' && App.drag && target.path && App.drag.items.some((i) => sameP(i.path, target.path) || isInside(target.path, i.path))) target = null;
      this.setDrop(target);
      if (!target) { App.dragStatus(null); return; }
      e.preventDefault();
      if (target.group === 'quick') {
        e.dataTransfer.dropEffect = 'link';
        App.dragStatus('pin');
      } else {
        const copy = kind === 'files' || e.ctrlKey;
        e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
        App.dragStatus(copy, target.path);
      }
      if (target.path && !target.open && this.springNode !== target) {
        clearTimeout(this.springTimer);
        this.springNode = target;
        this.springTimer = setTimeout(() => this.expand(target, true), SPRING_MS);
      }
      App.dragAlive();
    });
    this.root.addEventListener('dragleave', (e) => {
      if (!this.root.contains(e.relatedTarget)) { this.setDrop(null); clearTimeout(this.springTimer); this.springNode = null; }
    });
    this.root.addEventListener('drop', async (e) => {
      const n = this.dropNode;
      this.setDrop(null);
      clearTimeout(this.springTimer);
      if (!n) return;
      e.preventDefault();
      if (n.group === 'quick') {
        const items = App.dropItems(e).filter((i) => i.dir);
        for (const i of items) await App.pin(i.path, true);
        App.endDrag();
        return;
      }
      await App.handleDrop(e, n.path);
    });
  }
}

// ---------- Eine Ansicht (Suche oder Ordner) ----------

const COLS = [
  { key: 'name', title: 'Name', sort: 0 },
  { key: 'typ', title: 'Typ', sort: 4 },
  { key: 'dir', title: 'Ordner', sort: 1 },
  { key: 'size', title: 'Größe', sort: 2, num: true },
  { key: 'mod', title: 'Geändert', sort: 3 },
];
const DEFAULT_WIDTHS = [300, 105, 330, 85, 130];

class Pane {
  constructor(idx, root) {
    this.idx = idx;
    this.root = root;
    this.st = App.state.panes[idx];
    this.text = '';
    this.folder = null; // angezeigter Ordner (null = Suche)
    this.base = []; // Einträge (Suche oder Ordnerinhalt)
    this.view = []; // sichtbare Zeilen inkl. aufgeklappter Unterordner beim Ziehen
    this.sel = new Set();
    this.anchor = -1;
    this.focusIdx = -1;
    this.counts = [0, 0, 0, 0, 0, 0];
    this.total = 0;
    this.seq = 0;
    this.dropIdx = -1;
    this.springIdx = -1;
    this.springTimer = null;
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';
    const bar1 = el('div', 'bar1');
    this.folderBt = el('button', '', 'Ordner ▾');
    this.folderBt.title = 'Feste Ordner (z. B. Digitale Eingänge) mit einem Klick anzeigen';
    this.search = el('input', 'search');
    this.search.type = 'search';
    this.search.placeholder = this.idx === 0 ? 'Suchen …  z. B. angebot müller *.pdf' : 'Zweite Suche … z. B. Zielordner suchen und doppelklicken';
    this.search.spellcheck = false;
    const inPath = el('label', 'inpath');
    this.inPathCB = el('input');
    this.inPathCB.type = 'checkbox';
    this.inPathCB.checked = !!this.st.inPath;
    inPath.append(this.inPathCB, 'Auch im Ordnerpfad');
    bar1.append(this.folderBt, this.search, inPath);

    const bar2 = el('div', 'bar2');
    bar2.append(el('span', '', 'Nur anzeigen:'));
    this.filterCBs = FILTERS.map((f) => {
      const lb = el('label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = (this.st.filter & f.bit) !== 0;
      const cnt = el('span', 'cnt');
      lb.append(cb, f.label, cnt);
      cb.addEventListener('change', () => {
        this.st.filter = this.filterCBs.reduce((acc, x, i) => acc | (x.cb.checked ? FILTERS[i].bit : 0), 0);
        App.saveState();
        if (this.folder) this.applyView(); else this.runSearch();
      });
      bar2.append(lb);
      return { cb, cnt };
    });

    this.pathbar = el('div', 'pathbar');
    this.pathbar.hidden = true;
    this.upBt = el('button', 'small', '↑ Nach oben');
    this.upBt.title = 'Eine Ebene höher (Rücktaste)';
    this.crumbs = el('div', 'crumbs');
    this.newBt = el('button', 'small', '+ Neuer Ordner');
    this.exBt = el('button', 'small', 'Im ' + App.explorer);
    this.backBt = el('button', 'small', '× Zurück zur Suche');
    this.pathbar.append(this.upBt, this.crumbs, this.newBt, this.exBt, this.backBt);

    const table = el('div', 'table');
    this.thead = el('div', 'thead');
    this.tbody = el('div', 'tbody');
    this.tbody.tabIndex = 0;
    this.spacer = el('div', 'spacer');
    this.rowsEl = el('div', 'rows');
    this.empty = el('div', 'empty');
    this.tbody.append(this.spacer, this.rowsEl, this.empty);
    table.append(this.thead, this.tbody);
    r.append(bar1, bar2, this.pathbar, table);

    this.buildHeader();
    this.bind();
  }

  visibleCols() { return PANEL ? [0, 4] : [0, 1, 2, 3, 4]; }

  buildHeader() {
    const widths = this.st.cols || DEFAULT_WIDTHS;
    const vis = this.visibleCols();
    this.root.style.setProperty('--cols', PANEL ? 'minmax(120px,1fr) 132px'
      : vis.map((c) => (c === 2 ? `minmax(${widths[c]}px,1fr)` : widths[c] + 'px')).join(' '));
    this.thead.innerHTML = '';
    for (const c of vis) {
      const col = COLS[c];
      const h = el('div', col.num ? 'num' : '');
      let t = col.title;
      if (this.st.sort === col.sort) t += this.st.desc ? '  ▼' : '  ▲';
      h.textContent = t;
      h.addEventListener('click', (e) => {
        if (e.target.classList.contains('rs')) return;
        if (this.st.sort === col.sort) this.st.desc = !this.st.desc;
        else { this.st.sort = col.sort; this.st.desc = false; }
        App.saveState();
        this.buildHeader();
        if (this.folder) this.applyView(); else this.runSearch();
      });
      if (!PANEL) {
        const rs = el('div', 'rs');
        rs.addEventListener('mousedown', (e) => this.startResize(e, c));
        h.append(rs);
      }
      this.thead.append(h);
    }
  }

  startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const widths = (this.st.cols || DEFAULT_WIDTHS).slice();
    const x0 = e.clientX, w0 = widths[c];
    const move = (ev) => {
      widths[c] = Math.max(50, w0 + ev.clientX - x0);
      this.st.cols = widths;
      this.buildHeader();
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); App.saveState(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }

  bind() {
    let timer = null;
    this.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.text = this.search.value;
        if (this.folder && this.text.trim()) this.closeFolder(true);
        this.runSearch();
      }, 90);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        if (this.view.length) { this.tbody.focus(); if (this.focusIdx < 0) this.selectOnly(0); }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.search.value) { this.search.value = ''; this.text = ''; this.runSearch(); }
      }
    });
    this.search.addEventListener('focus', () => App.setActive(this));
    this.tbody.addEventListener('focus', () => App.setActive(this));
    this.root.addEventListener('mousedown', () => App.setActive(this));
    this.inPathCB.addEventListener('change', () => { this.st.inPath = this.inPathCB.checked; App.saveState(); this.runSearch(); });
    this.folderBt.addEventListener('click', () => this.folderMenu());
    this.upBt.addEventListener('click', () => this.goUp());
    this.backBt.addEventListener('click', () => this.closeFolder());
    this.exBt.addEventListener('click', () => this.folder && App.reveal(this.folder));
    this.newBt.addEventListener('click', () => this.newFolder());

    this.tbody.addEventListener('scroll', () => this.render());
    new ResizeObserver(() => this.render()).observe(this.tbody);
    this.tbody.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.tbody.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.tbody.addEventListener('dblclick', (e) => { const i = this.rowIndexAt(e); if (i >= 0) this.activate(i); });
    this.tbody.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e); });
    this.tbody.addEventListener('keydown', (e) => this.onKey(e));
    this.tbody.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.tbody.addEventListener('dragend', () => App.endDrag());
    for (const t of [this.tbody, this.pathbar]) {
      t.addEventListener('dragover', (e) => this.onDragOver(e));
      t.addEventListener('dragleave', (e) => { if (!t.contains(e.relatedTarget)) this.clearDrop(); });
      t.addEventListener('drop', (e) => this.onDrop(e));
    }
  }

  // ----- Suche -----

  async runSearch() {
    if (this.folder) return;
    const seq = ++this.seq;
    const text = this.search.value.trim();
    if (!text && !this.st.filter) {
      this.base = [];
      this.total = 0;
      this.counts = [0, 0, 0, 0, 0, 0];
      this.applyView(true);
      return;
    }
    let r;
    try {
      r = await NAS.api('search', { text, filter: this.st.filter, inPath: !!this.st.inPath, sort: this.st.sort, desc: !!this.st.desc, max: 20000 });
    } catch (e) { return; }
    if (seq !== this.seq || this.folder) return;
    this.base = r.rows.map(toEntry);
    this.total = r.total;
    this.counts = r.counts;
    this.noindex = r.noindex;
    this.ms = r.ms;
    this.applyView(true);
    if (App.active === this && !App.drag) {
      App.paneStatus(this.base.length < r.total
        ? `${thousands(r.total)} Treffer (${r.ms} ms) – die ersten ${thousands(this.base.length)} werden angezeigt, bitte genauer suchen.`
        : `${thousands(r.total)} Treffer (${r.ms} ms)`);
    }
  }

  // Filter anwenden (Ordneransicht) und Zeilen aufbauen
  applyView(resetScroll) {
    let list = this.base;
    if (this.folder) {
      this.counts = [list.length, 0, 0, 0, 0, 0];
      list.forEach((e) => { this.counts[e.cat]++; });
      if (this.st.filter) list = list.filter((e) => this.st.filter & (1 << e.cat));
      list = sortEntries(list.slice(), this.st.sort, this.st.desc);
    }
    this.view = list.map((e) => ({ e, depth: 0, open: false }));
    const keep = new Set();
    this.view.forEach((v) => { if (this.sel.has(v.e.path)) keep.add(v.e.path); });
    this.sel = keep;
    if (resetScroll) this.tbody.scrollTop = 0;
    this.updateCounts();
    this.updateEmpty();
    this.render();
  }

  updateCounts() {
    FILTERS.forEach((f, i) => { this.filterCBs[i].cnt.textContent = (this.folder || this.search.value.trim() || this.st.filter) ? ` (${thousands(this.counts[f.cat] || 0)})` : ''; });
  }

  updateEmpty() {
    let msg = '';
    if (this.view.length === 0) {
      if (this.folder) msg = this.folderError || (this.st.filter ? 'Keine passenden Dateien in diesem Ordner.' : 'Dieser Ordner ist leer.');
      else if (this.noindex) msg = 'Noch kein Index – bitte unter <b>Einstellungen</b> die Suchordner festlegen.';
      else if (!this.search.value.trim() && !this.st.filter) msg = this.idx === 0
        ? 'Suchbegriff eingeben – mehrere Wörter: alle müssen vorkommen. Platzhalter: <b>*.pdf</b>, <b>rechnung 2026*</b><br>Oder links einen Ordner wählen bzw. <b>Ordner ▾</b> für feste Ordner.'
        : 'Zweite Ansicht: z. B. Zielordner suchen und doppelklicken – dann Dateien hierher ziehen.';
      else msg = 'Keine Treffer.';
    }
    this.empty.innerHTML = msg;
    this.empty.hidden = !msg;
  }

  // ----- Ordneransicht -----

  async openFolder(path, opts = {}) {
    if (!path) return;
    const r = await NAS.api('list?dir=' + encodeURIComponent(path)).catch(() => null);
    if (!r) return;
    const changed = !this.folder || !sameP(this.folder, path);
    this.folder = path;
    this.folderError = r.error || '';
    const rows = r.rows.map(toEntry);
    if (opts.silent && !changed && JSON.stringify(rows) === JSON.stringify(this.base)) return;
    this.base = rows;
    if (changed && !opts.keepSel) this.sel.clear();
    const st = this.tbody.scrollTop;
    this.pathbar.hidden = false;
    this.renderCrumbs();
    this.applyView(changed);
    if (!changed) this.tbody.scrollTop = st;
    if (!opts.silent) {
      App.setActive(this);
      App.paneStatus(r.error ? r.error : `${path} – ${thousands(rows.length)} Einträge`);
      if (opts.select) { const i = this.view.findIndex((v) => sameP(v.e.path, opts.select)); if (i >= 0) { this.selectOnly(i); this.scrollTo(i); } }
    }
  }

  closeFolder(keepText) {
    this.folder = null;
    this.pathbar.hidden = true;
    this.sel.clear();
    if (!keepText) this.search.focus();
    this.runSearch();
  }

  goUp() {
    if (!this.folder) return;
    const p = parentOf(this.folder);
    if (p) this.openFolder(p, { select: this.folder });
  }

  renderCrumbs() {
    this.crumbs.innerHTML = '';
    const list = crumbsOf(this.folder);
    list.forEach((c, i) => {
      const b = el('button', 'crumb' + (i === list.length - 1 ? ' last' : ''), c.label);
      b.title = c.path;
      b.addEventListener('click', () => this.openFolder(c.path));
      const s = el('button', 'crumb sep', '›');
      s.title = 'Unterordner anzeigen';
      s.addEventListener('click', () => this.subfolderMenu(s, c.path, list[i + 1] && list[i + 1].path));
      this.crumbs.append(b, s);
    });
    this.crumbs.scrollLeft = 1e6;
  }

  async subfolderMenu(anchor, dir, current) {
    const r = await NAS.api('subdirs?dir=' + encodeURIComponent(dir)).catch(() => null);
    if (!r) return;
    const rect = anchor.getBoundingClientRect();
    const items = r.dirs.map((d) => {
      const p = joinPath(dir, d);
      return { label: d, checked: current && sameP(p, current), action: () => this.openFolder(p) };
    });
    Menu.show(rect.left, rect.bottom + 2, items.length ? items : [{ label: '(keine Unterordner)', disabled: true }]);
  }

  async newFolder() {
    const dir = this.folder;
    if (!dir) return;
    const name = await askText('Neuer Ordner', 'Name des neuen Ordners in ' + dir + ':', 'Neuer Ordner');
    if (!name) return;
    const r = await NAS.api('mkdir', { dir, name });
    if (r.error) { App.setStatus(r.error, true); return; }
    await this.openFolder(dir, { select: r.path });
  }

  // ----- Darstellung (nur sichtbare Zeilen) -----

  render() {
    if (typeof Vorschau !== 'undefined') Vorschau.auswahl(this);
    const n = this.view.length;
    this.spacer.style.height = n * ROW_H + 'px';
    const top = this.tbody.scrollTop;
    const h = this.tbody.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(n, Math.ceil((top + h) / ROW_H) + 5);
    this.rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    const vis = this.visibleCols();
    const pool = this.rowsEl.children;
    let k = 0;
    for (let i = first; i < last; i++, k++) {
      let row = pool[k];
      if (!row) { row = el('div', 'row'); row.draggable = true; this.rowsEl.append(row); }
      this.fillRow(row, i, vis);
    }
    while (this.rowsEl.children.length > k) this.rowsEl.lastChild.remove();
  }

  fillRow(row, i, vis) {
    const v = this.view[i];
    const e = v.e;
    const key = `${e.path}|${v.depth}|${v.open}|${e.size}|${e.mod}`;
    let cls = 'row';
    if (v.depth > 0) cls += ' treeRow';
    else if (e.isDir) cls += ' folder';
    if (this.sel.has(e.path)) cls += ' sel';
    if (i === this.dropIdx) cls += ' drop';
    row.className = cls;
    row._idx = i;
    if (row._key === key) return;
    row._key = key;
    row.replaceChildren();
    for (const c of vis) {
      let cell;
      switch (c) {
        case 0: {
          cell = el('div', 'name');
          if (v.depth > 0) {
            cell.style.paddingLeft = (8 + (v.depth - 1) * 18) + 'px';
            cell.append(el('span', 'tree', v.open ? '└▾' : '└─'));
          }
          const ic = el('span', 'ic');
          ic.innerHTML = iconSVG(e.cat, e.isDir);
          cell.append(ic, el('span', 'tx', e.name));
          cell.title = PANEL ? e.path : e.name;
          break;
        }
        case 1: cell = el('div', 'typ c' + e.cat, typeLabel(e)); break;
        case 2: cell = el('div', 'dir', e.dir); cell.title = e.dir; break;
        case 3: cell = el('div', 'num', e.isDir ? '' : formatSize(e.size)); break;
        case 4: cell = el('div', '', formatDate(e.mod)); break;
      }
      row.append(cell);
    }
  }

  rowIndexAt(e) {
    const row = e.target.closest && e.target.closest('.row');
    if (row && row._idx !== undefined) return row._idx;
    const r = this.tbody.getBoundingClientRect();
    const i = Math.floor((e.clientY - r.top + this.tbody.scrollTop) / ROW_H);
    return i >= 0 && i < this.view.length && e.clientY >= r.top ? i : -1;
  }

  scrollTo(i) {
    const top = i * ROW_H, h = this.tbody.clientHeight;
    if (top < this.tbody.scrollTop) this.tbody.scrollTop = top;
    else if (top + ROW_H > this.tbody.scrollTop + h) this.tbody.scrollTop = top + ROW_H - h;
  }

  // ----- Auswahl -----

  selectOnly(i) {
    this.sel = new Set([this.view[i].e.path]);
    this.anchor = this.focusIdx = i;
    this.render();
  }

  selectRange(i) {
    const a = Math.max(0, this.anchor), lo = Math.min(a, i), hi = Math.max(a, i);
    this.sel = new Set(this.view.slice(lo, hi + 1).map((v) => v.e.path));
    this.focusIdx = i;
    this.render();
  }

  selected() { return this.view.filter((v) => this.sel.has(v.e.path)).map((v) => v.e); }

  onMouseDown(e) {
    const i = this.rowIndexAt(e);
    this.pendingSingle = -1;
    if (i < 0) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey) { this.sel.clear(); this.render(); }
      return;
    }
    const p = this.view[i].e.path;
    if (e.button === 2) { if (!this.sel.has(p)) this.selectOnly(i); return; }
    if (e.ctrlKey || e.metaKey) {
      if (this.sel.has(p)) this.sel.delete(p); else this.sel.add(p);
      this.anchor = this.focusIdx = i;
      this.render();
    } else if (e.shiftKey) {
      this.selectRange(i);
    } else if (this.sel.has(p)) {
      this.pendingSingle = i; // erst beim Loslassen – damit man mehrere ziehen kann
      this.focusIdx = i;
    } else {
      this.selectOnly(i);
    }
  }

  onMouseUp(e) {
    if (this.pendingSingle >= 0 && e.button === 0) {
      const i = this.rowIndexAt(e);
      if (i === this.pendingSingle) this.selectOnly(i);
    }
    this.pendingSingle = -1;
  }

  onKey(e) {
    const n = this.view.length;
    const move = (i) => {
      i = Math.max(0, Math.min(n - 1, i));
      if (n === 0) return;
      if (e.shiftKey) this.selectRange(i); else this.selectOnly(i);
      this.scrollTo(i);
    };
    const page = Math.max(1, Math.floor(this.tbody.clientHeight / ROW_H) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(this.focusIdx + 1); break;
      case 'ArrowUp':
        e.preventDefault();
        if (this.focusIdx <= 0 && !this.folder) { this.search.focus(); break; }
        move(this.focusIdx - 1); break;
      case 'PageDown': e.preventDefault(); move(this.focusIdx + page); break;
      case 'PageUp': e.preventDefault(); move(this.focusIdx - page); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(n - 1); break;
      case 'Enter': e.preventDefault(); if (this.focusIdx >= 0) this.activate(this.focusIdx); break;
      case 'Backspace': e.preventDefault(); this.goUp(); break;
      case 'F2': e.preventDefault(); this.rename(); break;
      case 'a': case 'A':
        if (ctrl) { e.preventDefault(); this.sel = new Set(this.view.map((v) => v.e.path)); this.render(); }
        break;
      case 'c': case 'C':
        if (ctrl && e.shiftKey) { e.preventDefault(); App.copyText(this.selected().map((x) => x.path).join('\r\n'), 'Pfad kopiert.'); }
        else if (ctrl) { e.preventDefault(); App.copyFiles(this.selected().map((x) => x.path)); }
        break;
      default:
        // Tippen springt ins Suchfeld
        if (e.key.length === 1 && !ctrl && !e.altKey && !this.folder) { this.search.focus(); }
    }
  }

  activate(i) {
    const e = this.view[i].e;
    if (e.isDir) { this.openFolder(e.path); return; }
    const files = this.selected().filter((x) => !x.isDir).map((x) => x.path);
    App.openFiles(files.length && this.sel.has(e.path) ? files : [e.path]);
  }

  // ----- Umbenennen (F2) -----

  rename() {
    const sel = this.selected();
    if (!sel.length) return;
    if (sel.length > 1) { this.renameMany(sel); return; }
    const e = sel[0];
    const idx = this.view.findIndex((v) => v.e.path === e.path);
    if (idx < 0) return;
    this.scrollTo(idx);
    this.editRename(idx, e, e.name);
  }

  // Eingabefeld direkt über dem Namen (wie im Explorer)
  editRename(idx, e, value) {
    if (this.renameBox) this.renameBox.remove();
    const nameCol = this.thead.children[0];
    const inp = el('input', 'rename');
    inp.value = value;
    inp.spellcheck = false;
    inp.style.top = (idx * ROW_H + 1) + 'px';
    inp.style.left = '30px';
    inp.style.width = Math.max(200, nameCol.getBoundingClientRect().width - 36) + 'px';
    this.tbody.append(inp);
    this.renameBox = inp;
    inp.focus();
    const dot = e.isDir ? -1 : value.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 ? dot : value.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      inp.remove();
      this.renameBox = null;
      this.tbody.focus();
      const name = inp.value.trim();
      if (!commit || !name || name === e.name) return;
      if (!e.isDir && ext(name) !== ext(e.name) &&
          !await confirmBox('Dateiendung ändern?', `Die Endung wird von „.${ext(e.name) || '–'}“ zu „.${ext(name) || '–'}“ geändert. Danach lässt sich die Datei eventuell nicht mehr öffnen.`, 'Ändern')) {
        this.editRename(idx, e, name);
        return;
      }
      const r = await NAS.api('rename', { path: e.path, name }).catch((err) => ({ error: err.message }));
      if (r.error) {
        App.setStatus(r.error, true);
        this.editRename(idx, e, name);
        return;
      }
      App.setStatus(`Umbenannt in „${name}“.`, true);
      await App.afterRename({ [e.path]: r.path });
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
    inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
    inp.addEventListener('blur', () => finish(true));
  }

  // Mehrere zusammenfassen: gleicher Name, durchnummeriert – „Rechnung Müller (1).pdf“, „(2)“ …
  async renameMany(sel) {
    const first = sel[0];
    const dot = first.isDir ? -1 : first.name.lastIndexOf('.');
    const base = await askText(`${sel.length} Elemente umbenennen`,
      'Gemeinsamer Name – die Elemente werden in der angezeigten Reihenfolge durchnummeriert, die Dateiendungen bleiben:',
      dot > 0 ? first.name.slice(0, dot) : first.name);
    if (!base) return;
    const moves = {};
    const errs = [];
    for (let i = 0; i < sel.length; i++) {
      const e = sel[i];
      const x = e.isDir ? '' : ext(e.name);
      const name = `${base} (${i + 1})${x ? '.' + x : ''}`;
      App.setStatus(`Benenne um ${i + 1}/${sel.length}: ${name} …`);
      const r = await NAS.api('rename', { path: e.path, name }).catch((err) => ({ error: err.message }));
      if (r.error) errs.push(`${e.name}: ${r.error}`); else moves[e.path] = r.path;
    }
    const n = Object.keys(moves).length;
    App.setStatus(`${n} Element(e) umbenannt.` + (errs.length ? ' Nicht umbenannt: ' + errs.join('; ') : ''), true);
    if (n) await App.afterRename(moves);
  }

  // ----- Menüs -----

  async folderMenu() {
    await App.refreshHello();
    const h = App.hello;
    const r = this.folderBt.getBoundingClientRect();
    const favs = (h.favorites || []).map((f) => ({ label: f.name, title: f.path, action: () => this.openFolder(f.path) }));
    const start = (h.start || [])[this.idx] || '';
    const items = [{ head: 'Feste Ordner' }, ...(favs.length ? favs : [{ label: '(noch keine festen Ordner)', disabled: true }]), { sep: true },
      { label: 'Ordner auswählen und anzeigen …', action: async () => { const p = await pickFolder('Ordner anzeigen', this.folder || ''); if (p) this.openFolder(p); } },
      { label: 'Angezeigten Ordner als festen Ordner merken …', disabled: !this.folder, action: async () => {
        const name = await askText('Festen Ordner merken', 'Name im Menü (z. B. „Digitale Eingänge“):', baseName(this.folder));
        if (name) await App.pin(this.folder, false, name);
      } },
      { label: `Angezeigten Ordner beim Start ${this.idx === 0 ? 'links' : 'rechts'} öffnen`, disabled: !this.folder,
        checked: this.folder && start && sameP(start, this.folder),
        action: async () => { await NAS.api('startfolder', { pane: this.idx, path: this.folder }); App.setStatus('Wird künftig beim Start geöffnet: ' + this.folder, true); } },
    ];
    if (start) items.push({ label: 'Startordner nicht mehr öffnen', title: start, action: () => NAS.api('startfolder', { pane: this.idx, path: '' }) });
    if (favs.length) {
      items.push({ label: 'Festen Ordner entfernen', sub: h.favorites.map((f) => ({ label: f.name, title: f.path, action: () => App.unpin(f.path) })) });
    }
    Menu.show(r.left, r.bottom + 2, items);
  }

  contextMenu(e) {
    const i = this.rowIndexAt(e);
    const sel = this.selected();
    if (i < 0 || !sel.length) {
      if (!this.folder) return;
      Menu.show(e.clientX, e.clientY, [
        { label: 'Neuer Ordner …', action: () => this.newFolder() },
        { label: `Im ${App.explorer} öffnen`, action: () => App.reveal(this.folder) },
        { label: 'Aktualisieren', action: () => this.openFolder(this.folder) },
      ]);
      return;
    }
    const paths = sel.map((x) => x.path);
    const first = sel[0];
    const one = sel.length === 1;
    const targets = (App.hello.copyTargets || []).filter(Boolean);
    const targetMenu = (move) => [
      ...targets.map((t) => ({ label: t, action: () => App.transfer(paths, t, move, true) })),
      ...(targets.length ? [{ sep: true }] : []),
      { label: 'Anderer Ordner …', action: async () => { const t = await pickFolder(move ? 'Verschieben nach' : 'Kopieren nach'); if (t) App.transfer(paths, t, move, true); } },
    ];
    const dir = first.isDir ? first.path : first.dir;
    Menu.show(e.clientX, e.clientY, [
      { label: 'Öffnen', key: 'Enter', action: () => this.activate(this.view.findIndex((v) => v.e === first)) },
      ...(one && Vorschau.geeignet(first) && !PANEL ? [{ label: 'In der PDF-Vorschau zeigen', action: () => Vorschau.zeigen(first.path) }] : []),
      { label: `Im ${App.explorer} zeigen`, action: () => App.reveal(first.path) },
      { label: 'In der anderen Ansicht öffnen', action: () => { App.setSecond(true); App.panes[1 - this.idx].openFolder(dir); } },
      ...(!this.folder ? [{ label: 'Ordner hier anzeigen', action: () => this.openFolder(first.dir, { select: first.path }) }] : []),
      { sep: true },
      { label: one ? 'Umbenennen' : `${sel.length} Elemente umbenennen …`, key: 'F2', action: () => this.rename() },
      { sep: true },
      { label: 'Kopieren', key: 'Strg+C', action: () => App.copyFiles(paths) },
      { label: 'Kopieren nach', sub: targetMenu(false) },
      { label: 'Verschieben nach', sub: targetMenu(true) },
      { sep: true },
      { label: 'Pfad kopieren', key: 'Strg+Umschalt+C', action: () => App.copyText(paths.join('\r\n'), 'Pfad kopiert.') },
      { label: 'Name kopieren', action: () => App.copyText(sel.map((x) => x.name).join('\r\n'), 'Name kopiert.') },
      ...(one && first.isDir ? [{ sep: true }, App.isPinned(first.path)
        ? { label: 'Vom Schnellzugriff lösen', action: () => App.unpin(first.path) }
        : { label: 'An Schnellzugriff anheften', action: () => App.pin(first.path) }] : []),
      ...(this.folder ? [{ sep: true }, { label: 'Neuer Ordner …', action: () => this.newFolder() }] : []),
    ]);
  }

  // ----- Ziehen -----

  onDragStart(e) {
    const i = this.rowIndexAt(e);
    if (i < 0) { e.preventDefault(); return; }
    const p = this.view[i].e.path;
    if (!this.sel.has(p)) this.selectOnly(i);
    const items = this.selected().map((x) => ({ path: x.path, name: x.name, dir: x.isDir }));
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copyMove';
    dt.setData(T, JSON.stringify({ items, src: this.idx }));
    dt.setData('text/plain', items.map((x) => x.path).join('\r\n'));
    const files = items.filter((x) => !x.dir);
    if (files.length === 1 && App.hello && App.hello.dl) {
      // auf den Desktop / in den Explorer ziehen
      const f = files[0];
      dt.setData('DownloadURL', `${MIME[ext(f.name)] || 'application/octet-stream'}:${f.name}:${App.hello.dl}${encodeURIComponent(f.path)}`);
    }
    if (items.length > 1) {
      const ghost = el('div', '', `${items.length} Elemente`);
      ghost.style.cssText = 'position:fixed;top:-100px;left:0;padding:4px 10px;background:#1F6FB2;color:#fff;border-radius:5px;font:600 13px Segoe UI';
      document.body.append(ghost);
      dt.setDragImage(ghost, -12, -8);
      setTimeout(() => ghost.remove(), 0);
    }
    App.drag = { src: this, items };
    App.setStatus(items.length === 1 ? `Ziehe „${items[0].name}“ – in die andere Ansicht, in einen Ordner, in WhatsApp/Gmail/Drive oder auf den Desktop`
      : `Ziehe ${items.length} Elemente`, false, true);
  }

  dropTargetAt(e) {
    if (this.pathbar.contains(e.target)) return this.folder ? { path: this.folder, idx: -1 } : null;
    const i = this.rowIndexAt(e);
    if (i >= 0 && this.view[i].e.isDir) return { path: this.view[i].e.path, idx: i };
    if (this.folder) return { path: this.folder, idx: -1 };
    return null;
  }

  setDropIdx(i, bar) {
    if (this.dropIdx !== i) { this.dropIdx = i; this.render(); }
    this.pathbar.classList.toggle('drop', !!bar);
  }

  clearDrop() {
    this.setDropIdx(-1, false);
    clearTimeout(this.springTimer);
    this.springIdx = -1;
  }

  onDragOver(e) {
    const kind = App.dragKind(e);
    if (!kind) return;
    App.dragAlive();
    this.autoScroll(e);
    let t = this.dropTargetAt(e);
    if (t && kind === 'nas' && App.drag && App.drag.items.some((i) => sameP(i.path, t.path) || isInside(t.path, i.path) ||
        sameP(parentOf(i.path), t.path))) {
      t = null; // in sich selbst oder in den eigenen Ordner
    }
    if (!t) { this.setDropIdx(-1, false); e.dataTransfer.dropEffect = 'none'; App.dragStatus(null); return; }
    e.preventDefault();
    this.setDropIdx(t.idx, t.idx < 0);
    const copy = kind === 'files' || e.ctrlKey;
    e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    App.dragStatus(copy, t.path);
    // aufspringende Ordner: kurz verweilen → Unterordner klappen darunter auf
    if (t.idx >= 0 && !this.view[t.idx].open) {
      if (this.springIdx !== t.idx) {
        clearTimeout(this.springTimer);
        this.springIdx = t.idx;
        const idx = t.idx;
        this.springTimer = setTimeout(() => this.expand(idx), SPRING_MS);
      }
    } else if (t.idx < 0) {
      clearTimeout(this.springTimer);
      this.springIdx = -1;
    }
  }

  autoScroll(e) {
    const r = this.tbody.getBoundingClientRect();
    const now = Date.now();
    if (this.lastScroll && now - this.lastScroll < 40) return;
    if (e.clientY < r.top + 28 && e.clientY >= r.top) { this.tbody.scrollTop -= ROW_H; this.lastScroll = now; }
    else if (e.clientY > r.bottom - 28 && e.clientY <= r.bottom) { this.tbody.scrollTop += ROW_H; this.lastScroll = now; }
  }

  async expand(idx) {
    const v = this.view[idx];
    if (!v || !v.e.isDir || v.open) return;
    const r = await NAS.api('subdirs?dir=' + encodeURIComponent(v.e.path)).catch(() => null);
    if (!r || this.view[idx] !== v) return;
    v.open = true;
    const kids = r.dirs.map((d) => ({ e: { name: d, dir: v.e.path, isDir: true, size: 0, mod: 0, cat: CAT.FOLDER, path: joinPath(v.e.path, d) }, depth: v.depth + 1, open: false }));
    this.view.splice(idx + 1, 0, ...kids);
    if (kids.length) {
      // aufgeklappte Unterordner sichtbar machen
      const lastTop = (idx + kids.length + 1) * ROW_H, h = this.tbody.clientHeight;
      if (lastTop > this.tbody.scrollTop + h) this.tbody.scrollTop = Math.min(idx * ROW_H, lastTop - h);
    }
    this.render();
  }

  collapseTrees() {
    if (this.view.some((v) => v.depth > 0 || v.open)) {
      this.view = this.view.filter((v) => v.depth === 0);
      this.view.forEach((v) => { v.open = false; });
      this.render();
    }
    this.clearDrop();
  }

  async onDrop(e) {
    const t = this.dropTargetAt(e);
    this.clearDrop();
    if (!t) return;
    e.preventDefault();
    await App.handleDrop(e, t.path);
  }

  async refresh() {
    if (this.folder) await this.openFolder(this.folder, { silent: true, keepSel: true });
    else await this.runSearch();
  }
}

// ---------- Anwendung ----------

const App = {
  state: null,
  hello: {},
  panes: [],
  nav: null,
  active: null,
  drag: null,
  stickyUntil: 0,
  explorer: 'Explorer',

  defaultState() {
    const p = () => ({ filter: 0, inPath: false, sort: 0, desc: false, cols: DEFAULT_WIDTHS.slice() });
    return { nav: true, second: false, panes: [p(), p()] };
  },

  async start() {
    if (PANEL) document.body.classList.add('panel');
    if (/Mac/.test(navigator.platform)) $('#hint').textContent = '⌥⇧F öffnet die Suche im Browser';
    $('#retryBt').addEventListener('click', () => this.connect());
    await this.connect();
  },

  async connect() {
    const box = $('#connect');
    box.hidden = false;
    $('#retryBt').hidden = true;
    $('#connectText').textContent = 'Das Programm wird im Hintergrund gestartet …';
    for (let attempt = 0; ; attempt++) {
      try {
        await NAS.connect();
        break;
      } catch (e) {
        const text = e.message === 'nohost'
          ? 'Das Programm NAS-Suche läuft gerade nicht. Bitte NasSuche.exe starten – diese Seite verbindet sich dann von selbst.\n\n' +
            'Tipp: Im Programm einmal „Einstellungen → Allgemein → NAS-Suche in Chrome einrichten“ ausführen. Dann startet Chrome das Programm künftig selbst.'
          : 'Das Programm antwortet nicht: ' + (e.detail || e.message) + '\nBitte NasSuche.exe starten.';
        $('#connectText').textContent = text;
        $('#retryBt').hidden = false;
        await sleep(attempt < 10 ? 2500 : 6000);
      }
    }
    box.hidden = true;
    await this.init();
  },

  async init() {
    if (this.panes.length) return;
    await this.refreshHello();
    let st = {};
    try { st = await NAS.api('state'); } catch (e) { /* Standard */ }
    const def = this.defaultState();
    this.state = Object.assign(def, st || {});
    this.state.panes = [0, 1].map((i) => Object.assign(def.panes[i], (st.panes || [])[i] || {}));
    this.panes = [new Pane(0, $('#pane0')), new Pane(1, $('#pane1'))];
    this.active = this.panes[0];
    this.nav = new NavTree($('#nav'));
    this.nav.load();

    $('#navBt').addEventListener('click', () => this.setNav(!this.state.nav));
    $('#secondBt').addEventListener('click', () => this.setSecond(!this.state.second));
    $('#refreshBt').addEventListener('click', () => this.reindex());
    $('#settingsBt').addEventListener('click', () => this.settings());
    this.setNav(this.state.nav, true);
    this.setSecond(this.state.second, true);
    this.bindGlobal();
    Vorschau.init();

    const start = this.hello.start || [];
    if (start[0]) this.panes[0].openFolder(start[0]);
    else this.panes[0].runSearch();
    if (start[1] && !PANEL) this.panes[1].openFolder(start[1]);
    else this.panes[1].runSearch();
    this.panes[0].search.focus();
    this.setStatus(this.hello.status || '');

    setInterval(() => this.poll(), 3000);
    setInterval(() => { if (!this.drag) this.panes.forEach((p) => p.folder && p.openFolder(p.folder, { silent: true, keepSel: true })); }, 10000);
  },

  async refreshHello() {
    try {
      this.hello = await NAS.api('hello');
      SEP = this.hello.sep || '\\';
      this.explorer = SEP === '\\' ? 'Explorer' : 'Finder';
    } catch (e) { /* später erneut */ }
  },

  async poll() {
    const wasIndexing = this.hello.indexing;
    await this.refreshHello();
    $('#refreshBt').textContent = this.hello.indexing ? 'Liest ein …' : 'Aktualisieren (F5)';
    if (!this.drag && Date.now() > this.stickyUntil && this.hello.indexing) this.setStatus(this.hello.status);
    if (wasIndexing && !this.hello.indexing) {
      this.setStatus(this.hello.status);
      this.panes.forEach((p) => !p.folder && p.runSearch());
    }
  },

  saveState() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => NAS.api('state', this.state).catch(() => {}), 400);
  },

  setNav(on, init) {
    this.state.nav = on;
    $('#nav').hidden = !on;
    $('#navBt').textContent = on ? 'Navigation ausblenden' : 'Navigation einblenden';
    if (!init) this.saveState();
  },

  setSecond(on, init) {
    if (PANEL) on = false;
    this.state.second = on;
    $('#pane1').hidden = !on;
    $('#secondBt').textContent = on ? 'Zweite Ansicht ausblenden' : 'Zweite Ansicht einblenden';
    if (on && this.panes[1]) this.panes[1].render();
    if (!init) this.saveState();
  },

  setActive(p) {
    if (this.active === p) return;
    this.active = p;
    this.panes.forEach((x) => x.root.classList.toggle('active', x === p));
  },

  activePane() {
    return this.active && !this.active.root.hidden ? this.active : this.panes[0];
  },

  setStatus(text, sticky, drag) {
    const s = $('#status');
    s.textContent = text || '';
    s.classList.toggle('drag', !!drag);
    if (sticky) this.stickyUntil = Date.now() + 5000;
  },

  paneStatus(text) {
    if (Date.now() > this.stickyUntil && !this.drag) this.setStatus(text);
  },

  // ----- Ziehen & Ablegen -----

  dragKind(e) {
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes(T)) return 'nas';
    if (types.includes('Files')) return 'files';
    return null;
  },

  dragStatus(copy, target) {
    if (copy === null) { this.setStatus(this.drag ? 'Hier nicht ablegen' : '', false, !!this.drag); return; }
    if (copy === 'pin') { this.setStatus('Loslassen = an Schnellzugriff anheften', false, true); return; }
    this.setStatus(copy ? `Loslassen = KOPIEREN nach ${target}` : `Loslassen = VERSCHIEBEN nach ${target}   (Strg gedrückt halten = kopieren)`, false, true);
  },

  // Ziehen läuft noch (auch wenn es woanders begonnen hat) – sonst nach kurzer Zeit aufräumen
  dragAlive() {
    clearTimeout(this.dragWatch);
    this.dragWatch = setTimeout(() => this.endDrag(), 1500);
  },

  endDrag() {
    clearTimeout(this.dragWatch);
    const was = this.drag;
    this.drag = null;
    this.panes.forEach((p) => p.collapseTrees());
    if (this.nav) this.nav.setDrop(null);
    $('#status').classList.remove('drag');
    if (was && Date.now() > this.stickyUntil) this.setStatus('');
  },

  dropItems(e) {
    if (this.drag) return this.drag.items;
    try { return (JSON.parse(e.dataTransfer.getData(T) || '{}').items) || []; } catch (err) { return []; }
  },

  async handleDrop(e, target) {
    const kind = this.dragKind(e);
    if (kind === 'nas') {
      const items = this.dropItems(e);
      const copy = e.ctrlKey;
      this.endDrag();
      if (items.length) await this.transfer(items.map((i) => i.path), target, !copy);
    } else if (kind === 'files') {
      const files = [];
      let dirs = 0;
      for (const it of Array.from(e.dataTransfer.items || [])) {
        if (it.kind !== 'file') continue;
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry && entry.isDirectory) { dirs++; continue; }
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      this.endDrag();
      await this.upload(files, target, dirs);
    }
  },

  async upload(files, target, dirs) {
    let ok = 0;
    const errs = [];
    for (let i = 0; i < files.length; i++) {
      this.setStatus(`Speichere ${i + 1}/${files.length}: ${files[i].name} …`);
      try {
        const r = await NAS.api(`upload?dir=${encodeURIComponent(target)}&name=${encodeURIComponent(files[i].name)}`, files[i]);
        if (r.error) errs.push(r.error); else ok++;
      } catch (e) { errs.push(files[i].name + ': ' + e.message); }
    }
    let msg = `${ok} Datei(en) nach ${target} kopiert.`;
    if (dirs) msg += ` ${dirs} Ordner übersprungen (Ordner bitte im Explorer kopieren).`;
    if (errs.length) msg += ' Fehler: ' + errs.join('; ');
    this.setStatus(msg, true);
    this.panes.forEach((p) => p.refresh());
  },

  async transfer(paths, target, move, remember) {
    this.setStatus(`${move ? 'Verschiebe' : 'Kopiere'} ${paths.length} Element(e) nach ${target} …`, true);
    let r;
    try { r = await NAS.api('transfer', { paths, target, move }); } catch (e) { r = { message: 'Fehler: ' + e.message }; }
    this.setStatus(r.error || r.message, true);
    if (remember && !r.error) NAS.api('copytarget', { path: target }).then(() => this.refreshHello());
    // verschobene Dateien in der Auswahl mitnehmen
    if (r.moves) this.panes.forEach((p) => { for (const [from, to] of Object.entries(r.moves)) if (p.sel.delete(from)) p.sel.add(to); });
    await Promise.all(this.panes.map((p) => p.refresh()));
    this.nav.load();
  },

  // Nach dem Umbenennen: Auswahl mitnehmen, Ansichten und Navigation auffrischen
  async afterRename(moves) {
    this.panes.forEach((p) => {
      for (const [from, to] of Object.entries(moves)) {
        if (p.sel.delete(from)) p.sel.add(to);
        if (p.folder && (sameP(p.folder, from) || isInside(p.folder, from))) p.folder = to + p.folder.slice(from.length);
      }
    });
    await Promise.all(this.panes.map((p) => p.refresh()));
    this.nav.load();
  },

  // ----- Aktionen -----

  async openFiles(paths) {
    if (!paths.length) return;
    if (paths.length > 5 && !await confirmBox('Öffnen', `${paths.length} Dateien öffnen?`, 'Öffnen')) return;
    let r = await NAS.native({ cmd: 'open', paths });
    if (r.nohost) r = await NAS.api('open', { paths }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok && r.error) this.setStatus(r.error, true);
  },

  async reveal(path) {
    const r = await NAS.native({ cmd: 'reveal', path });
    if (r.nohost) await NAS.api('reveal', { path }).catch(() => {});
  },

  async copyFiles(paths) {
    if (!paths.length) return;
    const r = await NAS.api('clipboard', { paths }).catch((e) => ({ error: e.message }));
    this.setStatus(r.error ? 'Kopieren fehlgeschlagen: ' + r.error
      : `${paths.length} Element(e) kopiert – mit Strg+V einfügen (Explorer, Gmail, WhatsApp, Drive …).`, true);
  },

  async copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); this.setStatus(msg, true); } catch (e) { this.setStatus('Zwischenablage nicht verfügbar', true); }
  },

  isPinned(path) { return (this.hello.favorites || []).some((f) => sameP(f.path, path)); },

  async pin(path, quiet, name) {
    await NAS.api('favorite', { action: 'add', path, name: name || baseName(path) });
    await this.refreshHello();
    this.nav.load();
    if (!quiet) this.setStatus('Angeheftet: ' + path, true);
  },

  async unpin(path) {
    await NAS.api('favorite', { action: 'remove', path });
    await this.refreshHello();
    this.nav.load();
    this.setStatus('Vom Schnellzugriff gelöst: ' + path, true);
  },

  async reindex() {
    await NAS.api('reindex').catch(() => {});
    this.setStatus('Index wird neu eingelesen …', true);
    $('#refreshBt').textContent = 'Liest ein …';
    this.hello.indexing = true;
  },

  async settings() {
    await NAS.native({ cmd: 'foreground' });
    await NAS.api('settings').catch(() => {});
    this.setStatus(this.hello.background
      ? 'Das Programm NAS-Suche wird geöffnet – dort „Einstellungen …“ wählen.'
      : 'Die Einstellungen sind im Programmfenster geöffnet.', true);
  },

  bindGlobal() {
    addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-bg:not([hidden])')) return;
      if (e.key === 'F5') { e.preventDefault(); this.reindex(); }
      else if (e.key === 'Escape') {
        Menu.close();
        const p = this.activePane();
        if (document.activeElement !== p.search && p.search.value) { p.search.value = ''; p.text = ''; p.runSearch(); p.search.focus(); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        e.preventDefault();
        this.activePane().search.focus();
        this.activePane().search.select();
      }
    });
    // Dateien versehentlich irgendwo anders fallen lassen: Chrome soll sie nicht öffnen
    addEventListener('dragover', (e) => { if (this.dragKind(e)) this.dragAlive(); });
    addEventListener('drop', (e) => { e.preventDefault(); this.endDrag(); });
  },
};

App.start();
