import { defineConfig } from "@playwright/test";

/** Address of the playground dev server; the e2e tests and `webServer` share it. */
const PLAYGROUND_URL = "http://127.0.0.1:5173";

/**
 * A Chromium binary supplied by the environment (for example a pre-installed browser in a sandbox). When unset,
 * Playwright uses the browser it downloaded for its own version.
 */
const chromiumPath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 2,
  use: {
    baseURL: PLAYGROUND_URL,
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: {
    command: "npm run dev -w playground",
    url: PLAYGROUND_URL,
    reuseExistingServer: true,
  },
});
