import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** Directory that receives the README screenshots. */
const DOCS_DIR = new URL("../docs/", import.meta.url);

test.skip(process.env.SCREENSHOTS !== "1", "set SCREENSHOTS=1 to regenerate the README screenshots");
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 900 } });

test("writes the README screenshots", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("pattern").fill("a(b|c)*d");
  await page.getByTestId("input").fill("xabcbd");
  for (let i = 0; i < 4; i++) await page.getByTestId("step").click();
  await expect(page.getByTestId("match-result")).toHaveText('Match [1, 6) "abcbd"');
  await page.screenshot({ path: fileURLToPath(new URL("playground.png", DOCS_DIR)), fullPage: true });

  await page.getByRole("button", { name: "ReDoS (a+)+b" }).click();
  await expect(page.getByTestId("native-result")).toHaveText(/timed out/, { timeout: 10_000 });
  await page.screenshot({ path: fileURLToPath(new URL("redos.png", DOCS_DIR)), fullPage: true });
});
