import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

const H = { "X-Agentur-Token": "e2e" };

async function seiteMit(page: Page, titel: string, text: string): Promise<number[]> {
  const dokumente = (await (await page.request.get("/api/dokumente", { headers: H })).json()) as { id: string; titel: string }[];
  const dok = dokumente.find((d) => d.titel === titel)!;
  const treffer = (await (await page.request.get(`/api/dokumente/${dok.id}/suche?q=${encodeURIComponent(text)}`, { headers: H })).json()) as {
    seite: number;
  }[];
  return [...new Set(treffer.map((t) => t.seite))];
}

test("T1: PDF, JPG und DOCX über den Dialog zusammenführen (≤ 10 s, richtige Reihenfolge)", async ({ page }) => {
  await start(page);
  await page.getByRole("tab", { name: "Konvertieren" }).click();
  await page.locator('[data-befehl="konvertieren.zusammenfuehren"]').click();
  const dialog = page.getByRole("dialog", { name: "Zu einer PDF zusammenführen" });
  await expect(dialog).toBeVisible();

  const auswahl = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Dateien hinzufügen …" }).click();
  // absichtlich falsche Reihenfolge, danach im Dialog korrigieren
  await (await auswahl).setFiles([join(DATEN, "anschreiben.docx"), join(DATEN, "brief.pdf"), join(DATEN, "foto.jpg")]);
  const namen = dialog.locator(".zf-liste li .zf-name");
  await expect(namen).toHaveText(["anschreiben.docx", "brief.pdf", "foto.jpg"]);
  await expect(dialog.locator(".dreht")).toHaveCount(0); // Uploads fertig

  // Word ans Ende: per Pfeil zweimal nach unten
  await dialog.getByRole("button", { name: "anschreiben.docx nach unten" }).click();
  await dialog.getByRole("button", { name: "anschreiben.docx nach unten" }).click();
  await expect(namen).toHaveText(["brief.pdf", "foto.jpg", "anschreiben.docx"]);

  const start_ms = Date.now();
  await dialog.getByRole("button", { name: "Zusammenführen" }).click();
  await expect(page.locator(".tab.aktiv")).toContainText("brief (zusammengeführt).pdf", { timeout: 10_000 });
  const dauer = Date.now() - start_ms;
  console.log(`T1: Zusammenführen bis Anzeige ${dauer} ms`);
  expect(dauer).toBeLessThan(10_000);
  await expect(dialog).toBeHidden();
  await expect(page.locator(".seitenwahl")).toContainText("/ 5");
  expect(await seiteMit(page, "brief (zusammengeführt).pdf", "Versicherungsschein")).toEqual([0, 1, 2]);
  expect(await seiteMit(page, "brief (zusammengeführt).pdf", "Familie Weiß")).toEqual([4]);
  // Lesezeichen je Datei
  await page.getByRole("button", { name: "Lesezeichen", exact: true }).click();
  await expect(page.locator(".lesezeichen .eintrag")).toContainText(["brief", "foto", "anschreiben"]);
  await expect(page.locator(".tab.aktiv .geaendert-punkt")).toBeVisible();
});

test("Reihenfolge per Drag & Drop im Dialog", async ({ page }) => {
  await start(page);
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').waitFor();
  // Explorer-Übergabe simulieren (wie Rechtsklick → „Zu einer PDF zusammenführen“)
  await page.request.post("/api/extern", {
    headers: H,
    data: { aktion: "zusammenfuehren", dateien: [join(DATEN, "foto.jpg"), join(DATEN, "brief.pdf")] },
  });
  const dialog = page.getByRole("dialog", { name: "Zu einer PDF zusammenführen" });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const namen = dialog.locator(".zf-liste li .zf-name");
  await expect(namen).toHaveText(["brief.pdf", "foto.jpg"]); // alphabetisch vorsortiert
  await dialog.locator('li[data-name="foto.jpg"]').dragTo(dialog.locator('li[data-name="brief.pdf"]'));
  await expect(namen).toHaveText(["foto.jpg", "brief.pdf"]);
  // zweite Übergabe während der Dialog offen ist → wird angehängt
  await page.request.post("/api/extern", { headers: H, data: { aktion: "zusammenfuehren", dateien: [join(DATEN, "a.pdf")] } });
  await expect(namen).toHaveText(["foto.jpg", "brief.pdf", "a.pdf"], { timeout: 5000 });
  await dialog.getByRole("button", { name: "Zusammenführen" }).click();
  await expect(page.locator(".tab.aktiv")).toContainText("foto (zusammengeführt).pdf", { timeout: 10_000 });
  await expect(page.locator(".seitenwahl")).toContainText("/ 9");
});

test("Word-Datei direkt öffnen wird im Hintergrund umgewandelt", async ({ page }) => {
  await start(page);
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, "anschreiben.docx"));
  await expect(page.locator(".tab.aktiv")).toContainText("anschreiben.pdf", { timeout: 10_000 });
  expect(await seiteMit(page, "anschreiben.pdf", "Familie Weiß")).toEqual([0]);
});

test("Fehlerhafte Datei: verständliche Meldung im Dialog", async ({ page }) => {
  await start(page);
  await page.request.post("/api/extern", { headers: H, data: { aktion: "zusammenfuehren", dateien: [join(DATEN, "kaputt.pdf")] } });
  const dialog = page.getByRole("dialog", { name: "Zu einer PDF zusammenführen" });
  await dialog.getByRole("button", { name: "In PDF umwandeln" }).click();
  await expect(dialog.locator(".zf-fortschritt.fehler")).toContainText("kaputt.pdf", { timeout: 5000 });
});
