// Ergoforyou Sign – Kundenseite: Dokument ansehen, Felder unterschreiben, Kopie laden.
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split("/")[2] || "";
  const basis = `/s/${token}`;
  const speicherSchluessel = `esign-zugang-${token.slice(0, 12)}`;
  let zugang = "";
  try { zugang = sessionStorage.getItem(speicherSchluessel) || ""; } catch (_) { /* privat */ }

  let daten = null;
  const eintraege = {}; // feld_id -> {png} | {text}
  let meine = null; // zuletzt benutzte Unterschrift – für weitere Felder
  let aktivesFeld = null;

  async function holen(pfad, optionen) {
    const antwort = await fetch(basis + pfad, { cache: "no-store", ...optionen });
    let inhalt = {};
    try { inhalt = await antwort.json(); } catch (_) { /* leer */ }
    if (!antwort.ok) {
      const fehler = new Error(inhalt.fehler || `Fehler ${antwort.status}`);
      fehler.status = antwort.status;
      throw fehler;
    }
    return inhalt;
  }

  function zeigen(id) {
    for (const b of ["laden", "code", "hinweis", "dokument", "fertig"]) $(b).hidden = b !== id;
  }

  function hinweis(titel, text) {
    $("hinweisTitel").textContent = titel;
    $("hinweisText").textContent = text;
    zeigen("hinweis");
  }

  const HINWEISE = {
    abgelaufen: ["Link abgelaufen", "Dieser Link ist nicht mehr gültig. Bitte melden Sie sich bei uns – wir senden Ihnen gern einen neuen."],
    widerrufen: ["Nicht mehr verfügbar", "Dieses Dokument wurde von uns zurückgezogen. Bei Fragen melden Sie sich gern bei uns."],
    gesperrt: ["Vorübergehend gesperrt", "Der Zugangscode wurde zu oft falsch eingegeben. Bitte melden Sie sich bei uns, damit wir den Link wieder freigeben."],
  };

  function wartetText(f) {
    const noch = f.offen.join(", ");
    return `${f.fertig} von ${f.anzahl} Unterschriften sind da – es fehlt noch: ${noch}. Über diesen Link können Sie sich die fertige PDF herunterladen, sobald alle unterschrieben haben.`;
  }

  async function start() {
    zeigen("laden");
    try {
      daten = await holen(`/daten${zugang ? `?z=${encodeURIComponent(zugang)}` : ""}`);
    } catch (e) {
      hinweis("Link ungültig", e.status === 404 ? "Dieser Link ist ungültig. Bitte prüfen Sie, ob er vollständig kopiert wurde." : e.message);
      return;
    }
    document.title = `${daten.titel} – unterschreiben`;
    $("kopfTitel").textContent = daten.titel;
    if (daten.status === "unterschrieben") {
      if (daten.code_noetig && !zugang) {
        zeigen("code");
        return;
      }
      return fertig(daten);
    }
    if (HINWEISE[daten.status]) return hinweis(...HINWEISE[daten.status]);
    if (daten.status === "wartet") return hinweis("Vielen Dank – Sie haben unterschrieben", wartetText(daten.fortschritt));
    if (daten.status === "noch_nicht") {
      const vor = daten.fortschritt.offen.slice(0, 1).join("");
      return hinweis("Noch nicht an der Reihe", `Dieses Dokument wird der Reihe nach unterschrieben. Zuerst unterschreibt ${vor || "eine andere Person"} – danach können Sie hier unterschreiben. Bitte öffnen Sie den Link später noch einmal.`);
    }
    if (!daten.seiten) {
      zeigen("code");
      $("codeEingabe").focus();
      return;
    }
    aufbauen();
  }

  $("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("codeFehler").textContent = "";
    try {
      const r = await holen("/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: $("codeEingabe").value }) });
      zugang = r.zugang;
      try { sessionStorage.setItem(speicherSchluessel, zugang); } catch (_) { /* privat */ }
      start();
    } catch (fehler) {
      if (fehler.status === 423) return hinweis(...HINWEISE.gesperrt);
      $("codeFehler").textContent = fehler.message;
    }
  });

  // ------------------------------------------------------------ Dokument
  function bildBreite() {
    const breite = Math.min($("seiten").clientWidth || 800, 900) * (window.devicePixelRatio || 1);
    return Math.min(2000, Math.max(600, Math.ceil(breite / 100) * 100));
  }

  function aufbauen() {
    zeigen("dokument");
    $("dokTitel").textContent = daten.titel;
    $("rolle").hidden = !daten.rolle;
    $("rolle").textContent = daten.rolle ? `Sie unterschreiben als: ${daten.rolle}` : "";
    $("gueltig").textContent = daten.gueltig_bis;
    if (daten.nachricht) {
      $("nachricht").textContent = daten.nachricht;
      $("nachricht").hidden = false;
    }
    $("name").value = daten.name || "";
    const container = $("seiten");
    container.textContent = "";
    const breite = bildBreite();
    daten.seiten.forEach((s, i) => {
      const seite = document.createElement("div");
      seite.className = "seite";
      seite.style.aspectRatio = `${s.b} / ${s.h}`;
      const img = document.createElement("img");
      img.alt = `Seite ${i + 1}`;
      img.loading = i < 2 ? "eager" : "lazy";
      img.src = `${basis}/seite/${i}?breite=${breite}&v=${daten.stand}${zugang ? `&z=${encodeURIComponent(zugang)}` : ""}`;
      seite.appendChild(img);
      const nr = document.createElement("span");
      nr.className = "seite-nr";
      nr.textContent = `Seite ${i + 1} von ${daten.seiten.length}`;
      seite.appendChild(nr);
      for (const f of daten.felder.filter((f) => f.seite === i)) seite.appendChild(feldElement(f));
      container.appendChild(seite);
    });
    $("endeBereich").hidden = !daten.felder.some((f) => f.seite === null);
    const ende = daten.felder.find((f) => f.seite === null);
    if (ende) {
      $("endeFeld").dataset.feld = ende.id;
      $("endeFeld").onclick = () => feldAntippen(ende);
    }
    aktualisieren();
  }

  function feldElement(f) {
    const el = document.createElement("button");
    el.type = "button";
    el.dataset.feld = f.id;
    const [x0, y0, x1, y1] = f.rechteck;
    el.style.left = `${x0 * 100}%`;
    el.style.top = `${y0 * 100}%`;
    el.style.width = `${(x1 - x0) * 100}%`;
    el.style.height = `${(y1 - y0) * 100}%`;
    if (f.art === "unterschrift") {
      el.className = "feld";
      el.innerHTML = "<span></span>";
      el.firstChild.textContent = f.beschriftung && !/^unterschrift/i.test(f.beschriftung) ? `${f.beschriftung}: unterschreiben` : "Hier unterschreiben";
      el.addEventListener("click", () => feldAntippen(f));
    } else {
      el.className = "feld text-feld";
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
    }
    return el;
  }

  function heute() {
    return new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function aktualisieren() {
    const name = $("name").value.trim();
    for (const f of daten.felder) {
      const el = document.querySelector(`[data-feld="${f.id}"]`);
      if (!el) continue;
      if (f.art === "datum") { el.textContent = heute(); continue; }
      if (f.art === "name") { el.textContent = name; continue; }
      const e = eintraege[f.id];
      el.classList.toggle("gefuellt", Boolean(e));
      el.textContent = "";
      if (e && e.png) {
        const img = document.createElement("img");
        img.src = e.png;
        img.alt = "Ihre Unterschrift";
        el.appendChild(img);
      } else if (e) {
        const s = document.createElement("span");
        s.className = "tipp-schrift";
        s.textContent = e.text;
        el.appendChild(s);
      } else {
        const s = document.createElement("span");
        s.textContent = f.seite === null ? "Hier tippen und unterschreiben" : "Hier unterschreiben";
        el.appendChild(s);
      }
    }
    const pflicht = daten.felder.filter((f) => f.art === "unterschrift" && f.pflicht);
    const offen = pflicht.filter((f) => !eintraege[f.id]);
    $("fortschritt").textContent = offen.length ? `Noch ${offen.length} von ${pflicht.length} Unterschrift${pflicht.length === 1 ? "" : "en"}` : "Alle Felder ausgefüllt";
    $("weiter").textContent = offen.length ? "Zum nächsten Feld" : "Zum Abschluss";
    $("absenden").disabled = offen.length > 0 || !$("zustimmung").checked || name.length < 2;
  }

  $("weiter").addEventListener("click", () => {
    const offen = daten.felder.find((f) => f.art === "unterschrift" && f.pflicht && !eintraege[f.id]);
    const ziel = offen ? document.querySelector(`[data-feld="${offen.id}"]`) : $("abschluss");
    ziel.scrollIntoView({ behavior: "smooth", block: "center" });
    if (offen) setTimeout(() => feldAntippen(offen), 450);
  });
  $("name").addEventListener("input", aktualisieren);
  $("zustimmung").addEventListener("change", aktualisieren);

  function feldAntippen(f) {
    if (eintraege[f.id]) {
      // gefülltes Feld erneut angetippt: neu unterschreiben
      aktivesFeld = f;
      return padOeffnen();
    }
    if (meine) {
      eintraege[f.id] = meine;
      return aktualisieren();
    }
    aktivesFeld = f;
    padOeffnen();
  }

  // ----------------------------------------------------- Unterschrift-Pad
  const leinwand = $("leinwand");
  const ctx = leinwand.getContext("2d");
  let modus = "zeichnen";
  let striche = [];
  let aktuell = null;

  function padOeffnen() {
    $("pad").hidden = false;
    striche = [];
    $("tippText").value = $("name").value.trim();
    tippVorschau();
    modusSetzen(modus);
    groesseAnpassen();
  }

  function padSchliessen() {
    $("pad").hidden = true;
    aktivesFeld = null;
  }

  function modusSetzen(m) {
    modus = m;
    for (const b of document.querySelectorAll(".pad-reiter button")) b.classList.toggle("aktiv", b.dataset.modus === m);
    $("padZeichnen").hidden = m !== "zeichnen";
    $("padTippen").hidden = m !== "tippen";
    if (m === "tippen") $("tippText").focus();
    else groesseAnpassen();
  }

  for (const b of document.querySelectorAll(".pad-reiter button")) b.addEventListener("click", () => modusSetzen(b.dataset.modus));

  function groesseAnpassen() {
    const r = leinwand.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    leinwand.width = Math.max(1, Math.round(r.width * dpr));
    leinwand.height = Math.max(1, Math.round(r.height * dpr));
    zeichnen();
  }
  window.addEventListener("resize", () => { if (!$("pad").hidden) groesseAnpassen(); });

  function linie(c, s, skala) {
    c.strokeStyle = "#1a2b6d";
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = 2.6 * skala;
    c.beginPath();
    c.moveTo(s[0].x * skala, s[0].y * skala);
    if (s.length === 1) c.lineTo(s[0].x * skala + 0.1, s[0].y * skala);
    for (let i = 1; i < s.length - 1; i++) {
      const mx = (s[i].x + s[i + 1].x) / 2;
      const my = (s[i].y + s[i + 1].y) / 2;
      c.quadraticCurveTo(s[i].x * skala, s[i].y * skala, mx * skala, my * skala);
    }
    if (s.length > 1) c.lineTo(s[s.length - 1].x * skala, s[s.length - 1].y * skala);
    c.stroke();
  }

  function zeichnen() {
    ctx.clearRect(0, 0, leinwand.width, leinwand.height);
    const dpr = window.devicePixelRatio || 1;
    for (const s of striche) linie(ctx, s, dpr);
    $("padTipp").hidden = striche.length > 0;
  }

  function punkt(e) {
    const r = leinwand.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  leinwand.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    leinwand.setPointerCapture(e.pointerId);
    aktuell = [punkt(e)];
    striche.push(aktuell);
    zeichnen();
  });
  leinwand.addEventListener("pointermove", (e) => {
    if (!aktuell) return;
    for (const p of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) aktuell.push(punkt(p));
    zeichnen();
  });
  const ende = () => { aktuell = null; };
  leinwand.addEventListener("pointerup", ende);
  leinwand.addEventListener("pointercancel", ende);

  function alsPng() {
    const punkte = striche.flat();
    if (punkte.length < 8) return null;
    const rand = 8;
    const x0 = Math.min(...punkte.map((p) => p.x)) - rand;
    const y0 = Math.min(...punkte.map((p) => p.y)) - rand;
    const x1 = Math.max(...punkte.map((p) => p.x)) + rand;
    const y1 = Math.max(...punkte.map((p) => p.y)) + rand;
    if (x1 - x0 < 30) return null;
    const skala = 3;
    const c = document.createElement("canvas");
    c.width = Math.round((x1 - x0) * skala);
    c.height = Math.round((y1 - y0) * skala);
    const k = c.getContext("2d");
    k.translate(-x0 * skala, -y0 * skala);
    for (const s of striche) linie(k, s, skala);
    return c.toDataURL("image/png");
  }

  function tippVorschau() {
    $("tippVorschau").textContent = $("tippText").value.trim();
  }
  $("tippText").addEventListener("input", tippVorschau);

  $("padLeeren").addEventListener("click", () => {
    striche = [];
    $("tippText").value = "";
    tippVorschau();
    zeichnen();
  });
  $("padAbbrechen").addEventListener("click", padSchliessen);
  $("pad").addEventListener("click", (e) => { if (e.target === $("pad")) padSchliessen(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("pad").hidden) padSchliessen(); });

  $("padOk").addEventListener("click", () => {
    let eintrag = null;
    if (modus === "zeichnen") {
      const png = alsPng();
      if (!png) return alert("Bitte unterschreiben Sie im Feld (etwas größer).");
      eintrag = { png };
    } else {
      const text = $("tippText").value.trim();
      if (text.length < 2) return alert("Bitte Ihren Namen eintippen.");
      eintrag = { text };
    }
    meine = eintrag;
    eintraege[aktivesFeld.id] = eintrag;
    if (!$("name").value.trim() && eintrag.text) $("name").value = eintrag.text;
    padSchliessen();
    aktualisieren();
  });

  // -------------------------------------------------------------- Absenden
  $("absenden").addEventListener("click", async () => {
    $("absendeFehler").textContent = "";
    $("absenden").disabled = true;
    $("absenden").textContent = "Wird unterschrieben …";
    try {
      const r = await holen("/unterschreiben", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("name").value.trim(), zustimmung: $("zustimmung").checked, unterschriften: eintraege, zugang }),
      });
      if (r.fertig) fertig({ ...r, titel: daten.titel });
      else hinweis("Vielen Dank – Sie haben unterschrieben", wartetText(r.fortschritt));
    } catch (fehler) {
      $("absendeFehler").textContent = fehler.message;
      $("absenden").textContent = "Verbindlich unterschreiben";
      aktualisieren();
    }
  });

  function fertig(d) {
    zeigen("fertig");
    $("fertigText").textContent = `„${d.titel}“ wurde am ${d.unterzeichnet} unterschrieben. Bitte laden Sie sich jetzt Ihre Kopie herunter.`;
    $("kopie").href = `${basis}/kopie${zugang ? `?z=${encodeURIComponent(zugang)}` : ""}`;
    $("fertigKlein").textContent = `Download möglich bis ${d.kopie_bis}. Prüfsumme (SHA-256): ${d.sha}`;
    window.scrollTo(0, 0);
  }

  start();
})();
