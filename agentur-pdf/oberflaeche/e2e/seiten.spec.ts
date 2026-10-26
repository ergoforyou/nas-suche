import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

/** Datei über „Öffnen“ (Browser-Dateiauswahl → Upload) öffnen. */
async function oeffnen(page: Page, name: string) {
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, name));
  await expect(page.locator(".tab.aktiv")).toContainText(name);
}

async function dokumentInfo(page: Page, titel: string) {
  return page.evaluate(async (t) => {
    const r = await fetch("/api/dokumente", { headers: { "X-Agentur-Token": "e2e" } });
    return ((await r.json()) as { titel: string; id: string; seitenanzahl: number }[]).find((d) => d.titel === t)!;
  }, titel);
}

async function seiteMit(page: Page, dokId: string, text: string): Promise<number[]> {
  return page.evaluate(
    async ([id, q]) => {
      const r = await fetch(`/api/dokumente/${id}/suche?q=${encodeURIComponent(q)}`, { headers: { "X-Agentur-Token": "e2e" } });
      return ((await r.json()) as { seite: number }[]).map((t) => t.seite);
    },
    [dokId, text],
  );
}

test("T3: Seiten 2–4 aus A in B zwischen Seite 1 und 2 ziehen, Rückgängig", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  await oeffnen(page, "b.pdf");
  await page.getByRole("tab", { name: "Seiten", exact: true }).first().click();
  await page.locator('[data-befehl="seiten.nebeneinander"]').click();
  await expect(page.getByTestId("bereich")).toHaveCount(2);

  const a = page.locator('.bereich:has(.bereich-titel:text-is("a.pdf")) .miniaturen');
  const b = page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .miniaturen');
  await a.locator('.miniatur[data-seite="1"]').click();
  await a.locator('.miniatur[data-seite="3"]').click({ modifiers: ["Shift"] });
  await expect(a.locator(".miniatur.markiert")).toHaveCount(3);

  // Strg gedrückt = kopieren; Ziel: obere Hälfte von B-Seite 2 → zwischen 1 und 2
  const ziel = b.locator('.miniatur[data-seite="1"]');
  const box = (await ziel.boundingBox())!;
  await page.keyboard.down("Control");
  await a.locator('.miniatur[data-seite="2"]').dragTo(ziel, { targetPosition: { x: box.width / 2, y: 8 } });
  await page.keyboard.up("Control");

  await expect(page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .bereich-info')).toHaveText("6 S.");
  const infoB = await dokumentInfo(page, "b.pdf");
  expect(await seiteMit(page, infoB.id, "B1")).toEqual([0]);
  expect(await seiteMit(page, infoB.id, "A2")).toEqual([1]);
  expect(await seiteMit(page, infoB.id, "A4")).toEqual([3]);
  expect(await seiteMit(page, infoB.id, "B2")).toEqual([4]);
  // Kopieren: A bleibt unverändert
  expect((await dokumentInfo(page, "a.pdf")).seitenanzahl).toBe(5);
  // geändert-Markierung
  await expect(page.locator(".tab", { hasText: "b.pdf" }).locator(".geaendert-punkt")).toBeVisible();

  await page.keyboard.press("Control+z");
  await expect(page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .bereich-info')).toHaveText("3 S.");
  expect(await seiteMit(page, infoB.id, "A2")).toEqual([]);
});

test("Verschieben zwischen Dokumenten (ohne Strg) und gemeinsames Rückgängig", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  await oeffnen(page, "b.pdf");
  await page.locator('.tab:has-text("a.pdf")').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rechts daneben anzeigen" }).click();
  await expect(page.getByTestId("bereich")).toHaveCount(2);
  const a = page.locator('.bereich:has(.bereich-titel:text-is("a.pdf")) .miniaturen');
  const b = page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .miniaturen');
  await a.locator('.miniatur[data-seite="0"]').dragTo(b.locator('.miniatur[data-seite="2"]'), { targetPosition: { x: 40, y: 150 } });
  await expect(page.locator('.bereich:has(.bereich-titel:text-is("a.pdf")) .bereich-info')).toHaveText("4 S.");
  await expect(page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .bereich-info')).toHaveText("4 S.");
  // Rückgängig im Ziel stellt beide wieder her
  await b.locator('.miniatur[data-seite="0"]').click();
  await page.keyboard.press("Control+z");
  await expect(page.locator('.bereich:has(.bereich-titel:text-is("a.pdf")) .bereich-info')).toHaveText("5 S.");
  await expect(page.locator('.bereich:has(.bereich-titel:text-is("b.pdf")) .bereich-info')).toHaveText("3 S.");
});

test("Umsortieren per Drag & Drop, Löschen mit Entf, Drehen per Rechtsklick", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  const mini = page.getByTestId("miniaturen");
  // A1 hinter A3 ziehen (untere Hälfte der dritten Miniatur)
  const ziel = mini.locator('.miniatur[data-seite="2"]');
  const zb = (await ziel.boundingBox())!;
  await mini.locator('.miniatur[data-seite="0"]').dragTo(ziel, { targetPosition: { x: zb.width / 2, y: zb.height - 10 } });
  const info = await dokumentInfo(page, "a.pdf");
  await expect.poll(() => seiteMit(page, info.id, "A1")).toEqual([2]);
  expect(await seiteMit(page, info.id, "A2")).toEqual([0]);
  // verschobene Seite bleibt markiert
  await expect(mini.locator('.miniatur[data-seite="2"]')).toHaveClass(/markiert/);

  // Seite 2 markieren und mit Entf löschen
  await mini.locator('.miniatur[data-seite="1"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".seitenwahl")).toContainText("/ 4");
  await expect(page.locator(".meldung")).toContainText("gelöscht");

  // Rechtsklick → Rechts drehen
  await mini.locator('.miniatur[data-seite="0"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rechts drehen" }).click();
  await expect
    .poll(async () => (await mini.locator('.miniatur[data-seite="0"] .miniatur-bild').boundingBox())!.width)
    .toBeGreaterThan((await mini.locator('.miniatur[data-seite="1"] .miniatur-bild').boundingBox())!.width);
  // zweimal rückgängig: Drehung und Löschen
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".seitenwahl")).toContainText("/ 5");
});

