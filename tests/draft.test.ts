import { describe, expect, it } from "vitest";
import { generateShareText } from "../src/domain/draft.js";
import { parseDay } from "../src/domain/parser.js";

describe("generateShareText", () => {
  it("generates a daily stateless report without accumulated balance", () => {
    const day = parseDay(
      "19/07 изменения\nEiffel 11-14 самостоятельно\nСушка Eiffel 3,90",
      new Date("2026-07-23T00:00:00Z"),
    );
    const text = generateShareText(day, { hourlyRateCents: 1000, dryerDefaultCents: 390 });

    expect(text).toContain("19/07 изменения");
    expect(text).toContain("Сегодня: 3h + 30,00€ заработок + 3,90€ расходы");
    expect(text).not.toContain("Было:");
    expect(text).not.toContain("Всего:");
  });
});
