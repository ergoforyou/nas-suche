// Kommentieren, Bearbeiten, Schützen über die Oberfläche (Abnahmetests T4, T5, T6, T8).

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

const H = { "X-Agentur-Token": "e2e" };
const BILDER = process.env.E2E_BILDER; // optional: Ordner für Bildschirmfotos

async function oeffnen(page: Page, name: string) {
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, name));
  await expect(page.locator(".tab.aktiv")).toContainText(name);
  await expect(page.locator(".seite-bild").first()).toBeVisible();
  await page.keyboard.press("Control+0"); // ganze Seite sichtbar
  await page.waitForTimeout(300);
}

async function aktivesDok(page: Page): Promise<string> {
  const liste = (await (await page.request.get("/api/dokumente", { headers: H })).json()) as { id: string; titel: string }[];
  const titel = (await page.locator(".tab.aktiv .tab-titel").textContent()) ?? "";
  return liste.find((d) => d.titel === titel)!.id;
}

async function anmerkungen(page: Page, dokId: string) {
  return (await (await page.request.get(`/api/dokumente/${dokId}/anmerkungen`, { headers: H })).json()) as Record<
    string,
    { id: number; art: string; text?: string; inhalt: string; text_darunter?: string; rechteck: number[] }[]
  >;
}

/** Punkt auf Seite 1 (Anteile der Seitenbreite/-höhe) → Bildschirmkoordinaten */
async function aufSeite(page: Page, fx: number, fy: number, seite = 0) {
  const box = (await page.locator(`.seite-inhalt[data-seite="${seite}"]`).boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function foto(page: Page, name: string) {
  if (!BILDER) return;
  await page.waitForTimeout(800); // neu gerenderte Seite abwarten
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

async function register(page: Page, name: string) {
  await page.locator(".mb-reiter").getByRole("tab", { name }).click();
}

test("T5: Text eintragen mit Rechtschreibprüfung und Vorschlag", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await page.keyboard.press("s");
  await expect(page.locator(".eigenschaftsleiste")).toContainText("Auf die Seite klicken und lostippen");
  const p = await aufSeite(page, 0.15, 0.62);
  await page.mouse.click(p.x, p.y);
  const feld = page.getByRole("textbox", { name: "Schreibmaschinentext" });
  await expect(feld).toBeFocused();
  await page.keyboard.type("Der Versicherugsnehmer zahlt.");
  const fehler = page.locator(".rs-fehler");
  await expect(fehler).toHaveText("Versicherugsnehmer");
  await foto(page, "t5-unterstrichen");
  const r = (await fehler.boundingBox())!;
  await feld.click({ button: "right", position: { x: r.x - (await feld.boundingBox())!.x + r.width / 2, y: r.height / 2 } });
  const menue = page.getByRole("menu");
  await expect(menue.getByRole("menuitem", { name: "Versicherungsnehmer", exact: true })).toBeVisible({ timeout: 10_000 });
  await foto(page, "t5-vorschlag");
  await menue.getByRole("menuitem", { name: "Versicherungsnehmer", exact: true }).click();
  await expect(feld).toHaveValue("Der Versicherungsnehmer zahlt.");
  await expect(fehler).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(feld).toBeHidden();
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.[0]?.text).toBe("Der Versicherungsnehmer zahlt.");
  await foto(page, "t5-fertig");
  // Werkzeug bleibt aktiv (wie PDF-XChange): Klick in den Text öffnet ihn wieder
  await expect(page.locator(".eigenschaftsleiste")).toContainText("lostippen");
  const bild = page.locator(".anm-bild.art-textfeld").first();
  await expect(bild).toBeVisible();
  await bild.click({ force: true });
  await expect(page.getByRole("textbox", { name: "Schreibmaschinentext" })).toHaveValue("Der Versicherungsnehmer zahlt.");
  await page.keyboard.press("End");
  await page.keyboard.type(" Danke");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.[0]?.text).toBe("Der Versicherungsnehmer zahlt. Danke");
});

test("Rechteck zeichnen, verschieben, löschen und rückgängig", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Kommentieren");
  await page.locator('[data-befehl="werkzeug.rechteck"]').click();
  const a = await aufSeite(page, 0.2, 0.7);
  const b = await aufSeite(page, 0.5, 0.8);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.length).toBe(1);
  const vorher = (await anmerkungen(page, dokId))["0"][0];
  expect(vorher.art).toBe("rechteck");
  // Nach einmaligem Benutzen zurück zur Hand → Auswahl, Griffe, Verschieben
  await expect(page.locator(".anm-auswahl")).toBeVisible();
  const ziel = await aufSeite(page, 0.35, 0.75);
  const start_ = await aufSeite(page, 0.3, 0.72);
  await page.mouse.move(start_.x + 2, start_.y);
  await page.mouse.down();
  await page.mouse.move(ziel.x, ziel.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"][0].rechteck[1]).toBeGreaterThan(vorher.rechteck[1] + 0.02);
  await foto(page, "rechteck-verschoben");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]).toBeUndefined();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.length).toBe(1);
});

