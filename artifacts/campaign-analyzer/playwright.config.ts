import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Replit's Chromium is already installed. Elsewhere use Playwright's browser,
// or explicitly supply a system browser with PLAYWRIGHT_CHROMIUM_EXECUTABLE.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "../../generated-artifacts/campaign-browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    // Exercise the registered Streamlit service through the shared proxy.
    // The managed web workflow must be running before starting this suite.
    baseURL: process.env.CAMPAIGN_BASE_URL ?? "http://localhost:80/",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    launchOptions: { executablePath, args: ["--no-sandbox"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
