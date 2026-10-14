// Speicher-Schicht des Whiteboards (IndexedDB).
// Alles, was Boards, Elemente und Dateien betrifft, läuft über dieses Modul –
// so lässt sich später ein Team-Backend (NAS, Cloud) dahinter setzen, ohne die
// Oberfläche anzufassen.

const DB_NAME = 'whiteboard';
const DB_VERSION = 1;
export const INBOX_ID = 'inbox';
export const BOARD_COLORS = ['#f5b700', '#e8590c', '#2f9e44', '#1c7ed6', '#7048e8', '#d6336c', '#0c8599'];

let dbPromise;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('boards', { keyPath: 'id' });
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('boardId', 'boardId');
        db.createObjectStore('blobs', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () => crypto.randomUUID();

// ---------- Änderungs-Benachrichtigung (zwischen Tabs, Seitenleiste und Hintergrund)

const channel = new BroadcastChannel('whiteboard');
const listeners = new Set();
channel.onmessage = () => listeners.forEach((fn) => fn());

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  channel.postMessage({ type: 'changed' });
  listeners.forEach((fn) => fn());
  refreshBadge();
}

export async function refreshBadge() {
  if (!globalThis.chrome?.action) return;
  const n = (await allItems()).filter((i) => i.isNew && !i.deletedAt).length;
  chrome.action.setBadgeBackgroundColor({ color: '#e8590c' });
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// ---------- Boards

export async function listBoards() {
  let boards = await request((await store('boards')).getAll());
  if (!boards.some((b) => b.id === INBOX_ID)) {
    const inbox = { id: INBOX_ID, name: 'Eingang', color: BOARD_COLORS[0], created: Date.now(), order: 0 };
    await request((await store('boards', 'readwrite')).put(inbox));
    boards.push(inbox);
  }
  return boards.sort((a, b) => a.order - b.order || a.created - b.created);
}

export async function createBoard(name) {
  const boards = await listBoards();
  const board = {
    id: uid(),
    name,
    color: BOARD_COLORS[boards.length % BOARD_COLORS.length],
    created: Date.now(),
    order: Math.max(...boards.map((b) => b.order)) + 1,
  };
  await request((await store('boards', 'readwrite')).put(board));
  notify();
  return board;
}

export async function updateBoard(id, patch) {
  const s = await store('boards', 'readwrite');
  const board = await request(s.get(id));
  if (board) await request(s.put({ ...board, ...patch }));
  notify();
}

// Ein Board zu löschen löscht keine Inhalte: alles wandert in den Papierkorb.
export async function deleteBoard(id) {
  if (id === INBOX_ID) return;
  const board = (await listBoards()).find((b) => b.id === id);
  const db = await openDB();
  const tx = db.transaction(['boards', 'items'], 'readwrite');
  const items = tx.objectStore('items');
  const now = Date.now();
  items.index('boardId').getAll(id).onsuccess = (e) => {
    for (const item of e.target.result) {
      if (!item.deletedAt) items.put({ ...item, deletedAt: now, boardName: board?.name });
    }
  };
  tx.objectStore('boards').delete(id);
  await done(tx);
  notify();
}

export async function getTargetBoard() {
  if (!globalThis.chrome?.storage) return INBOX_ID;
  const { targetBoardId } = await chrome.storage.local.get('targetBoardId');
  return targetBoardId || INBOX_ID;
}

export async function setTargetBoard(id) {
  if (globalThis.chrome?.storage) await chrome.storage.local.set({ targetBoardId: id });
}

// ---------- Elemente

export async function allItems() {
  return request((await store('items')).getAll());
}

export async function listItems(boardId) {
  const all = await request((await store('items')).index('boardId').getAll(boardId));
  return all.filter((i) => !i.deletedAt);
}

export async function addItem(data, blob) {
  const existing = await listItems(data.boardId);
  const now = Date.now();
  const item = {
    id: uid(),
    created: now,
    updated: now,
    isNew: true,
    done: false,
    title: '',
    text: '',
    w: 240,
    h: 180,
    ...data,
  };
  item.z = Math.max(0, ...existing.map((i) => i.z || 0)) + 1;
  if (item.x == null || item.y == null) Object.assign(item, findFreeSpot(existing, item.w, item.h));
  if (blob) {
    item.blobId = uid();
    item.size = blob.size;
    item.mime = item.mime || blob.type || 'application/octet-stream';
  }
  const db = await openDB();
  const tx = db.transaction(['items', 'blobs'], 'readwrite');
  tx.objectStore('items').put(item);
  if (blob) tx.objectStore('blobs').put({ id: item.blobId, blob });
  await done(tx);
  notify();
  return item;
}

export async function updateItem(id, patch) {
  return updateMany([{ id, ...patch }]);
}

export async function updateMany(patches) {
  const db = await openDB();
  const tx = db.transaction('items', 'readwrite');
  const s = tx.objectStore('items');
  const now = Date.now();
  for (const { id, ...patch } of patches) {
    s.get(id).onsuccess = (e) => {
      if (e.target.result) s.put({ ...e.target.result, ...patch, updated: now });
    };
  }
  await done(tx);
  notify();
}

export async function moveItem(id, boardId) {
  const item = await request((await store('items')).get(id));
  const existing = await listItems(boardId);
  const z = Math.max(0, ...existing.map((i) => i.z || 0)) + 1;
  await updateItem(id, { boardId, z, ...findFreeSpot(existing, item.w, item.h) });
}

export const trashItem = (id) => updateItem(id, { deletedAt: Date.now() });

export async function restoreItem(id) {
  const [item, boards] = await Promise.all([request((await store('items')).get(id)), listBoards()]);
  if (!item) return;
  const boardId = boards.some((b) => b.id === item.boardId) ? item.boardId : INBOX_ID;
  const existing = await listItems(boardId);
  const free = existing.some((i) => overlaps(item, i, 0)) ? findFreeSpot(existing, item.w, item.h) : {};
  await updateItem(id, { deletedAt: null, boardId, ...free });
}

export async function purgeItems(ids) {
  const db = await openDB();
  const tx = db.transaction(['items', 'blobs'], 'readwrite');
  const items = tx.objectStore('items');
  for (const id of ids) {
    items.get(id).onsuccess = (e) => {
      const item = e.target.result;
      if (item?.blobId) tx.objectStore('blobs').delete(item.blobId);
      items.delete(id);
    };
  }
  await done(tx);
  notify();
}

export async function getBlob(blobId) {
  const rec = await request((await store('blobs')).get(blobId));
  return rec?.blob;
}

// Import mehrerer Boards samt Dateien in einer Transaktion.
export async function importData(boards, items, blobs) {
  const db = await openDB();
  const tx = db.transaction(['boards', 'items', 'blobs'], 'readwrite');
  boards.forEach((b) => tx.objectStore('boards').put(b));
  items.forEach((i) => tx.objectStore('items').put(i));
  blobs.forEach((b) => tx.objectStore('blobs').put(b));
  await done(tx);
  notify();
}

// ---------- Platzierung

function overlaps(a, b, gap) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

export function findFreeSpot(items, w = 240, h = 180) {
  const step = 40;
  for (let y = 40; y < 20000; y += step) {
    for (let x = 40; x <= 1200; x += step) {
      const rect = { x, y, w, h };
      if (!items.some((i) => overlaps(rect, i, 16))) return { x, y };
    }
  }
  return { x: 40, y: 40 };
}

export async function imageCardSize(blob, maxW = 360) {
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = bmp;
    bmp.close();
    const w = Math.round(Math.min(maxW, Math.max(180, width + 16)));
    const imgH = ((w - 16) * height) / width;
    return { w, h: Math.round(Math.min(560, Math.max(120, imgH + 34 + 52))) };
  } catch {
    return { w: 280, h: 240 };
  }
}
