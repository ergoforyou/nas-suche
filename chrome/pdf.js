'use strict';
// PDF-Vorschau mit Ergoforyou PDF: Treffer (PDF, Bilder, Office, E-Mails) erscheinen
// rechts neben der Suche im vollständigen PDF-Editor – im selben Chrome-Tab.
// Ergoforyou PDF läuft dafür auf diesem PC (lokaler Dienst auf 127.0.0.1:47851)
// und gibt sein Zugangs-Token nur an diese Erweiterung heraus.

const Vorschau = (() => {
  const BASIS = 'http://127.0.0.1:47851';
  const ARTEN = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif', 'heic', 'webp',
    'doc', 'docx', 'xls', 'xlsx', 'odt', 'ods', 'rtf', 'txt', 'eml', 'msg', 'ppt', 'pptx']);
  let token = null;
  let aktiv = false;
  let aktuell = null;  // Pfad der gezeigten Datei
  let warten = null;   // Verzögerung bei schnellem Durchblättern
  let box, rahmen, titel, hinweis;

  const endung = (p) => { const i = p.lastIndexOf('.'); return i > 0 ? p.slice(i + 1).toLowerCase() : ''; };
  const name = (p) => p.split(/[\\/]/).pop();
  const geeignet = (e) => e && !e.isDir && ARTEN.has(endung(e.path));

  async function verbinden() {
    const r = await fetch(`${BASIS}/chrome/verbinden`, { method: 'POST' });
    if (!r.ok) throw new Error(r.status === 403 ? 'Diese Erweiterung ist für Ergoforyou PDF nicht freigegeben – bitte Ergoforyou PDF aktualisieren.' : 'Ergoforyou PDF antwortet nicht.');
    token = (await r.json()).token;
  }

  async function oeffnen(pfad) {
    if (!token) await verbinden();
    const senden = () => fetch(`${BASIS}/api/chrome/datei`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agentur-Token': token, 'X-Agentur-Client': 'chrome' },
      body: JSON.stringify({ pfad }),
    });
    let r = await senden();
    if (r.status === 401) { await verbinden(); r = await senden(); }
    if (!r.ok) {
      let text = '';
      try { text = (await r.json()).fehler; } catch (e) { /* keine JSON-Antwort */ }
      throw new Error(text || 'Ergoforyou PDF meldet Fehler ' + r.status);
    }
    return r.json();
  }

  const editorUrl = (id) => `${BASIS}/?v=${encodeURIComponent(id)}#t=${encodeURIComponent(token)}&chrome=1&dok=${encodeURIComponent(id)}`;

  function meldung(text, mitStart) {
    hinweis.replaceChildren();
    hinweis.append(el('p', '', text));
    if (mitStart) {
      const b = el('button', 'primary', 'Ergoforyou PDF starten');
      b.addEventListener('click', () => {
        // eingerichteter Link aus dem Setup von Ergoforyou PDF
        window.open('agentur-pdf://start', '_blank');
        meldung('Ergoforyou PDF wird gestartet …');
        const p = aktuell; aktuell = null;
        setTimeout(() => p && zeigen(p), 4000);
      });
      hinweis.append(b);
    }
    hinweis.hidden = false;
  }

  async function zeigen(pfad) {
    if (pfad === aktuell) return;
    aktuell = pfad;
    titel.textContent = name(pfad);
    titel.title = pfad;
    meldung('Wird geladen …');
    try {
      const info = await oeffnen(pfad);
      if (aktuell !== pfad) return; // inzwischen etwas anderes gewählt
      rahmen.src = editorUrl(info.id);
      rahmen.dataset.dok = info.id;
      hinweis.hidden = true;
    } catch (e) {
      if (aktuell !== pfad) return;
      const laeuftNicht = e instanceof TypeError || /antwortet nicht/.test(e.message);
      token = null;
      aktuell = laeuftNicht ? null : pfad;
      meldung(laeuftNicht ? 'Ergoforyou PDF läuft nicht. Für die Vorschau muss es auf diesem PC laufen.' : e.message, laeuftNicht);
    }
  }

  function setzen(an) {
    aktiv = an;
    box.hidden = !an;
    $('#vsplit').hidden = !an;
    $('#vorschauBt').textContent = an ? 'PDF-Vorschau ausblenden' : 'PDF-Vorschau einblenden';
    try { localStorage.setItem('vorschau', an ? '1' : '0'); } catch (e) { /* egal */ }
    if (an) {
      const p = App.activePane();
      if (p) auswahl(p, true);
    }
  }

  // Auswahl in einer Ansicht hat sich geändert (Pane.render)
  function auswahl(pane, sofort) {
    if (!aktiv) return;
    const sel = pane.selected();
    if (sel.length !== 1 || !geeignet(sel[0])) return;
    clearTimeout(warten);
    warten = setTimeout(() => zeigen(sel[0].path), sofort ? 0 : 350);
  }

  function breiteZiehen() {
    const griff = $('#vsplit');
    griff.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const start = e.clientX, b0 = box.getBoundingClientRect().width;
      rahmen.style.pointerEvents = 'none'; // sonst „verschluckt“ der Rahmen die Mausbewegung
      const zug = (ev) => { box.style.width = Math.max(320, Math.min(window.innerWidth - 360, b0 + start - ev.clientX)) + 'px'; };
      const los = () => {
        removeEventListener('mousemove', zug);
        rahmen.style.pointerEvents = '';
        try { localStorage.setItem('vorschauBreite', box.style.width); } catch (e) { /* egal */ }
      };
      addEventListener('mousemove', zug);
      addEventListener('mouseup', los, { once: true });
    });
  }

  function init() {
    box = $('#vorschau');
    rahmen = $('#vorschauRahmen');
    titel = $('#vorschauTitel');
    hinweis = $('#vorschauHinweis');
    if (PANEL) { $('#vorschauBt').hidden = true; return; }
    try { const b = localStorage.getItem('vorschauBreite'); if (b) box.style.width = b; } catch (e) { /* egal */ }
    $('#vorschauBt').addEventListener('click', () => setzen(!aktiv));
    $('#vorschauTab').addEventListener('click', () => { if (rahmen.dataset.dok && token) window.open(editorUrl(rahmen.dataset.dok), '_blank'); });
    $('#vorschauZu').addEventListener('click', () => setzen(false));
    breiteZiehen();
    let an = true;
    try { an = localStorage.getItem('vorschau') !== '0'; } catch (e) { /* Standard: an */ }
    setzen(an);
  }

  return { init, auswahl, zeigen: (p) => { if (!aktiv) setzen(true); aktuell = null; zeigen(p); }, geeignet };
})();
