// Verbindung zum Ergoforyou-PDF-Dienst auf diesem PC (Seitenleiste und Hintergrund).
// Der Dienst lauscht nur auf 127.0.0.1. Das Zugangs-Token gibt er nur an diese
// Erweiterung heraus (Prüfung des Origin-Kopfs).

/* exported Agentur */
const Agentur = (() => {
  const BASIS = "http://127.0.0.1:47851";
  let token = null;

  async function verbinden() {
    const r = await fetch(`${BASIS}/chrome/verbinden`, { method: "POST" });
    if (!r.ok) throw new Error(r.status === 403 ? "Diese Erweiterung ist für Ergoforyou PDF nicht freigegeben." : "Ergoforyou PDF antwortet nicht.");
    const daten = await r.json();
    token = daten.token;
    return daten;
  }

  async function anfrage(pfad, optionen = {}) {
    if (!token) await verbinden();
    const senden = () => fetch(BASIS + pfad, { ...optionen, headers: { ...(optionen.headers || {}), "X-Agentur-Token": token } });
    let r = await senden();
    if (r.status === 401) {
      // Programm wurde neu gestartet → neues Token
      await verbinden();
      r = await senden();
    }
    if (!r.ok) {
      let text = "";
      try {
        text = (await r.json()).fehler;
      } catch {
        /* keine JSON-Antwort */
      }
      throw new Error(text || `Ergoforyou PDF meldet Fehler ${r.status}.`);
    }
    return r;
  }

  const json = async (pfad, daten, methode = "POST") =>
    (await anfrage(pfad, { method: methode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(daten) })).json();

  /** Datei (Blob/File) im Dienst zwischenlagern → { id, name } */
  async function hochladen(datei, name) {
    const r = await anfrage(`/api/uploads?name=${encodeURIComponent(name)}`, { method: "POST", body: datei });
    return r.json();
  }

  /** Auftrag (Zusammenführen/Umwandeln) bis zum Ende verfolgen */
  async function abwarten(auftrag, fortschritt) {
    for (;;) {
      const a = await (await anfrage(`/api/auftraege/${auftrag.id}`)).json();
      if (fortschritt) fortschritt(a);
      if (a.status === "fertig") return a.ergebnis;
      if (a.status === "fehler") throw new Error(a.fehler || "Fehlgeschlagen.");
      if (a.status === "abgebrochen") throw new Error("Abgebrochen.");
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }

  const bildUrl = (dokId, seite, kennung, skala = 0.4) =>
    `${BASIS}/api/dokumente/${dokId}/seiten/${seite}/bild?skala=${skala}&v=${encodeURIComponent(kennung)}&t=${encodeURIComponent(token || "")}`;

  /** Dateiname aus Antwort/Adresse ableiten (mit passender Endung) */
  function dateiname(url, antwort, typ) {
    const kopf = antwort?.headers.get("content-disposition") || "";
    const treffer = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(kopf);
    let name = treffer ? decodeURIComponent(treffer[1] || treffer[2]) : "";
    if (!name) {
      try {
        name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        name = "";
      }
    }
    name = name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Datei";
    const endungen = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/tiff": ".tif", "message/rfc822": ".eml" };
    const passend = endungen[(typ || "").split(";")[0].trim()];
    if (passend && !/\.[a-z0-9]{2,5}$/i.test(name)) name += passend;
    return name;
  }

  /** Google-Drive-Ansicht/-Link → direkte Download-Adresse (sonst unverändert) */
  function driveAdresse(url) {
    const id = /\/file\/d\/([\w-]{10,})/.exec(url)?.[1] || (/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/.exec(url) || [])[1];
    return id && /(drive|docs)\.google\.com/.test(url) ? driveDownload(id) : url;
  }
  const driveDownload = (id) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

  /** Inhalt einer Adresse holen – mit den Anmeldedaten des Browsers (z. B. Kundenportal, Google Drive) */
  async function holen(url) {
    url = driveAdresse(url);
    if (url.startsWith("data:")) {
      const b = await (await fetch(url)).blob();
      return { blob: b, name: dateiname("bild", null, b.type) };
    }
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`Datei konnte nicht geladen werden (${r.status}).`);
    const blob = await r.blob();
    if (blob.type.startsWith("text/html")) {
      // z. B. Google-Anmeldeseite oder „Keine Berechtigung“ statt der Datei
      throw new Error("Statt der Datei kam eine Webseite zurück – bitte im Browser bei Google angemeldet sein bzw. Zugriff prüfen.");
    }
    return { blob, name: dateiname(url, r, blob.type) };
  }

  /** Adresse des vollständigen Editors im Chrome-Tab für ein geöffnetes Dokument */
  const editorUrl = (dokId) => `${BASIS}/#t=${encodeURIComponent(token || "")}&chrome=1&dok=${encodeURIComponent(dokId)}`;

  return { BASIS, editorUrl, verbinden, anfrage, json, hochladen, abwarten, bildUrl, holen, dateiname, driveAdresse, driveDownload, token: () => token };
})();
