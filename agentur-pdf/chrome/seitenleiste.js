// Seitenleiste: Dateien ablegen → zusammenführen/umwandeln → Vorschau,
// Seiten drehen/löschen → speichern, drucken oder im Programm weiterbearbeiten.

/* global Agentur */
const $ = (id) => document.getElementById(id);
const ENDUNGEN = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "heic", "heif", "webp", "txt", "csv", "eml", "msg", "doc", "docx", "xls", "xlsx", "odt", "ods", "odp", "ppt", "pptx", "rtf"];

const zustand = {
  dateien: [], // { id (Upload), name, groesse }
  dok: null, // Info des Ergebnisdokuments
};

// ------------------------------------------------------------ Meldungen
let meldungsTimer;
function melden(text, fehler = false) {
  const m = $("meldung");
  m.textContent = text;
  m.className = `meldung${fehler ? " fehler" : ""}`;
  m.hidden = false;
  clearTimeout(meldungsTimer);
  meldungsTimer = setTimeout(() => (m.hidden = true), fehler ? 7000 : 3500);
}
const fehlerMelden = (e) => melden(e.message || String(e), true);

// ------------------------------------------------------------ Verbindung
async function verbinden() {
  try {
    const d = await Agentur.verbinden();
    $("status").textContent = `verbunden · ${d.version}`;
    $("status").className = "status ok";
    $("getrennt").hidden = true;
    $("haupt").hidden = false;
    return true;
  } catch {
    $("status").textContent = "nicht verbunden";
    $("status").className = "status aus";
    $("getrennt").hidden = false;
    $("haupt").hidden = true;
    return false;
  }
}

$("starten").addEventListener("click", async () => {
  $("startHinweis").hidden = false;
  // Startet das Programm über den beim Einrichten registrierten Link
  const tab = await chrome.tabs.create({ url: "agentur-pdf://start", active: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    if (await verbinden()) {
      chrome.tabs.remove(tab.id).catch(() => {});
      melden("Ergo4You PDF ist bereit.");
      return;
    }
  }
  melden("Ergo4You PDF startet nicht – bitte über das Startmenü öffnen.", true);
});

// ------------------------------------------------------------ Dateien
const endung = (name) => (name.split(".").pop() || "").toLowerCase();
const art = (name) => {
  const e = endung(name);
  if (e === "pdf") return ["pdf", "PDF"];
  if (["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "heic", "heif", "webp"].includes(e)) return ["bild", "BILD"];
  if (["eml", "msg"].includes(e)) return ["mail", "MAIL"];
  return ["", e.toUpperCase().slice(0, 4) || "?"];
};
const groesse = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function dateienZeigen() {
  const liste = $("dateien");
  liste.replaceChildren();
  zustand.dateien.forEach((d, i) => {
    const li = document.createElement("li");
    li.className = "datei";
    const [klasse, kurz] = art(d.name);
    li.innerHTML = `<span class="typ ${klasse}">${kurz}</span><span class="name"></span><span class="leise klein">${groesse(d.groesse)}</span>`;
    li.querySelector(".name").textContent = d.name;
    li.querySelector(".name").title = d.name;
    const knopf = (zeichen, titel, aktion, aus) => {
      const b = document.createElement("button");
      b.textContent = zeichen;
      b.title = titel;
      b.setAttribute("aria-label", `${d.name}: ${titel}`);
      b.disabled = Boolean(aus);
      b.addEventListener("click", aktion);
      li.append(b);
    };
    knopf("↑", "nach oben", () => verschieben(i, -1), i === 0);
    knopf("↓", "nach unten", () => verschieben(i, 1), i === zustand.dateien.length - 1);
    knopf("✕", "entfernen", () => {
      zustand.dateien.splice(i, 1);
      dateienZeigen();
    });
    liste.append(li);
  });
  const n = zustand.dateien.length;
  $("dateienBereich").hidden = n === 0;
  $("anzahl").textContent = n ? `(${n})` : "";
  $("erstellen").textContent = n > 1 ? "Zu einer PDF zusammenführen" : "Als PDF übernehmen";
}

function verschieben(i, richtung) {
  const [d] = zustand.dateien.splice(i, 1);
  zustand.dateien.splice(i + richtung, 0, d);
  dateienZeigen();
}

async function hinzufuegen(datei, name = datei.name) {
  if (!ENDUNGEN.includes(endung(name))) {
    melden(`„${name}“: Dateityp wird nicht unterstützt.`, true);
    return;
  }
  try {
    const r = await Agentur.hochladen(datei, name);
    zustand.dateien.push({ id: r.id, name: r.name, groesse: datei.size });
    dateienZeigen();
  } catch (e) {
    fehlerMelden(e);
  }
}

// Ablage: Dateien aus dem Explorer, Bilder/Links aus Webseiten
const ablage = $("ablage");
ablage.addEventListener("dragover", (e) => {
  e.preventDefault();
  ablage.classList.add("ueber");
});
ablage.addEventListener("dragleave", () => ablage.classList.remove("ueber"));
ablage.addEventListener("drop", async (e) => {
  e.preventDefault();
  ablage.classList.remove("ueber");
  const dateien = [...e.dataTransfer.files];
  if (dateien.length) {
    for (const f of dateien) await hinzufuegen(f);
    return;
  }
  const url = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "").split("\n")[0].trim();
  if (/^(https?:|data:image)/.test(url)) await ausAdresse(url);
});
$("dateiwahl").accept = ENDUNGEN.map((e) => "." + e).join(",");
$("dateiwahl").addEventListener("change", async (e) => {
  for (const f of [...e.target.files]) await hinzufuegen(f);
  e.target.value = "";
});
ablage.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("dateiwahl").click();
});

