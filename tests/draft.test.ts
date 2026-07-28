import { describe, expect, it } from "vitest";
import { generateShareText } from "../src/domain/draft.js";
import { parseDay } from "../src/domain/parser.js";
import { settings } from "./helpers.js";

describe("generateShareText", () => {
  it("formats the daily report and takes Было/Всего from the database snapshot", () => {
    const day = parseDay(`21/07
Tiquetonne 9:00-12:00 самостоятельная уборка
сушка 3.60 + 5.09`, new Date("2026-07-28T00:00:00Z"));
    const text = generateShareText(day, settings, {
      previous: { minutes: 330, earnedCents: 5500, receivedCents: 10000, outstandingCents: -4500, expensesCents: 390, checkinCents: 0 },
      total: { minutes: 510, earnedCents: 8500, receivedCents: 10000, outstandingCents: -1500, expensesCents: 1259, checkinCents: 0 },
    });
    expect(text).toBe(`21/07
Tiquetonne 3h + 3.60€ сушка + 5.09€ расходы

Сегодня: 3 h + 8.69€ расходы

Было: 5.5 h + 3.90€ расходы

Всего: 8.5 h + 12.59€ расходы

Оплата наличными:
Аванс: 100€`);
  });

  it("leaves cash payment blank when the database has no receipt on this day", () => {
    const day = parseDay("19/07\nEiffel 9-12 уборка\nсушка 3.9\nOpera 13-15:30 уборка", new Date("2026-07-28T00:00:00Z"));
    const text = generateShareText(day, settings, {
      previous: { minutes: 0, earnedCents: 0, receivedCents: 10000, outstandingCents: -10000, expensesCents: 0, checkinCents: 0 },
      total: { minutes: 330, earnedCents: 5500, receivedCents: 10000, outstandingCents: -4500, expensesCents: 390, checkinCents: 0 },
    });
    expect(text).toContain("Eiffel 3h + 3.90€ сушка + 0");
    expect(text).toContain("Opera 2.5h + 0 + 0");
    expect(text).toContain("Сегодня: 5.5 h + 3.90€ расходы");
    expect(text).toContain("Было: 0 h + 0€");
    expect(text).toContain("Оплата наличными:\nАванс: 100€");
  });

  it("shows only the receipt recorded in the database for this day", () => {
    const day = parseDay("21/07\nTiquetonne 9-12 уборка", new Date("2026-07-28T00:00:00Z"));
    const text = generateShareText(day, settings, {
      previous: { minutes: 330, earnedCents: 5500, receivedCents: 10000, outstandingCents: -4500, expensesCents: 390, checkinCents: 0 },
      total: { minutes: 510, earnedCents: 8500, receivedCents: 13500, outstandingCents: -5000, expensesCents: 390, checkinCents: 0 },
    });
    expect(text).toContain("Оплата наличными: 35€\nАванс: 135€");
  });
});

