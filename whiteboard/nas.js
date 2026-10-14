// Abgleich mit einem Ordner auf dem Netzlaufwerk (File System Access API).
//
// Aufbau des Ordners:
//   <Ordner>/
//     _whiteboard/info.json          Kennung des Whiteboard-Ordners
//     _whiteboard/boards/<id>.json   ein Eintrag pro Board
//     _whiteboard/karten/<id>.json   ein Eintrag pro Karte (Position, Notiz, erledigt …)
//     Eingang/…                      echte Dateien, ein Unterordner pro Board
//     Projekt X/…
//
// Die lokale Datenbank (db.js) bleibt Arbeitskopie und Puffer: Alles wird
// sofort lokal gespeichert und dann alle paar Sekunden mit dem Ordner
// abgeglichen. Ist das Laufwerk weg, wird nachgeholt, sobald es wieder da ist.
// Bei gleichzeitigen Änderungen an derselben Karte gewinnt die neuere.

import * as db from './db.js';

const META_DIR = '_whiteboard';
const POLL_MS = 5000;
// Dateien, die nie als Karte auftauchen sollen (Office-Sperrdateien, Systemdateien, Schreibpuffer)
const IGNORE = /^(\.|~\$|_)|^(thumbs\.db|desktop\.ini)$|\.(crswap|tmp)$/i;
const LOCAL_ONLY = ['blobId', 'syncedUpdated', 'isNew', 'fileStamp', 'purgedAt'];

let root = null;
let status = { state: 'off' }; // off | needs-permission | syncing | connected | offline
const statusListeners = new Set();
const jsonCache = new Map();
let pollTimer = null;
let soonTimer = null;
let subscribed = false;

export const supported = () => typeof window.showDirectoryPicker === 'function';
export const getStatus = () => status;

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  statusListeners.forEach((fn) => fn(status));
}

// ---------- Verbinden / Trennen

export async function init() {
  const handle = await db.getMeta('nasHandle');
  if (!handle) return setStatus({ state: 'off', name: null });
  root = handle;
  if (await hasPermission(handle, false)) start();
  else setStatus({ state: 'needs-permission', name: handle.name });
}

async function hasPermission(handle, ask) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return ask && (await handle.requestPermission(opts)) === 'granted';
}

// Muss aus einem Klick heraus aufgerufen werden (Ordnerauswahl von Chrome).
export async function connect() {
  const handle = await window.showDirectoryPicker({ id: 'whiteboard', mode: 'readwrite' });
  return useHandle(handle);
}

// Erneute Freigabe nach Browser-Neustart (ebenfalls aus einem Klick heraus).
export async function grant() {
  if (root && (await hasPermission(root, true))) start();
}

export async function useHandle(handle) {
  let hasMeta = false;
  let others = 0;
  for await (const [name] of handle.entries()) {
    if (name === META_DIR) hasMeta = true;
    else if (!name.startsWith('.')) others++;
  }
  if (!hasMeta && others && !confirm(
    `Der Ordner „${handle.name}“ ist nicht leer (${others} Einträge).\n\n` +
    'Vorhandene Unterordner erscheinen als Boards, Dateien darin als Karten. Trotzdem verwenden?')) {
    return false;
  }

  const meta = await handle.getDirectoryHandle(META_DIR, { create: true });
  let info = await readJson(meta, 'info.json');
  if (!info?.id) {
    info = { format: 'chrome-whiteboard-ordner', version: 1, id: crypto.randomUUID(), created: new Date().toISOString() };
    await writeJson(meta, 'info.json', info);
  }
  // Anderer Ordner als bisher → alles Lokale gilt als neu und wird dort abgelegt.
  if ((await db.getMeta('nasId')) !== info.id) {
    await resetSyncState();
    await db.setMeta('nasId', info.id);
    await db.setMeta('nasConnectedAt', Date.now());
  }
  try {
    await db.setMeta('nasHandle', handle);
  } catch {
    // Nicht speicherbar (z. B. in Tests) – Verbindung gilt dann nur bis zum Schließen.
  }
  root = handle;
  jsonCache.clear();
  start();
  return true;
}

export async function disconnect() {
  stop();
  root = null;
  await db.setMeta('nasHandle', undefined);
  setStatus({ state: 'off', name: null, error: null });
}