async function ausAdresse(url) {
  try {
    const { blob, name } = await Agentur.holen(url);
    await hinzufuegen(blob, name);
  } catch (e) {
    fehlerMelden(e);
  }
}

$("ausTab").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || !/^(https?|file):/.test(tab.url)) {
    melden("Im aktuellen Tab ist keine Datei geöffnet.", true);
    return;
  }
  await ausAdresse(tab.url);
});

$("leeren").addEventListener("click", () => {
  zustand.dateien = [];
  dateienZeigen();
});

// Über das Rechtsklick-Menü übernommene Dateien (Hintergrund lädt sie hoch)
async function eingangAbholen() {
  const { eingang = [] } = await chrome.storage.session.get("eingang");
  if (!eingang.length) return;
  await chrome.storage.session.set({ eingang: [] });
  zustand.dateien.push(...eingang);
  dateienZeigen();
  melden(`${eingang.length} Datei(en) übernommen.`);
}
chrome.storage.session.onChanged.addListener((a) => {
  if (a.eingang?.newValue?.length) void eingangAbholen();
});

// ------------------------------------------------------------ Erstellen
$("erstellen").addEventListener("click", async () => {
  if (!zustand.dateien.length) return;
  $("fortschritt").hidden = false;
  $("erstellen").disabled = true;
  try {
    await ergebnisSchliessen();
    const auftrag = await Agentur.json("/api/zusammenfuehren", {
      eintraege: zustand.dateien.map((d) => ({ upload: d.id })),
      lesezeichen: true,
      anhaenge: true,
      still: true,
    });
    const ergebnis = await Agentur.abwarten(auftrag, (a) => {
      $("balken").style.width = `${Math.round(a.fortschritt * 100)}%`;
      $("schritt").textContent = a.schritt || "";
    });
    const dokId = ergebnis.dokumente[0];
    const erste = zustand.dateien[0].name.replace(/\.[^.]+$/, "");
    $("name").value = `${zustand.dateien.length > 1 ? `${erste} (zusammengeführt)` : erste}.pdf`;
    await dokumentLaden(dokId);
    zustand.dateien = [];
    dateienZeigen();
  } catch (e) {
    fehlerMelden(e);
  } finally {
    $("fortschritt").hidden = true;
    $("erstellen").disabled = false;
  }
});

$("programm").addEventListener("click", async () => {
  try {
    for (const d of zustand.dateien) {
      // Upload erneut holen geht nicht – daher über den Umwandeln-Weg öffnen
      await Agentur.json("/api/zusammenfuehren", { eintraege: [{ upload: d.id }], lesezeichen: false, anhaenge: true });
    }
    melden("Wird im Programmfenster geöffnet.");
  } catch (e) {
    fehlerMelden(e);
  }
});

// ------------------------------------------------------------ Ergebnis
async function dokumentLaden(dokId) {
  zustand.dok = await (await Agentur.anfrage(`/api/dokumente/${dokId}`)).json();
  ergebnisZeigen();
}