test("Leerseiten aus Duplex-Scan finden und entfernen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "duplex.pdf");
  await page.getByRole("tab", { name: "Seiten", exact: true }).first().click();
  await page.locator('[data-befehl="seiten.leerseiten"]').click();
  await expect(page.locator(".hinweisleiste")).toContainText("3 Leerseiten gefunden");
  await expect(page.getByTestId("miniaturen").locator(".miniatur.markiert").first()).toBeVisible();
  await page.getByRole("button", { name: "3 Seiten entfernen" }).click();
  await expect(page.locator(".seitenwahl")).toContainText("/ 3");
});

test("Teilen-Dialog öffnet Teile als neue Dokumente", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  await page.getByRole("tab", { name: "Seiten", exact: true }).first().click();
  await page.locator('[data-befehl="seiten.teilen"]').click();
  await page.getByLabel("Seiten pro Teil").fill("2");
  await expect(page.locator(".dialog")).toContainText("3 Teile");
  await page.locator(".dialog").getByRole("button", { name: "Teilen", exact: true }).click();
  await expect(page.locator(".tab")).toHaveCount(5); // 150_seiten, a + 3 Teile
  await expect(page.locator(".tab").last()).toContainText("a_Teil_03.pdf");
});

test("Speichern mit Strg+S und Nachfrage beim Schließen", async ({ page }) => {
  await start(page); // 150_seiten.pdf ist über den Pfad geöffnet → speicherbar
  await page.getByRole("tab", { name: "Seiten", exact: true }).first().click();
  await page.locator('[data-befehl="seiten.rechts_drehen"]').click();
  const tab = page.locator(".tab.aktiv");
  await expect(tab.locator(".geaendert-punkt")).toBeVisible();
  // Schließen fragt nach
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("alertdialog")).toContainText("Änderungen speichern?");
  await page.getByRole("button", { name: "Abbrechen" }).click();
  await page.keyboard.press("Control+s");
  await expect(page.locator(".meldung")).toContainText("Gespeichert");
  await expect(tab.locator(".geaendert-punkt")).toHaveCount(0);
  await page.keyboard.press("Control+w");
  await expect(page.locator(".startseite")).toBeVisible();
});

/** Mitte eines Elements */
async function mitte(page: Page, selektor: string, versatz = { x: 0.5, y: 0.5 }) {
  const b = (await page.locator(selektor).first().boundingBox())!;
  return { x: b.x + b.width * versatz.x, y: b.y + b.height * versatz.y };
}

