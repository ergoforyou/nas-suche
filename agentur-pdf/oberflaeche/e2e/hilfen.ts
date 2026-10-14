import { expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DATEN = join(tmpdir(), "agentur-pdf-e2e");
const H = { "X-Agentur-Token": "e2e" };

/** Jeder Test beginnt sauber: alle Dokumente schließen, Sitzung leeren und
 * nur die 150-seitige Test-PDF öffnen. */
export async function zuruecksetzen(page: Page) {
  const offen = (await (await page.request.get("/api/dokumente", { headers: H })).json()) as { id: string }[];
  for (const d of offen) await page.request.delete(`/api/dokumente/${d.id}`, { headers: H });
  await page.request.put("/api/sitzung", { headers: H, data: { dokumente: [], aktiv: null } });
  await page.request.post("/api/dokumente/oeffnen", { headers: H, data: { pfad: join(DATEN, "150_seiten.pdf") } });
}

export async function start(page: Page) {
  await zuruecksetzen(page);
  await page.goto("/#t=e2e");
  await expect(page.locator(".seite-bild").first()).toBeVisible({ timeout: 10_000 });
}
