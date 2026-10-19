import { defineConfig } from "@playwright/test";
// Service-Worker-Anfragen der Erweiterung abfangen können (Drive-Test)
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
import { existsSync } from "node:fs";

// In der Cloud-Umgebung liegt Chromium unter /opt/pw-browsers.
// Port 47811 = fester Port des Dienstes (die Chrome-Seitenleiste erwartet ihn dort).
const headlessShell = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:47811",
    viewport: { width: 1400, height: 900 },
    // Bei Fehlschlag Aufzeichnung behalten (npx playwright show-trace …)
    trace: "retain-on-failure",
    launchOptions: existsSync(headlessShell) ? { executablePath: headlessShell } : {},
  },
  webServer: {
    command: "python3 e2e/start_dienst.py",
    url: "http://127.0.0.1:47811/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
