import { describe, expect, it } from "vitest";
import { calculateDay } from "../src/domain/calculations.js";
import { parseDay } from "../src/domain/parser.js";
import type { Settings } from "../src/domain/types.js";

const settings: Settings = {
  hourlyRateCents: 1000,
  dryerDefaultCents: 390,
};

describe("calculateDay", () => {
  it("calculates minutes, earnings and expenses without an LLM", () => {
    const parsed = parseDay(
      `19/07 изменения
Eiffel 11-14 самостоятельно
Lauriston 31 14:30-15 ознакомление (Вероника)
Opera 15:30-18 ознакомление (Ана)
Сушка Eiffel 3,90`,
      new Date("2026-07-23T00:00:00Z"),
    );
    expect(calculateDay(parsed, settings)).toEqual({
      minutes: 360,
      incomeCents: 6000,
      expensesCents: 390,
    });
  });
});