async function resetSyncState() {
  const [boards, items] = await Promise.all([db.rawBoards(), db.rawItems()]);
  const clear = (rec) => ({ ...rec, syncedUpdated: null, filePath: null, fileStamp: null });
  await db.putRaw(
    boards.map((b) => ({ ...clear(b), folder: b.id === db.INBOX_ID ? 'Eingang' : null })),
    items.filter((i) => !i.purgedAt).map(clear),
    [],
    items.filter((i) => i.purgedAt).map((i) => i.id),
  );
}

function start() {
  setStatus({ state: 'syncing', name: root.name, error: null });
  if (!subscribed) {
    subscribed = true;
    db.subscribe(() => syncSoon(800));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncSoon(0));
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(() => syncSoon(0), POLL_MS);
  syncSoon(0);
}

function stop() {
  clearInterval(pollTimer);
  clearTimeout(soonTimer);
  pollTimer = null;
}

export function syncSoon(delay = 0) {
  if (!root || !pollTimer) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(syncNow, delay);
}

let running = false;
let rerun = false;

export async function syncNow() {
  if (!root) return;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    // Nur ein Tab bzw. Seitenbereich gleicht gleichzeitig ab.
    await navigator.locks.request('whiteboard-nas-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const changed = await syncOnce();
      setStatus({ state: 'connected', lastSync: Date.now(), error: null });
      if (changed) db.notify();
    });
  } catch (err) {
    console.warn('Whiteboard-Abgleich:', err);
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      setStatus({ state: 'needs-permission', error: null });
      stop();
    } else {
      setStatus({ state: 'offline', error: err.message });
    }
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      syncSoon(200);
    }
  }
}

// ---------- Der eigentliche Abgleich

const isDirty = (rec) => rec.syncedUpdated == null || rec.updated > rec.syncedUpdated;

// Welche Fassung gilt? Nur eine Seite geändert → diese; beide → die neuere.
function winner(local, remote) {
  const remoteChanged = remote.updated > (local.syncedUpdated ?? -Infinity);
  if (remoteChanged && isDirty(local)) return remote.updated >= local.updated ? 'remote' : 'local';
  return remoteChanged ? 'remote' : 'local';
}

function strip(rec) {
  const out = { ...rec };
  LOCAL_ONLY.forEach((k) => delete out[k]);
  return out;
}

