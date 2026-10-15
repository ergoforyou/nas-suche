import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

const H = { "X-Agentur-Token": "e2e" };

async function oeffnen(page: Page, name: string) {
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, name));
  await expect(page.locator(".tab.aktiv")).toContainText(name);
}

test("Scan ohne Text: Hinweis → Texterkennung → durchsuchbar", async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await oeffnen(page, "scan.pdf");
  const hinweis = page.getByTestId("ocr-hinweis");
  await expect(hinweis).toContainText("2 Seiten enthalten keinen durchsuchbaren Text");
  await hinweis.getByRole("button", { name: "Texterkennung starten" }).click();
  const dialog = page.getByRole("dialog", { name: "Texterkennung" });
  await expect(dialog).toContainText("Seitenbild bleibt unverändert");
  await dialog.getByRole("button", { name: "Texterkennung starten" }).click();
  await expect(page.locator(".meldung")).toContainText("Texterkennung fertig: 2 Seite(n)", { timeout: 60_000 });
  await expect(hinweis).toBeHidden();
  // Suche findet jetzt Text im Scan
  await page.keyboard.press("Control+f");
  await page.locator("#suchfeld").fill("Prämie");
  await page.locator("#suchfeld").press("Enter");
  await expect(page.locator(".suche-status")).toContainText("2 Treffer");
  await expect(page.locator(".treffer.aktiv")).toBeVisible();
  // Rückgängig entfernt die Textebene wieder
  await expect(page.locator('[data-befehl="schnell.bearbeiten.rueckgaengig"]')).toBeEnabled();
});

test("Text aus Bereich wird erkannt und angezeigt", async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await oeffnen(page, "scan.pdf");
  await page.getByTestId("dokumentansicht").click();
  await page.keyboard.press("t");
  await expect(page.locator(".eigenschaftsleiste")).toContainText("Text aus Bereich");
  const seite = (await page.locator(".seite").first().boundingBox())!;
  // Kopfzeile „Versicherungsschein Nr. VS-1000“ liegt oben links
  await page.mouse.move(seite.x + seite.width * 0.08, seite.y + seite.height * 0.06);
  await page.mouse.down();
  await page.mouse.move(seite.x + seite.width * 0.75, seite.y + seite.height * 0.125, { steps: 6 });
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Erkannter Text" });
  await expect(dialog.locator("textarea")).toHaveValue(/Versicherungsschein Nr\. VS-1000/, { timeout: 30_000 });
});

test("Unsichere Wörter eines schlechten Scans markieren", async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await oeffnen(page, "schlecht.pdf");
  await page.getByRole("tab", { name: "Konvertieren" }).click();
  await page.locator('[data-befehl="ocr.dokument"]').click();
  await page.getByRole("dialog", { name: "Texterkennung" }).getByRole("button", { name: "Texterkennung starten" }).click();
  await expect(page.locator(".meldung")).toContainText("Texterkennung fertig", { timeout: 60_000 });
  await page.locator('[data-befehl="ocr.unsicher"]').click();
  await expect(page.locator(".unsicher").first()).toBeVisible();
  await page.locator('[data-befehl="ocr.unsicher"]').click();
  await expect(page.locator(".unsicher")).toHaveCount(0);
});

test("Überwachungsordner verarbeitet neuen Scan automatisch", async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await page.getByRole("tab", { name: "Konvertieren" }).click();
  await page.locator('[data-befehl="ocr.ueberwachung"]').click();
  const dialog = page.getByRole("dialog", { name: "Überwachungsordner" });
  await dialog.getByLabel("Überwachter Ordner 1").fill(join(DATEN, "eingang"));
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".meldung")).toContainText("Überwachungsordner gespeichert");
  copyFileSync(join(DATEN, "scan.pdf"), join(DATEN, "eingang", "Scan_0815.pdf"));
  await expect(page.locator(".meldung")).toContainText("Scan verarbeitet: Scan_0815.pdf", { timeout: 60_000 });
  expect(existsSync(join(DATEN, "eingang", "_Original", "Scan_0815.pdf"))).toBe(true);
  // aufräumen
  await page.request.put("/api/ueberwachung", { headers: H, data: [] });
});