function ergebnisZeigen() {
  const d = zustand.dok;
  $("ergebnis").hidden = !d;
  if (!d) return;
  $("seitenzahl").textContent = `(${d.seitenanzahl} Seite${d.seitenanzahl === 1 ? "" : "n"})`;
  $("zurueck").disabled = !d.rueckgaengig;
  $("zurueck").title = d.rueckgaengig ? `Rückgängig: ${d.rueckgaengig}` : "";
  const seiten = $("seiten");
  seiten.replaceChildren();
  d.kennungen.forEach((kennung, i) => {
    const kachel = document.createElement("div");
    kachel.className = "seite";
    const bild = document.createElement("img");
    bild.src = Agentur.bildUrl(d.id, i, kennung, 0.35);
    bild.alt = `Seite ${i + 1}`;
    bild.loading = "lazy";
    bild.addEventListener("click", () => grossZeigen(i));
    const werkzeuge = document.createElement("div");
    werkzeuge.className = "werkzeuge";
    const knopf = (zeichen, titel, aktion) => {
      const b = document.createElement("button");
      b.textContent = zeichen;
      b.title = titel;
      b.setAttribute("aria-label", `Seite ${i + 1}: ${titel}`);
      b.addEventListener("click", aktion);
      werkzeuge.append(b);
    };
    knopf("↺", "links drehen", () => aendern(`/seiten/drehen`, { seiten: [i], grad: -90 }));
    knopf("↻", "rechts drehen", () => aendern(`/seiten/drehen`, { seiten: [i], grad: 90 }));
    if (d.seitenanzahl > 1) knopf("🗑", "löschen", () => aendern(`/seiten/loeschen`, { seiten: [i] }));
    const nr = document.createElement("span");
    nr.className = "leise klein";
    nr.textContent = String(i + 1);
    kachel.append(bild, werkzeuge, nr);
    seiten.append(kachel);
  });
}

async function aendern(pfad, daten) {
  try {
    const r = await Agentur.json(`/api/dokumente/${zustand.dok.id}${pfad}`, daten);
    zustand.dok = r.dokumente[0];
    ergebnisZeigen();
  } catch (e) {
    fehlerMelden(e);
  }
}

$("zurueck").addEventListener("click", () => aendern("/rueckgaengig", {}));

function grossZeigen(i) {
  const g = $("gross");
  g.querySelector("img").src = Agentur.bildUrl(zustand.dok.id, i, zustand.dok.kennungen[i], 1.3);
  g.hidden = false;
}
$("gross").addEventListener("click", () => ($("gross").hidden = true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("gross").hidden = true;
});

async function pdfBlob() {
  return (await Agentur.anfrage(`/api/dokumente/${zustand.dok.id}/datei`)).blob();
}

$("speichern").addEventListener("click", async () => {
  try {
    const url = URL.createObjectURL(await pdfBlob());
    let name = $("name").value.trim() || "Dokument.pdf";
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    await chrome.downloads.download({ url, filename: name.replace(/[\\/:*?"<>|]+/g, "_"), saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    fehlerMelden(e);
  }
});

$("drucken").addEventListener("click", async () => {
  try {
    // Chromes PDF-Ansicht im neuen Tab – dort Strg+P bzw. Drucker-Symbol
    const url = URL.createObjectURL(await pdfBlob());
    await chrome.tabs.create({ url });
  } catch (e) {
    fehlerMelden(e);
  }
});

$("weiter").addEventListener("click", async () => {
  // vollständiger Editor im neuen Chrome-Tab – das Dokument gehört dann dem Tab
  await chrome.tabs.create({ url: Agentur.editorUrl(zustand.dok.id) });
  zustand.dok = null;
  ergebnisZeigen();
});

chrome.storage.sync.get("pdfsUebernehmen").then(({ pdfsUebernehmen = true }) => ($("automatisch").checked = pdfsUebernehmen));
$("automatisch").addEventListener("change", (e) => chrome.storage.sync.set({ pdfsUebernehmen: e.target.checked }));

async function ergebnisSchliessen() {
  if (!zustand.dok) return;
  const id = zustand.dok.id;
  zustand.dok = null;
  ergebnisZeigen();
  await Agentur.anfrage(`/api/dokumente/${id}`, { method: "DELETE" }).catch(() => {});
}
$("neu").addEventListener("click", () => void ergebnisSchliessen());
window.addEventListener("pagehide", () => {
  // Leiste geschlossen: Zwischenergebnis im Dienst nicht liegen lassen
  if (zustand.dok) {
    fetch(`${Agentur.BASIS}/api/dokumente/${zustand.dok.id}`, { method: "DELETE", headers: { "X-Agentur-Token": Agentur.token() }, keepalive: true });
  }
});

// ------------------------------------------------------------ Start
(async () => {
  dateienZeigen();
  if (await verbinden()) await eingangAbholen();
  // Verbindung im Blick behalten (Programm beendet/gestartet)
  setInterval(async () => {
    const vorher = !$("haupt").hidden;
    const jetzt = await verbinden();
    if (jetzt && !vorher) await eingangAbholen();
  }, 5000);
})();
