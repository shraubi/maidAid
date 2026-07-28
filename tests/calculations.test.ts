import { describe, expect, it } from "vitest";
import { calculateDay } from "../src/domain/calculations.js";
import { parseDay } from "../src/domain/parser.js";
import { settings } from "./helpers.js";

describe("calculateDay", () => {
  it("counts only independent cleaning in worked hours", () => {
    const parsed = parseDay("26/07\nBosquet 9-12 уборка\nDominique 12-13 ознакомление\nOpera 13-14 практика\n16:00 check in Dominique", new Date("2026-07-28T00:00:00Z"));
    expect(calculateDay(parsed, settings)).toEqual({ minutes: 180, incomeCents: 6500, checkinCents: 1000, expensesCents: 0 });
  });
});

