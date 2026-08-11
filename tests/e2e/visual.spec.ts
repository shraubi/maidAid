import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "playwright/test";

const outputDirectory = resolve("test-results", "visual-qa");

test("capture the redesigned primary screens", async ({ page }, testInfo) => {
  await mkdir(outputDirectory, { recursive: true });
  const capture = async (name: string) => {
    const path = resolve(outputDirectory, `${testInfo.project.name}-${name}.png`);
    await page.waitForTimeout(300);
    await page.screenshot({ path, fullPage: false });
    await testInfo.attach(`${testInfo.project.name}-${name}`, { path, contentType: "image/png" });
  };

  await page.goto("/today");
  await page.getByRole("button", { name: "+ Квартира", exact: true }).click();
  await page.getByPlaceholder("Например, Bosquet или Lauriston").fill("Bos");
  await page.locator("[data-choose-apartment]", { hasText: "Bosquet" }).first().click();
  await page.getByLabel("Сушка, €").fill("4");
  await page.getByLabel("Другие расходы, €").fill("15.82");
  await page.locator(".today-job-card").evaluate((card: HTMLDetailsElement) => { card.open = false; });
  await capture("today");

  await page.locator(".today-job-card > summary").click();
  await page.getByRole("button", { name: "Сформировать отчёт", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Отчёт за день" })).toBeVisible();
  await capture("report");
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.locator("body")).not.toHaveClass(/report-open/);

  await page.getByRole("link", { name: "Учёт", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Учёт", exact: true })).toBeVisible();
  await capture("ledger");

  await page.getByRole("link", { name: "Карта", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Карта", exact: true })).toBeVisible();
  await page.waitForTimeout(1_000);
  await capture("map");
});
