/* Service Worker: Fensterverwaltung, Benachrichtigungen, Kontextmenü, Anrufliste.
   Die eigentliche Telefonie läuft im Offscreen-Dokument (engine.html), damit
   Gespräche auch weiterlaufen, wenn das Telefonfenster geschlossen wird. */
importScripts('common.js');

let creatingEngine = null;

async function ensureEngine() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creatingEngine) {
    creatingEngine = chrome.offscreen.createDocument({
      url: 'engine.html',
      reasons: ['WEB_RTC', 'USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'SIP/WebRTC-Telefonie im Hintergrund (Gespräche, Klingelton)'
    }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; })
      .finally(() => { creatingEngine = null; });
  }
  await creatingEngine;
}

async function openPhoneWindow(focus = true) {
  const { phoneWindowId } = await chrome.storage.session.get('phoneWindowId');
  if (phoneWindowId) {
    try {
      await chrome.windows.update(phoneWindowId, focus ? { focused: true, drawAttention: true } : { drawAttention: true });
      return;
    } catch (e) { /* Fenster existiert nicht mehr */ }
  }
  const { winBounds } = await chrome.storage.local.get('winBounds');
  const opts = { url: 'app.html', type: 'popup', width: 390, height: 720, focused: true };
  if (winBounds) Object.assign(opts, winBounds);
  let w;
  try { w = await chrome.windows.create(opts); }
  catch (e) { w = await chrome.windows.create({ url: 'app.html', type: 'popup', width: 390, height: 720 }); }
  await chrome.storage.session.set({ phoneWindowId: w.id });
}

chrome.windows.onRemoved.addListener(async (id) => {
  const { phoneWindowId } = await chrome.storage.session.get('phoneWindowId');
  if (id === phoneWindowId) await chrome.storage.session.remove('phoneWindowId');
});

chrome.windows.onBoundsChanged.addListener(async (w) => {
  const { phoneWindowId } = await chrome.storage.session.get('phoneWindowId');
  if (w.id === phoneWindowId) {
    await chrome.storage.local.set({ winBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
  }
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'call-selection', title: 'Anrufen: „%s“', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'call-link', title: 'Mit Browser-Telefon anrufen', contexts: ['link'], targetUrlPatterns: ['tel:*'] });
  });
}

async function startCall(raw) {
  const number = cleanDial(raw);
  if (!number) return;
  await ensureEngine();
  await openPhoneWindow();
  chrome.runtime.sendMessage({ target: 'engine', cmd: 'call', number }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'call-selection') startCall(info.selectionText);
  if (info.menuItemId === 'call-link') startCall(info.linkUrl);
});

chrome.action.onClicked.addListener(async () => { await ensureEngine(); await openPhoneWindow(); });
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'open-phone') { await ensureEngine(); await openPhoneWindow(); }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  setupMenus();
  await ensureEngine();
  if (details.reason === 'install') await openPhoneWindow();
});

chrome.runtime.onStartup.addListener(async () => {
  setupMenus();
  const s = await loadSettings();
  if (s.autoStart) await ensureEngine();
  updateBadge();
});

// ---------- Benachrichtigungen bei eingehenden Anrufen ----------

async function onIncoming(line) {
  const s = await loadSettings();
  const { phonebook } = await chrome.storage.local.get('phonebook');
  const hit = lookupNumber(phonebook, line.number);
  const who = hit ? displayName(hit.entry) : (line.name || line.number || 'Unbekannt');
  if (s.notifications) {
    chrome.notifications.create('call-' + line.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Eingehender Anruf (L' + line.slot + ')',
      message: who + (hit || line.name ? '\n' + (line.number || '') : ''),
      requireInteraction: true,
      priority: 2,
      buttons: [{ title: 'Annehmen' }, { title: 'Ablehnen' }]
    });
  }
  if (s.popupOnIncoming) await openPhoneWindow(true);
}

chrome.notifications.onButtonClicked.addListener(async (nid, idx) => {
  if (!nid.startsWith('call-')) return;
  const id = Number(nid.slice(5));
  chrome.notifications.clear(nid);
  chrome.runtime.sendMessage({ target: 'engine', cmd: idx === 0 ? 'answer' : 'hangup', id }).catch(() => {});
  if (idx === 0) openPhoneWindow();
});
chrome.notifications.onClicked.addListener((nid) => { chrome.notifications.clear(nid); openPhoneWindow(); });

// ---------- Anrufliste / Badge ----------

async function addCallLog(entry) {
  const { callLog = [], missed = 0 } = await chrome.storage.local.get(['callLog', 'missed']);
  callLog.unshift(entry);
  const upd = { callLog: callLog.slice(0, 500) };
  if (entry.missed) upd.missed = missed + 1;
  await chrome.storage.local.set(upd);
  updateBadge();
}

async function updateBadge() {
  const { missed = 0 } = await chrome.storage.local.get('missed');
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: missed ? String(missed) : '' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'engine') return;
  switch (msg.type) {
    case 'get-config':
      loadSettings().then(sendResponse);
      return true;
    case 'ensure-engine':
      ensureEngine().then(() => sendResponse(true), (e) => sendResponse({ error: String(e) }));
      return true;
    case 'incoming':
      onIncoming(msg.line);
      break;
    case 'incoming-end':
      chrome.notifications.clear('call-' + msg.id);
      break;
    case 'call-log':
      addCallLog(msg.entry);
      break;
    case 'clear-missed':
      chrome.storage.local.set({ missed: 0 }).then(updateBadge);
      break;
    case 'open-permission':
      chrome.tabs.create({ url: 'permission.html' });
      break;
  }
});
