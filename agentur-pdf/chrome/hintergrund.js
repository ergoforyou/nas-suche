// Hintergrund: Rechtsklick-Menüs in Chrome und Seitenleiste per Symbol öffnen.

importScripts("verbindung.js");

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "leiste", title: "In Agentur-PDF-Leiste übernehmen", contexts: ["link", "image"] });
    chrome.contextMenus.create({ id: "programm", title: "Mit Agentur-PDF öffnen", contexts: ["link", "image"] });
  });
});

async function melden(text) {
  await chrome.action.setBadgeBackgroundColor({ color: "#B5121B" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: `Agentur-PDF: ${text}` });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.srcUrl || info.linkUrl || info.pageUrl;
  if (info.menuItemId === "leiste" && tab?.windowId !== undefined) {
    // Öffnen muss sofort (Benutzergeste) geschehen, das Laden danach
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  (async () => {
    try {
      const { blob, name } = await Agentur.holen(url);
      if (info.menuItemId === "leiste") {
        const hochgeladen = await Agentur.hochladen(blob, name);
        const { eingang = [] } = await chrome.storage.session.get("eingang");
        eingang.push({ id: hochgeladen.id, name: hochgeladen.name, groesse: blob.size });
        await chrome.storage.session.set({ eingang });
      } else {
        await Agentur.anfrage(`/api/chrome/oeffnen?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
      }
    } catch (fehler) {
      await melden(fehler.message);
    }
  })();
});
