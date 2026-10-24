// Online-Unterschrift: Feld setzen, über den NAS-Dienst „Ergoforyou Sign“
// verschicken, als Kunde unterschreiben, Ergebnis wieder öffnen.

import { expect, request, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATEN, start } from "./hilfen";

const BILDER = process.env.E2E_BILDER;
const NAS_KUNDE = "http://127.0.0.1:47880";
const NAS_INTERN = "http://127.0.0.1:47881";
let nas: ChildProcess | null = null;

async function foto(page: Page, name: string) {
  if (BILDER) await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

test.beforeAll(async () => {
  nas = spawn("python3", ["-m", "ergoforyou_sign"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../signatur"),
    env: { ...process.env, SIGN_DATEN: mkdtempSync(join(tmpdir(), "sign-e2e-")), SIGN_PORT_KUNDE: "47880", SIGN_PORT_INTERN: "47881" },
    stdio: "inherit",
  });
  const ctx = await request.newContext();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await ctx.get(`${NAS_KUNDE}/gesundheit`)).ok()) break;
    } catch {
      /* startet noch */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await ctx.dispose();
});

test.afterAll(() => {
  nas?.kill();
});

test("Unterschriftsfeld setzen, senden, als Kunde unterschreiben, Ergebnis öffnen", async ({ page, context }) => {
  // Einrichtung auf dem NAS (wie im Browser unter http://<NAS>:8481)
  const einrichtung = await request.newContext({ baseURL: NAS_INTERN });
  expect((await einrichtung.post("/einrichtung/kennwort", { data: { kennwort: "geheim123" } })).ok()).toBeTruthy();
  expect((await einrichtung.post("/einrichtung/werte", { data: { oeffentliche_adresse: NAS_KUNDE } })).ok()).toBeTruthy();
  const { verbindungscode } = await (await einrichtung.get("/einrichtung/werte")).json();
  expect(verbindungscode).toMatch(/^EFY-SIGN:/);

  await start(page);
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, "brief.pdf"));
  await expect(page.locator(".tab.aktiv")).toContainText("brief.pdf");
  await page.keyboard.press("Control+0");

  // Unterschriftsfeld auf Seite 1 aufziehen
  await page.locator(".mb-reiter").getByRole("tab", { name: "Schützen" }).click();
  await page.locator('[data-befehl="signatur.feld"]').click();
  const box = (await page.locator('.seite-inhalt[data-seite="0"]').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.82);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.88, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".fg-feld.fg-unterschrift")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Senden-Dialog: einmalig verbinden, dann Link erstellen
  await page.locator('[data-befehl="signatur.senden"]').click();
  const dialog = page.getByRole("dialog", { name: "Zur Unterschrift senden" });
  await dialog.getByLabel("Verbindungscode").fill(verbindungscode);
  await dialog.getByRole("button", { name: "Verbinden" }).click();
  await expect(dialog.getByLabel("Titel")).toHaveValue("brief");
  await dialog.getByLabel("Titel").fill("Maklervertrag Max Muster");
  await dialog.getByLabel("Name des Unterzeichners").fill("Max Muster");
  await dialog.getByLabel("Nachricht").fill("Bitte unten auf Seite 1 unterschreiben.");
  await expect(dialog).toContainText("1 Unterschriftsfeld im Dokument (Seite 1)");
  await foto(page, "sign-1-senden");
  await dialog.getByRole("button", { name: "Link erstellen" }).click();
  const linkFeld = dialog.getByLabel("Link für den Kunden");
  await expect(linkFeld).toHaveValue(/^http:\/\/127\.0\.0\.1:47880\/s\/.{30,}/);
  const link = await linkFeld.inputValue();
  await foto(page, "sign-2-link");
  await dialog.getByRole("button", { name: "Fertig" }).click();

  // Kunde öffnet den Link (Handy-Format)
  const kunde = await context.newPage();
  await kunde.setViewportSize({ width: 390, height: 844 });
  await kunde.goto(link);
  await expect(kunde.getByRole("heading", { name: "Maklervertrag Max Muster" })).toBeVisible();
  await expect(kunde.locator(".nachricht")).toContainText("Seite 1 unterschreiben");
  await expect(kunde.locator(".seite img").first()).toBeVisible();
  await expect(kunde.locator("#absenden")).toBeDisabled();
  await foto(kunde, "sign-3-kunde");
  await kunde.locator(".feld:not(.text-feld)").first().click();
  const leinwand = kunde.locator("#leinwand");
  await expect(leinwand).toBeVisible();
  const lb = (await leinwand.boundingBox())!;
  await kunde.mouse.move(lb.x + 30, lb.y + 120);
  await kunde.mouse.down();
  for (let i = 1; i <= 20; i++) await kunde.mouse.move(lb.x + 30 + i * 14, lb.y + 120 - Math.sin(i / 3) * 40);
  await kunde.mouse.up();
  await foto(kunde, "sign-4-pad");
  await kunde.getByRole("button", { name: "Übernehmen" }).click();
  await expect(kunde.locator(".feld.gefuellt img")).toBeVisible();
  await expect(kunde.locator("#name")).toHaveValue("Max Muster");
  await kunde.locator("#zustimmung").check();
  await kunde.locator("#absenden").click();
  await expect(kunde.getByRole("heading", { name: "Vielen Dank!" })).toBeVisible();
  await foto(kunde, "sign-5-fertig");
  const download = kunde.waitForEvent("download");
  await kunde.getByRole("link", { name: "Kopie herunterladen (PDF)" }).click();
  const datei = await (await download).path();
  expect(readFileSync(datei!).subarray(0, 4).toString()).toBe("%PDF");
  // Link ist danach verbraucht: zeigt nur noch den Abschluss
  await kunde.reload();
  await expect(kunde.getByRole("heading", { name: "Vielen Dank!" })).toBeVisible();

  // Büro: Übersicht zeigt „Unterschrieben“, PDF öffnen
  await page.locator('[data-befehl="signatur.uebersicht"]').click();
  const uebersicht = page.getByRole("dialog", { name: "Unterschriften" });
  await expect(uebersicht.locator(".sig-status.sig-unterschrieben")).toHaveCount(1);
  await uebersicht.getByRole("button", { name: /Maklervertrag Max Muster/ }).click();
  await expect(uebersicht.locator(".sig-verlauf")).toContainText("Unterschrieben");
  await foto(page, "sign-6-uebersicht");
  await uebersicht.getByRole("button", { name: "Unterschriebene PDF öffnen" }).click();
  await expect(page.locator(".tab.aktiv")).toContainText("unterschrieben");
  await expect(page.locator(".seite-bild").first()).toBeVisible();
  await einrichtung.dispose();
});
