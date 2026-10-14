import * as db from './db.js';
import * as nas from './nas.js';
import { createZip, readZip } from './zip.js';

const TRASH = '__trash__';
const NOTE_COLORS = ['#fff3b0', '#ffd6e0', '#c9f2d0', '#cfe3ff', '#e6d9ff', '#f1f1f1'];
const ACCENT_COLORS = ['#f5b700', '#e8590c', '#2f9e44', '#1c7ed6', '#7048e8', null];
const TYPE_LABEL = { note: 'Notiz', image: 'Bild', file: 'Datei', link: 'Link' };

const ICONS = {
  note: '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  open: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  done: '<path d="m5 12 5 5 9-10"/>',
  color: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  import: '<path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

const $ = (sel) => document.querySelector(sel);
const viewport = $('#viewport');
const sizer = $('#sizer');
const canvas = $('#canvas');
const trashView = $('#trashView');

const state = {
  boards: [],
  all: [],
  boardId: db.INBOX_ID,
  scale: 1,
  selected: null,
  search: '',
  lastPoint: null,
  focusId: null,
  draggingOut: false,
  lastTrashed: null,
};
const blobUrls = new Map();

init();

// ---------- Start & Aktualisierung

async function init() {
  navigator.storage?.persist?.().catch(() => {});
  document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
  state.boards = await db.listBoards();
  const target = await db.getTargetBoard();
  state.boardId = state.boards.some((b) => b.id === target) ? target : db.INBOX_ID;
  state.scale = Number(readPref('scale')) || 1;
  bindToolbar();
  bindCanvas();
  bindGlobal();
  await refresh();
  db.subscribe(scheduleRefresh);
  nas.onStatus(renderSync);
  nas.init().catch((err) => console.warn('Netzlaufwerk:', err));
}

function readPref(key) {
  try { return localStorage.getItem('wb-' + key); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem('wb-' + key, value); } catch {}
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 40);
}

async function refresh() {
  const [boards, all] = await Promise.all([db.listBoards(), db.allItems()]);
  state.boards = boards;
  state.all = all;
  if (state.boardId !== TRASH && !boards.some((b) => b.id === state.boardId)) state.boardId = db.INBOX_ID;
  renderSidebar();
  renderHeader();
  if (state.boardId === TRASH) renderTrash();
  else renderCanvas();
  updateStorageInfo();
}