test("Text markieren und hervorheben, Kommentarliste", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  const woerter = (await (await page.request.get(`/api/dokumente/${dokId}/seiten/0/woerter`, { headers: H })).json()) as [number, number, number, number, string][];
  const w1 = woerter.find((w) => w[4] === "jährliche")!;
  const w2 = woerter.find((w) => w[4].startsWith("Prämie"))!;
  await page.keyboard.press("m");
  const a = await aufSeite(page, w1[0] + 0.002, (w1[1] + w1[3]) / 2);
  const b = await aufSeite(page, w2[2] - 0.002, (w2[1] + w2[3]) / 2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.[0]?.text_darunter ?? "").toContain("Prämie");
  await register(page, "Kommentieren");
  await page.locator('[data-befehl="kommentare.liste"]').click();
  await expect(page.locator(".kommentar-panel")).toContainText("Hervorhebung");
  await foto(page, "hervorheben");
});

test("Stempel mit Datum und Notiz setzen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Kommentieren");
  await page.locator('[data-befehl="werkzeug.stempel"]').click();
  await expect(page.getByRole("combobox", { name: "Stempelvorlage" })).toBeVisible();
  const p = await aufSeite(page, 0.6, 0.1);
  await page.mouse.move(p.x, p.y);
  await foto(page, "stempel-vorschau");
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.[0]?.text ?? "").toMatch(/^EINGEGANGEN\n\d\d\.\d\d\.\d{4}/);
  await page.locator('[data-befehl="werkzeug.notiz"]').click();
  const n = await aufSeite(page, 0.85, 0.3);
  await page.mouse.click(n.x, n.y);
  await page.getByRole("textbox", { name: "Notiztext" }).fill("Kunde zurückrufen");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.some((x) => x.art === "notiz" && x.inhalt === "Kunde zurückrufen")).toBe(true);
  await foto(page, "stempel-notiz");
});

test("T4: Unterschrift freistellen, speichern und platzieren", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Bearbeiten");
  await page.locator('[data-befehl="bild.unterschrift"]').click();
  const dialog = page.getByRole("dialog", { name: "Unterschrift einfügen" });
  const auswahl = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Datei wählen …" }).click();
  await (await auswahl).setFiles(join(DATEN, "unterschrift.png"));
  await expect(dialog.getByRole("img", { name: "Vorschau" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Hintergrund entfernen/ })).toBeChecked();
  await foto(page, "t4-dialog");
  await dialog.getByRole("button", { name: "Platzieren" }).click();
  const p = await aufSeite(page, 0.3, 0.85);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator(".platzieren-vorschau")).toBeVisible();
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await anmerkungen(page, dokId))["0"]?.[0]?.art).toBe("unterschrift");
  await foto(page, "t4-platziert");
  // Bibliothek kennt die Unterschrift jetzt
  const liste = (await (await page.request.get("/api/unterschriften", { headers: H })).json()) as unknown[];
  expect(liste.length).toBeGreaterThan(0);
});

test("T6: IBAN suchen, schwärzen und endgültig entfernen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "iban.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Schützen");
  await page.locator('[data-befehl="schwaerzen.suchen"]').click();
  const dialog = page.getByRole("dialog", { name: "Schwärzen" });
  await dialog.getByRole("button", { name: "Suchen" }).click();
  await expect(dialog).toContainText("DE89 3704 0044 0532 0130 00");
  await dialog.getByRole("button", { name: /vormerken/ }).click();
  await expect(dialog.getByRole("button", { name: "Schwärzungen anwenden" })).toBeVisible();
  await foto(page, "t6-vorgemerkt");
  await dialog.getByRole("button", { name: "Schwärzungen anwenden" }).click();
  await expect(page.locator(".meldung")).toContainText("Schwärzungen auf 1 Seite(n) angewendet");
  const text = await (await page.request.get(`/api/dokumente/${dokId}/text`, { headers: H })).text();
  expect(text).not.toContain("3704");
  expect(text).toContain("Bankverbindung");
  await foto(page, "t6-geschwaerzt");
});

