// Hintergrund: PDFs in Chrome im Agentur-PDF-Editor (Tab) öffnen statt in
// Chromes eigener PDF-Anzeige, Rechtsklick-Menüs, Google-Drive-Knopf und
// Seitenleiste per Symbol.

importScripts("verbindung.js");

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tab", title: "Mit Agentur-PDF öffnen", contexts: ["link", "image"] });
    chrome.contextMenus.create({ id: "leiste", title: "In Agentur-PDF-Leiste übernehmen", contexts: ["link", "image"] });
  });
});

async function melden(text) {
  await chrome.action.setBadgeBackgroundColor({ color: "#B5121B" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: `Agentur-PDF: ${text}` });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
}

/** Datei im Editor-Tab öffnen (vorhandenen Tab ersetzen oder neuen anlegen) */
async function imEditor(blob, name, tabId) {
  const info = await (await Agentur.anfrage(`/api/chrome/tab?name=${encodeURIComponent(name)}`, { method: "POST", body: blob })).json();
  const url = Agentur.editorUrl(info.id);
  if (tabId !== undefined) await chrome.tabs.update(tabId, { url });
  else await chrome.tabs.create({ url });
}

async function uebernehmen(url, ziel, tabId) {
  const { blob, name } = await Agentur.holen(url);
  if (ziel === "leiste") {
    const hochgeladen = await Agentur.hochladen(blob, name);
    const { eingang = [] } = await chrome.storage.session.get("eingang");
    eingang.push({ id: hochgeladen.id, name: hochgeladen.name, groesse: blob.size });
    await chrome.storage.session.set({ eingang });
  } else if (ziel === "programm") {
    await Agentur.anfrage(`/api/chrome/oeffnen?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
  } else {
    await imEditor(blob, name, tabId);
  }
}

// ------------------------------------------- PDFs in Chrome automatisch übernehmen
async function automatischAn() {
  const { pdfsUebernehmen = true } = await chrome.storage.sync.get("pdfsUebernehmen");
  return pdfsUebernehmen;
}

const inArbeit = new Set(); // Tabs, die gerade übernommen werden (keine Doppelung)

async function pdfUebernehmen(tabId, url) {
  if (inArbeit.has(tabId) || url.startsWith(Agentur.BASIS)) return;
  if (!(await automatischAn())) return;
  inArbeit.add(tabId);
  try {
    await Agentur.verbinden(); // läuft das Programm nicht → Chrome-Ansicht bleibt
    await uebernehmen(url, "tab", tabId);
  } catch (fehler) {
    await melden(`PDF bleibt in Chromes Ansicht – ${fehler.message}`);
  } finally {
    setTimeout(() => inArbeit.delete(tabId), 3000);
  }
}

// Webadressen: am Inhaltstyp erkennen (auch ohne „.pdf“ in der Adresse)
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.method !== "GET" || d.statusCode !== 200) return;
    const kopf = (n) => d.responseHeaders?.find((h) => h.name.toLowerCase() === n)?.value?.toLowerCase() ?? "";
    if (!kopf("content-type").includes("application/pdf")) return;
    if (kopf("content-disposition").startsWith("attachment")) return; // ausdrücklicher Download
    void pdfUebernehmen(d.tabId, d.url);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"],
);

// Lokale Dateien (file:///…pdf) – nur wenn „Zugriff auf Datei-URLs“ erlaubt ist
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const url = info.url;
  if (!url || !/^file:\/\/\/.+\.pdf$/i.test(url.split(/[?#]/)[0])) return;
  chrome.extension.isAllowedFileSchemeAccess((erlaubt) => {
    if (erlaubt) void pdfUebernehmen(tabId, url);
  });
});

// ------------------------------------------- Google Drive (drive.js)
chrome.runtime.onMessage.addListener((nachricht, absender, antworten) => {
  if (nachricht?.art !== "drive") return false;
  if (nachricht.ziel === "leiste" && absender.tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: absender.tab.windowId }).catch(() => {});
  }
  (async () => {
    try {
      for (const id of nachricht.ids) await uebernehmen(Agentur.driveDownload(id), nachricht.ziel);
      antworten({ ok: true });
    } catch (fehler) {
      await melden(fehler.message);
      antworten({ fehler: fehler.message });
    }
  })();
  return true; // Antwort kommt asynchron
});

// ------------------------------------------- Rechtsklick auf Link/Bild
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.srcUrl || info.linkUrl || info.pageUrl;
  if (info.menuItemId === "leiste" && tab?.windowId !== undefined) {
    // Öffnen muss sofort (Benutzergeste) geschehen, das Laden danach
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  (async () => {
    try {
      await uebernehmen(url, info.menuItemId === "leiste" ? "leiste" : "tab");
    } catch (fehler) {
      await melden(fehler.message);
    }
  })();
});
