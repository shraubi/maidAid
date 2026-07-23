import { describe, expect, it } from "vitest";
import { MaidAid } from "../src/app/maidAid.js";
import { MemoryStorage } from "../src/storage/memory.js";

describe("MaidAid conversation", () => {
  it("asks only for a missing final end, then confirms and saves", async () => {
    const storage = new MemoryStorage();
    const app = new MaidAid(storage);
    const phone = "33600000000";

    const first = await app.handle(
      phone,
      `19/07 изменения
Eiffel 11-14 самостоятельно
Opera 15:30 ознакомление (Ана)`,
    );
    expect(first[0]?.text).toContain("Во сколько закончилась работа Opera?");

    const second = await app.handle(phone, "18:00");
    expect(second[0]?.buttons?.map((button) => button.id)).toEqual([
      "confirm",
      "correct",
      "cancel",
    ]);

    const confirmed = await app.handle(phone, "Подтвердить", "confirm");
    expect(confirmed).toHaveLength(2);
    expect(confirmed[0]?.text).toContain("День 19/07 сохранён");
    expect(confirmed[1]?.text).toContain("Всего: 5.5h + 55,00€ заработок");
  });

  it("replaces a previously confirmed day instead of doubling it", async () => {
    const storage = new MemoryStorage();
    const app = new MaidAid(storage);
    const phone = "33600000000";

    await app.handle(phone, "19/07 изменения\nEiffel 11-14 самостоятельно");
    await app.handle(phone, "Подтвердить", "confirm");
    await app.handle(phone, "исправить 19/07");
    await app.handle(phone, "19/07 изменения\nEiffel 11-15 самостоятельно");
    await app.handle(phone, "Подтвердить", "confirm");

    expect(await storage.getBalance()).toEqual({
      minutes: 240,
      incomeCents: 4000,
      expensesCents: 0,
    });
  });

  it("does not offer confirmation while a line is unparsed", async () => {
    const storage = new MemoryStorage();
    const app = new MaidAid(storage);
    const response = await app.handle(
      "33600000000",
      "19/07\nEiffel 11-14 самостоятельно\nпотом может ещё куда-нибудь",
    );
    expect(response[0]?.text).toContain("Не распознано");
    expect(response[0]?.buttons?.some((button) => button.id === "confirm")).toBe(false);
  });
});