test("T8: Drucken ohne Kommentare, Export als Download", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await page.request.post(`/api/dokumente/${dokId}/anmerkungen`, { headers: H, data: { seite: 0, art: "notiz", punkt: [0.8, 0.1], inhalt: "intern" } });
  await page.request.post(`/api/dokumente/${dokId}/anmerkungen`, { headers: H, data: { seite: 0, art: "stempel", punkt: [0.5, 0.5], text: "ERLEDIGT" } });
  await page.keyboard.press("Control+p");
  const dialog = page.getByRole("dialog", { name: "Drucken" });
  await dialog.getByRole("checkbox", { name: "Kommentare" }).uncheck();
  await dialog.getByRole("button", { name: "Weiter zum Drucken" }).click();
  await expect(page.locator("iframe.druck-vorschau")).toBeVisible();
  await page.getByRole("dialog", { name: "Druckvorschau" }).getByRole("button", { name: "Schließen" }).click();
  // Export (Browser-Modus → Download)
  await register(page, "Schützen");
  await page.locator('[data-befehl="ausgabe.exportieren"]').click();
  const exportDialog = page.getByRole("dialog", { name: "Exportieren" });
  await exportDialog.getByRole("checkbox", { name: "Kommentare" }).uncheck();
  const download = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "Exportieren …" }).click();
  const datei = await (await download).path();
  const pdf = readFileSync(datei!);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.includes(Buffer.from("/Subtype /Text"))).toBe(false);
  expect(pdf.includes(Buffer.from("FreeText"))).toBe(true);
});

test("Formular ausfüllen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "formular.pdf");
  const dokId = await aktivesDok(page);
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toBeVisible();
  await name.fill("Müller");
  await name.press("Enter");
  await page.getByRole("button", { name: "Einverstanden" }).click();
  await expect
    .poll(async () => {
      const f = (await (await page.request.get(`/api/dokumente/${dokId}/formular`, { headers: H })).json()) as Record<string, { name: string; wert: unknown }[]>;
      return f["0"].map((x) => `${x.name}=${x.wert}`).join(";");
    })
    .toBe("Name=Müller;Einverstanden=true");
  await foto(page, "formular");
});

test("Foto aufbereiten → neues Dokument", async ({ page }) => {
  await start(page);
  await register(page, "Bearbeiten");
  await page.locator('[data-befehl="foto.aufbereiten"]').click();
  const dialog = page.getByRole("dialog", { name: "Foto aufbereiten" });
  const auswahl = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Foto wählen …" }).click();
  await (await auswahl).setFiles(join(DATEN, "handyfoto.jpg"));
  await expect(dialog.getByRole("img", { name: "Ergebnis" })).toBeVisible({ timeout: 15_000 });
  await foto(page, "foto-dialog");
  await dialog.getByRole("button", { name: "Als neues Dokument" }).click();
  await expect(page.locator(".tab.aktiv")).toContainText("Foto");
});

test("Kennwortschutz festlegen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Schützen");
  await page.locator('[data-befehl="schutz.kennwort"]').click();
  const dialog = page.getByRole("dialog", { name: "Kennwortschutz" });
  await dialog.getByLabel("Kennwort zum Öffnen").fill("geheim1");
  await dialog.getByLabel("Kennwort wiederholen").fill("geheim1");
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await expect(page.locator(".meldung")).toContainText("beim nächsten Speichern");
  const info = (await (await page.request.get(`/api/dokumente/${dokId}`, { headers: H })).json()) as { schutz: string };
  expect(info.schutz).toBe("kennwort");
});

test("Screenshot: Karte erscheint, Bild als Seite einfügen", async ({ page }) => {
  await start(page);
  await page.request.put("/api/einstellungen", { headers: H, data: { screenshot_ordner: join(DATEN, "shots"), screenshot_ocr: false } });
  const dokId = await aktivesDok(page);
  await page.request.post("/api/screenshot/verarbeiten", { headers: H, data: readFileSync(join(DATEN, "unterschrift.png")) });
  const karte = page.getByRole("status", { name: "Screenshot gespeichert" });
  await expect(karte).toBeVisible({ timeout: 10_000 });
  await foto(page, "screenshot-karte");
  await karte.getByRole("button", { name: "In Dokument einfügen" }).click();
  await expect
    .poll(async () => ((await (await page.request.get(`/api/dokumente/${dokId}`, { headers: H })).json()) as { seitenanzahl: number }).seitenanzahl)
    .toBe(151);
});

test("Einstellungen: Kürzel und Screenshot-Ordner speichern", async ({ page }) => {
  await start(page);
  await page.locator(".testversion").click();
  const dialog = page.getByRole("dialog", { name: "Über Agentur-PDF" });
  await dialog.getByLabel(/Ihr Kürzel/).fill("JK");
  await dialog.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(page.locator(".meldung")).toContainText("Einstellungen gespeichert");
  const e = (await (await page.request.get("/api/einstellungen", { headers: H })).json()) as { kuerzel: string };
  expect(e.kuerzel).toBe("JK");
  await page.request.put("/api/einstellungen", { headers: H, data: { kuerzel: "" } });
});

