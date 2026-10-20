// Google Drive (drive.google.com): schwebender Knopf „Ergo4You PDF“ für die
// geöffnete bzw. markierten Dateien – öffnen im Programm oder in der Leiste
// sammeln (zum Zusammenführen). Drive ist eine Einzelseiten-Anwendung, daher
// wird die Auswahl regelmäßig neu gelesen.

(() => {
  if (window.__agenturPdfDrive) return;
  window.__agenturPdfDrive = true;

  const knopf = document.createElement("div");
  knopf.id = "agentur-pdf-drive";
  knopf.innerHTML = `
    <style>
      #agentur-pdf-drive { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; display: none; gap: 6px;
        font: 13px/1.2 "Segoe UI", system-ui, sans-serif; }
      #agentur-pdf-drive button { border: 0; border-radius: 18px; padding: 9px 14px; cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,.25); background: #b5121b; color: #fff; font: inherit; }
      #agentur-pdf-drive button.zweit { background: #fff; color: #b5121b; }
      #agentur-pdf-drive button:disabled { opacity: .6; cursor: progress; }
    </style>
    <button type="button" data-ziel="tab" title="Im Ergo4You-PDF-Editor (neuer Tab) öffnen und bearbeiten">Ergo4You PDF: öffnen</button>
    <button type="button" class="zweit" data-ziel="leiste" title="In die Ergo4You-PDF-Leiste übernehmen (z. B. zum Zusammenführen)">In Leiste</button>`;
  document.documentElement.append(knopf);

  function ausgewaehlt() {
    const ids = new Set();
    const ausAdresse = /\/file\/d\/([\w-]{10,})/.exec(location.pathname)?.[1];
    if (ausAdresse) ids.add(ausAdresse);
    // markierte Einträge in der Dateiliste/-kachelansicht
    for (const el of document.querySelectorAll('[aria-selected="true"][data-id]')) {
      const id = el.getAttribute("data-id");
      if (id && /^[\w-]{10,}$/.test(id)) ids.add(id);
    }
    return [...ids];
  }

  let ids = [];
  setInterval(() => {
    ids = ausgewaehlt();
    knopf.style.display = ids.length ? "flex" : "none";
    const haupt = knopf.querySelector('[data-ziel="tab"]');
    haupt.textContent = ids.length > 1 ? `Ergo4You PDF: ${ids.length} öffnen` : "Ergo4You PDF: öffnen";
  }, 700);

  knopf.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || !ids.length) return;
    const alle = [...knopf.querySelectorAll("button")];
    alle.forEach((x) => (x.disabled = true));
    try {
      const antwort = await chrome.runtime.sendMessage({ art: "drive", ids, ziel: b.dataset.ziel });
      if (antwort?.fehler) alert(`Ergo4You PDF: ${antwort.fehler}`);
    } finally {
      alle.forEach((x) => (x.disabled = false));
    }
  });
})();
