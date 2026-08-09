import { expect, test } from "playwright/test";

const productRelease = Number(process.env.PRODUCT_RELEASE ?? 3);

test("release one hides future place-management controls", async ({ page, request }) => {
  test.skip(productRelease !== 1, "release-one assertion");
  await page.goto("/map?view=list");
  await expect(page.locator("#add-place-button")).toBeHidden();
  await expect(page.locator("#place-filter")).toBeHidden();
  expect((await request.get("/api/places")).status()).toBe(404);
  expect((await request.get("/api/app-config")).status()).toBe(200);
  await page.getByRole("button", { name: "Указать место" }).first().click();
  await page.getByLabel("Ссылка Maps").fill("https://www.google.com/maps?q=48.8566,2.3522");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Координаты сохранены").first()).toBeVisible();
});

test("Today keeps its preview while navigating between sections", async ({ page }) => {
  await page.goto("/today");
  await page.getByLabel("Вставьте сообщение целиком", { exact: true }).fill("05/08\nКвартира А 9-12 уборка");
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Всё ли верно?" })).toBeVisible();
  await page.getByRole("link", { name: "Карта", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Карта", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Сегодня", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Всё ли верно?" })).toBeVisible();
});

test("Map and list are equal views and a place can be added", async ({ page }, testInfo) => {
  test.skip(productRelease < 2, "available from release two");
  await page.goto("/map?view=map");
  await expect(page.getByRole("button", { name: "Карта", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.getByRole("button", { name: "Список", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Добавить место" }).click();
  const name = `E2E квартира ${testInfo.project.name}`;
  await page.getByLabel("Название", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#place-list strong", { hasText: name })).toBeVisible();
});

test("Saved work appears in the dedicated ledger", async ({ page, request }) => {
  await request.post("/api/days", { data: { text: "05/08\nКвартира А 9-12 уборка" } });
  await page.goto("/ledger");
  await expect(page.getByRole("heading", { name: "Учёт", exact: true })).toBeVisible();
  await expect(page.getByText("3 ч работы", { exact: true })).toBeVisible();
});

test("mobile layout has no horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await page.goto("/map?view=list");
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBe(dimensions.client);
  await expect(page.locator(".mobile-nav")).toBeVisible();
});