/** Umriss der dunklen Pixel (Text) in einem Bildschirmausschnitt */
async function textUmriss(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (daten) => {
    const bild = new Image();
    bild.src = `data:image/png;base64,${daten}`;
    await bild.decode();
    const c = document.createElement("canvas");
    c.width = bild.width;
    c.height = bild.height;
    const g = c.getContext("2d")!;
    g.drawImage(bild, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 130 && d[i + 1] < 130 && d[i + 2] < 130) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
    return { x0, y0, x1, y1 };
  }, png);
}

test("Text springt beim Bearbeiten und Verschieben nicht", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  // Text in einem leeren Bereich anlegen (unten auf der Seite)
  await page.keyboard.press("s");
  const p0 = await aufSeite(page, 0.15, 0.88);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.type("Versicherungsnehmer Müller");
  await page.keyboard.press("Escape");
  await page.keyboard.press("h");
  const bild = page.locator(".anm-bild.art-textfeld").first();
  await expect(bild).toBeVisible();
  // bei 200 % messen (genauer)
  await page.getByLabel("Zoom in Prozent").fill("200");
  await page.getByLabel("Zoom in Prozent").press("Enter");
  await page.waitForTimeout(500);
  await bild.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = (await bild.boundingBox())!;
  const clip = { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 };
  const vorher = await textUmriss(page, clip);
  // Bearbeiten öffnen: Text muss exakt stehen bleiben (höchstens 2 px)
  await page.keyboard.press("s");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("textbox", { name: "Schreibmaschinentext" })).toBeFocused();
  await page.waitForTimeout(400);
  const beimBearbeiten = await textUmriss(page, clip);
  await foto(page, "text-beim-bearbeiten");
  for (const k of ["x0", "y0", "x1", "y1"] as const) expect(Math.abs(beimBearbeiten[k] - vorher[k])).toBeLessThanOrEqual(2);
  // Ansicht darf beim Öffnen nicht scrollen
  const scroll = await page.getByTestId("dokumentansicht").first().evaluate((el) => el.scrollTop);
  // Fertig ohne Änderung: wieder identisch
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const nachher = await textUmriss(page, clip);
  for (const k of ["x0", "y0", "x1", "y1"] as const) expect(Math.abs(nachher[k] - vorher[k])).toBeLessThanOrEqual(2);
  expect(await page.getByTestId("dokumentansicht").first().evaluate((el) => el.scrollTop)).toBe(scroll);
  await foto(page, "text-ohne-springen");

  // Verschieben mit der Maus: Text folgt live, bleibt nach dem Loslassen liegen
  await page.keyboard.press("h");
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2 - 50, { steps: 8 });
  const unterwegs = (await bild.boundingBox())!;
  expect(unterwegs.x).toBeGreaterThan(box.x + 40); // bewegt sich schon während des Ziehens
  await page.mouse.up();
  const losgelassen = (await bild.boundingBox())!;
  expect(Math.abs(losgelassen.x - unterwegs.x)).toBeLessThan(2);
  await page.waitForTimeout(800); // Dienst speichert, neues Bild kommt
  const gespeichert = (await bild.boundingBox())!;
  expect(Math.abs(gespeichert.x - unterwegs.x)).toBeLessThan(2);
  expect(Math.abs(gespeichert.y - unterwegs.y)).toBeLessThan(2);
  // Pfeiltasten schieben fein (1 pt)
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  const geschubst = (await bild.boundingBox())!;
  expect(geschubst.x).toBeGreaterThan(gespeichert.x + 1);
  const liste = await anmerkungen(page, dokId);
  expect(liste["0"].length).toBe(1);
});

test("Wasserzeichen und Seitenzahlen einfügen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const dokId = await aktivesDok(page);
  await register(page, "Bearbeiten");
  await page.locator('[data-befehl="seitengestaltung.wasserzeichen"]').click();
  let dialog = page.getByRole("dialog", { name: "Wasserzeichen" });
  await dialog.getByLabel("Text").fill("KOPIE");
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  await expect(page.locator(".meldung")).toContainText("Wasserzeichen auf");
  await page.locator('[data-befehl="seitengestaltung.kopffuss"]').click();
  dialog = page.getByRole("dialog", { name: "Kopf- und Fußzeile" });
  await expect(dialog.getByLabel("Unten Mitte")).toHaveValue("Seite {seite} von {seiten}");
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  await expect(page.locator(".meldung")).toContainText("Kopf-/Fußzeile auf");
  await foto(page, "wasserzeichen");
  const text = await (await page.request.get(`/api/dokumente/${dokId}/text`, { headers: H })).text();
  expect(text).toContain("KOPIE");
  expect(text).toMatch(/Seite 1 von \d/);
});