async function syncOnce() {
  const meta = await root.getDirectoryHandle(META_DIR, { create: true });
  const boardsDir = await meta.getDirectoryHandle('boards', { create: true });
  const cardsDir = await meta.getDirectoryHandle('karten', { create: true });
  const connectedAt = (await db.getMeta('nasConnectedAt')) || 0;
  let changed = false;

  // ----- 1. Boards
  const remoteBoards = await readJsonDir(boardsDir);
  const boards = new Map((await db.rawBoards()).map((b) => [b.id, b]));
  const boardPuts = [];

  for (const r of remoteBoards.data.values()) {
    const l = boards.get(r.id);
    if (!l || winner(l, r) === 'remote') {
      const next = { ...r, syncedUpdated: r.updated };
      boardPuts.push(next);
      boards.set(r.id, next);
    }
  }

  // Im Explorer angelegte Unterordner werden zu Boards.
  const dirs = await listDirs(root);
  const knownFolders = new Set([...boards.values()].map((b) => b.folder).filter(Boolean));
  for (const name of dirs) {
    if (knownFolders.has(name)) continue;
    const id = 'dir-' + hash(name);
    if (boards.has(id)) continue;
    const now = Date.now();
    const order = Math.max(0, ...[...boards.values()].map((b) => b.order || 0)) + 1;
    const board = { id, name, folder: name, color: db.BOARD_COLORS[boards.size % db.BOARD_COLORS.length], created: now, updated: now, order };
    boardPuts.push(board);
    boards.set(id, board);
    knownFolders.add(name);
  }
  if (boardPuts.length) {
    await db.putRaw(boardPuts);
    changed = true;
  }

  for (const b of boards.values()) {
    if (!isDirty(b)) continue;
    const r = remoteBoards.data.get(b.id);
    if (r && winner(b, r) === 'remote') continue;
    let folder = b.folder;
    if (!folder) {
      folder = uniqueIn(safeName(b.name), new Set([...dirs, ...knownFolders]));
      knownFolders.add(folder);
    }
    if (!b.deletedAt) await root.getDirectoryHandle(folder, { create: true });
    await writeJson(boardsDir, b.id + '.json', { ...strip(b), folder });
    await db.markSynced('boards', b.id, b.updated, { syncedUpdated: b.updated, folder });
    b.folder = folder;
  }
  const folderOf = (boardId) => boards.get(boardId)?.folder;

  // ----- 2. Karten: vom Laufwerk übernehmen
  const remoteItems = await readJsonDir(cardsDir);
  const localItems = await db.rawItems();
  const items = new Map(localItems.map((i) => [i.id, i]));
  const puts = new Map();
  const blobs = [];
  const delItems = [];
  const delBlobs = [];

  for (const r of remoteItems.data.values()) {
    const l = items.get(r.id);
    if (l?.purgedAt) continue;
    if (l && winner(l, r) !== 'remote') continue;
    const next = {
      ...r,
      syncedUpdated: r.updated,
      isNew: l ? l.isNew : r.created > connectedAt,
      blobId: l?.blobId ?? null,
      fileStamp: l?.fileStamp ?? null,
    };
    if (r.filePath && (!l || l.filePath !== r.filePath || !l.blobId)) {
      const f = await readFile(r.filePath);
      if (f) {
        if (next.blobId) delBlobs.push(next.blobId);
        next.blobId = crypto.randomUUID();
        next.fileStamp = f.stamp;
        next.size = f.blob.size;
        blobs.push({ id: next.blobId, blob: f.blob });
      }
    }
    puts.set(next.id, next);
    items.set(next.id, next);
  }

  // Auf dem Laufwerk endgültig gelöscht (von jemand anderem) → hier auch entfernen.
  // Schutz: Ist das Kartenverzeichnis plötzlich leer, ist eher das Laufwerk gestört.
  const vanished = localItems.filter((l) => l.syncedUpdated != null && !l.purgedAt && !remoteItems.names.has(l.id));
  if (vanished.length > 5 && remoteItems.names.size === 0) {
    throw new Error('Kartenverzeichnis auf dem Laufwerk unvollständig – Abgleich ausgesetzt');
  }
  for (const l of vanished) {
    delItems.push(l.id);
    if (l.blobId) delBlobs.push(l.blobId);
    items.delete(l.id);
  }

  // ----- 3. Karten: lokale Änderungen hochladen
  for (const l of [...items.values()]) {
    if (l.purgedAt) {
      await removeEntry(cardsDir, l.id + '.json');
      if (l.filePath) await removePath(l.filePath);
      delItems.push(l.id);
      items.delete(l.id);
      continue;
    }
    if (puts.has(l.id) || !isDirty(l)) continue;
    const folder = folderOf(l.boardId);
    if (!folder) continue;

    let { filePath, fileStamp } = l;
    if (l.blobId && (!filePath || dirOf(filePath) !== folder)) {
      // Neue Datei ablegen bzw. beim Verschieben in den Ordner des neuen Boards umziehen
      const blob = await db.getBlob(l.blobId);
      if (blob) {
        const dir = await root.getDirectoryHandle(folder, { create: true });
        const name = await uniqueFileName(dir, safeName(l.fileName || fallbackName(l)));
        fileStamp = await writeFile(dir, name, blob);
        if (filePath) await removePath(filePath);
        filePath = `${folder}/${name}`;
      }
    }
    await writeJson(cardsDir, l.id + '.json', { ...strip(l), filePath: filePath ?? null });
    await db.markSynced('items', l.id, l.updated, { syncedUpdated: l.updated, filePath: filePath ?? null, fileStamp: fileStamp ?? null });
    Object.assign(l, { filePath, fileStamp });
  }

  // ----- 4. Dateien in den Board-Ordnern: geändert oder neu hineingelegt?
  const byPath = new Map([...items.values()].filter((i) => i.filePath).map((i) => [i.filePath, i]));
  for (const b of boards.values()) {
    if (b.deletedAt || !b.folder) continue;
    let dir;
    try {
      dir = await root.getDirectoryHandle(b.folder);
    } catch {
      continue;
    }
    const boardItems = [...items.values()].filter((i) => i.boardId === b.id && !i.deletedAt);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || IGNORE.test(name)) continue;
      const path = `${b.folder}/${name}`;
      const file = await handle.getFile();
      const stamp = `${file.size}-${file.lastModified}`;
      const item = byPath.get(path);

      if (item) {
        // Datei wurde außerhalb (z. B. im Explorer) bearbeitet → Vorschau aktualisieren
        if (item.blobId && item.fileStamp === stamp) continue;
        const next = { ...(puts.get(item.id) || item), fileStamp: stamp, size: file.size };
        if (next.blobId) delBlobs.push(next.blobId);
        next.blobId = crypto.randomUUID();
        blobs.push({ id: next.blobId, blob: await copyFile(file) });
        puts.set(next.id, next);
        continue;
      }

      // Unbekannte Datei → neue Karte (gleiche ID bei allen im Team, daher keine Dubletten)
      const id = 'file-' + hash(path);
      if (items.has(id)) continue;
      const blob = await copyFile(file);
      const isImage = blob.type.startsWith('image/');
      const size = isImage ? await db.imageCardSize(blob) : { w: 250, h: 160 };
      const now = Date.now();
      const card = {
        id,
        boardId: b.id,
        type: isImage ? 'image' : 'file',
        title: name,
        fileName: name,
        filePath: path,
        fileStamp: stamp,
        mime: blob.type || 'application/octet-stream',
        size: blob.size,
        text: '',
        done: false,
        isNew: true,
        created: now,
        updated: now,
        z: Math.max(0, ...boardItems.map((i) => i.z || 0)) + 1,
        ...size,
        ...db.findFreeSpot(boardItems, size.w, size.h),
        blobId: crypto.randomUUID(),
      };
      blobs.push({ id: card.blobId, blob });
      puts.set(id, card);
      items.set(id, card);
      boardItems.push(card);
    }
  }

  if (puts.size || blobs.length || delItems.length) {
    await db.putRaw([], [...puts.values()], blobs, delItems, delBlobs);
    changed = true;
  } else if (delBlobs.length) {
    await db.putRaw([], [], [], [], delBlobs);
  }

  const pending = [...items.values()].filter((i) => !i.purgedAt && isDirty(i) && !puts.has(i.id)).length;
  setStatus({ pending });
  return changed;
}

