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