test("Seiten über den Tab ins andere Dokument ziehen (Tabs, ohne Nebeneinander)", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  await oeffnen(page, "b.pdf");
  await page.locator('.tab:has-text("a.pdf")').click();
  const mini = page.getByTestId("miniaturen");
  await mini.locator('.miniatur[data-seite="1"]').click();
  await mini.locator('.miniatur[data-seite="2"]').click({ modifiers: ["Shift"] });

  // A2+A3 greifen, auf den Tab „b.pdf“ ziehen und kurz verweilen → b wird angezeigt
  const start_ = await mitte(page, '[data-testid="miniaturen"] .miniatur[data-seite="1"]');
  await page.mouse.move(start_.x, start_.y);
  await page.mouse.down();
  const tab = await mitte(page, '.tab:has-text("b.pdf")');
  await page.mouse.move(tab.x, tab.y, { steps: 8 });
  await expect(page.locator('.tab:has-text("b.pdf")')).toHaveClass(/seiten-ziel/);
  await expect(page.locator(".tab.aktiv")).toContainText("b.pdf", { timeout: 3000 });
  // in b's Miniaturleiste zwischen B1 und B2 ablegen
  const ziel = await mitte(page, '[data-testid="miniaturen"] .miniatur[data-seite="1"]', { x: 0.5, y: 0.1 });
  await page.mouse.move(ziel.x, ziel.y, { steps: 8 });
  await page.mouse.up();

  const infoB = await dokumentInfo(page, "b.pdf");
  await expect.poll(async () => (await dokumentInfo(page, "b.pdf")).seitenanzahl).toBe(5);
  expect(await seiteMit(page, infoB.id, "A2")).toEqual([1]);
  expect(await seiteMit(page, infoB.id, "A3")).toEqual([2]);
  expect(await seiteMit(page, infoB.id, "B2")).toEqual([3]);
  expect((await dokumentInfo(page, "a.pdf")).seitenanzahl).toBe(3); // verschoben
});

test("Seite direkt auf einen Tab fallen lassen (hinten anhängen, Strg = kopieren) und in die Seitenansicht ziehen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  await oeffnen(page, "b.pdf");
  await page.locator('.tab:has-text("a.pdf")').click();
  const mini = page.getByTestId("miniaturen");
  await mini.locator('.miniatur[data-seite="0"]').click();

  // schnell auf den Tab b fallen lassen, mit Strg → kopieren, hinten anhängen
  const s = await mitte(page, '[data-testid="miniaturen"] .miniatur[data-seite="0"]');
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.keyboard.down("Control");
  const tab = await mitte(page, '.tab:has-text("b.pdf")');
  await page.mouse.move(tab.x, tab.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect.poll(async () => (await dokumentInfo(page, "b.pdf")).seitenanzahl).toBe(4);
  const infoB = await dokumentInfo(page, "b.pdf");
  expect(await seiteMit(page, infoB.id, "A1")).toEqual([3]);
  expect((await dokumentInfo(page, "a.pdf")).seitenanzahl).toBe(5);

  // jetzt aus b (aktiv) eine Seite über den Tab a in die große Seitenansicht von a ziehen
  await expect(page.locator(".tab.aktiv")).toContainText("b.pdf");
  await page.keyboard.press("Control+0");
  const quelle = await mitte(page, '[data-testid="miniaturen"] .miniatur[data-seite="0"]');
  await page.mouse.move(quelle.x, quelle.y);
  await page.mouse.down();
  const tabA = await mitte(page, '.tab:has-text("a.pdf")');
  await page.mouse.move(tabA.x, tabA.y, { steps: 6 });
  await expect(page.locator(".tab.aktiv")).toContainText("a.pdf", { timeout: 3000 });
  // obere Hälfte der ersten sichtbaren Seite → vor Seite 1
  const seite = await mitte(page, '[data-testid="dokumentansicht"] .seite', { x: 0.5, y: 0.2 });
  await page.mouse.move(seite.x, seite.y, { steps: 6 });
  await expect(page.locator(".seiten-ablage-linie")).toBeVisible();
  await page.mouse.up();
  const infoA = await dokumentInfo(page, "a.pdf");
  await expect.poll(async () => (await dokumentInfo(page, "a.pdf")).seitenanzahl).toBe(6);
  expect(await seiteMit(page, infoA.id, "B1")).toEqual([0]);
  expect((await dokumentInfo(page, "b.pdf")).seitenanzahl).toBe(3); // verschoben
  await expect(page.locator(".seiten-ablage-linie")).toHaveCount(0);
});