// ---------- Dateisystem-Helfer

async function readJson(dir, name) {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeJson(dir, name, data) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
}

// Liest alle JSON-Dateien eines Verzeichnisses; unveränderte kommen aus dem Cache.
async function readJsonDir(dir) {
  const data = new Map();
  const names = new Set();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    names.add(id);
    const file = await handle.getFile();
    const key = `${dir.name}/${name}`;
    let cached = jsonCache.get(key);
    if (!cached || cached.lm !== file.lastModified || cached.size !== file.size) {
      try {
        cached = { lm: file.lastModified, size: file.size, data: JSON.parse(await file.text()) };
        jsonCache.set(key, cached);
      } catch {
        continue; // gerade im Schreiben – beim nächsten Durchlauf
      }
    }
    if (cached.data?.id) data.set(cached.data.id, cached.data);
  }
  return { data, names };
}

async function listDirs(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory' && !IGNORE.test(name)) out.push(name);
  }
  return out;
}

async function readFile(path) {
  try {
    const [folder, name] = splitPath(path);
    const dir = await root.getDirectoryHandle(folder);
    const file = await (await dir.getFileHandle(name)).getFile();
    return { blob: await copyFile(file), stamp: `${file.size}-${file.lastModified}` };
  } catch {
    return null;
  }
}

// Inhalt kopieren, damit die lokale Kopie nicht an der Datei auf dem Laufwerk hängt
async function copyFile(file) {
  return new Blob([await file.arrayBuffer()], { type: file.type });
}

async function writeFile(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  const file = await handle.getFile();
  return `${file.size}-${file.lastModified}`;
}

async function removeEntry(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
}

async function removePath(path) {
  const [folder, name] = splitPath(path);
  try {
    await removeEntry(await root.getDirectoryHandle(folder), name);
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
}

async function uniqueFileName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      throw err;
    }
  }
}

function uniqueIn(name, taken) {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (${n})`;
  return candidate;
}

const splitPath = (path) => {
  const i = path.indexOf('/');
  return [path.slice(0, i), path.slice(i + 1)];
};
const dirOf = (path) => splitPath(path)[0];

function safeName(s) {
  const name = (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[._~$\s]+/, '').trim().slice(0, 80);
  return name || 'Ohne Namen';
}

function fallbackName(item) {
  const ext = (item.mime || '').split('/')[1]?.split('+')[0] || 'bin';
  return `${item.title || 'datei'}.${ext}`;
}

// Kurzer, stabiler Hash (cyrb53) für IDs aus Datei- und Ordnernamen
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
