'use strict';
importScripts('conn.js');

const APP = chrome.runtime.getURL('app.html');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tab', title: 'NAS-Suche als Tab öffnen', contexts: ['action'] });
    // Seitenleiste gibt es in Chrome/Edge/Brave, nicht in Opera
    if (chrome.sidePanel) chrome.contextMenus.create({ id: 'panel', title: 'NAS-Suche in der Seitenleiste öffnen', contexts: ['action'] });
  });
  if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

async function openApp() {
  // eigener Tab schon offen? (ohne „tabs“-Berechtigung über getContexts)
  const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
  const own = ctx.find((c) => c.documentUrl && c.documentUrl.startsWith(APP) && !c.documentUrl.includes('panel='));
  if (own) {
    await chrome.tabs.update(own.tabId, { active: true });
    await chrome.windows.update(own.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP });
  }
}

chrome.action.onClicked.addListener(openApp);

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-app') openApp();
  else if (cmd === 'open-panel') { if (chrome.sidePanel && tab) chrome.sidePanel.open({ windowId: tab.windowId }); else openApp(); }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'panel' && tab && chrome.sidePanel) chrome.sidePanel.open({ windowId: tab.windowId });
  else openApp();
});

// Dateien für eine Webseite holen (die Seite selbst darf nicht auf das Programm zugreifen).
let dlBase = null;
async function fetchFiles(paths) {
  if (!dlBase) dlBase = (await NAS.api('hello')).dl;
  const out = [];
  let total = 0;
  for (const p of paths) {
    let r = await fetch(dlBase + encodeURIComponent(p));
    if (r.status === 403) { // Programm wurde neu gestartet → neuer Schlüssel
      dlBase = (await NAS.api('hello')).dl;
      r = await fetch(dlBase + encodeURIComponent(p));
    }
    const name = p.split(/[\\/]/).pop();
    if (!r.ok) throw new Error(`„${name}“ ist nicht lesbar.`);
    const buf = await r.arrayBuffer();
    total += buf.byteLength;
    if (total > 150 * 1024 * 1024) throw new Error('Zu groß für die Übergabe an die Webseite (über 150 MB).');
    out.push({ name, type: (r.headers.get('Content-Type') || '').split(';')[0], data: toBase64(buf) });
  }
  return { files: out };
}

function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'fetchFiles') {
    fetchFiles(msg.paths || []).then(reply, (e) => reply({ error: String(e.message || e) }));
    return true;
  }
  return false;
});
