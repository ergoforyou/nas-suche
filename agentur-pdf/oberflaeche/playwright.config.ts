import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// In der Cloud-Umgebung liegt Chromium unter /opt/pw-browsers.
const headlessShell = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8766",
    viewport: { width: 1400, height: 900 },
    launchOptions: existsSync(headlessShell) ? { executablePath: headlessShell } : {},
  },
  webServer: {
    command: "python3 e2e/start_dienst.py",
    url: "http://127.0.0.1:8766/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
