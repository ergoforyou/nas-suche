// Stapelverarbeitung: Ordner auf einmal bearbeiten.

import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

test("Stapelverarbeitung: Ordner verkleinern und in Zielordner speichern", async ({ page }) => {
  const quelle = join(DATEN, "stapel-eingang");
  const ziel = join(DATEN, "stapel-fertig");
  rmSync(quelle, { recursive: true, force: true });
  rmSync(ziel, { recursive: true, force: true });
  mkdirSync(quelle, { recursive: true });
  for (const n of ["a.pdf", "duplex.pdf", "foto.jpg"]) copyFileSync(join(DATEN, n), join(quelle, n));

  await start(page);
  await page.locator(".mb-reiter").getByRole("tab", { name: "Konvertieren" }).click();
  await page.locator('[data-befehl="konvertieren.stapel"]').click();
  const dialog = page.getByRole("dialog", { name: "Stapelverarbeitung" });
  await dialog.getByLabel("Pfad hinzufügen").fill(quelle);
  await dialog.getByLabel("Pfad hinzufügen").press("Enter");
  await expect(dialog).toContainText("3 Datei(en) werden bearbeitet");
  await dialog.getByLabel(/Texterkennung/).uncheck();
  await dialog.getByLabel("Leerseiten entfernen").check();
  await dialog.getByLabel("Verkleinern").selectOption("mittel");
  await dialog.getByLabel("In diesen Ordner:").check();
  await dialog.getByLabel("Zielordner").fill(ziel);
  await dialog.getByLabel("Namensmuster").fill("{nr} {name}");
  await dialog.getByRole("button", { name: "3 Datei(en) bearbeiten" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".meldung")).toContainText("Stapel fertig: 3 von 3", { timeout: 30_000 });
  expect(readdirSync(ziel).sort()).toEqual(["001 a.pdf", "002 duplex.pdf", "003 foto.pdf"]);
  expect(existsSync(join(quelle, "a.pdf"))).toBe(true); // Original bleibt
});

test("PDF-Drucker: Ausdruck im Druckordner öffnet sich als neues Dokument", async ({ page }) => {
  const druck = join(DATEN, "druck");
  rmSync(druck, { recursive: true, force: true });
  mkdirSync(druck, { recursive: true });
  await start(page);
  await page.request.put("/api/einstellungen", { headers: { "X-Agentur-Token": "e2e" }, data: { druck_ordner: druck } });
  await page.locator(".mb-reiter").getByRole("tab", { name: "Konvertieren" }).click();
  await page.locator('[data-befehl="konvertieren.drucker"]').click();
  const dialog = page.getByRole("dialog", { name: "PDF-Drucker" });
  await expect(dialog).toContainText("Agentur-PDF");
  await dialog.getByRole("button", { name: "Schließen" }).click();
  // so legt der Drucker einen Ausdruck ab
  copyFileSync(join(DATEN, "brief.pdf"), join(druck, "Ausdruck.pdf"));
  await expect(page.locator(".tab.aktiv")).toContainText("Ausdruck", { timeout: 10_000 });
  expect(existsSync(join(druck, "Ausdruck.pdf"))).toBe(false);
  await page.request.put("/api/einstellungen", { headers: { "X-Agentur-Token": "e2e" }, data: { druck_ordner: "" } });
});
