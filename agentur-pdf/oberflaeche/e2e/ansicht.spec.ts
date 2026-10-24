import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { DATEN, start, zuruecksetzen } from "./hilfen";

const START = "/#t=e2e";

async function bereit(page: Page) {
  const fehler: string[] = [];
  page.on("pageerror", (e) => fehler.push(String(e)));
  page.on("console", (m) => m.type() === "error" && fehler.push(m.text()));
  await zuruecksetzen(page);
  await page.goto(START);
  await expect(page.locator(".seite-bild").first()).toBeVisible({ timeout: 10_000 });
  return fehler;
}

/** Wartet, bis alle sichtbaren Seiten ein Bild haben, und misst die Zeit. */
async function sichtbarGeladenMs(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const start = performance.now();
    const ansicht = document.querySelector<HTMLElement>(".dokumentansicht")!;
    const fertig = () => {
      const r = ansicht.getBoundingClientRect();
      const seiten = [...document.querySelectorAll<HTMLElement>(".seite")].filter((s) => {
        const b = s.getBoundingClientRect();
        return b.bottom > r.top && b.top < r.bottom;
      });
      // „Fertig“ = Grundbild in der Ziel-Auflösung da und alle Kacheln geladen
      // (ein gestrecktes Bild der vorherigen Zoomstufe zählt nicht).
      return seiten.length > 0 && seiten.every((s) => {
        const inhalt = s.querySelector<HTMLElement>(".seite-inhalt")!;
        const img = s.querySelector<HTMLImageElement>(".seite-bild");
        const kacheln = Number(inhalt.dataset.kacheln ?? 0);
        return (
          img && img.complete && img.naturalWidth > 0 &&
          img.dataset.stufe === inhalt.dataset.zielStufe &&
          s.querySelectorAll(".kachel.geladen").length >= kacheln
        );
      });
    };
    while (!fertig()) {
      if (performance.now() - start > 10_000) return 99_999;
      await new Promise((r) => setTimeout(r, 16));
    }
    return performance.now() - start;
  });
}

test("Startet mit 150-seitigem Dokument ohne Fehler", async ({ page }) => {
  const fehler = await bereit(page);
  await expect(page.locator(".tab.aktiv")).toContainText("150_seiten.pdf");
  await expect(page.locator(".seitenwahl")).toContainText("/ 150");
  await expect(page.locator(".miniatur").first()).toBeVisible();
  expect(fehler).toEqual([]);
});

test("T7: 150 Seiten scrollen flüssig", async ({ page }) => {
  await bereit(page);
  // Nur sichtbare Seiten im DOM (Virtualisierung) – nicht alle 150
  expect(await page.locator(".seite").count()).toBeLessThan(15);

  // Gleichmäßig durch das Dokument scrollen und Bildzeiten messen
  const frames = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>(".dokumentansicht")!;
    const dauer: number[] = [];
    let letzte = performance.now();
    const ziel = el.scrollHeight - el.clientHeight;
    for (let i = 0; i <= 180; i++) {
      el.scrollTop = (ziel * i) / 180;
      await new Promise(requestAnimationFrame);
      const jetzt = performance.now();
      dauer.push(jetzt - letzte);
      letzte = jetzt;
    }
    return dauer;
  });
  frames.sort((a, b) => a - b);
  const p95 = frames[Math.floor(frames.length * 0.95)];
  console.log(`Frame-Dauer p95: ${p95.toFixed(1)} ms`);
  expect(p95).toBeLessThan(50); // ≥ 20 fps auch im schlechtesten Zwanzigstel

  // Am Ende angekommen: Seite 150 wird angezeigt und ist schnell scharf
  await expect(page.locator(".seitenwahl input")).toHaveValue("150");
  const ms = await sichtbarGeladenMs(page);
  console.log(`Seiten am Ende geladen nach ${ms.toFixed(0)} ms`);
  expect(ms).toBeLessThan(1500);
});