test("Dokumente vergleichen: Unterschiede nebeneinander markiert und anspringbar", async ({ page }) => {
  await start(page);
  await oeffnen(page, "vertrag_alt.pdf");
  await oeffnen(page, "vertrag_neu.pdf");
  await page.locator(".mb-reiter").getByRole("tab", { name: "Ansicht" }).click();
  await page.locator('[data-befehl="ansicht.vergleichen"]').click();
  const dialog = page.getByRole("dialog", { name: "Dokumente vergleichen" });
  await dialog.getByLabel("Alte Fassung").selectOption({ label: "vertrag_alt.pdf" });
  await dialog.getByLabel("Neue Fassung").selectOption({ label: "vertrag_neu.pdf" });
  await dialog.getByRole("button", { name: "Vergleichen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("bereich")).toHaveCount(2);
  const liste = page.getByRole("list", { name: "Unterschiede" });
  await expect(liste).toContainText("1.200,00");
  await expect(liste).toContainText("1.250,00");
  await expect(liste).toContainText("Selbstbeteiligung");
  // Markierungen in beiden Dokumenten
  await expect(page.locator(".vergleich.v-geaendert")).toHaveCount(2);
  await expect(page.locator(".vergleich.aktiv").first()).toBeVisible();
  // weiterblättern
  const zaehler = page.locator(".vergleich-navi strong");
  await expect(zaehler).toHaveText(/^1 \/ \d+$/);
  await page.getByRole("button", { name: "Nächster Unterschied" }).click();
  await expect(zaehler).toHaveText(/^2 \/ \d+$/);
  if (process.env.E2E_BILDER) await page.screenshot({ path: join(process.env.E2E_BILDER, "vergleich.png") });
  await page.getByRole("button", { name: "Vergleich beenden" }).click();
  await expect(page.locator(".vergleich")).toHaveCount(0);
  await expect(page.getByTestId("bereich")).toHaveCount(0); // wieder nur ein Dokument
});

test("Rechtsklick: Seite drucken – aus Seitenansicht und Miniaturen", async ({ page }) => {
  await start(page);
  // Seitenansicht: Rechtsklick auf die Seite → nur diese Seite im Druckdialog
  const seite = page.locator('.seite-inhalt[data-seite="0"]');
  const box = (await seite.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height, 400) / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Seite 1 drucken …" }).click();
  const dialog = page.getByRole("dialog", { name: "Drucken" });
  await expect(dialog.getByRole("textbox", { name: "Seitenbereich" })).toHaveValue("1");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  // Miniaturen: zwei Seiten markieren → „2 Seiten drucken …“
  const mini = page.locator(".miniaturen").first();
  await mini.locator('.miniatur[data-seite="0"]').click();
  await mini.locator('.miniatur[data-seite="1"]').click({ modifiers: ["Shift"] });
  await mini.locator('.miniatur[data-seite="1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "2 Seiten drucken …" }).click();
  await expect(dialog.getByRole("radio", { name: /Markierte Seiten \(2\)/ })).toBeChecked();
});

test("Datei aus dem Explorer zwischen zwei Miniaturen ablegen – Hinweis bleibt nicht hängen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "a.pdf");
  const mini = page.getByTestId("miniaturen");
  const ziel = (await mini.locator('.miniatur[data-seite="1"]').boundingBox())!;
  // Textdatei (wird wie Word erst umgewandelt) von außen auf die Miniaturleiste ziehen
  const zug = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["Notiz von Max Muster"], "Notiz.txt", { type: "text/plain" }));
    return dt;
  });
  const punkt = { clientX: ziel.x + ziel.width / 2, clientY: ziel.y + 6 };
  await page.locator("body").dispatchEvent("dragover", { dataTransfer: zug, ...punkt });
  await expect(page.locator(".ablage-hinweis")).toBeVisible();
  for (const art of ["dragenter", "dragover"]) await mini.dispatchEvent(art, { dataTransfer: zug, ...punkt });
  await expect(page.locator(".ablage-hinweis")).toBeHidden(); // über den Miniaturen: einfügen, nicht öffnen
  await expect(mini.locator(".ablagemarke")).toBeVisible();
  await mini.dispatchEvent("drop", { dataTransfer: zug, ...punkt });
  await expect(page.locator(".seitenwahl")).toContainText("/ 6");
  await expect(page.locator(".ablage-hinweis")).toBeHidden();
  const info = await dokumentInfo(page, "a.pdf");
  expect(await seiteMit(page, info.id, "Max Muster")).toEqual([1]);
  // Programm bleibt bedienbar: Seite umsortieren klappt direkt danach
  const hinter = (await mini.locator('.miniatur[data-seite="2"]').boundingBox())!;
  await mini.locator('.miniatur[data-seite="1"]').dragTo(mini.locator('.miniatur[data-seite="2"]'), {
    targetPosition: { x: hinter.width / 2, y: hinter.height - 10 },
  });
  await expect.poll(() => seiteMit(page, info.id, "Max Muster")).toEqual([2]);
});
