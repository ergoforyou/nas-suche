// Ergoforyou Sign – Einrichtungsseite (intern)
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);

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

  async function start() {
    const z = await anfrage("/einrichtung/zustand");
    $("version").textContent = `Version ${z.version}`;
    $("neu").hidden = z.kennwort_gesetzt;
    $("login").hidden = !z.kennwort_gesetzt || z.angemeldet;
    $("haupt").hidden = !z.angemeldet;
    if (z.angemeldet) await laden();
    else (z.kennwort_gesetzt ? $("loginKw") : $("neuKw")).focus();
  }

  async function laden() {
    const w = await anfrage("/einrichtung/werte");
    $("adresse").value = w.oeffentliche_adresse;
    $("hsStatus").textContent = w.hubspot_verbunden ? `verbunden (Schlüssel …${w.hubspot_token_ende}${w.hubspot_portal ? `, Portal ${w.hubspot_portal}` : ""})` : "noch nicht verbunden";
    $("hsStatus").className = w.hubspot_verbunden ? "ok" : "fehler";
    $("verbindungscode").textContent = w.verbindungscode;
    $("anzahl").textContent = w.anzahl;
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

  $("adresseTest").addEventListener("click", async () => {
    melden("adresseErgebnis", "Wird geprüft …", true);
    try {
      const r = await anfrage("/einrichtung/adresse-test", {});
      melden("adresseErgebnis", r.hinweis, r.ok);
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