const find = (id) => state.all.find((i) => i.id === id);
const boardItems = () => state.all.filter((i) => i.boardId === state.boardId && !i.deletedAt);
const trashItems = () => state.all.filter((i) => i.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
const boardName = (id) => state.boards.find((b) => b.id === id)?.name;

async function blobUrl(item) {
  if (!item.blobId) return null;
  if (!blobUrls.has(item.blobId)) {
    const blob = await db.getBlob(item.blobId);
    if (!blob) return null;
    blobUrls.set(item.blobId, URL.createObjectURL(blob));
  }
  return blobUrls.get(item.blobId);
}

// ---------- Seitenleiste & Kopf

function renderSidebar() {
  const list = $('#boardList');
  const select = $('#boardSelect');
  list.replaceChildren();
  select.replaceChildren();

  for (const b of state.boards) {
    const items = state.all.filter((i) => i.boardId === b.id && !i.deletedAt);
    const fresh = items.filter((i) => i.isNew).length;
    const li = document.createElement('li');
    li.className = 'board-entry' + (b.id === state.boardId ? ' active' : '');
    li.dataset.boardDrop = b.id;
    li.title = 'Klicken zum Öffnen, Doppelklick zum Umbenennen. Karten und Dateien lassen sich hierher ziehen.';
    li.innerHTML = `<span class="dot"></span><span class="name"></span>
      <span class="badge" ${fresh ? '' : 'hidden'}></span><span class="count"></span>
      ${b.id === db.INBOX_ID ? '' : `<button class="icon-btn del" title="Board löschen">${icon('trash')}</button>`}`;
    li.querySelector('.dot').style.background = b.color;
    li.querySelector('.name').textContent = b.name;
    li.querySelector('.badge').textContent = fresh;
    li.querySelector('.count').textContent = items.length || '';
    li.addEventListener('click', (e) => (e.target.closest('.del') ? deleteBoard(b) : switchBoard(b.id)));
    li.addEventListener('dblclick', (e) => !e.target.closest('.del') && renameBoard(b));
    bindFileDrop(li, b.id);
    list.append(li);
    select.add(new Option(`${b.name}${fresh ? ` • ${fresh} neu` : ''}`, b.id, false, b.id === state.boardId));
  }

  const trashCount = trashItems().length;
  select.add(new Option(`Papierkorb (${trashCount})`, TRASH, false, state.boardId === TRASH));
  const t = $('#trashEntry');
  t.classList.toggle('active', state.boardId === TRASH);
  t.querySelector('.count').textContent = trashCount || '';
}

function renderHeader() {
  const inTrash = state.boardId === TRASH;
  $('#boardTitle').textContent = inTrash ? 'Papierkorb' : boardName(state.boardId);
  document.title = `${inTrash ? 'Papierkorb' : boardName(state.boardId)} – Whiteboard`;
  viewport.hidden = inTrash;
  trashView.hidden = !inTrash;
  for (const id of ['addNoteBtn', 'addFileBtn', 'arrangeBtn', 'exportBtn', 'search', 'zoomIn', 'zoomOut', 'zoomReset']) {
    $('#' + id).disabled = inTrash;
  }
  $('#zoomReset').textContent = Math.round(state.scale * 100) + '%';
}

async function switchBoard(id) {
  if (id === state.boardId) return;
  state.boardId = id;
  state.selected = null;
  canvas.replaceChildren();
  if (id !== TRASH) db.setTargetBoard(id);
  await refresh();
  viewport.scrollTo(0, 0);
}

async function newBoard() {
  const name = prompt('Name des neuen Boards (z. B. Projekt, Kunde, Vorgang):', '');
  if (!name?.trim()) return;
  const board = await db.createBoard(name.trim());
  await switchBoard(board.id);
}

async function renameBoard(board) {
  const name = prompt('Board umbenennen:', board.name);
  if (name?.trim() && name.trim() !== board.name) await db.updateBoard(board.id, { name: name.trim() });
}

async function deleteBoard(board) {
  const n = state.all.filter((i) => i.boardId === board.id && !i.deletedAt).length;
  const msg = n
    ? `Board „${board.name}“ löschen?\n\nDie ${n} Elemente landen im Papierkorb und können von dort wiederhergestellt werden.`
    : `Leeres Board „${board.name}“ löschen?`;
  if (!confirm(msg)) return;
  await db.deleteBoard(board.id);
  toast(`Board „${board.name}“ gelöscht`);
}

// ---------- Zeichenfläche

function signature(it) {
  return JSON.stringify([it.type, it.title, it.text, it.url, it.blobId, it.color, it.fileName]);
}

function matches(it, q) {
  return [it.title, it.text, it.fileName, it.url].some((v) => v?.toLowerCase().includes(q));
}

function renderCanvas() {
  const items = boardItems();
  const q = state.search.trim().toLowerCase();
  const seen = new Set();

  for (const it of items) {
    seen.add(it.id);
    let el = canvas.querySelector(`.card[data-id="${it.id}"]`);
    if (!el) {
      el = createCard(it);
      canvas.append(el);
    } else if (el.dataset.sig !== signature(it) && !el.contains(document.activeElement)) {
      const fresh = createCard(it);
      resizeObserver.unobserve(el);
      el.replaceWith(fresh);
      el = fresh;
    }
    if (!el.classList.contains('dragging')) placeCard(el, it);
    el.classList.toggle('is-new', !!it.isNew);
    el.classList.toggle('done', !!it.done);
    el.classList.toggle('selected', state.selected === it.id);
    el.classList.toggle('dim', !!q && !matches(it, q));
  }
  for (const el of [...canvas.children]) {
    if (!seen.has(el.dataset.id)) {
      resizeObserver.unobserve(el);
      el.remove();
    }
  }

  $('#emptyHint').hidden = items.length > 0;
  applyCanvasSize();

  if (state.focusId) {
    canvas.querySelector(`.card[data-id="${state.focusId}"] textarea`)?.focus();
    state.focusId = null;
  }
}

function placeCard(el, it) {
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.width = it.w + 'px';
  el.style.height = it.h + 'px';
  el.style.zIndex = it.z || 1;
}

function applyCanvasSize() {
  const items = boardItems();
  const maxX = Math.max(0, ...items.map((i) => i.x + i.w));
  const maxY = Math.max(0, ...items.map((i) => i.y + i.h));
  const w = Math.max(maxX + 800, viewport.clientWidth / state.scale, 2400);
  const h = Math.max(maxY + 600, viewport.clientHeight / state.scale, 1600);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.style.transform = `scale(${state.scale})`;
  sizer.style.width = w * state.scale + 'px';
  sizer.style.height = h * state.scale + 'px';
}

function createCard(it) {
  const el = document.createElement('div');
  el.className = `card type-${it.type}`;
  el.dataset.id = it.id;
  el.dataset.sig = signature(it);
  if (it.color) el.style.setProperty('--card-color', it.color);

  const actions = [];
  if (it.blobId) actions.push(['open', 'Öffnen'], ['download', 'Herunterladen']);
  if (it.type === 'link') actions.push(['open', 'Link öffnen']);
  if (it.type !== 'file') actions.push(['copy', 'In die Zwischenablage kopieren']);
  actions.push(['done', 'Erledigt / offen'], ['color', 'Farbe wechseln'], ['trash', 'In den Papierkorb (Entf)']);

  el.innerHTML = `
    <div class="card-head">
      <span class="type-ico">${icon(it.type)}</span>
      <span class="title" title="Doppelklick zum Umbenennen"></span>
      <span class="new-flag">NEU</span>
      <div class="actions">${actions.map(([a, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(a)}</button>`).join('')}</div>
    </div>
    <div class="card-body"></div>`;
  el.querySelector('.title').textContent = it.title || TYPE_LABEL[it.type];

  const body = el.querySelector('.card-body');
  if (it.type === 'note') {
    body.append(textBox('note-text', 'Notiz schreiben…', it));
  } else if (it.type === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const img = document.createElement('img');
    img.alt = it.title || 'Bild';
    img.draggable = true;
    img.title = 'Doppelklick: groß öffnen · Ziehen: als Datei herausziehen';
    if (it.blobId) blobUrl(it).then((u) => u && (img.src = u));
    else img.src = it.url;
    wrap.append(img);
    body.append(wrap, textBox('caption', 'Notiz zum Bild…', it));
  } else if (it.type === 'file') {
    const tile = document.createElement('div');
    tile.className = 'file-tile';
    tile.draggable = true;
    tile.title = 'Doppelklick: öffnen · Ziehen: auf Desktop oder in einen Ordner ziehen';
    tile.innerHTML = '<div class="ext"></div><div class="meta"><div class="fname"></div><div class="fsize muted small"></div></div>';
    const ext = (it.fileName || '').includes('.') ? it.fileName.split('.').pop().slice(0, 5) : 'datei';
    tile.querySelector('.ext').textContent = ext;
    tile.querySelector('.fname').textContent = it.fileName || it.title;
    tile.querySelector('.fsize').textContent = formatSize(it.size);
    blobUrl(it); // vorladen, damit das Herausziehen sofort klappt
    body.append(tile, textBox('caption', 'Was ist damit zu tun?', it));
  } else if (it.type === 'link') {
    const a = document.createElement('a');
    a.className = 'link';
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '<img alt=""><span class="lurl"></span>';
    a.querySelector('img').src = faviconUrl(it.url);
    a.querySelector('.lurl').textContent = it.url;
    body.append(a, textBox('caption', 'Notiz zum Link…', it));
  }

  if (it.url && it.type !== 'link') {
    const src = document.createElement('div');
    src.className = 'source';
    src.innerHTML = 'Quelle: <a target="_blank" rel="noopener"></a>';
    const a = src.querySelector('a');
    a.href = it.url;
    a.textContent = safeHost(it.url);
    body.append(src);
  }

  resizeObserver.observe(el);
  return el;
}

function textBox(cls, placeholder, it) {
  const ta = document.createElement('textarea');
  ta.className = cls;
  ta.placeholder = placeholder;
  ta.value = it.text || '';
  ta.spellcheck = true;
  ta.addEventListener('input', () => saveText(it.id, ta.value));
  ta.addEventListener('change', () => saveText(it.id, ta.value, true));
  return ta;
}

const textTimers = new Map();
function saveText(id, value, now = false) {
  clearTimeout(textTimers.get(id));
  const write = () => {
    textTimers.delete(id);
    const it = find(id);
    if (it) {
      it.text = value;
      const el = canvas.querySelector(`.card[data-id="${id}"]`);
      if (el) el.dataset.sig = signature(it);
    }
    db.updateItem(id, { text: value });
  };
  if (now) write();
  else textTimers.set(id, setTimeout(write, 400));
}

const sizeTimers = new Map();
const resizeObserver = new ResizeObserver((entries) => {
  for (const { target: el } of entries) {
    if (!el.isConnected) continue;
    const it = find(el.dataset.id);
    if (!it) continue;
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (Math.abs(w - it.w) <= 2 && Math.abs(h - it.h) <= 2) continue;
    it.w = w;
    it.h = h;
    clearTimeout(sizeTimers.get(it.id));
    sizeTimers.set(it.id, setTimeout(() => db.updateItem(it.id, { w, h }), 300));
  }
});

function select(id) {
  state.selected = id;
  canvas.querySelectorAll('.card.selected').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  if (id) canvas.querySelector(`.card[data-id="${id}"]`)?.classList.add('selected');
}

// Nach vorn holen und "neu"-Markierung entfernen
function touch(it, el) {
  const maxZ = Math.max(0, ...boardItems().map((i) => i.z || 0));
  const patch = {};
  if ((it.z || 0) < maxZ) patch.z = maxZ + 1;
  if (it.isNew) patch.isNew = false;
  if (!Object.keys(patch).length) return;
  Object.assign(it, patch);
  el.style.zIndex = it.z;
  el.classList.remove('is-new');
  db.updateItem(it.id, patch);
}

function startDrag(e, el, it) {
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y };
  let target = null;
  let moved = false;
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - start.x) / state.scale;
    const dy = (ev.clientY - start.y) / state.scale;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    el.classList.add('dragging');
    el.style.left = Math.max(0, Math.round(start.ix + dx)) + 'px';
    el.style.top = Math.max(0, Math.round(start.iy + dy)) + 'px';
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-board-drop]');
    if (over !== target) {
      target?.classList.remove('drop-target');
      target = over && over.dataset.boardDrop !== state.boardId ? over : null;
      target?.classList.add('drop-target');
    }
  };

  const end = async () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    el.classList.remove('dragging');
    target?.classList.remove('drop-target');
    if (!moved) return;
    if (target) {
      const dest = target.dataset.boardDrop;
      if (dest === TRASH) return trash(it);
      await db.moveItem(it.id, dest);
      toast(`Verschoben nach „${boardName(dest)}“`, 'Rückgängig', () => db.updateItem(it.id, { boardId: it.boardId, x: start.ix, y: start.iy }));
    } else {
      it.x = parseFloat(el.style.left);
      it.y = parseFloat(el.style.top);
      await db.updateItem(it.id, { x: it.x, y: it.y });
    }
  };

  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function renameItem(it, titleEl) {
  titleEl.contentEditable = 'true';
  titleEl.focus();
  document.getSelection().selectAllChildren(titleEl);
  const finish = (save) => {
    titleEl.contentEditable = 'false';
    titleEl.removeEventListener('keydown', onKey);
    const value = titleEl.textContent.trim();
    if (save && value !== (it.title || TYPE_LABEL[it.type])) db.updateItem(it.id, { title: value });
    else titleEl.textContent = it.title || TYPE_LABEL[it.type];
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') { finish(false); }
  };
  titleEl.addEventListener('keydown', onKey);
  titleEl.addEventListener('blur', () => titleEl.isContentEditable && finish(true), { once: true });
}

// ---------- Aktionen auf Karten

async function runAction(act, it) {
  switch (act) {
    case 'open': {
      const url = it.blobId ? await blobUrl(it) : it.url;
      if (url) window.open(url, '_blank');
      break;
    }
    case 'download': {
      const a = document.createElement('a');
      a.href = await blobUrl(it);
      a.download = fileNameOf(it);
      a.click();
      break;
    }
    case 'copy':
      try {
        if (it.type === 'image' && it.blobId) {
          const png = await toPng(await db.getBlob(it.blobId));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        } else {
          await navigator.clipboard.writeText(it.type === 'link' ? it.url : it.text || '');
        }
        toast('In die Zwischenablage kopiert');
      } catch (err) {
        toast('Kopieren nicht möglich: ' + err.message);
      }
      break;
    case 'done':
      await db.updateItem(it.id, { done: !it.done });
      break;
    case 'color': {
      const palette = it.type === 'note' ? NOTE_COLORS : ACCENT_COLORS;
      const next = palette[(palette.indexOf(it.color ?? (it.type === 'note' ? NOTE_COLORS[0] : null)) + 1) % palette.length];
      await db.updateItem(it.id, { color: next });
      break;
    }
    case 'trash':
      await trash(it);
      break;
  }
}

async function trash(it) {
  state.lastTrashed = it.id;
  if (state.selected === it.id) state.selected = null;
  await db.trashItem(it.id);
  toast(`„${it.title || TYPE_LABEL[it.type]}“ liegt im Papierkorb`, 'Rückgängig', () => db.restoreItem(it.id));
}

async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

// ---------- Inhalte hinzufügen

function toCanvas(e) {
  const r = viewport.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round((e.clientX - r.left + viewport.scrollLeft) / state.scale)),
    y: Math.max(0, Math.round((e.clientY - r.top + viewport.scrollTop) / state.scale)),
  };
}

function insertPoint() {
  if (state.lastPoint) return state.lastPoint;
  return {
    x: Math.round((viewport.scrollLeft + viewport.clientWidth / 2) / state.scale - 120),
    y: Math.round((viewport.scrollTop + viewport.clientHeight / 2) / state.scale - 90),
  };
}

const writableBoard = (id) => (id === TRASH ? db.INBOX_ID : id);
const stamp = () => new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

async function addNote(at, text = '') {
  const item = await db.addItem({ boardId: writableBoard(state.boardId), type: 'note', text, isNew: false, w: 240, h: 180, ...(at || insertPoint()) });
  state.focusId = text ? null : item.id;
  state.selected = item.id;
  await refresh(); // sofort anzeigen und Schreibfokus setzen
}

async function addFiles(files, boardId = state.boardId, at = null) {
  boardId = writableBoard(boardId);
  let pos = at;
  for (const f of files) {
    const p = pos ? { x: pos.x, y: pos.y } : {};
    if (f.type.startsWith('image/')) {
      const pasted = !f.name || /^image\.\w+$/.test(f.name);
      await db.addItem({
        boardId,
        type: 'image',
        title: pasted ? `Screenshot ${stamp()}` : f.name,
        fileName: pasted ? `screenshot-${Date.now()}.${f.type.split('/')[1] || 'png'}` : f.name,
        mime: f.type,
        isNew: false,
        ...(await db.imageCardSize(f)),
        ...p,
      }, f);
    } else {
      await db.addItem({ boardId, type: 'file', title: f.name, fileName: f.name, mime: f.type, isNew: false, w: 250, h: 160, ...p }, f);
    }
    if (pos) pos = { x: pos.x + 28, y: pos.y + 28 };
  }
  if (boardId !== state.boardId) toast(`${files.length} Datei(en) in „${boardName(boardId)}“ abgelegt`);
}

async function addText(text, at) {
  text = (text || '').trim();
  if (!text) return;
  if (/^https?:\/\/\S+$/i.test(text)) return addUrl(text, at);
  return addNote(at, text);
}

async function addUrl(url, at) {
  const boardId = writableBoard(state.boardId);
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(url)) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      if (res.ok && blob.type.startsWith('image/')) {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'bild';
        return db.addItem({ boardId, type: 'image', title: name, fileName: name, url, isNew: false, ...(await db.imageCardSize(blob)), ...at }, blob);
      }
    } catch {}
  }
  return db.addItem({ boardId, type: 'link', title: safeHost(url), url, isNew: false, w: 280, h: 130, ...at });
}

// Aufräumen: Elemente zeilenweise anordnen, Erledigtes ans Ende.
async function arrange() {
  const items = boardItems().sort((a, b) => (a.done - b.done) || (a.y - b.y) || (a.x - b.x));
  const maxW = Math.max(700, viewport.clientWidth / state.scale - 40);
  let x = 40, y = 40, rowH = 0;
  const patches = [];
  for (const it of items) {
    if (x + it.w > maxW && x > 40) {
      x = 40;
      y += rowH + 24;
      rowH = 0;
    }
    patches.push({ id: it.id, x, y });
    x += it.w + 24;
    rowH = Math.max(rowH, it.h);
  }
  const before = items.map(({ id, x, y }) => ({ id, x, y }));
  await db.updateMany(patches);
  viewport.scrollTo(0, 0);
  toast('Aufgeräumt', 'Rückgängig', () => db.updateMany(before));
}

// ---------- Export / Import (Weitergeben ans Team, Sicherung)

async function exportBoards(boards, label) {
  const enc = new TextEncoder();
  const entries = [];
  const data = { format: 'chrome-whiteboard', version: 1, exported: new Date().toISOString(), boards, items: [] };
  for (const board of boards) {
    for (const it of state.all.filter((i) => i.boardId === board.id && !i.deletedAt)) {
      const { blobId: _b, syncedUpdated, fileStamp, isNew, ...copy } = it;
      if (it.blobId) {
        const blob = await db.getBlob(it.blobId);
        if (blob) {
          copy.path = `dateien/${safeName(board.name)}/${it.blobId.slice(0, 8)}-${safeName(fileNameOf(it))}`;
          entries.push({ name: copy.path, data: new Uint8Array(await blob.arrayBuffer()) });
        }
      }
      data.items.push(copy);
    }
  }
  entries.unshift({ name: 'whiteboard.json', data: enc.encode(JSON.stringify(data, null, 2)) });
  const zip = createZip(entries);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `Whiteboard-${safeName(label)}-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Export erstellt (${formatSize(zip.size)})`);
}

async function importZip(file) {
  try {
    const files = await readZip(file);
    const json = files.get('whiteboard.json');
    if (!json) throw new Error('In der ZIP fehlt whiteboard.json – ist das ein Whiteboard-Export?');
    const data = JSON.parse(new TextDecoder().decode(json));
    const names = new Set(state.boards.map((b) => b.name));
    const idMap = new Map();
    let order = Math.max(0, ...state.boards.map((b) => b.order)) + 1;
    const boards = data.boards.map((b) => {
      const id = db.uid();
      idMap.set(b.id, id);
      const name = names.has(b.name) ? `${b.name} (Import)` : b.name;
      const { folder, syncedUpdated, deletedAt, ...rest } = b;
      return { ...rest, id, name, order: order++, created: Date.now(), updated: Date.now() };
    });
    const items = [];
    const blobs = [];
    for (const it of data.items) {
      const copy = { ...it, id: db.uid(), boardId: idMap.get(it.boardId), isNew: true };
      if (!copy.boardId) continue;
      for (const k of ['path', 'deletedAt', 'purgedAt', 'syncedUpdated', 'filePath', 'fileStamp']) delete copy[k];
      if (it.path) {
        const bytes = files.get(it.path);
        if (!bytes) continue;
        copy.blobId = db.uid();
        blobs.push({ id: copy.blobId, blob: new Blob([bytes], { type: it.mime || '' }) });
      }
      items.push(copy);
    }
    await db.importData(boards, items, blobs);
    toast(`${boards.length} Board(s) mit ${items.length} Elementen importiert`);
    if (boards[0]) switchBoard(boards[0].id);
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message);
  }
}

// ---------- Papierkorb

function renderTrash() {
  const items = trashItems();
  trashView.replaceChildren();
  const head = document.createElement('div');
  head.className = 'trash-head';
  head.innerHTML = `<h2>Papierkorb</h2>${items.length ? '<button class="tool" id="emptyTrashBtn">Papierkorb leeren</button>' : ''}`;
  const info = document.createElement('p');
  info.className = 'muted';
  info.textContent = 'Alles, was du entfernst, landet zuerst hier – endgültig weg ist es erst, wenn du es hier löschst.';
  trashView.append(head, info);
  head.querySelector('#emptyTrashBtn')?.addEventListener('click', async () => {
    if (confirm(`${items.length} Elemente endgültig löschen? Das lässt sich nicht rückgängig machen.${nasNote()}`)) {
      await db.purgeItems(items.map((i) => i.id));
    }
  });

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-trash';
    empty.textContent = 'Der Papierkorb ist leer.';
    trashView.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'trash-grid';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'trash-card';
    card.innerHTML = `<div class="thumb">${icon(it.type)}</div>
      <div class="info"><div class="t"></div><div class="m"></div></div>
      <button class="icon-btn" data-act="restore" title="Wiederherstellen">${icon('restore')}</button>
      <button class="icon-btn" data-act="purge" title="Endgültig löschen">${icon('trash')}</button>`;
    card.querySelector('.t').textContent = it.title || it.fileName || (it.text || '').slice(0, 60) || TYPE_LABEL[it.type];
    const from = boardName(it.boardId) || it.boardName || 'gelöschtes Board';
    card.querySelector('.m').textContent = `aus „${from}“ · ${new Date(it.deletedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`;
    if (it.type === 'image' && it.blobId) {
      blobUrl(it).then((u) => {
        if (u) card.querySelector('.thumb').innerHTML = `<img alt="" src="${u}">`;
      });
    }
    card.querySelector('[data-act="restore"]').addEventListener('click', async () => {
      await db.restoreItem(it.id);
      toast(`Wiederhergestellt in „${boardName(it.boardId) || 'Eingang'}“`);
    });
    card.querySelector('[data-act="purge"]').addEventListener('click', () => {
      if (confirm(`Dieses Element endgültig löschen?${nasNote()}`)) db.purgeItems([it.id]);
    });
    grid.append(card);
  }
  trashView.append(grid);
}

// ---------- Ereignisse

function bindToolbar() {
  bindSync();
  $('#newBoardBtn').addEventListener('click', newBoard);
  $('#trashEntry').addEventListener('click', () => switchBoard(TRASH));
  $('#boardSelect').addEventListener('change', (e) => switchBoard(e.target.value));
  $('#boardTitle').addEventListener('dblclick', () => {
    const b = state.boards.find((x) => x.id === state.boardId);
    if (b) renameBoard(b);
  });
  $('#addNoteBtn').addEventListener('click', () => addNote());
  $('#addFileBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    await addFiles([...e.target.files], state.boardId, insertPoint());
    e.target.value = '';
  });
  $('#arrangeBtn').addEventListener('click', arrange);
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderCanvas();
  });
  $('#zoomIn').addEventListener('click', () => setScale(state.scale * 1.2));
  $('#zoomOut').addEventListener('click', () => setScale(state.scale / 1.2));
  $('#zoomReset').addEventListener('click', () => setScale(1));
  $('#exportBtn').addEventListener('click', () => {
    const b = state.boards.find((x) => x.id === state.boardId);
    if (b) exportBoards([b], b.name);
  });
  $('#backupBtn').addEventListener('click', () => exportBoards(state.boards, 'Sicherung'));
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    if (e.target.files[0]) await importZip(e.target.files[0]);
    e.target.value = '';
  });
  $('#toast button').addEventListener('click', () => {
    $('#toast').hidden = true;
    toastAction?.();
  });
}

function bindCanvas() {
  canvas.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.card');
    if (!el) return;
    const it = find(el.dataset.id);
    if (!it) return;
    select(it.id);
    touch(it, el);
    if (e.button === 0 && e.target.closest('.card-head') && !e.target.closest('button, [contenteditable="true"]')) {
      startDrag(e, el, it);
    }
  });

  canvas.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const it = find(btn.closest('.card').dataset.id);
    if (it) runAction(btn.dataset.act, it);
  });

  // Doppelklick auf freie Fläche = neue Notiz. (Durch das Pointer-Capture beim
  // Verschieben landet das Ereignis am Viewport, nicht an der Fläche.)
  viewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card')) return;
    const r = viewport.getBoundingClientRect();
    if (e.clientX - r.left > viewport.clientWidth || e.clientY - r.top > viewport.clientHeight) return; // Scrollbalken
    addNote(toCanvas(e));
  });

  canvas.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.card');
    if (!el) return;
    const it = find(el.dataset.id);
    if (!it) return;
    if (e.target.closest('.title')) renameItem(it, e.target.closest('.title'));
    else if (e.target.closest('.img-wrap img, .file-tile')) runAction('open', it);
  });

  // Bilder und Dateien als echte Datei aus dem Board herausziehen
  canvas.addEventListener('dragstart', (e) => {
    const handle = e.target.closest?.('.img-wrap img, .file-tile');
    if (!handle) return;
    const it = find(handle.closest('.card').dataset.id);
    const url = it?.blobId && blobUrls.get(it.blobId);
    state.draggingOut = true;
    if (url) e.dataTransfer.setData('DownloadURL', `${it.mime || 'application/octet-stream'}:${fileNameOf(it)}:${url}`);
  });
  document.addEventListener('dragend', () => (state.draggingOut = false));

  // Fläche verschieben (Ziehen auf freiem Bereich)
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas && e.target !== sizer) return;
    select(null);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sl = viewport.scrollLeft, st = viewport.scrollTop;
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('panning');
    const move = (ev) => {
      viewport.scrollLeft = sl - (ev.clientX - sx);
      viewport.scrollTop = st - (ev.clientY - sy);
    };
    const up = () => {
      viewport.classList.remove('panning');
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      viewport.removeEventListener('pointercancel', up);
    };
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', up);
  });

  viewport.addEventListener('pointermove', (e) => (state.lastPoint = toCanvas(e)));
  viewport.addEventListener('pointerleave', () => (state.lastPoint = null));

  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale(state.scale * Math.exp(-e.deltaY * 0.0015), e);
  }, { passive: false });

  viewport.addEventListener('dragover', (e) => {
    if (state.draggingOut) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('drop-active');
  });
  viewport.addEventListener('dragleave', (e) => {
    if (!viewport.contains(e.relatedTarget)) viewport.classList.remove('drop-active');
  });
  viewport.addEventListener('drop', (e) => {
    viewport.classList.remove('drop-active');
    if (state.draggingOut) return;
    e.preventDefault();
    const at = toCanvas(e);
    const files = [...e.dataTransfer.files];
    if (files.length) return addFiles(files, state.boardId, at);
    const uri = e.dataTransfer.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    addText(uri || e.dataTransfer.getData('text/plain'), at);
  });

  window.addEventListener('resize', applyCanvasSize);
}

// Dateien direkt auf ein Board in der Seitenleiste ziehen
function bindFileDrop(el, boardId) {
  el.addEventListener('dragover', (e) => {
    if (state.draggingOut || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-target');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files], boardId);
  });
}

const isEditing = (t) => !!t?.closest?.('textarea, input, select, [contenteditable="true"]');

function bindGlobal() {
  document.addEventListener('paste', (e) => {
    if (isEditing(e.target) || state.boardId === TRASH) return;
    e.preventDefault();
    const files = [...e.clipboardData.files];
    if (files.length) addFiles(files, state.boardId, insertPoint());
    else addText(e.clipboardData.getData('text/plain'), insertPoint());
  });

  document.addEventListener('keydown', (e) => {
    if (isEditing(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const it = state.selected && find(state.selected);
    if ((e.key === 'Delete' || e.key === 'Backspace') && it) {
      e.preventDefault();
      trash(it);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.lastTrashed) {
      e.preventDefault();
      db.restoreItem(state.lastTrashed);
      state.lastTrashed = null;
      toast('Wiederhergestellt');
    } else if (e.key === 'Escape') {
      select(null);
    }
  });

  window.addEventListener('pagehide', () => {
    for (const [id, timer] of textTimers) {
      clearTimeout(timer);
      const ta = canvas.querySelector(`.card[data-id="${id}"] textarea`);
      if (ta) db.updateItem(id, { text: ta.value });
    }
  });
}

function setScale(s, anchor) {
  s = Math.min(2.5, Math.max(0.25, s));
  const r = viewport.getBoundingClientRect();
  const ax = anchor ? anchor.clientX - r.left : viewport.clientWidth / 2;
  const ay = anchor ? anchor.clientY - r.top : viewport.clientHeight / 2;
  const cx = (viewport.scrollLeft + ax) / state.scale;
  const cy = (viewport.scrollTop + ay) / state.scale;
  state.scale = s;
  writePref('scale', s);
  applyCanvasSize();
  viewport.scrollLeft = cx * s - ax;
  viewport.scrollTop = cy * s - ay;
  $('#zoomReset').textContent = Math.round(s * 100) + '%';
}

// ---------- Hilfsfunktionen

let toastTimer;
let toastAction;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.querySelector('.msg').textContent = msg;
  const btn = t.querySelector('button');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  toastAction = action;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------- Netzlaufwerk

const nasNote = () =>
  nas.getStatus().state === 'off' ? '' : '\n\nZugehörige Dateien werden auch auf dem Netzlaufwerk gelöscht – für alle im Team.';

const SYNC_TEXT = {
  off: ['Nur lokal', 'Noch kein Netzlaufwerk verbunden – alles liegt nur in diesem Chrome.'],
  'needs-permission': ['Freigeben', 'Chrome braucht nach dem Neustart einmal deine Freigabe für den Ordner.'],
  syncing: ['Gleiche ab…', 'Abgleich mit dem Netzlaufwerk läuft.'],
  connected: ['Netzlaufwerk', 'Verbunden – Änderungen werden automatisch gespeichert.'],
  offline: ['Nicht erreichbar', 'Netzlaufwerk gerade nicht erreichbar. Alles wird lokal gepuffert und nachgeholt.'],
};

function renderSync(st) {
  const btn = $('#syncBtn');
  const [label, text] = SYNC_TEXT[st.state] || SYNC_TEXT.off;
  btn.dataset.state = st.state;
  btn.querySelector('.lbl').textContent = label;
  btn.title = st.name ? `${text}\nOrdner: ${st.name}` : text;
  const panel = $('#syncPanel');
  panel.querySelector('.sync-state').textContent = text;
  panel.querySelector('.sync-folder').textContent = st.name ? `Ordner: ${st.name}` : '';
  const details = [];
  if (st.lastSync) details.push(`Zuletzt abgeglichen: ${new Date(st.lastSync).toLocaleTimeString('de-DE')}`);
  if (st.pending) details.push(`${st.pending} Änderung(en) warten auf Übertragung`);
  if (st.error) details.push(`Fehler: ${st.error}`);
  panel.querySelector('.sync-details').textContent = details.join(' · ');
  const on = st.state !== 'off';
  panel.querySelector('[data-sync="connect"]').textContent = on ? 'Anderen Ordner wählen…' : 'Ordner auf dem Netzlaufwerk wählen…';
  panel.querySelector('[data-sync="grant"]').hidden = st.state !== 'needs-permission';
  panel.querySelector('[data-sync="now"]').hidden = !['connected', 'offline'].includes(st.state);
  panel.querySelector('[data-sync="disconnect"]').hidden = !on;
}

function bindSync() {
  const panel = $('#syncPanel');
  $('#syncBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (nas.getStatus().state === 'needs-permission') return grantNas();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !e.target.closest('#syncPanel, #syncBtn')) panel.hidden = true;
  });
  panel.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-sync]')?.dataset.sync;
    if (!act) return;
    if (act === 'connect') {
      if (!nas.supported()) return toast('Dieser Browser kann keine Ordner freigeben – bitte Chrome oder Edge verwenden.');
      try {
        if (await nas.connect()) {
          panel.hidden = true;
          toast('Netzlaufwerk verbunden – deine Boards werden jetzt dort gespeichert.');
        }
      } catch (err) {
        if (err.name !== 'AbortError') toast('Ordner konnte nicht verbunden werden: ' + err.message);
      }
    } else if (act === 'grant') {
      await grantNas();
    } else if (act === 'now') {
      nas.syncNow();
    } else if (act === 'disconnect') {
      if (confirm('Verbindung zum Netzlaufwerk trennen?\n\nDeine Boards bleiben lokal erhalten, auf dem Laufwerk wird nichts gelöscht. Neue Änderungen werden dann aber nicht mehr dort gespeichert.')) {
        await nas.disconnect();
        panel.hidden = true;
      }
    }
  });
}

async function grantNas() {
  try {
    await nas.grant();
  } catch (err) {
    toast('Freigabe nicht möglich: ' + err.message);
  }
}

async function updateStorageInfo() {
  const est = await navigator.storage?.estimate?.();
  if (est) $('#storageInfo').textContent = `${formatSize(est.usage)} belegt · ${state.all.filter((i) => !i.deletedAt).length} Elemente`;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i && bytes < 10 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

function fileNameOf(it) {
  if (it.fileName) return it.fileName;
  const ext = (it.mime || '').split('/')[1]?.split('+')[0] || 'bin';
  return `${safeName(it.title || TYPE_LABEL[it.type])}.${ext}`;
}

const safeName = (s) => (s || 'datei').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'datei';

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}
