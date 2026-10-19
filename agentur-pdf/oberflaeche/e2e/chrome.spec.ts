// Chrome-Seitenleiste (Erweiterung aus ../chrome) gegen den laufenden Dienst.

import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DATEN } from "./hilfen";

const ERWEITERUNG = resolve(process.cwd(), "../chrome");
const KENNUNG = "lghbgpogeocemchimfnflmjgekhnofca";
const VOLL = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let kontext: BrowserContext;

test.beforeAll(async () => {
  kontext = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "chrome-erw-")), {
    headless: true,
    ...(existsSync(VOLL) ? { executablePath: VOLL } : {}),
    args: ["--headless=new", `--disable-extensions-except=${ERWEITERUNG}`, `--load-extension=${ERWEITERUNG}`],
    acceptDownloads: true,
  });
  // Hintergrund (Service Worker) abwarten → Erweiterung geladen, Kennung stimmt
  const sw = kontext.serviceWorkers()[0] ?? (await kontext.waitForEvent("serviceworker"));
  expect(sw.url()).toContain(KENNUNG);
});

test.afterAll(async () => {
  await kontext?.close();
});

test("Seitenleiste: Dateien zusammenführen, Seite drehen/löschen, speichern", async () => {
  const leiste = await kontext.newPage();
  await leiste.setViewportSize({ width: 380, height: 900 });
  await leiste.goto(`chrome-extension://${KENNUNG}/seitenleiste.html`);
  await expect(leiste.locator("#status")).toContainText("verbunden");

  await leiste.locator("#dateiwahl").setInputFiles([join(DATEN, "a.pdf"), join(DATEN, "foto.jpg"), join(DATEN, "b.pdf")]);
  await expect(leiste.locator(".datei")).toHaveCount(3);
  // Bild nach hinten schieben
  await leiste.getByRole("button", { name: "foto.jpg: nach unten" }).click();
  await expect(leiste.locator(".datei .name").nth(2)).toHaveText("foto.jpg");
  await leiste.getByRole("button", { name: "Zu einer PDF zusammenführen" }).click();
  await expect(leiste.locator("#seitenzahl")).toHaveText("(9 Seiten)", { timeout: 30_000 }); // 5 + 3 + 1
  await expect(leiste.locator(".seite img").first()).toHaveJSProperty("complete", true);

  await leiste.locator(".seite").first().hover();
  await leiste.getByRole("button", { name: "Seite 1: rechts drehen" }).click();
  await leiste.locator(".seite").nth(1).hover();
  await leiste.getByRole("button", { name: "Seite 2: löschen" }).click();
  await expect(leiste.locator("#seitenzahl")).toHaveText("(8 Seiten)");
  await leiste.getByRole("button", { name: /Rückgängig/ }).click();
  await expect(leiste.locator("#seitenzahl")).toHaveText("(9 Seiten)");
  await leiste.screenshot({ path: join(process.env.E2E_BILDER ?? tmpdir(), "chrome-seitenleiste.png") });

  // Im Programmfenster weiterbearbeiten → Dokument geht an das Programm über
  await leiste.getByRole("button", { name: "Im Programm" }).click();
  await expect(leiste.locator("#ergebnis")).toBeHidden();
});

test("Fremde Webseite bekommt kein Token", async () => {
  const seite = await kontext.newPage();
  const r = await seite.request.post("http://127.0.0.1:47811/chrome/verbinden", { headers: { Origin: "https://example.com" } });
  expect(r.status()).toBe(403);
});
