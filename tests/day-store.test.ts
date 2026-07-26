import { describe, expect, it } from "vitest";
import { DayStore } from "../src/storage/day-store.js";

describe("DayStore", () => {
  it("replaces totals for the same date with the last entry", () => {
    const store = new DayStore(":memory:");
    store.save("2026-07-19", { minutes: 180, incomeCents: 3000, expensesCents: 390 });
    store.save("2026-07-19", { minutes: 240, incomeCents: 4000, expensesCents: 0 });

    expect(store.get("2026-07-19")).toMatchObject({
      minutes: 240,
      incomeCents: 4000,
      expensesCents: 0,
    });
    store.close();
  });
});