test("T7: Zoom 25 % bis 800 % ohne spürbare Verzögerung", async ({ page }) => {
  await bereit(page);
  const zoomFeld = page.getByLabel("Zoom in Prozent");
  for (const prozent of [25, 50, 100, 200, 400, 800]) {
    await zoomFeld.fill(`${prozent}`);
    await zoomFeld.press("Enter");
    await expect(zoomFeld).toHaveValue(`${prozent} %`);
    const ms = await sichtbarGeladenMs(page);
    console.log(`Zoom ${prozent} %: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  }
  // Bei 800 % werden scharfe Kacheln nur für den sichtbaren Bereich geladen
  await expect(page.locator(".kachel").first()).toBeVisible({ timeout: 3000 });
  expect(await page.locator(".kachel").count()).toBeLessThan(40);
});

test("Strg+Mausrad zoomt am Mauszeiger", async ({ page }) => {
  await bereit(page);
  const vorher = await page.getByLabel("Zoom in Prozent").inputValue();
  const ansicht = page.getByTestId("dokumentansicht");
  const box = (await ansicht.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect(page.getByLabel("Zoom in Prozent")).not.toHaveValue(vorher);
  expect(parseInt(await page.getByLabel("Zoom in Prozent").inputValue())).toBeGreaterThan(parseInt(vorher));
});

test("Volltextsuche findet Umlaute und springt zum Treffer", async ({ page }) => {
  await bereit(page);
  await page.keyboard.press("Control+f");
  await page.locator("#suchfeld").fill("prämie");
  await page.locator("#suchfeld").press("Enter");
  await expect(page.locator(".suche-status")).toContainText("150 Treffer");
  await page.locator(".trefferliste button").nth(41).click();
  await expect(page.locator(".seitenwahl input")).toHaveValue("42");
  await expect(page.locator(".treffer.aktiv")).toBeVisible();
});

test("Befehlssuche Strg+K und Ansichtsmodi", async ({ page }) => {
  await bereit(page);
  await page.getByTestId("dokumentansicht").click();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("doppelseite fort");
  await page.keyboard.press("Enter");
  await expect(page.locator('.modi [aria-checked="true"]')).toHaveAttribute("title", "Doppelseite fortlaufend");
  // zwei Seiten nebeneinander
  const tops = await page.locator(".seite").evaluateAll((s) => s.slice(0, 2).map((e) => (e as HTMLElement).style.top));
  expect(tops[0]).toBe(tops[1]);
});

test("Seitenzahl eingeben und Ansicht drehen", async ({ page }) => {
  await bereit(page);
  const feld = page.getByLabel("Seitenzahl");
  await feld.fill("120");
  await feld.press("Enter");
  await expect(page.locator('.seite-inhalt[data-seite="119"]')).toBeVisible();
  await page.getByTestId("dokumentansicht").click();
  await page.locator(".mb-reiter").getByRole("tab", { name: "Ansicht" }).click();
  await page.locator('[data-befehl="ansicht.rechts_drehen"]').click();
  const seite = page.locator(".seite").first();
  const b = (await seite.boundingBox())!;
  expect(b.width).toBeGreaterThan(b.height); // Hochformat jetzt quer
});

test("Lasso-Zoom vergrößert den aufgezogenen Bereich", async ({ page }) => {
  await bereit(page);
  await page.keyboard.press("Control+0"); // ganze Seite
  await expect(page.locator('[data-befehl="zoom.ganzeseite"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Zoom in Prozent")).not.toHaveValue("144 %");
  const vorher = parseInt(await page.getByLabel("Zoom in Prozent").inputValue());
  await page.locator('[data-befehl="werkzeug.lassozoom"]').click();
  await expect(page.locator(".eigenschaftsleiste")).toBeVisible();
  const box = (await page.getByTestId("dokumentansicht").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 220, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => parseInt(await page.getByLabel("Zoom in Prozent").inputValue()))
    .toBeGreaterThan(vorher * 3);
  await expect(page.locator(".eigenschaftsleiste")).toHaveClass(/leer/); // nicht fixiert → zurück zur Hand
});

test("Lupe zeigt vergrößerten Ausschnitt", async ({ page }) => {
  await bereit(page);
  await page.locator('[data-befehl="werkzeug.lupe"]').click();
  const box = (await page.locator(".seite").first().boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.move(box.x + 210, box.y + 205);
  await expect(page.locator(".lupe img")).toBeVisible({ timeout: 3000 });
});

test("Gemischte Seitengrößen: Seitenbreite bleibt stabil beim Scrollen", async ({ page }) => {
  const fehler: string[] = [];
  page.on("pageerror", (e) => fehler.push(e.message));
  await start(page);
  const auswahl = page.waitForEvent("filechooser");
  await page.locator('[data-befehl="schnell.datei.oeffnen"]').click();
  await (await auswahl).setFiles(join(DATEN, "gemischt.pdf"));
  await expect(page.locator(".tab.aktiv")).toContainText("gemischt.pdf");
  await page.locator('.miniatur[data-seite="1"]').click();
  const box = (await page.locator(".dokumentansicht").boundingBox())!;
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, i < 6 ? 400 : -400);
    await page.waitForTimeout(80);
  }
  await expect(page.locator('.seite-inhalt[data-seite="1"]')).toBeVisible();
  expect(fehler).toEqual([]);
});
