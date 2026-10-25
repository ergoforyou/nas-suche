// Ergoforyou Sign – Einrichtungsassistent (intern)
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  let werte = null;
  let timer = null;

  async function anfrage(pfad, daten) {
    const optionen = daten === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(daten) };
    const antwort = await fetch(pfad, { cache: "no-store", credentials: "same-origin", ...optionen });
    let inhalt = {};
    try { inhalt = await antwort.json(); } catch (_) { /* leer */ }
    if (!antwort.ok) throw new Error(inhalt.fehler || `Fehler ${antwort.status}`);
    return inhalt;
  }

  function melden(id, text, ok) {
    $(id).textContent = text;
    $(id).className = `klein ${ok ? "ok" : "fehler"}`;
  }

  function ampel(id, stufe, text) {
    $(id).className = `ampel ${stufe}`;
    $(id).querySelector("small").textContent = text;
  }

  function knopf(text, primaer, aktion) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (primaer) b.className = "primaer";
    b.addEventListener("click", aktion);
    return b;
  }

  async function start() {
    const z = await anfrage("/einrichtung/zustand");
    $("version").textContent = `Version ${z.version}`;
    $("neu").hidden = z.kennwort_gesetzt;
    $("login").hidden = !z.kennwort_gesetzt || z.angemeldet;
    $("haupt").hidden = !z.angemeldet;
    if (z.angemeldet) await laden();
    else (z.kennwort_gesetzt ? $("loginKw") : $("neuKw")).focus();
  }

  function zeitText(s) {
    if (s === null || s === undefined) return "noch nie verbunden";
    if (s < 120) return "gerade eben verbunden";
    if (s < 7200) return `zuletzt vor ${Math.round(s / 60)} Minuten`;
    return `zuletzt vor ${Math.round(s / 3600)} Stunden`;
  }

  async function laden() {
    werte = await anfrage("/einrichtung/werte");
    const t = werte.tunnel;
    const eigene = werte.adresse_quelle === "manuell" && werte.oeffentliche_adresse && !/^http:\/\/(10\.|192\.168\.|172\.)/.test(werte.oeffentliche_adresse);

    // 1 · Zugang
    $("tunnelText").textContent = eigene ? `Eigene Adresse aktiv: ${werte.oeffentliche_adresse}` : t.text;
    const kn = $("tunnelKnoepfe");
    kn.textContent = "";
    if (!eigene && t.login_url) {
      kn.appendChild(knopf(t.zustand === "anmelden" ? "Bei Tailscale anmelden" : "Jetzt freischalten", true, () => window.open(t.login_url, "_blank", "noopener")));
    }
    if (werte.oeffentliche_adresse) {
      kn.appendChild(knopf("Erreichbarkeit testen", !t.login_url || eigene, testen));
    }
    $("tunnelAdresse").hidden = !werte.oeffentliche_adresse;
    $("tunnelAdresse").textContent = werte.oeffentliche_adresse ? `Kundenadresse: ${werte.oeffentliche_adresse}` : "";
    $("adresse").value = werte.oeffentliche_adresse;
    const bereit = eigene || t.zustand === "bereit";
    ampel("ampelTunnel", bereit ? "gruen" : t.zustand === "fehler" || t.zustand === "fehlt" ? "rot" : "gelb", bereit ? werte.oeffentliche_adresse : t.text);

    // 2 · HubSpot
    $("hsStatus").textContent = werte.hubspot_verbunden ? `verbunden (Schlüssel …${werte.hubspot_token_ende}${werte.hubspot_portal ? `, Portal ${werte.hubspot_portal}` : ""})` : "noch nicht verbunden";
    $("hsStatus").className = werte.hubspot_verbunden ? "ok" : "grau";
    $("hsAnleitung").open = !werte.hubspot_verbunden;
    ampel("ampelHubspot", werte.hubspot_verbunden ? "gruen" : "grau", werte.hubspot_verbunden ? "verbunden" : "optional – noch nicht verbunden");

    // 3 · PC
    $("verbindungscode").textContent = werte.verbindungscode;
    $("unterwegs").hidden = !werte.unterwegs_adresse;
    $("unterwegs").textContent = werte.unterwegs_adresse
      ? `Von unterwegs/zu Hause: Auf dem PC die Tailscale-App installieren und mit demselben Konto anmelden – Ergoforyou PDF nutzt dann automatisch ${werte.unterwegs_adresse} (nur für Ihre eigenen Geräte, nicht öffentlich).`
      : "";
    $("anzahl").textContent = werte.anzahl;
    const pcOk = werte.pc_kontakt_vor_s !== null && werte.pc_kontakt_vor_s !== undefined;
    // 3 · HubSpot-Karte
    $("karteAdresse").textContent = werte.oeffentliche_adresse || "(erst Schritt 1 abschließen)";
    let karteStufe = "grau", karteText = "noch nicht eingerichtet";
    if (werte.karte_fehler) { karteStufe = "rot"; karteText = werte.karte_fehler; }
    else if (werte.karte_kontakt_vor_s !== null) { karteStufe = "gruen"; karteText = `aktiv – ${zeitText(werte.karte_kontakt_vor_s).replace(" verbunden", "")}`; }
    else if (werte.karte_geheimnis_gesetzt) { karteStufe = "gelb"; karteText = "Client-Secret gespeichert – Karte hat sich noch nicht gemeldet"; }
    ampel("ampelKarte", karteStufe, karteText);
    $("karteStatus").textContent = karteText;
    $("karteStatus").className = karteStufe === "gruen" ? "ok" : karteStufe === "rot" ? "fehler" : "grau";
    $("karteAnleitung").open = karteStufe !== "gruen";
    $("karteGeheimnis").placeholder = werte.karte_geheimnis_gesetzt ? "gespeichert – zum Ändern neu einfügen" : "z. B. 1a2b3c4d-…";
    ampel("ampelPc", pcOk ? "gruen" : "gelb", zeitText(werte.pc_kontakt_vor_s));

    // solange der Tunnel noch nicht fertig ist, selbst nachsehen
    clearTimeout(timer);
    if (!bereit) timer = setTimeout(async () => {
      try { await anfrage("/einrichtung/tunnel", {}); } catch (_) { /* später erneut */ }
      laden().catch(() => undefined);
    }, 5000);
  }

  async function testen() {
    melden("adresseErgebnis", "Wird geprüft …", true);
    try {
      const r = await anfrage("/einrichtung/adresse-test", {});
      melden("adresseErgebnis", r.ok ? `${r.hinweis} Zur Sicherheit auch am Handy ohne WLAN öffnen: ${werte.oeffentliche_adresse}/gesundheit` : r.hinweis, r.ok);
    } catch (f) { melden("adresseErgebnis", f.message, false); }
  }

  $("neuForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await anfrage("/einrichtung/kennwort", { kennwort: $("neuKw").value });
      start();
    } catch (f) { $("neuFehler").textContent = f.message; }
  });

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await anfrage("/einrichtung/anmelden", { kennwort: $("loginKw").value });
      start();
    } catch (f) { $("loginFehler").textContent = f.message; }
  });

  $("adresseSpeichern").addEventListener("click", async () => {
    try {
      await anfrage("/einrichtung/werte", { oeffentliche_adresse: $("adresse").value });
      await laden();
      melden("adresseErgebnis", "Gespeichert.", true);
    } catch (f) { melden("adresseErgebnis", f.message, false); }
  });

  $("tunnelNutzen").addEventListener("click", async () => {
    try {
      await anfrage("/einrichtung/tunnel", {});
      await laden();
    } catch (f) { melden("adresseErgebnis", f.message, false); }
  });

  $("hsSpeichern").addEventListener("click", async () => {
    melden("hsErgebnis", "Wird geprüft …", true);
    try {
      await anfrage("/einrichtung/werte", { hubspot_token: $("hsToken").value });
      $("hsToken").value = "";
      await laden();
      melden("hsErgebnis", "HubSpot ist verbunden.", true);
    } catch (f) { melden("hsErgebnis", f.message, false); }
  });

  $("hsTest").addEventListener("click", async () => {
    try {
      const r = await anfrage("/einrichtung/hubspot-test", {});
      melden("hsErgebnis", `Verbindung klappt${r.portal ? ` (Portal ${r.portal})` : ""}.`, true);
    } catch (f) { melden("hsErgebnis", f.message, false); }
  });

  $("hsTrennen").addEventListener("click", async () => {
    if (!confirm("HubSpot-Verbindung wirklich trennen?")) return;
    await anfrage("/einrichtung/werte", { hubspot_token: "" });
    await laden();
    melden("hsErgebnis", "Getrennt.", true);
  });

  $("karteSpeichern").addEventListener("click", async () => {
    try {
      await anfrage("/einrichtung/werte", { hubspot_app_geheimnis: $("karteGeheimnis").value });
      $("karteGeheimnis").value = "";
      await laden();
      melden("karteErgebnis", "Gespeichert. Jetzt einen Kontakt in HubSpot öffnen – die Karte meldet sich dann hier.", true);
    } catch (f) { melden("karteErgebnis", f.message, false); }
  });

  $("codeKopieren").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("verbindungscode").textContent);
      melden("codeErgebnis", "Kopiert – jetzt in Ergoforyou PDF einfügen.", true);
    } catch (_) {
      const r = document.createRange();
      r.selectNodeContents($("verbindungscode"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      melden("codeErgebnis", "Bitte mit Strg+C kopieren (Text ist markiert).", true);
    }
  });

  $("schluesselNeu").addEventListener("click", async () => {
    if (!confirm("Neuen Verbindungscode erzeugen? Alle PCs müssen danach neu verbunden werden.")) return;
    await anfrage("/einrichtung/schluessel-neu", {});
    await laden();
    melden("codeErgebnis", "Neuer Code erzeugt.", true);
  });

  $("abmelden").addEventListener("click", async () => {
    await anfrage("/einrichtung/abmelden", {});
    start();
  });

  start().catch((f) => alert(f.message));
})();
