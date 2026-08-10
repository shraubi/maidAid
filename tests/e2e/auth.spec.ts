import { expect, test } from "playwright/test";

test("cleaner signs in once and reaches the requested screen", async ({ page }, testInfo) => {
  const port = testInfo.project.name === "mobile" ? 4274 : 4276;
  await page.goto(`http://127.0.0.1:${port}/ledger`);
  await expect(page.locator("#auth-view")).toBeVisible();
  await page.locator("#login-name").fill("E2E Cleaner");
  await page.locator("#login-pin").fill("123456");
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#auth-view")).toBeHidden();
  await expect(page.locator("#view-ledger")).toBeVisible();
  await expect(page.locator("#cleaner-name")).toHaveText("E2E Cleaner");
  await page.reload();
  await expect(page.locator("#view-ledger")).toBeVisible();
});
