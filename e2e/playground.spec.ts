import { expect, type Locator, type Page, test } from "@playwright/test";

/** Upper bound, in milliseconds, for the native comparison to report: the worker timeout plus start-up. */
const NATIVE_TIMEOUT = 10_000;

/** Clicks the Step button `count` times. */
async function stepTimes(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await page.getByTestId("step").click();
}

/** Types a pattern and an input string into the playground. */
async function load(page: Page, pattern: string, input: string): Promise<void> {
  await page.getByTestId("pattern").fill(pattern);
  await page.getByTestId("input").fill(input);
}

/** Reads the text of a locator, failing the test when it is missing. */
async function textOf(locator: Locator): Promise<string> {
  const text = await locator.textContent();
  expect(text).not.toBeNull();
  return text ?? "";
}

test.describe("playground", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("steps through a match and agrees with the native RegExp", async ({ page }) => {
    await load(page, "a(b|c)*d", "xabcbd");
    await expect(page.getByTestId("error")).toBeHidden();

    await stepTimes(page, 3);

    const threads = page.getByTestId("active-thread").locator("li");
    expect(await threads.count()).toBeGreaterThan(0);

    const highlighted = page.locator('[data-testid="bytecode-row"].active');
    expect(await highlighted.count()).toBeGreaterThan(0);

    const libraryResult = page.getByTestId("match-result");
    const nativeResult = page.getByTestId("native-result");
    await expect(libraryResult).toHaveText('Match [1, 6) "abcbd"');
    await expect(nativeResult).toHaveText('Match [1, 6) "abcbd"', { timeout: NATIVE_TIMEOUT });
    expect(await textOf(libraryResult)).toBe(await textOf(nativeResult));
    await expect(page.getByText("Agrees with the native RegExp.")).toBeVisible();
  });

  test("stays responsive on a catastrophic pattern and reports the native timeout", async ({ page }) => {
    await load(page, "(a|a)+b", "a".repeat(200));
    await expect(page.getByTestId("match-result")).toHaveText("No match.");

    await expect(page.getByTestId("native-result")).toHaveText(
      "native: timed out (catastrophic backtracking under V8)",
      { timeout: NATIVE_TIMEOUT },
    );
    await expect(page.getByText("Not compared: the native RegExp did not produce a result in time.")).toBeVisible();

    await stepTimes(page, 2);
    await expect(page.getByTestId("step-pos")).toHaveText("Position 2 of 200");
  });

  test("shows a caret under the position of a syntax error", async ({ page }) => {
    await load(page, "a(", "xabcbd");

    const error = page.getByTestId("error");
    await expect(error).toBeVisible();
    await expect(error.getByRole("heading", { name: "Syntax error" })).toBeVisible();
    await expect(error.locator(".error-message")).toHaveText("unterminated group at position 1");

    const [snippet, caret] = (await textOf(error.locator("pre.caret"))).split("\n");
    expect(snippet).toBe("a(");
    expect(caret).toBe(" ^");

    await expect(page.getByTestId("match-result")).toHaveText(/syntax error/);
    await expect(page.getByTestId("step")).toBeDisabled();
  });
});
