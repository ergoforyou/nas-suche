// Chrome-Seitenleiste (Erweiterung aus ../chrome) gegen den laufenden Dienst.

import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
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

  // „Bearbeiten“ → vollständiger Editor im neuen Tab
  const neuerTab = kontext.waitForEvent("page");
  await leiste.getByRole("button", { name: "Bearbeiten" }).click();
  const editor = await neuerTab;
  await expect(editor.locator(".seite-bild").first()).toBeVisible({ timeout: 15_000 });
  await expect(leiste.locator("#ergebnis")).toBeHidden();
  await editor.close();
});

test("Google Drive: markierte Datei per Knopf im Programm öffnen", async () => {
  // Nachgebaute Drive-Seite + Download-Adresse (echte Google-Anmeldung gibt es im Test nicht)
  const pdf = readFileSync(join(DATEN, "b.pdf"));
  await kontext.route("https://drive.google.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/uc?export=download")) {
      expect(url).toContain("id=1AbCdEfGhIjKlMnOp");
      await route.fulfill({ body: pdf, contentType: "application/pdf", headers: { "Content-Disposition": 'attachment; filename="Police Muster.pdf"' } });
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: '<html><body><div role="row" data-id="1AbCdEfGhIjKlMnOp" aria-selected="true">Police Muster.pdf</div></body></html>',
      });
    }
  });
  const drive = await kontext.newPage();
  await drive.goto("https://drive.google.com/drive/my-drive");
  const knopf = drive.getByRole("button", { name: "Ergoforyou PDF: öffnen" });
  await expect(knopf).toBeVisible({ timeout: 10_000 });
  const editorTab = kontext.waitForEvent("page");
  await knopf.click();
  const editor = await editorTab;
  await expect(editor).toHaveTitle(/Police Muster.*Ergoforyou PDF/, { timeout: 15_000 });
  await expect(editor.locator(".seite-bild").first()).toBeVisible();
  await editor.close();
  await kontext.unroute("https://drive.google.com/**");
});

test("PDF-Link in Chrome öffnet sich im vollständigen Editor (statt Chromes Ansicht)", async () => {
  // eigener kleiner Webserver liefert eine PDF mit „Content-Type: application/pdf“
  const server = spawn("python3", ["-m", "http.server", "47899", "--bind", "127.0.0.1", "--directory", DATEN], { stdio: "ignore" });
  try {
    const seite = await kontext.newPage();
    await expect.poll(async () => (await seite.request.get("http://127.0.0.1:47899/b.pdf").catch(() => null))?.status(), { timeout: 10_000 }).toBe(200);
    await seite.goto("http://127.0.0.1:47899/b.pdf").catch(() => undefined); // Navigation wird umgeleitet
    await expect(seite).toHaveURL(/127\.0\.0\.1:47851\//, { timeout: 15_000 });
    await expect(seite).toHaveTitle(/b.*Ergoforyou PDF/);
    await expect(seite.locator(".seite-bild").first()).toBeVisible();
    // es ist der echte Editor: Menüband und Bearbeiten-Werkzeuge sind da
    await expect(seite.locator(".mb-reiter").getByRole("tab", { name: "Bearbeiten" })).toBeVisible();
    await expect(seite.locator(".tab")).toHaveCount(1);
    // bearbeiten (Seite drehen) und mit Strg+S als Download speichern
    const box = (await seite.locator('.seite-inhalt[data-seite="0"]').boundingBox())!;
    await seite.mouse.click(box.x + box.width / 2, box.y + 60, { button: "right" });
    await seite.getByRole("menuitem", { name: "Rechts drehen" }).click();
    await expect(seite).toHaveTitle(/^● /);
    await seite.screenshot({ path: join(process.env.E2E_BILDER ?? tmpdir(), "chrome-editor.png") });
    const download = seite.waitForEvent("download");
    await seite.keyboard.press("Control+s");
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
    await expect(seite).not.toHaveTitle(/^● /);
    // Schalter „automatisch“ aus → Chrome-Ansicht bleibt
    const leiste = await kontext.newPage();
    await leiste.goto(`chrome-extension://${KENNUNG}/seitenleiste.html`);
    await leiste.getByRole("checkbox", { name: /automatisch mit Ergoforyou PDF/ }).uncheck();
    const zweite = await kontext.newPage();
    await zweite.goto("http://127.0.0.1:47899/a.pdf").catch(() => undefined);
    await zweite.waitForTimeout(2500);
    expect(zweite.url()).toContain("47899/a.pdf");
    await leiste.getByRole("checkbox", { name: /automatisch mit Ergoforyou PDF/ }).check();
    await Promise.all([seite.close(), leiste.close(), zweite.close()]);
  } finally {
    server.kill();
  }
});

test("Fremde Webseite bekommt kein Token", async () => {
  const seite = await kontext.newPage();
  const r = await seite.request.post("http://127.0.0.1:47851/chrome/verbinden", { headers: { Origin: "https://example.com" } });
  expect(r.status()).toBe(403);
});

test("HubSpot: Knopf „Unterschrift anfordern“ öffnet den Editor mit Senden-Dialog", async () => {
  await kontext.route("https://app-eu1.hubspot.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Max Muster | HubSpot</title><h1>Max Muster</h1>" }),
  );
  const hubspot = await kontext.newPage();
  await hubspot.goto("https://app-eu1.hubspot.com/contacts/146305116/record/0-2/9");
  await hubspot.waitForTimeout(1200);
  await expect(hubspot.getByRole("button", { name: /Unterschrift anfordern/ })).toBeHidden(); // Firma, kein Kontakt
  await hubspot.goto("https://app-eu1.hubspot.com/contacts/146305116/record/0-1/501");
  const knopf = hubspot.getByRole("button", { name: /Unterschrift anfordern/ });
  await expect(knopf).toBeVisible();
  const neu = kontext.waitForEvent("page");
  await knopf.click();
  const editor = await neu;
  await expect(editor).toHaveURL(/127\.0\.0\.1:47851\//);
  await expect(editor.locator(".sig-start")).toContainText("Unterschrift anfordern");
  await editor.screenshot({ path: join(process.env.E2E_BILDER ?? tmpdir(), "hubspot-start.png") });
  // Dokument öffnen → Senden-Dialog geht von selbst auf
  const auswahl = editor.waitForEvent("filechooser");
  await editor.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, "brief.pdf"));
  await expect(editor.getByRole("dialog", { name: "Zur Unterschrift senden" })).toBeVisible();
  await Promise.all([hubspot.close(), editor.close()]);
  await kontext.unroute("https://app-eu1.hubspot.com/**");
});
