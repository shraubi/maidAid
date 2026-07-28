import { describe, expect, it } from "vitest";
import { generateShareText } from "../src/domain/draft.js";
import { parseDay } from "../src/domain/parser.js";
import { settings } from "./helpers.js";

describe("generateShareText", () => {
  it("matches the requested compact cumulative report", () => {
    const day = parseDay(`26/07
Bosquet 9:00-12:00 - самостоятельная уборка / ключ от Вероники у вас
сушка 4.2 + 11.67
Dominique 12:30-15:30 - самостоятельная уборка
сушка 6 + 5.13
16:00 check in Dominiquet - самостоятельное заселение / LX638 flight number`, new Date("2026-07-28T00:00:00Z"));
    const text = generateShareText(day, settings, {
      previous: { minutes: 930, earnedCents: 17500, receivedCents: 20000, outstandingCents: -2500, expensesCents: 4905, checkinCents: 1000 },
      total: { minutes: 1290, earnedCents: 24500, receivedCents: 20000, outstandingCents: 4500, expensesCents: 7605, checkinCents: 2000 },
    });
    expect(text).toContain("Bosquet\n3h + 4.20€ сушка + 11.67€ расходы");
    expect(text).toContain("Dominique\n3h + 6€ сушка + 5.13€ расходы\n\nCheck in 10€");
    expect(text).toContain("Было : 15.5 h + 49.05€ расходы + 10€ check in");
    expect(text).toContain("Всего : 21.5 h + 76.05€ расходы + 20€ check in");
    expect(text).toContain("Оплата наличными: 245€\nАванс: 200€");
  });

  it("adds the current advance and outstanding balance only when present", () => {
    const day = parseDay("26/07\nBosquet 9-12 уборка\nАванс: 50€", new Date("2026-07-28T00:00:00Z"));
    const text = generateShareText(day, settings, {
      previous: { minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0, expensesCents: 0, checkinCents: 0 },
      total: { minutes: 180, earnedCents: 3000, receivedCents: 5000, outstandingCents: -2000, expensesCents: 0, checkinCents: 0 },
    });
    expect(text).toContain("Аванс сегодня: 50€");
    expect(text).toContain("Остаток: -20€");
  });
});
