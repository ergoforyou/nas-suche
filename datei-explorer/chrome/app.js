'use strict';
// ERGOFORYOU Datei-Explorer – Oberfläche in Chrome. Die Arbeit (Index, Verschieben, Löschen,
// NAS-Zugriff) erledigt das Programm DateiExplorer im Hintergrund; diese Seite spricht über NAS.api mit ihm.

const PANEL = new URLSearchParams(location.search).has('panel');
const T = 'application/x-dateiexplorer';
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
const TEXT_EXT = new Set(['txt', 'csv', 'log', 'md', 'json', 'xml', 'ini', 'cfg', 'bat', 'cmd', 'ps1', 'html', 'htm', 'css', 'js', 'go', 'py', 'sql', 'yml', 'yaml', 'tsv', 'eml']);
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
    if (this.opts.follow) await this.revealPath(this.opts.follow());
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
        else App.explorerPane().openFolder(n.path);
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
      { label: 'Links öffnen', action: () => App.panes[0].openFolder(n.path) },
      { label: 'Rechts öffnen', action: () => App.panes[1].openFolder(n.path) },
      { label: 'Einfügen', disabled: !App.clipFiles, action: () => App.paste(n.path) },
      { label: `Im ${App.explorer} öffnen`, action: () => App.reveal(n.path) },
      { label: 'Eigenschaften', action: () => App.properties([n.path]) },
      { sep: true },
      pinned ? { label: 'Vom Schnellzugriff lösen', action: () => App.unpin(n.path) }
        : { label: 'An Schnellzugriff anheften', action: () => App.pin(n.path) },
    ]);
  }

  // revealPath klappt den Baum bis zum Ordner auf und markiert ihn (wie der Windows-Explorer).
  async revealPath(path) {
    if (!path || !this.nodes.length) return;
    const seq = (this.revealSeq = (this.revealSeq || 0) + 1);
    let cur = null;
    for (const g of this.nodes.filter((n) => n.group === 'net' || n.group === 'pc')) {
      for (const c of g.children || []) {
        if (c.path && (sameP(c.path, path) || isInside(path, c.path)) && (!cur || c.path.length > cur.path.length)) cur = c;
      }
    }
    if (!cur) { this.active = null; this.render(); return; }
    const top = this.nodes.find((g) => g.children && g.children.includes(cur));
    if (top) top.open = true;
    for (let d = 0; d < 40 && !sameP(cur.path, path); d++) {
      if (cur.children === null) {
        try {
          const r = await NAS.api('subdirs?dir=' + encodeURIComponent(cur.path));
          cur.children = r.dirs.map((x) => { const p = joinPath(cur.path, x); return { key: 'd:' + p, name: x, path: p, depth: cur.depth + 1, open: false, children: null }; });
        } catch (e) { cur.children = []; }
      }
      if (seq !== this.revealSeq) return;
      const next = cur.children.find((c) => sameP(c.path, path) || isInside(path, c.path));
      if (!next) break;
      cur.open = true;
      cur = next;
    }
    // den aktuellen Ordner selbst aufklappen – seine Unterordner sind gleich anklickbar
    if (sameP(cur.path, path)) {
      if (cur.children === null) {
        try {
          const r = await NAS.api('subdirs?dir=' + encodeURIComponent(cur.path));
          cur.children = r.dirs.map((x) => { const p = joinPath(cur.path, x); return { key: 'd:' + p, name: x, path: p, depth: cur.depth + 1, open: false, children: null }; });
        } catch (e) { cur.children = []; }
      }
      if (seq !== this.revealSeq) return;
      cur.open = true;
    }
    this.active = cur;
    this.render();
    const el = Array.from(this.root.children).find((r) => r._node === cur);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // Unterordner eines Ordners beim nächsten Anzeigen neu lesen (nach Neu/Umbenennen/Verschieben)
  invalidate(path) {
    const walkN = (list) => { for (const n of list || []) { if (n.path && sameP(n.path, path)) { n.children = null; n.open = false; } else walkN(n.children); } };
    walkN(this.nodes);
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

// ---------- Eine Ansicht: Suche oben oder Explorer unten ----------

const COLS = [
  { key: 'name', title: 'Name', sort: 0 },
  { key: 'typ', title: 'Typ', sort: 4 },
  { key: 'dir', title: 'Ordner', sort: 1 },
  { key: 'size', title: 'Größe', sort: 2, num: true },
  { key: 'mod', title: 'Geändert', sort: 3 },
];
const DEFAULT_WIDTHS = [300, 105, 330, 85, 130];
const SCOPES = ['Überall (alle Suchordner)', 'Nur im linken Ordner', 'Nur im rechten Ordner'];

class Pane {
  constructor(idx, root) {
    this.idx = idx; // 0 = links, 1 = rechts, 2 = Suche oben
    this.isSearch = idx === 2;
    this.root = root;
    this.st = App.state.panes[idx];
    this.folder = null; // angezeigter Ordner (Explorer)
    this.history = [];
    this.histPos = -1;
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

  get side() { return ['links', 'rechts', 'Suche'][this.idx]; }
  other() { return this.isSearch ? App.explorerPane() : App.panes[1 - this.idx]; }

  build() {
    const r = this.root;
    r.innerHTML = '';
    if (this.isSearch) {
      const bar1 = el('div', 'bar1');
      this.search = el('input', 'search');
      this.search.type = 'search';
      this.search.placeholder = 'Dateien und Ordner finden …  z. B.  angebot müller *.pdf   (Strg+F)';
      this.search.spellcheck = false;
      this.scopeSel = el('select');
      SCOPES.forEach((t, i) => { const o = el('option', '', t); o.value = i; this.scopeSel.append(o); });
      this.scopeSel.value = App.state.scope || 0;
      this.scopeSel.title = 'Wo gesucht wird – Ordner außerhalb der Suchordner werden direkt durchsucht';
      const inPath = el('label', 'inpath');
      this.inPathCB = el('input');
      this.inPathCB.type = 'checkbox';
      this.inPathCB.checked = !!this.st.inPath;
      inPath.append(this.inPathCB, 'Auch im Ordnerpfad');
      bar1.append(el('span', 'lbl', 'Suchen:'), this.search, this.scopeSel, inPath, el('span', 'muted', 'Nur:'));
      this.filterCBs = FILTERS.map((f) => {
        const lb = el('label', 'f');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = (this.st.filter & f.bit) !== 0;
        const cnt = el('span', 'cnt');
        lb.append(cb, f.label, cnt);
        cb.addEventListener('change', () => {
          this.st.filter = this.filterCBs.reduce((acc, x, i) => acc | (x.cb.checked ? FILTERS[i].bit : 0), 0);
          App.saveState();
          this.runSearch();
        });
        bar1.append(lb);
        return { cb, cnt };
      });
      r.append(bar1);
    } else {
      this.pathbar = el('div', 'pathbar');
      const nb = (t, title) => { const b = el('button', 'nb small', t); b.title = title; return b; };
      this.backBt = nb('←', 'Zurück (Alt+←)');
      this.fwdBt = nb('→', 'Vor (Alt+→)');
      this.upBt = nb('↑', 'Eine Ebene höher (Alt+↑ / Rücktaste)');
      this.crumbs = el('div', 'crumbs');
      this.addr = el('input', 'addr');
      this.addr.type = 'text';
      this.addr.spellcheck = false;
      this.addr.hidden = true;
      this.editBt = nb('✎', 'Pfad eintippen (F4)');
      this.viewBt = el('button', 'small', 'Ansicht ▾');
      this.viewBt.title = 'Details, Symbole, Ordnerbaum, Vorschaufenster';
      this.favBt = nb('★', 'Feste Ordner');
      this.reloadBt = nb('⟳', 'Aktualisieren (F5)');
      this.pathbar.append(this.backBt, this.fwdBt, this.upBt, this.crumbs, this.addr, this.editBt, this.viewBt, this.favBt, this.reloadBt);
      r.append(this.pathbar);
    }
    const table = el('div', 'table');
    this.thead = el('div', 'thead');
    this.tbody = el('div', 'tbody');
    this.tbody.tabIndex = 0;
    this.spacer = el('div', 'spacer');
    this.rowsEl = el('div', 'rows');
    this.empty = el('div', 'empty');
    this.tbody.append(this.spacer, this.rowsEl, this.empty);
    table.append(this.thead, this.tbody);
    if (this.isSearch) {
      r.append(table);
    } else {
      // Ordnerbaum | Inhalt | Vorschaufenster – Breiten mit den Trennlinien verstellbar
      this.body = el('div', 'pbody');
      this.treeEl = el('nav', 'ptree');
      this.treeEl.tabIndex = -1;
      this.split1 = el('div', 'vsplit');
      this.split2 = el('div', 'vsplit');
      this.prevEl = el('div', 'pprev');
      this.prevMedia = el('div', 'pv');
      this.prevName = el('div', 'pname');
      this.prevInfo = el('div', 'pinfo');
      this.prevText = el('pre', 'ptext');
      this.prevEl.append(this.prevMedia, this.prevName, this.prevInfo, this.prevText);
      this.body.append(this.treeEl, this.split1, table, this.split2, this.prevEl);
      r.append(this.body);
      this.info = el('div', 'info');
      r.append(this.info);
      this.tree = new NavTree(this.treeEl, { onSelect: (p) => { this.openFolder(p); this.tbody.focus(); }, follow: () => this.folder });
      this.bindSplit(this.split1, 'treeW', this.treeEl, 1);
      this.bindSplit(this.split2, 'prevW', this.prevEl, -1);
      this.applyLayout();
    }
    this.buildHeader();
    this.bind();
  }

  // ----- Ansicht: Details / Symbole, Ordnerbaum, Vorschaufenster -----

  get mode() { return this.isSearch ? 0 : (this.st.view || 0); }

  applyLayout() {
    if (this.isSearch) return;
    const treeOn = this.st.tree !== false && App.state.nav !== false;
    this.treeEl.hidden = this.split1.hidden = !treeOn;
    this.prevEl.hidden = this.split2.hidden = !this.st.prev;
    this.treeEl.style.width = (this.st.treeW || 210) + 'px';
    this.prevEl.style.width = (this.st.prevW || 280) + 'px';
    this.root.classList.toggle('grid', this.mode > 0);
    this.root.classList.toggle('large', this.mode === 2);
    this.rowsEl.replaceChildren();
    this.render();
    if (treeOn && !this.tree.nodes.length) this.tree.load();
    else if (treeOn) this.tree.revealPath(this.folder);
    this.updatePreview();
  }

  setView(m) { this.st.view = m; App.saveState(); this.applyLayout(); }

  bindSplit(bar, key, target, dir) {
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX, w0 = target.getBoundingClientRect().width;
      bar.classList.add('on');
      const move = (ev) => {
        const w = Math.max(120, Math.min(this.root.clientWidth * 0.6, w0 + dir * (ev.clientX - x0)));
        this.st[key] = Math.round(w);
        target.style.width = w + 'px';
        this.render();
      };
      const up = () => { bar.classList.remove('on'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); App.saveState(); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  }

  viewMenu() {
    const r = this.viewBt.getBoundingClientRect();
    const m = this.mode;
    Menu.show(r.left, r.bottom + 2, [
      { label: 'Details (Liste mit Spalten)', checked: m === 0, action: () => this.setView(0) },
      { label: 'Mittelgroße Symbole', checked: m === 1, action: () => this.setView(1) },
      { label: 'Große Symbole (Vorschaubilder)', checked: m === 2, action: () => this.setView(2) },
      { sep: true },
      { label: 'Ordnerbaum', checked: this.st.tree !== false && App.state.nav !== false, action: () => { this.st.tree = !(this.st.tree !== false && App.state.nav !== false); if (this.st.tree) App.state.nav = true; App.saveState(); this.applyLayout(); } },
      { label: 'Vorschaufenster', key: 'Alt+P', checked: !!this.st.prev, action: () => this.togglePreview() },
      { label: 'Versteckte Dateien anzeigen', checked: !!App.hello.showHidden, action: () => App.toggleHidden() },
    ]);
  }

  togglePreview() { if (this.isSearch) return; this.st.prev = !this.st.prev; App.saveState(); this.applyLayout(); }

  // Vorschaufenster: Bild, PDF, Video, Text – sonst die Miniatur von Windows
  updatePreview() {
    if (this.isSearch || this.prevEl.hidden) return;
    clearTimeout(this.prevTimer);
    this.prevTimer = setTimeout(() => this.showPreview(), 150);
  }

  async showPreview() {
    const sel = this.selected();
    const h = App.hello;
    const media = (node) => this.prevMedia.replaceChildren(node);
    const bigIcon = (cat, dir) => { const d = el('div', 'bigic'); d.innerHTML = iconSVG(cat, dir).replace(/width="16" height="16"/, 'width="96" height="96"'); return d; };
    const clearText = () => { this.prevText.hidden = true; this.prevText.textContent = ''; };
    if (sel.length !== 1) {
      clearText();
      this.prevKey = '';
      media(bigIcon(CAT.FOLDER, true));
      if (sel.length) {
        this.prevName.textContent = `${sel.length} Elemente ausgewählt`;
        this.prevInfo.textContent = 'zusammen ' + formatSize(sel.filter((x) => !x.isDir).reduce((a, x) => a + x.size, 0));
      } else {
        this.prevName.textContent = this.folder ? baseName(this.folder) : '';
        this.prevInfo.textContent = this.folder ? `Ordner mit ${thousands(this.base.length)} Elementen\n${this.folder}` : '';
      }
      return;
    }
    const e = sel[0];
    const key = e.path + '|' + e.mod;
    if (key === this.prevKey) return;
    this.prevKey = key;
    clearText();
    this.prevName.textContent = e.name;
    this.prevInfo.textContent = typeLabel(e) + (e.isDir ? '' : ' · ' + formatSize(e.size)) + (e.mod ? '\nGeändert: ' + formatDate(e.mod) : '') + '\n' + e.dir;
    const x = ext(e.name);
    const dl = h.dl + encodeURIComponent(e.path) + '?inline=1';
    const th = (s) => `${h.th}${encodeURIComponent(e.path)}?s=${s}&m=${e.mod}`;
    if (e.isDir) { media(bigIcon(CAT.FOLDER, true)); return; }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(x)) {
      const img = el('img'); img.src = dl; img.onerror = () => media(bigIcon(e.cat, false)); media(img); return;
    }
    if (x === 'pdf') { const f = el('iframe'); f.src = dl; media(f); return; }
    if (['mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'ogg'].includes(x)) {
      const v = el(['mp3', 'wav', 'm4a', 'ogg'].includes(x) ? 'audio' : 'video'); v.src = dl; v.controls = true; media(v); return;
    }
    if (TEXT_EXT.has(x)) {
      media(bigIcon(e.cat, false));
      const r = await NAS.api('peek', { path: e.path }).catch(() => null);
      if (r && !r.error && this.prevKey === key) { this.prevText.textContent = r.text; this.prevText.hidden = false; this.prevMedia.replaceChildren(); }
      return;
    }
    const img = el('img'); img.src = th(512); img.onerror = () => media(bigIcon(e.cat, false)); media(img);
  }

  visibleCols() {
    if (PANEL) return [0, 4];
    if (this.isSearch) return [0, 1, 2, 3, 4];
    // schmale Seite (Ordnerbaum und Vorschau offen): weniger Spalten, Name bleibt lesbar
    const w = this.tableW || 800;
    if (w < 330) return [0, 4];
    if (w < 450) return [0, 3, 4];
    return [0, 1, 3, 4];
  }

  buildHeader() {
    const widths = this.st.cols || DEFAULT_WIDTHS;
    const vis = this.visibleCols();
    const flexCol = this.isSearch ? 2 : 0;
    const exp = [150, 95, 78, 130, 130]; // Explorer: schmale Grundbreiten, Name dehnt sich
    this.root.style.setProperty('--cols', PANEL ? 'minmax(120px,1fr) 132px'
      : vis.map((c) => (c === flexCol ? `minmax(${this.isSearch ? widths[c] : exp[c]}px,1fr)` : (this.isSearch ? widths[c] : exp[c]) + 'px')).join(' '));
    this.colKey = vis.join(',');
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
        if (this.isSearch) this.runSearch(); else this.applyView();
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
    if (this.isSearch) {
      let timer = null;
      this.search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.runSearch(), 90);
      });
      this.search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          e.preventDefault();
          if (this.view.length) { this.tbody.focus(); if (this.focusIdx < 0) this.selectOnly(0); }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (this.search.value) { this.search.value = ''; this.runSearch(); }
        }
      });
      this.search.addEventListener('focus', () => App.setActive(this));
      this.inPathCB.addEventListener('change', () => { this.st.inPath = this.inPathCB.checked; App.saveState(); this.runSearch(); });
      this.scopeSel.addEventListener('change', () => { App.state.scope = +this.scopeSel.value; App.saveState(); this.runSearch(); });
    } else {
      this.backBt.addEventListener('click', () => this.goBack());
      this.fwdBt.addEventListener('click', () => this.goForward());
      this.upBt.addEventListener('click', () => this.goUp());
      this.editBt.addEventListener('click', () => this.editAddress());
      this.favBt.addEventListener('click', () => this.folderMenu());
      this.viewBt.addEventListener('click', () => this.viewMenu());
      this.reloadBt.addEventListener('click', () => this.reload());
      this.crumbs.addEventListener('dblclick', (e) => { if (e.target === this.crumbs) this.editAddress(); });
      this.addr.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); this.goAddress(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.closeAddress(); this.tbody.focus(); }
      });
      this.addr.addEventListener('blur', () => setTimeout(() => this.closeAddress(), 150));
    }
    this.tbody.addEventListener('focus', () => App.setActive(this));
    this.root.addEventListener('mousedown', () => App.setActive(this));

    this.tbody.addEventListener('scroll', () => this.render());
    new ResizeObserver(() => {
      this.tableW = this.tbody.clientWidth;
      if (!this.isSearch && this.visibleCols().join(',') !== this.colKey) { this.buildHeader(); this.rowsEl.replaceChildren(); }
      this.render();
    }).observe(this.tbody);
    this.tbody.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.tbody.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.tbody.addEventListener('dblclick', (e) => { const i = this.rowIndexAt(e); if (i >= 0) this.activate(i); });
    this.tbody.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e); });
    this.tbody.addEventListener('keydown', (e) => this.onKey(e));
    this.tbody.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.tbody.addEventListener('dragend', () => App.endDrag());
    const targets = this.isSearch ? [this.tbody] : [this.tbody, this.pathbar];
    for (const t of targets) {
      t.addEventListener('dragover', (e) => this.onDragOver(e));
      t.addEventListener('dragleave', (e) => { if (!t.contains(e.relatedTarget)) this.clearDrop(); });
      t.addEventListener('drop', (e) => this.onDrop(e));
    }
  }

  // ----- Suche -----

  scopeFolder() {
    const s = App.state.scope || 0;
    return s ? (App.panes[s - 1].folder || '') : '';
  }

  async runSearch() {
    if (!this.isSearch) return;
    const seq = ++this.seq;
    const text = this.search.value.trim();
    if (!text && !this.st.filter) {
      this.base = [];
      this.total = 0;
      this.counts = [0, 0, 0, 0, 0, 0];
      this.applyView(true);
      return;
    }
    const under = this.scopeFolder();
    let r;
    try {
      r = await NAS.api('search', { text, filter: this.st.filter, inPath: !!this.st.inPath, sort: this.st.sort, desc: !!this.st.desc, max: 20000, under });
    } catch (e) { return; }
    if (seq !== this.seq) return;
    this.base = r.rows.map(toEntry);
    this.total = r.total;
    this.counts = r.counts;
    this.noindex = r.noindex;
    this.applyView(true);
    if (!App.drag) {
      let msg = `${thousands(r.total)} Treffer (${r.ms} ms)`;
      if (under) msg += ' in ' + under + (r.live ? ' (direkt durchsucht)' : '');
      if (this.base.length < r.total) msg += ` – die ersten ${thousands(this.base.length)} werden angezeigt, bitte genauer suchen.`;
      App.paneStatus(msg);
    }
  }

  // Zeilen aufbauen (Explorer: sortieren)
  applyView(resetScroll) {
    let list = this.base;
    if (!this.isSearch) list = sortEntries(list.slice(), this.st.sort, this.st.desc);
    this.view = list.map((e) => ({ e, depth: 0, open: false }));
    const keep = new Set();
    this.view.forEach((v) => { if (this.sel.has(v.e.path)) keep.add(v.e.path); });
    this.sel = keep;
    if (resetScroll) this.tbody.scrollTop = 0;
    this.updateCounts();
    this.updateEmpty();
    this.render();
    this.updateInfo();
  }

  updateCounts() {
    if (!this.isSearch) return;
    FILTERS.forEach((f, i) => { this.filterCBs[i].cnt.textContent = (this.search.value.trim() || this.st.filter) ? ` (${thousands(this.counts[f.cat] || 0)})` : ''; });
  }

  updateEmpty() {
    let msg = '';
    if (this.view.length === 0) {
      if (!this.isSearch) msg = this.folderError || (this.folder ? 'Dieser Ordner ist leer.' : '');
      else if (this.noindex && !this.scopeFolder()) msg = 'Noch kein Suchindex – bitte unter <b>Einstellungen</b> die Suchordner festlegen.';
      else if (!this.search.value.trim() && !this.st.filter) msg = 'Suchbegriff eingeben – mehrere Wörter: alle müssen vorkommen. Platzhalter: <b>*.pdf</b>, <b>rechnung 2026*</b>.<br>Treffer nach unten in einen Ordner ziehen = verschieben (Strg = kopieren).';
      else msg = 'Keine Treffer.';
    }
    this.empty.innerHTML = msg;
    this.empty.hidden = !msg;
  }

  updateInfo() {
    if (this.isSearch || !this.info) return;
    this.updatePreview();
    const n = this.base.length;
    let t = n === 1 ? '1 Element' : `${thousands(n)} Elemente`;
    const sel = this.selected();
    if (sel.length) {
      const files = sel.filter((x) => !x.isDir);
      t += `   ·   ${sel.length} ausgewählt`;
      if (files.length) t += `  (${formatSize(files.reduce((a, x) => a + x.size, 0))})`;
    }
    this.info.textContent = this.folderError ? this.folderError : t;
  }

  // ----- Explorer: Ordner, Verlauf, Adresszeile -----

  async openFolder(path, opts = {}) {
    if (!path) return;
    if (this.isSearch) {
      const t = App.explorerPane();
      await t.openFolder(path, opts);
      t.tbody.focus();
      return;
    }
    const r = await NAS.api('list?dir=' + encodeURIComponent(path)).catch(() => null);
    if (!r) return;
    if (r.error && !opts.silent && !this.folder) {
      // Startordner nicht erreichbar: trotzdem anzeigen, mit Hinweis
    } else if (r.error && !opts.silent) {
      App.setStatus(r.error, true);
      return;
    }
    const changed = !this.folder || !sameP(this.folder, path);
    if (changed && !opts.silent && opts.hist !== false) {
      this.history = this.history.slice(0, this.histPos + 1);
      this.history.push(path);
      if (this.history.length > 50) this.history.shift();
      this.histPos = this.history.length - 1;
    }
    this.folder = path;
    this.folderError = r.error || '';
    const rows = r.rows.map(toEntry);
    if (opts.silent && !changed && JSON.stringify(rows) === JSON.stringify(this.base)) return;
    this.base = rows;
    if (changed && !opts.keepSel) this.sel.clear();
    const st = this.tbody.scrollTop;
    this.renderCrumbs();
    this.updateNav();
    this.applyView(changed);
    if (changed && this.tree && !this.treeEl.hidden) this.tree.revealPath(path);
    if (!changed) this.tbody.scrollTop = st;
    if (changed && !sameP(this.st.last || '', path)) { this.st.last = path; App.saveState(); }
    if (changed && App.state.scope === this.idx + 1 && App.search) App.search.runSearch();
    if (!opts.silent) {
      App.setActive(this);
      if (opts.select) { const i = this.view.findIndex((v) => sameP(v.e.path, opts.select)); if (i >= 0) { this.selectOnly(i); this.scrollTo(i); } }
    }
  }

  updateNav() {
    if (this.isSearch) return;
    this.backBt.disabled = this.histPos <= 0;
    this.fwdBt.disabled = this.histPos >= this.history.length - 1;
    this.upBt.disabled = !this.folder || !parentOf(this.folder);
  }

  goBack() {
    if (this.isSearch || this.histPos <= 0) return;
    const cur = this.folder;
    this.histPos--;
    this.openFolder(this.history[this.histPos], { hist: false, select: cur });
  }

  goForward() {
    if (this.isSearch || this.histPos >= this.history.length - 1) return;
    this.histPos++;
    this.openFolder(this.history[this.histPos], { hist: false });
  }

  goUp() {
    if (!this.folder) return;
    const p = parentOf(this.folder);
    if (p) this.openFolder(p, { select: this.folder });
  }

  reload() {
    if (this.isSearch) this.runSearch();
    else if (this.folder) this.openFolder(this.folder, { silent: true, keepSel: true }).then(() => this.render());
  }

  editAddress() {
    if (this.isSearch) return;
    this.crumbs.hidden = true;
    this.addr.hidden = false;
    this.addr.value = this.folder || '';
    this.addr.focus();
    this.addr.select();
  }

  closeAddress() {
    if (this.isSearch || this.addr.hidden) return;
    this.addr.hidden = true;
    this.crumbs.hidden = false;
  }

  async goAddress() {
    let p = this.addr.value.trim().replace(/^"|"$/g, '');
    if (!p) { this.closeAddress(); return; }
    if (/^[A-Za-z]:$/.test(p)) p += '\\';
    const r = await NAS.api('list?dir=' + encodeURIComponent(p)).catch(() => null);
    if (!r || r.error) {
      // vielleicht eine Datei: Ordner öffnen und Datei markieren
      const par = parentOf(p);
      const r2 = par ? await NAS.api('list?dir=' + encodeURIComponent(par)).catch(() => null) : null;
      if (r2 && !r2.error && r2.rows.some((x) => sameP(joinPath(par, x[0]), p))) {
        this.closeAddress();
        await this.openFolder(par, { select: p });
        this.tbody.focus();
        return;
      }
      App.setStatus(`„${p}“ wurde nicht gefunden – bitte die Schreibweise prüfen.`, true);
      this.addr.focus();
      return;
    }
    this.closeAddress();
    await this.openFolder(p);
    this.tbody.focus();
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

  targetFolder() { return this.isSearch ? App.explorerPane().folder : this.folder; }

  // Neuer Ordner: sofort anlegen und den Namen bearbeiten (wie im Explorer)
  async newFolder() {
    const p = this.isSearch ? App.explorerPane() : this;
    const dir = p.folder;
    if (!dir) return;
    let r;
    for (let i = 1; i < 100; i++) {
      r = await NAS.api('mkdir', { dir, name: i === 1 ? 'Neuer Ordner' : `Neuer Ordner (${i})` });
      if (!r.error || !/gibt es dort schon/.test(r.error)) break;
    }
    if (r.error) { App.setStatus(r.error, true); return; }
    await p.openFolder(dir, { select: r.path, silent: false });
    p.tbody.focus();
    p.rename();
  }

  async newFile() {
    const p = this.isSearch ? App.explorerPane() : this;
    if (!p.folder) return;
    const r = await NAS.api('newfile', { dir: p.folder, name: 'Neues Textdokument.txt' });
    if (r.error) { App.setStatus(r.error, true); return; }
    await p.openFolder(p.folder, { select: r.path });
    p.tbody.focus();
    p.rename();
  }

  // ----- Darstellung (nur sichtbare Zeilen) -----

  // Symbolansicht: Kachelmaße
  gridDims() {
    const large = this.mode === 2;
    const cw = large ? 214 : 124, ch = large ? 246 : 150;
    const cols = Math.max(1, Math.floor((this.tbody.clientWidth || 600) / cw));
    return { cw, ch, cols, t: large ? 192 : 96 };
  }

  renderGrid() {
    const n = this.view.length;
    const { cw, ch, cols, t } = this.gridDims();
    this.spacer.style.height = Math.ceil(n / cols) * ch + 'px';
    const top = this.tbody.scrollTop, h = this.tbody.clientHeight || 600;
    const firstRow = Math.max(0, Math.floor(top / ch) - 1);
    const lastRow = Math.ceil((top + h) / ch) + 1;
    const first = firstRow * cols, last = Math.min(n, lastRow * cols);
    this.rowsEl.style.transform = 'none';
    const pool = this.rowsEl.children;
    let k = 0;
    for (let i = first; i < last; i++, k++) {
      let c = pool[k];
      if (!c || !c.classList.contains('cell')) {
        const nc = el('div', 'cell'); nc.draggable = true;
        if (c) c.replaceWith(nc); else this.rowsEl.append(nc);
        c = nc;
      }
      const v = this.view[i], e = v.e;
      c.style.left = (i % cols) * cw + 'px';
      c.style.top = Math.floor(i / cols) * ch + 'px';
      c.style.width = cw + 'px';
      c.style.height = ch + 'px';
      let cls = 'cell';
      if (e.isDir) cls += ' folder';
      if (this.sel.has(e.path)) cls += ' sel';
      if (i === this.dropIdx) cls += ' drop';
      if (App.cut.has(e.path.toLowerCase())) cls += ' cut';
      c.className = cls;
      c._idx = i;
      const key = `${e.path}|${e.mod}|${t}`;
      if (c._key === key) continue;
      c._key = key;
      const box = el('div', 'thumb');
      box.style.width = box.style.height = t + 'px';
      const fallback = () => { box.innerHTML = iconSVG(e.cat, e.isDir).replace(/width="16" height="16"/, `width="${Math.round(t * 0.55)}" height="${Math.round(t * 0.55)}"`); };
      if (e.isDir || !App.hello.th) fallback();
      else {
        const img = el('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = `${App.hello.th}${encodeURIComponent(e.path)}?s=${t}&m=${e.mod}`;
        img.onerror = fallback;
        box.append(img);
      }
      const nm = el('div', 'cname', e.name);
      c.title = e.name + (e.isDir ? '' : '\n' + typeLabel(e) + ' · ' + formatSize(e.size) + '\n' + formatDate(e.mod));
      c.replaceChildren(box, nm);
    }
    while (this.rowsEl.children.length > k) this.rowsEl.lastChild.remove();
  }

  render() {
    if (this.mode > 0) { this.renderGrid(); return; }
    if (this.rowsEl.firstChild && this.rowsEl.firstChild.classList.contains('cell')) this.rowsEl.replaceChildren();
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
    if (App.cut.has(e.path.toLowerCase())) cls += ' cut';
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
          cell.title = this.isSearch ? e.path : e.name;
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
    const row = e.target.closest && e.target.closest(this.mode > 0 ? '.cell' : '.row');
    if (row && row._idx !== undefined) return row._idx;
    const r = this.tbody.getBoundingClientRect();
    if (this.mode > 0) {
      const { cw, ch, cols } = this.gridDims();
      const x = e.clientX - r.left, y = e.clientY - r.top + this.tbody.scrollTop;
      if (x < 0 || x >= cols * cw || y < 0) return -1;
      const i = Math.floor(y / ch) * cols + Math.floor(x / cw);
      return i < this.view.length ? i : -1;
    }
    const i = Math.floor((e.clientY - r.top + this.tbody.scrollTop) / ROW_H);
    return i >= 0 && i < this.view.length && e.clientY >= r.top ? i : -1;
  }

  scrollTo(i) {
    let top = i * ROW_H, rh = ROW_H;
    if (this.mode > 0) { const { ch, cols } = this.gridDims(); top = Math.floor(i / cols) * ch; rh = ch; }
    const h = this.tbody.clientHeight;
    if (top < this.tbody.scrollTop) this.tbody.scrollTop = top;
    else if (top + rh > this.tbody.scrollTop + h) this.tbody.scrollTop = top + rh - h;
  }

  // ----- Auswahl -----

  selectOnly(i) {
    this.sel = new Set([this.view[i].e.path]);
    this.anchor = this.focusIdx = i;
    this.render();
    this.updateInfo();
    this.updatePreview();
  }

  selectRange(i) {
    const a = Math.max(0, this.anchor), lo = Math.min(a, i), hi = Math.max(a, i);
    this.sel = new Set(this.view.slice(lo, hi + 1).map((v) => v.e.path));
    this.focusIdx = i;
    this.render();
    this.updateInfo();
    this.updatePreview();
  }

  selectAll() {
    this.sel = new Set(this.view.map((v) => v.e.path));
    this.render();
    this.updateInfo();
  }

  selected() { return this.view.filter((v) => this.sel.has(v.e.path)).map((v) => v.e); }
  selectedPaths() { return this.selected().map((x) => x.path); }

  onMouseDown(e) {
    const i = this.rowIndexAt(e);
    this.pendingSingle = -1;
    if (i < 0) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey) { this.sel.clear(); this.render(); this.updateInfo(); }
      return;
    }
    const p = this.view[i].e.path;
    if (e.button === 2) { if (!this.sel.has(p)) this.selectOnly(i); return; }
    if (e.ctrlKey || e.metaKey) {
      if (this.sel.has(p)) this.sel.delete(p); else this.sel.add(p);
      this.anchor = this.focusIdx = i;
      this.render();
      this.updateInfo();
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
    const g = this.mode > 0 ? this.gridDims() : null;
    const step = g ? g.cols : 1;
    const page = g ? Math.max(1, Math.floor(this.tbody.clientHeight / g.ch)) * g.cols : Math.max(1, Math.floor(this.tbody.clientHeight / ROW_H) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    if (g && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      move(this.focusIdx + (e.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (e.altKey) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.goBack(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.goForward(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.goUp(); }
      else if (e.key === 'Enter') { e.preventDefault(); App.properties(this.selectedPaths().length ? this.selectedPaths() : [this.folder]); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this.togglePreview(); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(this.focusIdx < 0 ? 0 : this.focusIdx + step); break;
      case 'ArrowUp':
        e.preventDefault();
        if (this.focusIdx <= 0 && this.isSearch) { this.search.focus(); break; }
        move(this.focusIdx - step); break;
      case 'PageDown': e.preventDefault(); move(this.focusIdx + page); break;
      case 'PageUp': e.preventDefault(); move(this.focusIdx - page); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(n - 1); break;
      case 'Enter': e.preventDefault(); if (this.focusIdx >= 0) this.activate(this.focusIdx); break;
      case 'Backspace': e.preventDefault(); if (this.histPos > 0) this.goBack(); else this.goUp(); break;
      case 'F2': e.preventDefault(); this.rename(); break;
      case 'F4': e.preventDefault(); this.editAddress(); break;
      case 'F7': e.preventDefault(); this.newFolder(); break;
      case 'Delete': e.preventDefault(); App.deletePaths(this.selectedPaths(), !e.shiftKey); break;
      case 'a': case 'A':
        if (ctrl) { e.preventDefault(); this.selectAll(); }
        break;
      case 'c': case 'C':
        if (ctrl && e.shiftKey) { e.preventDefault(); App.copyText(this.selectedPaths().join('\r\n'), 'Pfad kopiert.'); }
        else if (ctrl) { e.preventDefault(); App.copyFiles(this.selectedPaths(), false); }
        break;
      case 'x': case 'X':
        if (ctrl) { e.preventDefault(); App.copyFiles(this.selectedPaths(), true); }
        break;
      case 'v': case 'V':
        if (ctrl) { e.preventDefault(); App.paste(this.pasteTarget()); }
        break;
      default:
        // Tippen springt ins Suchfeld (Suche oben)
        if (e.key.length === 1 && !ctrl && this.isSearch) { this.search.focus(); }
    }
  }

  // Einfügen: in den angezeigten Ordner – in der Suche in den markierten Ordner bzw. unten
  pasteTarget() {
    if (!this.isSearch) return this.folder;
    const sel = this.selected();
    return sel.length === 1 && sel[0].isDir ? sel[0].path : App.explorerPane().folder;
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
    const r = this.favBt.getBoundingClientRect();
    const favs = (h.favorites || []).map((f) => ({ label: f.name, title: f.path, action: () => this.openFolder(f.path) }));
    const start = (h.start || [])[this.idx] || '';
    const items = [{ head: 'Feste Ordner' }, ...(favs.length ? favs : [{ label: '(noch keine festen Ordner)', disabled: true }]), { sep: true },
      { label: 'Ordner auswählen und anzeigen …', action: async () => { const p = await pickFolder('Ordner anzeigen', this.folder || ''); if (p) this.openFolder(p); } },
      { label: 'Angezeigten Ordner als festen Ordner merken …', disabled: !this.folder, action: async () => {
        const name = await askText('Festen Ordner merken', 'Name im Menü (z. B. „Digitale Eingänge“):', baseName(this.folder));
        if (name) await App.pin(this.folder, false, name);
      } },
      { label: `Angezeigten Ordner beim Start ${this.side} öffnen`, disabled: !this.folder,
        checked: this.folder && start && sameP(start, this.folder),
        action: async () => { await NAS.api('startfolder', { pane: this.idx, path: this.folder }); App.setStatus('Wird künftig beim Start geöffnet: ' + this.folder, true); } },
    ];
    if (start) items.push({ label: 'Startordner nicht mehr festlegen', title: start, action: () => NAS.api('startfolder', { pane: this.idx, path: '' }) });
    if (favs.length) {
      items.push({ label: 'Festen Ordner entfernen', sub: h.favorites.map((f) => ({ label: f.name, title: f.path, action: () => App.unpin(f.path) })) });
    }
    Menu.show(r.left, r.bottom + 2, items);
  }

  contextMenu(e) {
    const i = this.rowIndexAt(e);
    const sel = this.selected();
    if (i < 0 || !sel.length) {
      if (this.isSearch || !this.folder) return;
      Menu.show(e.clientX, e.clientY, [
        { label: 'Einfügen', key: 'Strg+V', disabled: !App.clipFiles, action: () => App.paste(this.folder) },
        { sep: true },
        { label: 'Neuer Ordner', key: 'F7', action: () => this.newFolder() },
        { label: 'Neues Textdokument', action: () => this.newFile() },
        { sep: true },
        { label: 'Alles auswählen', key: 'Strg+A', action: () => this.selectAll() },
        { label: 'Aktualisieren', key: 'F5', action: () => this.reload() },
        { label: 'Versteckte Dateien anzeigen', checked: !!App.hello.showHidden, action: () => App.toggleHidden() },
        { sep: true },
        { label: `Im ${App.explorer} öffnen`, action: () => App.reveal(this.folder) },
        { label: 'Pfad kopieren', action: () => App.copyText(this.folder, 'Pfad kopiert.') },
        App.isPinned(this.folder) ? { label: 'Vom Schnellzugriff lösen', action: () => App.unpin(this.folder) }
          : { label: 'An Schnellzugriff anheften', action: () => App.pin(this.folder) },
        { label: 'Eigenschaften', key: 'Alt+Enter', action: () => App.properties([this.folder]) },
      ]);
      return;
    }
    const paths = sel.map((x) => x.path);
    const first = sel[0];
    const one = sel.length === 1;
    const dir = first.isDir ? first.path : first.dir;
    const items = [
      { label: 'Öffnen', key: 'Enter', action: () => this.activate(this.view.findIndex((v) => v.e === first)) },
      ...(one && !first.isDir ? [{ label: 'Öffnen mit …', action: () => App.openWith(first.path) }] : []),
      ...(this.isSearch ? [
        { label: 'Ordner links anzeigen (Datei markiert)', action: () => App.panes[0].openFolder(first.dir, { select: first.path }) },
        { label: 'Ordner rechts anzeigen (Datei markiert)', action: () => App.panes[1].openFolder(first.dir, { select: first.path }) },
      ] : one && first.isDir ? [{ label: 'In der anderen Ansicht öffnen', action: () => this.other().openFolder(dir) }] : []),
      { label: `Im ${App.explorer} zeigen`, action: () => App.reveal(first.path) },
      ...(one && first.isDir ? [App.isPinned(first.path)
        ? { label: 'Vom Schnellzugriff lösen', action: () => App.unpin(first.path) }
        : { label: 'An Schnellzugriff anheften', action: () => App.pin(first.path) }] : []),
      { sep: true },
      { label: 'Ausschneiden', key: 'Strg+X', action: () => App.copyFiles(paths, true) },
      { label: 'Kopieren', key: 'Strg+C', action: () => App.copyFiles(paths, false) },
      ...(one && first.isDir ? [{ label: 'Einfügen in diesen Ordner', disabled: !App.clipFiles, action: () => App.paste(first.path) }] : []),
      { label: 'Verschieben nach', sub: App.targetMenu(this, paths, true) },
      { label: 'Kopieren nach', sub: App.targetMenu(this, paths, false) },
      { sep: true },
      { label: one ? 'Umbenennen' : `${sel.length} Elemente umbenennen …`, key: 'F2', action: () => this.rename() },
      { label: 'Löschen (Papierkorb)', key: 'Entf', action: () => App.deletePaths(paths, true) },
      { sep: true },
      { label: 'Pfad kopieren', key: 'Strg+Umschalt+C', action: () => App.copyText(paths.join('\r\n'), 'Pfad kopiert.') },
      { label: 'Name kopieren', action: () => App.copyText(sel.map((x) => x.name).join('\r\n'), 'Name kopiert.') },
      { sep: true },
      { label: 'Eigenschaften', key: 'Alt+Enter', action: () => App.properties(paths) },
    ];
    Menu.show(e.clientX, e.clientY, items);
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
      // auf den Desktop / in den Explorer ziehen (Chrome legt eine Kopie ab)
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
    App.setStatus(items.length === 1 ? `Ziehe „${items[0].name}“ – in einen Ordner (= verschieben, Strg = kopieren), in WhatsApp/Gmail/Drive oder auf den Desktop`
      : `Ziehe ${items.length} Elemente – in einen Ordner = verschieben (Strg = kopieren)`, false, true);
  }

  dropTargetAt(e) {
    if (this.pathbar && this.pathbar.contains(e.target)) return this.folder ? { path: this.folder, idx: -1 } : null;
    const i = this.rowIndexAt(e);
    if (i >= 0 && this.view[i].e.isDir) return { path: this.view[i].e.path, idx: i };
    if (!this.isSearch && this.folder) return { path: this.folder, idx: -1 };
    return null;
  }

  setDropIdx(i, bar) {
    if (this.dropIdx !== i) { this.dropIdx = i; this.render(); }
    if (this.pathbar) this.pathbar.classList.toggle('drop', !!bar);
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
    if (t.idx >= 0 && !this.view[t.idx].open && this.mode === 0) {
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
    const stepPx = this.mode > 0 ? 40 : ROW_H;
    if (e.clientY < r.top + 28 && e.clientY >= r.top) { this.tbody.scrollTop -= stepPx; this.lastScroll = now; }
    else if (e.clientY > r.bottom - 28 && e.clientY <= r.bottom) { this.tbody.scrollTop += stepPx; this.lastScroll = now; }
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
    if (this.isSearch) await this.runSearch();
    else if (this.folder) await this.openFolder(this.folder, { silent: true, keepSel: true });
  }
}

// ---------- Anwendung ----------

const App = {
  state: null,
  hello: {},
  search: null, // Suche oben
  panes: [], // Explorer links und rechts
  all: [],
  nav: null,
  active: null,
  lastExplorer: null,
  drag: null,
  stickyUntil: 0,
  explorer: 'Explorer',
  cut: new Set(), // ausgeschnittene Pfade (klein geschrieben) – blass dargestellt
  clipFiles: false, // liegen Dateien in der Zwischenablage?

  defaultState() {
    const p = () => ({ filter: 0, inPath: false, sort: 0, desc: false, cols: DEFAULT_WIDTHS.slice(), last: '', view: 0, tree: true, prev: false, treeW: 210, prevW: 280 });
    return { nav: true, scope: 0, topH: 0, panes: [p(), p(), p()] };
  },

  async start() {
    if (PANEL) document.body.classList.add('panel');
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
          ? 'Das Programm Datei-Explorer läuft gerade nicht. Bitte DateiExplorer.exe starten – diese Seite verbindet sich dann von selbst.\n\n' +
            'Tipp: Im Programm einmal „Einstellungen → Allgemein → Explorer im Browser einrichten“ ausführen. Dann startet Chrome das Programm künftig selbst.'
          : 'Das Programm antwortet nicht: ' + (e.detail || e.message) + '\nBitte DateiExplorer.exe starten.';
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
    this.state.panes = [0, 1, 2].map((i) => Object.assign(def.panes[i], (st.panes || [])[i] || {}));
    if (this.state.topH) document.documentElement.style.setProperty('--top-h', this.state.topH + 'px');
    this.search = new Pane(2, $('#paneS'));
    this.panes = [new Pane(0, $('#pane0')), new Pane(1, $('#pane1'))];
    this.all = [this.search, ...this.panes];
    this.lastExplorer = this.panes[0];
    this.active = this.search;
    this.nav = { load: () => this.panes.forEach((p) => { if (!p.treeEl.hidden) p.tree.load(); }), setDrop: (x) => this.panes.forEach((p) => p.tree.setDrop(x)) };

    $('#navBt').addEventListener('click', () => this.setNav(!this.state.nav));
    $('#refreshBt').addEventListener('click', () => this.reindex());
    $('#settingsBt').addEventListener('click', () => this.settings());
    $('#newBt').addEventListener('click', (e) => {
      const p = this.explorerPane();
      const r = e.currentTarget.getBoundingClientRect();
      Menu.show(r.left, r.bottom + 2, [
        { label: 'Ordner', key: 'F7', action: () => p.newFolder() },
        { label: 'Textdokument', action: () => p.newFile() },
      ]);
    });
    $('#cutBt').addEventListener('click', () => this.copyFiles(this.cmdPane().selectedPaths(), true));
    $('#copyBt').addEventListener('click', () => this.copyFiles(this.cmdPane().selectedPaths(), false));
    $('#pasteBt').addEventListener('click', () => this.paste(this.cmdPane().pasteTarget()));
    $('#renameBt').addEventListener('click', () => this.cmdPane().rename());
    $('#deleteBt').addEventListener('click', (e) => this.deletePaths(this.cmdPane().selectedPaths(), !e.shiftKey));
    $('#toOtherCopyBt').addEventListener('click', (e) => this.toOther(false, e.currentTarget));
    $('#toOtherMoveBt').addEventListener('click', (e) => this.toOther(true, e.currentTarget));
    $('#propsBt').addEventListener('click', () => {
      const p = this.cmdPane();
      const paths = p.selectedPaths();
      this.properties(paths.length ? paths : p.isSearch ? [] : [p.folder]);
    });
    // Toolbar-Knöpfe sollen die Auswahl in der Liste nicht verlieren
    $('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    this.setNav(this.state.nav, true);
    this.bindSplitter();
    this.bindGlobal();

    // Startordner: fest eingestellt › zuletzt benutzt › Suchordner › Dokumente
    const start = this.hello.start || [];
    let docs = '';
    try { const n = await NAS.api('nav'); const pc = n.groups.find((g) => g.id === 'pc'); docs = ((pc && pc.items) || []).map((x) => x.path).find((p) => /Dokumente|Documents/i.test(p)) || ((pc && pc.items[0]) || {}).path || ''; } catch (e) { /* egal */ }
    const cands = [
      [start[0], this.state.panes[0].last, (this.hello.folders || [])[0], docs],
      [start[1], this.state.panes[1].last, docs, (this.hello.folders || [])[0]],
    ];
    for (let i = 0; i < 2; i++) {
      for (const c of cands[i]) {
        if (!c) continue;
        const r = await NAS.api('list?dir=' + encodeURIComponent(c)).catch(() => null);
        if (r && !r.error) { await this.panes[i].openFolder(c); break; }
      }
    }
    this.setActive(this.search);
    this.search.runSearch();
    this.search.search.focus();
    this.setStatus(this.hello.status || '');

    setInterval(() => this.poll(), 3000);
    setInterval(() => { if (!this.drag && !document.hidden) this.panes.forEach((p) => p.folder && !p.renameBox && p.openFolder(p.folder, { silent: true, keepSel: true })); }, 5000);
  },

  async refreshHello() {
    try {
      this.hello = await NAS.api('hello');
      SEP = this.hello.sep || '\\';
      const v = $('#ver');
      v.textContent = (this.hello.versionText || 'Version ' + this.hello.version) + '  ·  Browser-Teil ' + chrome.runtime.getManifest().version;
      v.classList.toggle('test', !!this.hello.stage);
      this.explorer = SEP === '\\' ? 'Explorer' : 'Dateimanager';
    } catch (e) { /* später erneut */ }
  },

  async poll() {
    const wasIndexing = this.hello.indexing;
    await this.refreshHello();
    $('#refreshBt').textContent = this.hello.indexing ? 'Liest ein …' : 'Index aktualisieren';
    if (!this.drag && Date.now() > this.stickyUntil && this.hello.indexing) this.setStatus(this.hello.status);
    if (wasIndexing && !this.hello.indexing) {
      this.setStatus(this.hello.status);
      this.search.runSearch();
    }
    this.checkClipboard();
  },

  async checkClipboard() {
    try { this.clipFiles = !!(await NAS.api('clipcheck')).files; } catch (e) { this.clipFiles = false; }
    $('#pasteBt').disabled = !this.clipFiles;
  },

  saveState() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => NAS.api('state', this.state).catch(() => {}), 400);
  },

  // Ordnerbäume beider Seiten ein/aus
  setNav(on, init) {
    this.state.nav = on;
    if (on && !init) this.panes.forEach((p) => { p.st.tree = true; });
    $('#navBt').textContent = on ? 'Ordnerbäume ausblenden' : 'Ordnerbäume einblenden';
    if (!init) { this.panes.forEach((p) => p.applyLayout()); this.saveState(); }
  },

  // Trennlinie zwischen Suche und Explorer: Höhe der Suche (höchstens ein Drittel)
  bindSplitter() {
    const bar = $('#splitH');
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const top = $('#paneS').getBoundingClientRect().top;
      bar.classList.add('on');
      const move = (ev) => {
        const h = Math.max(130, Math.min(innerHeight / 3, ev.clientY - top));
        this.state.topH = Math.round(h);
        document.documentElement.style.setProperty('--top-h', h + 'px');
      };
      const up = () => { bar.classList.remove('on'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); this.saveState(); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  },

  setActive(p) {
    if (this.active === p) return;
    this.active = p;
    if (!p.isSearch) this.lastExplorer = p;
    this.all.forEach((x) => x.root.classList.toggle('active', x === p));
  },

  activePane() { return this.active || this.search; },
  cmdPane() { return this.active || this.panes[0]; },
  explorerPane() { return this.lastExplorer || this.panes[0]; },

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
    this.all.forEach((p) => p.collapseTrees());
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
    if (dirs) msg += ` ${dirs} Ordner übersprungen (Ordner bitte mit Strg+C / Strg+V einfügen).`;
    if (errs.length) msg += ' Fehler: ' + errs.join('; ');
    this.setStatus(msg, true);
    this.all.forEach((p) => p.refresh());
  },

  async transfer(paths, target, move, remember) {
    if (!paths.length || !target) return;
    this.setStatus(`${move ? 'Verschiebe' : 'Kopiere'} ${paths.length} Element(e) nach ${target} …`, true);
    let r;
    try { r = await NAS.api('transfer', { paths, target, move }); } catch (e) { r = { message: 'Fehler: ' + e.message }; }
    this.setStatus(r.error || r.message, true);
    if (remember && !r.error) NAS.api('copytarget', { path: target }).then(() => this.refreshHello());
    // verschobene Dateien in der Auswahl mitnehmen
    if (r.moves) this.all.forEach((p) => { for (const [from, to] of Object.entries(r.moves)) { if (p.sel.delete(from)) p.sel.add(to); this.cut.delete(from.toLowerCase()); } });
    this.panes.forEach((p) => { this.panes.forEach((q) => q.folder && p.tree.invalidate(q.folder)); if (target) p.tree.invalidate(target); });
    await Promise.all(this.all.map((p) => p.refresh()));
    this.nav.load();
  },

  // „Verschieben nach“ / „Kopieren nach“: die Ordner links/rechts, gemerkte Ziele, Auswahl
  targetMenu(src, paths, move) {
    const targets = (this.hello.copyTargets || []).filter(Boolean);
    const items = this.panes.filter((q) => q !== src && q.folder).map((q) => ({ label: `Ordner ${q.side}:  ${q.folder}`, action: () => this.transfer(paths, q.folder, move) }));
    if (targets.length) items.push({ sep: true });
    targets.forEach((t) => items.push({ label: t, action: () => this.transfer(paths, t, move, true) }));
    items.push({ sep: true }, { label: 'Anderer Ordner …', action: async () => { const t = await pickFolder(move ? 'Verschieben nach' : 'Kopieren nach'); if (t) this.transfer(paths, t, move, true); } });
    return items;
  },

  toOther(move, anchor) {
    const p = this.cmdPane();
    const paths = p.selectedPaths();
    if (!paths.length) { this.setStatus('Bitte erst Dateien oder Ordner markieren.', true); return; }
    if (!p.isSearch) { this.transfer(paths, p.other().folder, move); return; }
    const r = anchor.getBoundingClientRect();
    const verb = move ? 'Verschieben' : 'Kopieren';
    Menu.show(r.left, r.bottom + 2, this.panes.map((q) => ({ label: `${verb} nach ${q.side}:  ${q.folder || '–'}`, disabled: !q.folder, action: () => this.transfer(paths, q.folder, move) })));
  },

  // Nach dem Umbenennen: Auswahl mitnehmen, Ansichten und Navigation auffrischen
  async afterRename(moves) {
    this.panes.forEach((p) => { this.panes.forEach((q) => q.folder && p.tree.invalidate(q.folder)); });
    this.all.forEach((p) => {
      for (const [from, to] of Object.entries(moves)) {
        if (p.sel.delete(from)) p.sel.add(to);
        if (p.folder && (sameP(p.folder, from) || isInside(p.folder, from))) p.folder = to + p.folder.slice(from.length);
      }
    });
    await Promise.all(this.all.map((p) => p.refresh()));
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

  async openWith(path) {
    await NAS.native({ cmd: 'foreground' });
    await NAS.api('openwith', { path }).catch(() => {});
  },

  async reveal(path) {
    const r = await NAS.native({ cmd: 'reveal', path });
    if (r.nohost) await NAS.api('reveal', { path }).catch(() => {});
  },

  // Strg+C / Strg+X: Dateien in die Windows-Zwischenablage (Einfügen hier, im Explorer, in E-Mails …)
  async copyFiles(paths, cut) {
    if (!paths.length) return;
    const r = await NAS.api('clipboard', { paths, cut }).catch((e) => ({ error: e.message }));
    this.cut = new Set(cut && !r.error ? paths.map((p) => p.toLowerCase()) : []);
    this.all.forEach((p) => p.render());
    this.setStatus(r.error ? 'Zwischenablage: ' + r.error
      : cut ? `${paths.length} Element(e) ausgeschnitten – im Zielordner Strg+V (oder „Einfügen“) verschiebt sie.`
        : `${paths.length} Element(e) kopiert – mit Strg+V einfügen (hier, im Explorer, in Gmail, WhatsApp, Drive …).`, true);
    this.checkClipboard();
  },

  async paste(dir) {
    if (!dir) return;
    this.setStatus('Füge ein …', true);
    const r = await NAS.api('paste', { dir }).catch((e) => ({ error: e.message }));
    this.setStatus(r.error || r.message, true);
    this.cut = new Set();
    await Promise.all(this.all.map((p) => p.refresh()));
    this.checkClipboard();
  },

  async deletePaths(paths, recycle) {
    if (!paths.length) return;
    await NAS.native({ cmd: 'foreground' }); // Windows-Rückfrage darf nach vorne
    this.setStatus(recycle ? 'Lösche (Papierkorb) … – bitte die Windows-Rückfrage beantworten.' : 'Lösche endgültig … – bitte die Windows-Rückfrage beantworten.', true);
    const r = await NAS.api('delete', { paths, recycle }).catch((e) => ({ error: e.message, gone: [] }));
    const n = (r.gone || []).length;
    this.setStatus(n ? `${n} Element(e) ${recycle ? 'gelöscht (Papierkorb)' : 'endgültig gelöscht'}.` : (r.error || 'Nichts gelöscht.'), true);
    (r.gone || []).forEach((g) => this.all.forEach((p) => p.sel.delete(g)));
    await Promise.all(this.all.map((p) => p.refresh()));
    this.nav.load();
  },

  async properties(paths) {
    paths = (paths || []).filter(Boolean);
    if (!paths.length) return;
    await NAS.native({ cmd: 'foreground' });
    await NAS.api('properties', { paths }).catch(() => {});
  },

  async toggleHidden() {
    await NAS.api('hidden', { show: !this.hello.showHidden }).catch(() => {});
    await this.refreshHello();
    this.panes.forEach((p) => p.refresh());
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
    this.setStatus('Suchindex wird neu eingelesen …', true);
    $('#refreshBt').textContent = 'Liest ein …';
    this.hello.indexing = true;
  },

  async settings() {
    await NAS.native({ cmd: 'foreground' });
    await NAS.api('settings').catch(() => {});
    this.setStatus(this.hello.background
      ? 'Das Programm Datei-Explorer wird geöffnet – dort „Einstellungen …“ wählen.'
      : 'Die Einstellungen sind im Programmfenster geöffnet.', true);
  },

  bindGlobal() {
    addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-bg:not([hidden])')) return;
      const p = this.activePane();
      if (e.key === 'F5') { e.preventDefault(); p.reload(); }
      else if (e.key === 'Escape') {
        Menu.close();
        const s = this.search;
        if (document.activeElement !== s.search && s.search.value && p === s) { s.search.value = ''; s.runSearch(); s.search.focus(); }
      } else if (((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F' || e.key === 'e' || e.key === 'E') && !e.shiftKey) || e.key === 'F3') {
        e.preventDefault();
        this.search.search.focus();
        this.search.search.select();
      } else if (e.altKey && !p.isSearch && ['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(e.key) && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        if (e.key === 'ArrowLeft') p.goBack(); else if (e.key === 'ArrowRight') p.goForward(); else p.goUp();
      }
    });
    // Dateien versehentlich irgendwo anders fallen lassen: Chrome soll sie nicht öffnen
    addEventListener('dragover', (e) => { if (this.dragKind(e)) this.dragAlive(); });
    addEventListener('drop', (e) => { e.preventDefault(); this.endDrag(); });
  },
};

App.start();
