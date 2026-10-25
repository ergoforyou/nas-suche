/* Ergoforyou Sign – Fenster in HubSpot („Neue Unterschrift anfordern“).
   Läuft als Iframe aus der HubSpot-Karte; der Schlüssel ``t`` kommt aus der
   Karte und gilt nur für diesen Kontakt/Deal. */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const parameter = new URLSearchParams(location.search);
  const T = parameter.get("t") || "";
  const AUFTRAG = parameter.get("auftrag") || "";
  const FARBEN = ["#2563eb", "#d97706", "#059669", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#dc2626"];
  const ROLLEN = ["Kunde", "Ehepartner", "Versicherungsnehmer", "Versicherte Person", "Beitragszahler", "Kontoinhaber", "Berater"];
  const GROESSE = { unterschrift: [190, 48], datum: [95, 20], name: [170, 20] }; // in Punkt
  const ART_TEXT = { unterschrift: "Unterschrift", datum: "Datum", name: "Name" };

  const zustand = {
    kontext: null,
    entwurf: null, // {entwurf, name, seiten:[{b,h}], vorschlaege}
    personen: [],
    felder: [], // {seite, rechteck:[x0,y0,x1,y1] 0..1, art, person(Index)}
    setzArt: "",
    sendet: false,
  };

  // ------------------------------------------------------------ Helfer
  function el(tag, attrs, ...kinder) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "style") e.style.cssText = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kind of kinder.flat()) if (kind !== null && kind !== undefined) e.append(kind);
    return e;
  }

  async function api(pfad, optionen) {
    const o = optionen || {};
    const kopf = { "X-Karte": T, ...(o.kopf || {}) };
    let inhalt = o.inhalt;
    if (o.json !== undefined) {
      kopf["Content-Type"] = "application/json";
      inhalt = JSON.stringify(o.json);
    }
    let antwort;
    try {
      antwort = await fetch(pfad, { method: o.methode || "GET", headers: kopf, body: inhalt, cache: "no-store" });
    } catch (_) {
      throw new Error("Keine Verbindung zum NAS – bitte Internet prüfen und erneut versuchen.");
    }
    let daten = {};
    try {
      daten = await antwort.json();
    } catch (_) {
      /* leer */
    }
    if (!antwort.ok) throw new Error(daten.fehler || daten.detail || `Fehler ${antwort.status}`);
    return daten;
  }

  function meldung(text, gut) {
    $("meldungText").textContent = text;
    $("meldung").classList.toggle("gut", !!gut);
    $("meldung").hidden = !text;
    if (gut) setTimeout(() => { if ($("meldungText").textContent === text) $("meldung").hidden = true; }, 3500);
  }

  function zeige(id) {
    for (const s of ["laden", "wahl", "editor", "fertig", "detail"]) $(s).hidden = s !== id;
    const schritt = { wahl: 1, editor: 2, fertig: 3 }[id] || 0;
    $("schritte").hidden = !schritt;
    for (const s of document.querySelectorAll("#schritte span")) {
      const n = Number(s.dataset.schritt);
      s.classList.toggle("aktiv", n === schritt);
      s.classList.toggle("erledigt", n < schritt);
    }
  }

  function schliessen() {
    // HubSpot schließt das Fenster auf diese Nachricht hin.
    try {
      window.parent.postMessage(JSON.stringify({ action: "DONE" }), "*");
      window.parent.postMessage({ action: "DONE" }, "*");
    } catch (_) {
      /* außerhalb von HubSpot geöffnet */
    }
  }

  async function kopieren(text, knopf) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      const feld = el("textarea", { style: "position:fixed;left:-9999px" });
      feld.value = text;
      document.body.append(feld);
      feld.select();
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      feld.remove();
    }
    if (knopf) {
      const alt = knopf.textContent;
      knopf.textContent = ok ? "✔ Kopiert" : "Bitte markieren + Strg+C";
      setTimeout(() => { knopf.textContent = alt; }, 1800);
    }
  }

  function mailLink(p, titel, link) {
    const anrede = p.name ? `Hallo ${p.name},` : "Hallo,";
    const text = `${anrede}\n\nbitte unterschreiben Sie das Dokument „${titel}“ online über diesen Link:\n${link}\n\n` +
      (p.mit_code ? "Den Zugangscode erhalten Sie von uns separat.\n\n" : "") + "Vielen Dank!\nIhr Ergoforyou-Team";
    return `mailto:${encodeURIComponent(p.email || "")}?subject=${encodeURIComponent("Bitte unterschreiben: " + titel)}&body=${encodeURIComponent(text)}`;
  }

  function linkKarte(p, titel) {
    const eingabe = el("input", { readonly: true, value: p.link, "aria-label": "Link" });
    eingabe.addEventListener("focus", () => eingabe.select());
    const kopierKnopf = el("button", { type: "button", class: "primaer", text: "Link kopieren" });
    kopierKnopf.addEventListener("click", () => kopieren(p.link, kopierKnopf));
    return el(
      "div",
      { class: "linkkarte" },
      el("div", { class: "oben" }, el("strong", { text: `${p.name || p.rolle}` }), el("span", { class: "grau klein", text: p.rolle + (p.mit_code ? " · mit Zugangscode" : "") })),
      el("div", { class: "reihe" }, eingabe, kopierKnopf, el("a", { class: "knopf", href: mailLink(p, titel, p.link), target: "_blank", rel: "noopener", text: "E-Mail" })),
    );
  }

  // ------------------------------------------------------------- Start
  async function start() {
    $("schliessen").addEventListener("click", schliessen);
    $("meldungZu").addEventListener("click", () => meldung(""));
    if (!T) {
      zeige("laden");
      $("laden").innerHTML = "<p>Bitte über die Karte „Ergoforyou Sign“ in HubSpot öffnen.</p>";
      return;
    }
    if (AUFTRAG) return detailLaden();
    wahlEinrichten();
    zeige("wahl");
    $("wahlHinweis").textContent = "Anhänge aus HubSpot werden geladen …";
    // Kontakte und Anhänge im Hintergrund – die Wahl ist sofort bedienbar.
    zustand.kontextLaden = api("/hs/api/kontext").catch((fehler) => ({ kontakte: [], deals: [], anhaenge: [], hinweise: [fehler.message] }));
    const k = (zustand.kontext = await zustand.kontextLaden);
    $("kopfInfo").textContent = k.deal ? `Deal: ${k.deal.name}` : (k.kontakte[0] ? `Kontakt: ${k.kontakte[0].name}` : "");
    anhaengeZeigen();
    $("wahlHinweis").textContent = (k.hinweise || []).join(" · ");
  }

  // --------------------------------------------------------- 1: Wahl
  function wahlEinrichten() {
    const ablage = $("ablage");
    $("datei").addEventListener("change", () => {
      const d = $("datei").files[0];
      $("datei").value = "";
      if (d) hochladen(d);
    });
    ablage.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("datei").click(); } });
    for (const ereignis of ["dragenter", "dragover"]) ablage.addEventListener(ereignis, (e) => { e.preventDefault(); ablage.classList.add("drueber"); });
    for (const ereignis of ["dragleave", "drop"]) ablage.addEventListener(ereignis, () => ablage.classList.remove("drueber"));
    ablage.addEventListener("drop", (e) => {
      e.preventDefault();
      const d = [...(e.dataTransfer.files || [])].find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      if (d) hochladen(d);
      else meldung("Bitte eine PDF-Datei wählen.");
    });
    // Ziehen neben die Ablage soll den Browser nicht die PDF öffnen lassen
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
  }

  function anhaengeZeigen() {
    const liste = $("anhaenge");
    liste.replaceChildren();
    const anhaenge = zustand.kontext.anhaenge || [];
    $("anhaengeBox").hidden = !anhaenge.length;
    for (const a of anhaenge) {
      const datum = a.zeit ? new Date(a.zeit).toLocaleDateString("de-DE") : "";
      const groesse = a.groesse ? `${Math.max(1, Math.round(a.groesse / 1024))} KB` : "";
      liste.append(el("li", {}, el("button", { type: "button", onclick: () => ausHubspot(a) }, "📄", el("span", { class: "name", text: a.name }), el("span", { class: "grau klein", text: [datum, groesse].filter(Boolean).join(" · ") }))));
    }
  }

  async function hochladen(datei) {
    if (datei.size > 40e6) return meldung("Die PDF ist zu groß (max. 40 MB).");
    zeige("laden");
    meldung("");
    try {
      const daten = await api("/hs/api/entwurf", { methode: "POST", inhalt: datei, kopf: { "Content-Type": "application/pdf", "X-Dateiname": encodeURIComponent(datei.name) } });
      await editorOeffnen(daten);
    } catch (fehler) {
      zeige("wahl");
      meldung(fehler.message);
    }
  }

  async function ausHubspot(anhang) {
    zeige("laden");
    meldung("");
    try {
      await editorOeffnen(await api("/hs/api/entwurf/hubspot", { methode: "POST", json: { datei_id: anhang.id } }));
    } catch (fehler) {
      zeige("wahl");
      meldung(fehler.message);
    }
  }

  // ------------------------------------------------------- 2: Editor
  function neuePerson(kontakt, rolle) {
    return {
      rolle: rolle || (zustand.personen.length ? (ROLLEN[zustand.personen.length] || `Person ${zustand.personen.length + 1}`) : "Kunde"),
      name: kontakt ? kontakt.name : "",
      email: kontakt ? kontakt.email : "",
      hubspot_kontakt_id: kontakt ? kontakt.id : "",
      code: "",
      codeOffen: false,
    };
  }

  async function editorOeffnen(daten) {
    if (!zustand.kontext && zustand.kontextLaden) zustand.kontext = await zustand.kontextLaden;
    zustand.entwurf = daten;
    zustand.felder = [];
    $("titel").value = daten.name;
    const k = zustand.kontext || { kontakte: [], deals: [] };
    if (!zustand.personen.length) zustand.personen.push(neuePerson(k.kontakte[0]));
    // Vorhandene Unterschriftsfelder aus der PDF übernehmen
    for (const v of daten.vorschlaege || []) {
      let nr = 0;
      if (v.rolle) {
        nr = zustand.personen.findIndex((p) => p.rolle.toLowerCase() === v.rolle.toLowerCase());
        if (nr < 0) {
          if (zustand.personen.length >= 8) nr = 0;
          else {
            const kontakt = k.kontakte[zustand.personen.length];
            zustand.personen.push(neuePerson(kontakt, v.rolle));
            nr = zustand.personen.length - 1;
          }
        }
      }
      zustand.felder.push({ seite: v.seite, rechteck: v.rechteck, art: "unterschrift", person: nr });
    }
    const deals = k.deals || [];
    $("dealZeile").hidden = !deals.length;
    $("deal").replaceChildren(el("option", { value: "", text: "– kein Deal –" }), ...deals.map((d) => el("option", { value: d.id, text: d.name })));
    if (deals.length === 1) $("deal").value = deals[0].id;
    seitenZeichnen();
    personenZeichnen();
    zeige("editor");
    if (daten.vorschlaege && daten.vorschlaege.length) meldung(`${daten.vorschlaege.length} Unterschriftsfeld(er) aus der PDF übernommen.`, true);
  }

  function seitenZeichnen() {
    const box = $("seiten");
    box.replaceChildren();
    zustand.entwurf.seiten.forEach((s, nr) => {
      const seite = el("div", { class: "seite", "data-seite": nr, style: `aspect-ratio:${s.b}/${s.h}` },
        el("span", { class: "seite-nr", text: `Seite ${nr + 1}` }),
        el("img", { src: `/hs/api/entwurf/${zustand.entwurf.entwurf}/seite/${nr}?breite=1000&t=${encodeURIComponent(T)}`, alt: `Seite ${nr + 1}`, loading: nr < 3 ? "eager" : "lazy", draggable: "false" }));
      seite.addEventListener("click", (e) => feldSetzen(e, seite, nr));
      box.append(seite);
    });
    felderZeichnen();
  }

  function felderZeichnen() {
    for (const f of document.querySelectorAll(".feld")) f.remove();
    zustand.felder.forEach((f, i) => {
      const seite = document.querySelector(`.seite[data-seite="${f.seite}"]`);
      if (!seite) return;
      const p = zustand.personen[f.person];
      const [x0, y0, x1, y1] = f.rechteck;
      const feld = el("div", {
        class: "feld",
        style: `--farbe:${FARBEN[f.person % FARBEN.length]};left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`,
        title: `${ART_TEXT[f.art]} – ${p ? p.name || p.rolle : "?"} (ziehen zum Verschieben)`,
      }, `${ART_TEXT[f.art]} · ${p ? p.rolle : "?"}`);
      const weg = el("button", { type: "button", class: "weg", "aria-label": "Feld entfernen", text: "×" });
      weg.addEventListener("click", (e) => { e.stopPropagation(); zustand.felder.splice(i, 1); felderZeichnen(); personenInfo(); });
      const griff = el("span", { class: "griff" });
      feld.append(weg, griff);
      feld.addEventListener("click", (e) => e.stopPropagation());
      feld.addEventListener("pointerdown", (e) => ziehen(e, f, seite, e.target === griff));
      seite.append(feld);
    });
  }

  function ziehen(e, f, seite, groesse) {
    if (e.target.classList.contains("weg")) return;
    e.preventDefault();
    const box = seite.getBoundingClientRect();
    const start = [e.clientX, e.clientY];
    const alt = f.rechteck.slice();
    const ziel = e.currentTarget;
    ziel.setPointerCapture(e.pointerId);
    const bewegen = (ev) => {
      const dx = (ev.clientX - start[0]) / box.width;
      const dy = (ev.clientY - start[1]) / box.height;
      if (groesse) {
        f.rechteck = [alt[0], alt[1], Math.min(1, Math.max(alt[0] + 0.03, alt[2] + dx)), Math.min(1, Math.max(alt[1] + 0.012, alt[3] + dy))];
      } else {
        const b = alt[2] - alt[0], h = alt[3] - alt[1];
        const x = Math.min(1 - b, Math.max(0, alt[0] + dx)), y = Math.min(1 - h, Math.max(0, alt[1] + dy));
        f.rechteck = [x, y, x + b, y + h];
      }
      const [x0, y0, x1, y1] = f.rechteck;
      Object.assign(ziel.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
    };
    const ende = () => {
      ziel.removeEventListener("pointermove", bewegen);
      ziel.removeEventListener("pointerup", ende);
      ziel.removeEventListener("pointercancel", ende);
    };
    ziel.addEventListener("pointermove", bewegen);
    ziel.addEventListener("pointerup", ende);
    ziel.addEventListener("pointercancel", ende);
  }

  function setzModus(art) {
    zustand.setzArt = zustand.setzArt === art ? "" : art;
    for (const k of document.querySelectorAll(".werkzeug")) k.classList.toggle("aktiv", k.dataset.art === zustand.setzArt);
    $("seiten").classList.toggle("setzen", !!zustand.setzArt);
    $("setzHinweis").textContent = zustand.setzArt ? "→ jetzt auf die Stelle im Dokument klicken (Esc bricht ab)" : "";
  }

  function feldSetzen(e, seite, nr) {
    if (!zustand.setzArt) return;
    const box = seite.getBoundingClientRect();
    const masse = zustand.entwurf.seiten[nr];
    const [bPt, hPt] = GROESSE[zustand.setzArt];
    const b = Math.min(0.9, bPt / masse.b), h = Math.min(0.3, hPt / masse.h);
    const x = Math.min(1 - b, Math.max(0, (e.clientX - box.left) / box.width - b / 2));
    const y = Math.min(1 - h, Math.max(0, (e.clientY - box.top) / box.height - h / 2));
    zustand.felder.push({ seite: nr, rechteck: [x, y, x + b, y + h], art: zustand.setzArt, person: Number($("feldPerson").value) || 0 });
    setzModus("");
    felderZeichnen();
    personenInfo();
  }

  function personenZeichnen() {
    const box = $("personen");
    box.replaceChildren();
    const kontakte = (zustand.kontext && zustand.kontext.kontakte) || [];
    zustand.personen.forEach((p, i) => {
      const farbe = FARBEN[i % FARBEN.length];
      const rolle = el("input", { value: p.rolle, list: "rollenListe", "aria-label": "Rolle", maxlength: 60 });
      rolle.addEventListener("input", () => { p.rolle = rolle.value; feldPersonenListe(); felderZeichnen(); });
      const kontaktWahl = el("select", { "aria-label": "Kontakt aus HubSpot" },
        el("option", { value: "", text: kontakte.length ? "Andere Person (von Hand)" : "Name von Hand eintragen" }),
        ...kontakte.map((k) => el("option", { value: k.id, text: k.name + (k.email ? ` · ${k.email}` : "") })));
      kontaktWahl.value = p.hubspot_kontakt_id || "";
      const name = el("input", { value: p.name, placeholder: "Vor- und Nachname", "aria-label": "Name", maxlength: 150 });
      kontaktWahl.addEventListener("change", () => {
        const k = kontakte.find((x) => x.id === kontaktWahl.value);
        p.hubspot_kontakt_id = k ? k.id : "";
        if (k) { p.name = k.name; p.email = k.email; name.value = k.name; } else { p.email = ""; }
        feldPersonenListe();
      });
      name.addEventListener("input", () => { p.name = name.value; feldPersonenListe(); });
      const code = el("input", { value: p.code, placeholder: "z. B. Geburtsdatum TTMMJJJJ", "aria-label": "Zugangscode", maxlength: 40, autocomplete: "off" });
      code.addEventListener("input", () => { p.code = code.value; });
      const codeZeile = el("label", { class: "feldzeile", style: "margin:4px 0 0" }, el("span", { text: "Zugangscode (optional, telefonisch mitteilen)" }), code);
      codeZeile.hidden = !p.codeOffen && !p.code;
      const codeKnopf = el("button", { type: "button", class: "code-link", text: "Zugangscode hinzufügen" });
      codeKnopf.hidden = !codeZeile.hidden;
      codeKnopf.addEventListener("click", () => { p.codeOffen = true; codeZeile.hidden = false; codeKnopf.hidden = true; code.focus(); });
      const weg = el("button", { type: "button", class: "schlicht weg", title: "Person entfernen", text: "×" });
      weg.hidden = zustand.personen.length < 2;
      weg.addEventListener("click", () => personEntfernen(i));
      box.append(el("div", { class: "person", style: `--farbe:${farbe}` },
        el("div", { class: "person-kopf" }, el("span", { class: "punkt" }), rolle, weg),
        el("div", { class: "zeile2" }, kontakte.length ? kontaktWahl : null, name),
        codeKnopf, codeZeile,
        el("div", { class: "felder-info", "data-info": i })));
    });
    if (!document.getElementById("rollenListe")) document.body.append(el("datalist", { id: "rollenListe" }, ...ROLLEN.map((r) => el("option", { value: r }))));
    $("personDazu").hidden = zustand.personen.length >= 8;
    $("reihenfolgeZeile").hidden = zustand.personen.length < 2;
    feldPersonenListe();
    personenInfo();
  }

  function personEntfernen(i) {
    zustand.personen.splice(i, 1);
    zustand.felder = zustand.felder.filter((f) => f.person !== i).map((f) => ({ ...f, person: f.person > i ? f.person - 1 : f.person }));
    personenZeichnen();
    felderZeichnen();
  }

  function feldPersonenListe() {
    const wahl = $("feldPerson");
    const alt = wahl.value;
    wahl.replaceChildren(...zustand.personen.map((p, i) => el("option", { value: i, text: `${p.rolle || "Person " + (i + 1)}${p.name ? " – " + p.name : ""}` })));
    if (alt && Number(alt) < zustand.personen.length) wahl.value = alt;
  }

  function personenInfo() {
    let ohne = 0;
    zustand.personen.forEach((p, i) => {
      const anzahl = zustand.felder.filter((f) => f.person === i && f.art === "unterschrift").length;
      const info = document.querySelector(`[data-info="${i}"]`);
      if (!anzahl) ohne += 1;
      if (info) info.textContent = anzahl ? `✍ ${anzahl} Unterschriftsfeld${anzahl > 1 ? "er" : ""} im Dokument` : "Kein Feld gesetzt → unterschreibt auf der Abschlussseite";
    });
    $("ohneFeldHinweis").textContent = ohne
      ? "Tipp: Mit „✍ Unterschrift“ oben ein Feld an die richtige Stelle setzen. Ohne Feld wird auf einer Abschlussseite unterschrieben."
      : "";
  }

  async function senden() {
    if (zustand.sendet) return;
    meldung("");
    const fehlt = zustand.personen.findIndex((p) => p.name.trim().length < 2);
    if (fehlt >= 0) {
      meldung(`Bitte den Namen für „${zustand.personen[fehlt].rolle || "Person " + (fehlt + 1)}“ eintragen.`);
      return;
    }
    zustand.sendet = true;
    $("senden").disabled = true;
    $("senden").textContent = "Wird gesendet …";
    try {
      const titel = $("titel").value.trim() || zustand.entwurf.name;
      const a = await api("/hs/api/senden", {
        methode: "POST",
        json: {
          entwurf: zustand.entwurf.entwurf,
          titel,
          nachricht: $("nachricht").value,
          gueltig_tage: Number($("gueltig").value),
          reihenfolge: zustand.personen.length > 1 && $("reihenfolge").checked,
          deal_id: $("deal").value,
          personen: zustand.personen.map((p) => ({ rolle: p.rolle, name: p.name.trim(), email: p.email, hubspot_kontakt_id: p.hubspot_kontakt_id, code: p.code.trim() })),
          felder: zustand.felder.map((f) => ({ seite: f.seite, rechteck: f.rechteck, art: f.art, person: f.person + 1 })),
        },
      });
      $("fertigText").textContent = `„${a.titel}“ – gültig bis ${new Date(a.gueltig_bis).toLocaleDateString("de-DE")}. ` +
        "Den Link per E-Mail, WhatsApp o. Ä. schicken. Notiz und Status landen automatisch in HubSpot.";
      $("fertigLinks").replaceChildren(...a.personen.map((p) => linkKarte(p, a.titel)));
      zeige("fertig");
    } catch (fehler) {
      meldung(fehler.message);
    } finally {
      zustand.sendet = false;
      $("senden").disabled = false;
      $("senden").textContent = "Zur Unterschrift senden";
    }
  }

  // ------------------------------------------------------------ Detail
  async function detailLaden() {
    zeige("laden");
    let a;
    try {
      a = await api(`/hs/api/auftraege/${encodeURIComponent(AUFTRAG)}`);
    } catch (fehler) {
      $("laden").innerHTML = "";
      $("laden").append(el("p", { text: fehler.message }));
      return;
    }
    $("detailTitel").textContent = a.titel;
    $("detailStatus").textContent = a.status_text;
    $("detailStatus").className = `status ${a.status}`;
    $("detailInfo").textContent = `Erstellt ${a.erstellt_text}${a.erstellt_von ? " von " + a.erstellt_von : ""} · gültig bis ${a.gueltig_bis_text}${a.reihenfolge ? " · feste Reihenfolge" : ""}`;
    const offen = ["offen", "geoeffnet", "teilweise"].includes(a.status);
    $("detailPersonen").replaceChildren(...a.personen.map((p) => {
      if (offen && p.status !== "unterschrieben") return linkKarte(p, a.titel);
      const text = p.status === "unterschrieben" ? `✔ unterschrieben ${p.unterschrieben_text}` : "nicht unterschrieben";
      return el("div", { class: "linkkarte" }, el("div", { class: "oben" }, el("strong", { text: p.name || p.rolle }), el("span", { class: "grau klein", text: `${p.rolle} · ${text}` })));
    }));
    const pdf = $("detailPdf");
    pdf.hidden = a.status !== "unterschrieben";
    pdf.href = `/hs/pdf/${a.id}?t=${encodeURIComponent(T)}`;
    $("detailOriginal").href = `/hs/pdf/${a.id}?art=original&t=${encodeURIComponent(T)}`;
    const widerrufen = $("detailWiderrufen");
    widerrufen.hidden = !offen;
    widerrufen.textContent = "Zurückziehen";
    widerrufen.onclick = async () => {
      // zweistufig statt confirm() – Dialoge sind im HubSpot-Fenster gesperrt
      if (widerrufen.dataset.sicher !== "1") {
        widerrufen.dataset.sicher = "1";
        widerrufen.textContent = "Wirklich zurückziehen? Links werden ungültig";
        setTimeout(() => { widerrufen.dataset.sicher = ""; widerrufen.textContent = "Zurückziehen"; }, 5000);
        return;
      }
      widerrufen.dataset.sicher = "";
      try {
        await api(`/hs/api/auftraege/${a.id}/widerrufen`, { methode: "POST" });
        await detailLaden();
        meldung("Zurückgezogen.", true);
      } catch (fehler) {
        meldung(fehler.message);
      }
    };
    const ablage = a.ablage || {};
    $("detailAblage").textContent = ablage.hubspot_fehler
      ? `HubSpot-Ablage: ${ablage.hubspot_fehler} (wird automatisch erneut versucht)`
      : (ablage.hubspot_fertig ? "✔ Unterschriebenes PDF liegt als Notiz mit Anhang in HubSpot." : "");
    const namen = { erstellt: "Erstellt", geoeffnet: "Link geöffnet", code_ok: "Zugangscode bestätigt", code_falsch: "Falscher Zugangscode", gesperrt: "Gesperrt", entsperrt: "Entsperrt", unterschrieben: "Unterschrieben", kopie: "Kopie geladen", widerrufen: "Zurückgezogen", abgeschlossen: "Abgeschlossen" };
    $("detailVerlauf").replaceChildren(...a.verlauf.slice().reverse().map((e) => el("li", { text: `${e.zeit_text} – ${namen[e.art] || e.art}${e.text ? " · " + e.text : ""}` })));
    zeige("detail");
  }

  // ---------------------------------------------------------- Ereignisse
  for (const k of document.querySelectorAll(".werkzeug")) k.addEventListener("click", () => setzModus(k.dataset.art));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && zustand.setzArt) setzModus(""); });
  $("personDazu").addEventListener("click", () => {
    const kontakte = (zustand.kontext && zustand.kontext.kontakte) || [];
    const frei = kontakte.find((k) => !zustand.personen.some((p) => p.hubspot_kontakt_id === k.id));
    zustand.personen.push(neuePerson(frei));
    personenZeichnen();
    $("feldPerson").value = String(zustand.personen.length - 1);
  });
  $("senden").addEventListener("click", senden);
  $("andereDatei").addEventListener("click", () => { zustand.entwurf = null; zustand.felder = []; zeige("wahl"); });
  $("fertigZu").addEventListener("click", schliessen);

  start();
})();
