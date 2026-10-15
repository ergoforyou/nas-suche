// Automatische Sicherung (Wiederherstellung nach Absturz) und Sperrhinweis
// für Dateien, die gerade bei jemand anderem geöffnet sind (NAS).

import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

const H = { "X-Agentur-Token": "e2e" };

test("Nach einem Absturz: ungespeicherte Änderungen wiederherstellen", async ({ page }) => {
  const ordner = join(DATEN, "benutzer", "wiederherstellung");
  mkdirSync(ordner, { recursive: true });
  copyFileSync(join(DATEN, "brief.pdf"), join(ordner, "424242-e2e.pdf"));
  writeFileSync(
    join(ordner, "424242-e2e.json"),
    JSON.stringify({ pid: 424242, titel: "Entwurf Kündigung.pdf", pfad: null, ordner: null, seiten: 3, zeit: "2026-10-15T09:41:00" }),
  );
  await start(page);
  const dialog = page.getByRole("dialog", { name: "Dokumente wiederherstellen" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Entwurf Kündigung.pdf");
  await expect(dialog).toContainText("noch nie gespeichert");
  await dialog.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(dialog).toBeHidden();
  const tab = page.locator(".tab", { hasText: "Entwurf Kündigung.pdf" });
  await expect(tab).toBeVisible();
  await expect(tab.locator(".geaendert-punkt")).toBeVisible();
  expect(existsSync(join(ordner, "424242-e2e.pdf"))).toBe(false);
});

test("Datei ist bei einer Kollegin geöffnet: Hinweis, Rückfrage beim Speichern, wieder frei", async ({ page }) => {
  const ordner = join(DATEN, "gemeinsam");
  mkdirSync(ordner, { recursive: true });
  const datei = join(ordner, "vertrag.pdf");
  copyFileSync(join(DATEN, "brief.pdf"), datei);
  const sperre = join(ordner, "~$vertrag.pdf.sperre");
  writeFileSync(sperre, JSON.stringify({ benutzer: "martina", rechner: "PC-02", kuerzel: "MW", seit: "2026-10-15T08:30" }));

  await start(page);
  await page.request.post("/api/dokumente/oeffnen", { headers: H, data: { pfad: datei } });
  await page.reload();
  await page.locator(".tab", { hasText: "vertrag.pdf" }).click();
  const hinweis = page.locator(".sperr-hinweis");
  await expect(hinweis).toContainText("Bei martina");
  await expect(hinweis).toContainText("PC-02");
  await expect(page.locator(".tab", { hasText: "vertrag.pdf" }).locator(".tab-gesperrt")).toBeVisible();

  // Speichern → Rückfrage statt stillem Überschreiben
  await page.keyboard.press("Control+s");
  const frage = page.getByRole("alertdialog", { name: "Datei wird gerade verwendet" });
  await expect(frage).toContainText("bei martina am PC PC-02 geöffnet");
  await frage.getByRole("button", { name: "Abbrechen" }).click();
  await expect(frage).toBeHidden();

  // Martina schließt die Datei → „Erneut prüfen“ → frei, Speichern ohne Rückfrage
  rmSync(sperre);
  await hinweis.getByRole("button", { name: "Erneut prüfen" }).click();
  await expect(hinweis).toBeHidden();
  await expect(page.locator(".meldung")).toContainText("ist jetzt frei");
  expect(existsSync(sperre)).toBe(true); // jetzt meine Sperre
  await page.keyboard.press("Control+s");
  await expect(page.locator(".meldung")).toContainText("Gespeichert");
  await expect(frage).toHaveCount(0);
});
