import * as db from './db.js';

const BOARD_URL = chrome.runtime.getURL('board.html');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const menu = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
    menu('wb-selection', 'Auswahl aufs Whiteboard', ['selection']);
    menu('wb-image', 'Bild aufs Whiteboard', ['image']);
    menu('wb-link', 'Link aufs Whiteboard', ['link']);
    menu('wb-page', 'Seite als Link aufs Whiteboard', ['page']);
    menu('wb-screenshot', 'Screenshot dieser Seite aufs Whiteboard', ['page', 'image', 'selection', 'link']);
    menu('wb-sidepanel', 'Whiteboard im Seitenbereich öffnen', ['action']);
  });
  db.refreshBadge();
});

chrome.runtime.onStartup.addListener(() => db.refreshBadge());

chrome.action.onClicked.addListener(openBoard);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-tab') run(() => captureTab(tab));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'wb-selection':
      return run(() => saveNote(info.selectionText, tab));
    case 'wb-image':
      return run(() => saveImage(info.srcUrl, tab));
    case 'wb-link':
      return run(() => saveLink(info.linkUrl, info.selectionText || info.linkUrl, tab));
    case 'wb-page':
      return run(() => saveLink(tab.url, tab.title, tab));
    case 'wb-screenshot':
      return run(() => captureTab(tab));
    case 'wb-sidepanel':
      return chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

async function openBoard() {
  const [existing] = await chrome.tabs.query({ url: BOARD_URL + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: BOARD_URL });
  }
}

// Kurzes Feedback am Symbol: ✓ bei Erfolg, ! bei Fehler.
async function run(fn) {
  let ok = true;
  try {
    await fn();
  } catch (err) {
    ok = false;
    console.error('Whiteboard:', err);
  }
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#2f9e44' : '#c92a2a' });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => db.refreshBadge(), 1500);
}

async function targetBoard() {
  const [id, boards] = await Promise.all([db.getTargetBoard(), db.listBoards()]);
  return boards.some((b) => b.id === id) ? id : db.INBOX_ID;
}

const source = (tab) => (tab?.url && !tab.url.startsWith('chrome') ? tab.url : undefined);

async function saveNote(text, tab) {
  await db.addItem({
    boardId: await targetBoard(),
    type: 'note',
    title: tab?.title ? `Aus: ${tab.title}` : '',
    text,
    url: source(tab),
    w: 260,
    h: 200,
  });
}

async function saveLink(url, title, tab) {
  await db.addItem({
    boardId: await targetBoard(),
    type: 'link',
    title: title || url,
    url,
    w: 280,
    h: 130,
  });
}

async function saveImage(srcUrl, tab) {
  let blob;
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) throw new Error(res.statusText);
    blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('kein Bild');
  } catch {
    // Bild nicht ladbar (z. B. Login nötig) – wenigstens den Link sichern.
    return saveLink(srcUrl, `Bild: ${tab?.title || srcUrl}`, tab);
  }
  const name = decodeURIComponent(new URL(srcUrl, 'https://x').pathname.split('/').pop() || '') || 'bild';
  await db.addItem({
    boardId: await targetBoard(),
    type: 'image',
    title: tab?.title || name,
    fileName: name,
    url: source(tab),
    ...(await db.imageCardSize(blob)),
  }, blob);
}

async function captureTab(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const stamp = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  await db.addItem({
    boardId: await targetBoard(),
    type: 'image',
    title: `Screenshot ${stamp} – ${tab.title || ''}`.trim(),
    fileName: `screenshot-${Date.now()}.png`,
    url: source(tab),
    ...(await db.imageCardSize(blob)),
  }, blob);
}
