// Register „Design“: freistellen, anordnen, Deckblatt, Briefpapier, Hausfarben.

import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { DATEN, start } from "./hilfen";

const H = { "X-Agentur-Token": "e2e" };
const BILDER = process.env.E2E_BILDER; // optional: Ordner für Bildschirmfotos

async function foto(page: Page, name: string) {
  if (BILDER) await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

async function oeffnen(page: Page, name: string) {
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, name));
  await expect(page.locator(".tab.aktiv")).toContainText(name);
  await expect(page.locator(".seite-bild").first()).toBeVisible();
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(300);
}

async function aktivesDok(page: Page): Promise<{ id: string; seiten: number }> {
  const liste = (await (await page.request.get("/api/dokumente", { headers: H })).json()) as { id: string; titel: string; seiten: unknown[] }[];
  const titel = (await page.locator(".tab.aktiv .tab-titel").textContent()) ?? "";
  const d = liste.find((x) => x.titel === titel)!;
  return { id: d.id, seiten: Array.isArray(d.seiten) ? d.seiten.length : Number(d.seiten) };
}

async function anmerkungen(page: Page, dokId: string) {
  return (await (await page.request.get(`/api/dokumente/${dokId}/anmerkungen`, { headers: H })).json()) as Record<string, { id: number; art: string; rechteck: number[] }[]>;
}

async function aufSeite(page: Page, fx: number, fy: number, seite = 0) {
  const box = (await page.locator(`.seite-inhalt[data-seite="${seite}"]`).boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function design(page: Page) {
  await page.locator(".mb-reiter").getByRole("tab", { name: "Design" }).click();
}

test("Objekt freistellen, duplizieren und zentrieren", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const { id } = await aktivesDok(page);
  await design(page);
  await expect(page.locator('[data-befehl="design.ki_bild"]')).toBeDisabled();
  await page.locator('[data-befehl="design.freistellen"]').click();
  const a = await aufSeite(page, 0.08, 0.03);
  const b = await aufSeite(page, 0.6, 0.2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Objekt freistellen" });
  await expect(dialog.getByRole("img", { name: "Freigestellt" })).toBeVisible({ timeout: 15_000 });
  await foto(page, "design-freistellen");
  await dialog.getByRole("button", { name: "Einsetzen" }).click();
  await expect.poll(async () => (await anmerkungen(page, id))["0"]?.map((x) => x.art)).toEqual(["bild"]);
  // neue Anmerkung ist gewählt → Anordnen-Befehle aktiv
  await expect(page.locator('[data-befehl="design.duplizieren"]')).toBeEnabled();
  await page.locator('[data-befehl="design.duplizieren"]').click();
  await expect.poll(async () => (await anmerkungen(page, id))["0"]?.length).toBe(2);
  await page.locator('[data-befehl="design.a_zentriert"]').click();
  await expect
    .poll(async () => {
      const liste = (await anmerkungen(page, id))["0"];
      return liste.some((x) => Math.abs((x.rechteck[0] + x.rechteck[2]) / 2 - 0.5) < 0.01);
    })
    .toBe(true);
  await page.waitForTimeout(500);
  await foto(page, "design-angeordnet");
  await page.locator('[data-befehl="design.ganz_hinten"]').click();
  await page.keyboard.press("Control+z");
});

test("Deckblatt einfügen und Briefpapier unterlegen", async ({ page }) => {
  await start(page);
  await oeffnen(page, "brief.pdf");
  const { id } = await aktivesDok(page);
  const seitenVorher = (await page.request.get(`/api/dokumente/${id}`, { headers: H }).then((r) => r.json())) as { seiten: unknown[] };
  const anzahl = seitenVorher.seiten.length;
  await design(page);
  await page.locator('[data-befehl="design.deckblatt"]').click();
  const db = page.getByRole("dialog", { name: "Deckblatt" });
  await db.getByRole("textbox", { name: "Titel", exact: true }).fill("Ihr Versicherungsangebot");
  await db.getByRole("textbox", { name: "Kunde" }).fill("Familie Muster");
  await db.getByRole("radio", { name: "Seitenleiste" }).click();
  await foto(page, "design-deckblatt-dialog");
  await db.getByRole("button", { name: "Deckblatt einfügen" }).click();
  await expect(db).toBeHidden();
  await expect
    .poll(async () => ((await page.request.get(`/api/dokumente/${id}`, { headers: H }).then((r) => r.json())) as { seiten: unknown[] }).seiten.length)
    .toBe(anzahl + 1);
  const zeilen = (await (await page.request.get(`/api/dokumente/${id}/seiten/0/textzeilen`, { headers: H })).json()) as { text: string }[];
  expect(zeilen.map((z) => z.text).join(" ")).toContain("Ihr Versicherungsangebot");

  await page.locator('[data-befehl="design.briefpapier"]').click();
  const bp = page.getByRole("dialog", { name: "Briefpapier" });
  const auswahl = page.waitForEvent("filechooser");
  await bp.getByRole("button", { name: /Briefpapier hinzufügen/ }).click();
  await (await auswahl).setFiles(join(DATEN, "a.pdf"));
  await expect(bp.getByRole("radio", { name: "a", exact: true })).toHaveAttribute("aria-checked", "true");
  await foto(page, "design-briefpapier-dialog");
  await bp.getByRole("button", { name: "Unterlegen" }).click();
  await expect(bp).toBeHidden();
  await expect(page.getByText(/Briefpapier unter \d+ Seite/)).toBeVisible();
  await page.locator('.miniatur').first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await foto(page, "design-deckblatt");
});

test("Hausfarben speichern", async ({ page }) => {
  await start(page);
  await design(page);
  await page.locator('[data-befehl="design.hausfarben"]').click();
  const d = page.getByRole("dialog", { name: "Hausfarben" });
  await d.getByRole("textbox", { name: "Hausfarbe 1 als Code" }).fill("#0A5C36");
  await d.getByRole("button", { name: "Speichern" }).click();
  await expect(d).toBeHidden();
  const e = (await (await page.request.get("/api/einstellungen", { headers: H })).json()) as { hausfarben: string[] };
  expect(e.hausfarben[0]).toBe("#0A5C36");
  await page.request.put("/api/einstellungen", { headers: H, data: { hausfarben: [] } }).catch(() => undefined);
});
