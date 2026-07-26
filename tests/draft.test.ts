import { describe, expect, it } from "vitest";
import { generateShareText } from "../src/domain/draft.js";
import { parseDay } from "../src/domain/parser.js";

describe("generateShareText", () => {
  it("generates a daily report without accumulated balance", () => {
    const day = parseDay(
      "19/07 изменения\nEiffel 11-14 самостоятельно\nСушка Eiffel 3,90",
      new Date("2026-07-23T00:00:00Z"),
    );
    const text = generateShareText(day, {
      hourlyRateCents: 1000,
      orientationFlatCents: 1000,
      practiceFlatCents: 1500,
      dryerDefaultCents: 390,
    });

    expect(text.startsWith("19/07\n")).toBe(true);
    expect(text).not.toContain("19/07 изменения");
    expect(text).toContain("Сегодня: 3h + 30,00€ заработок + 3,90€ расходы");
    expect(text).not.toContain("Было:");
    expect(text).not.toContain("Всего:");
  });

  it("omits zero expenses and empty payment sections", () => {
    const day = parseDay(
      `19/07
St Denis 09:00-10:00 ознакомление
23 Stuart 10:00-12:30 практика
Ferronnerie 13:00-15:30 практика
Tiquetonne 16:00-16:30 ознакомление
Dominique 17:00-18:00 ознакомление`,
      new Date("2026-07-23T00:00:00Z"),
    );
    const text = generateShareText(day, {
      hourlyRateCents: 1000,
      orientationFlatCents: 1000,
      practiceFlatCents: 1500,
      dryerDefaultCents: 390,
    });

    expect(text).not.toContain("Ferronnerie 13:00-15:30 Практика");
    expect(text.endsWith(
      `St Denis 1h + 10,00€
23 Stuart 2.5h + 15,00€
Ferronnerie 2.5h + 15,00€
Tiquetonne 0.5h + 10,00€
Dominique 1h + 10,00€

Сегодня: 7.5h + 60,00€ заработок`,
    )).toBe(true);
    expect(text).not.toMatch(/(?:^|\+ )0(?:,00)?€/m);
    expect(text).not.toContain("Оплата наличными:");
    expect(text).not.toContain("Аванс:");
  });
});
