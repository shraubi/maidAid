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
  await page.getByLabel("Дата рабочего дня").fill("2026-08-08");
  await expect(page.locator("#today-date-label")).toHaveText("8 августа");
  await page.getByRole("button", { name: "+ Квартира", exact: true }).click();
  await page.getByPlaceholder("Например, Bosquet или Lauriston").fill("Bos");
  await page.locator("[data-choose-apartment]", { hasText: "Bosquet" }).first().click();
  await page.locator("[data-work-type]").selectOption("orientation");
  await expect(page.getByLabel("Сушка, €")).toHaveCount(0);
  await expect(page.getByLabel("Другие расходы, €")).toHaveCount(0);
  await page.locator("[data-work-type]").selectOption("independent");
  await page.getByRole("button", { name: "Сформировать отчёт", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Можно отправлять" })).toBeVisible();
  await expect(page.locator("#parsed-summary")).toContainText("08/08");
  await page.getByRole("link", { name: "Карта", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Карта", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Сегодня", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Можно отправлять" })).toBeVisible();
});

test("an apartment can choose an already saved laundry", async ({ page, request }, testInfo) => {
  test.skip(productRelease < 2, "available from release two");
  const address = `19 rue de la Buanderie, Paris · ${testInfo.project.name}`;
  await request.post("/api/places", { data: { kind: "laundry", name: "", address } });
  await page.goto("/map/apartments/1?view=list");
  await page.getByRole("button", { name: /(?:Выбрать|Сменить) сушку/ }).click();
  const card = page.locator(".laundry-card", { hasText: address });
  await card.getByRole("button", { name: "Связать с квартирой" }).click();
  await expect(page.getByText("Выбранная сушка")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Выбранная сушка ${address}`) })).toBeVisible();
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

test("release two offers every place type and manual laundry linking", async ({ page, request }, testInfo) => {
  test.skip(productRelease !== 2, "release-two assertion");
  await page.goto("/map?view=list");

  await page.getByRole("button", { name: "Добавить место" }).click();
  await page.locator("#place-kind").selectOption("laundry");
  await expect(page.getByLabel("Связать с квартирой")).toBeVisible();
  await page.getByLabel("Связать с квартирой").selectOption({ index: 1 });
  const laundryName = `Сушка ${testInfo.project.name}`;
  await page.getByLabel("Название", { exact: true }).fill(laundryName);
  await page.getByLabel("Ссылка Maps").fill("https://www.google.com/maps?q=48.857,2.353");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#place-list strong", { hasText: laundryName })).toBeVisible();

  await page.getByRole("button", { name: "Добавить место" }).click();
  await page.locator("#place-kind").selectOption("partner_restaurant");
  const partnerName = `Партнёр ${testInfo.project.name}`;
  await page.getByLabel("Название", { exact: true }).fill(partnerName);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#place-list strong", { hasText: partnerName })).toBeVisible();

  expect((await request.get("/api/apartments/1/nearby-laundries")).status()).toBe(404);
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

