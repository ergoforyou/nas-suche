// HubSpot (app.hubspot.com / app-eu1.hubspot.com): auf Kontakt- und Deal-Seiten
// ein schwebender Knopf „Unterschrift anfordern“. Öffnet Ergoforyou PDF im
// Chrome-Tab; nach dem Hineinziehen des Dokuments ist der Kunde im
// Senden-Dialog schon ausgewählt. HubSpot ist eine Einzelseiten-Anwendung,
// daher wird die Adresse regelmäßig neu gelesen.

(() => {
  if (window.__agenturPdfHubspot) return;
  window.__agenturPdfHubspot = true;

  /** Kontakt bzw. Deal aus der Adresse (neue und alte HubSpot-Adressen) */
  function eintrag() {
    const pfad = location.pathname;
    let m = /\/record\/0-1\/(\d+)/.exec(pfad) || /\/contacts\/\d+\/contact\/(\d+)/.exec(pfad);
    if (m) return { objekt: "kontakt", id: m[1] };
    m = /\/record\/0-3\/(\d+)/.exec(pfad) || /\/contacts\/\d+\/deal\/(\d+)/.exec(pfad);
    if (m) return { objekt: "deal", id: m[1] };
    return null;
  }

  const knopf = document.createElement("div");
  knopf.id = "agentur-pdf-hubspot";
  knopf.innerHTML = `
    <style>
      #agentur-pdf-hubspot { position: fixed; right: 24px; bottom: 88px; z-index: 2147483000; display: none;
        font: 600 14px/1.2 "Segoe UI", system-ui, sans-serif; }
      #agentur-pdf-hubspot button { border: 0; border-radius: 22px; padding: 11px 18px; cursor: pointer;
        box-shadow: 0 3px 10px rgba(0,0,0,.25); background: #b5121b; color: #fff; font: inherit; }
      #agentur-pdf-hubspot button:hover { background: #8e0e15; }
      #agentur-pdf-hubspot button:disabled { opacity: .6; cursor: progress; }
    </style>
    <button type="button" title="Dokument mit Ergoforyou PDF zur Online-Unterschrift senden – der Kunde ist schon ausgewählt">✍ Unterschrift anfordern</button>`;
  document.documentElement.append(knopf);
  const button = knopf.querySelector("button");

  let aktuell = null;
  const pruefen = () => {
    aktuell = eintrag();
    knopf.style.display = aktuell ? "block" : "none";
    if (aktuell) button.dataset.objekt = `${aktuell.objekt}:${aktuell.id}`;
  };
  pruefen();
  setInterval(pruefen, 800);

  button.addEventListener("click", async () => {
    if (!aktuell) return;
    button.disabled = true;
    try {
      const antwort = await chrome.runtime.sendMessage({ art: "signatur", objekt: aktuell.objekt, id: aktuell.id });
      if (antwort?.fehler) alert(`Ergoforyou PDF: ${antwort.fehler}`);
    } finally {
      button.disabled = false;
    }
  });
})();
