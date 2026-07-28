import { describe, expect, it } from "vitest";
import { MemoryLedgerStore, normalizeDateIso } from "../src/storage/ledger-store.js";
import { parseDay } from "../src/domain/parser.js";
import { calculateDay } from "../src/domain/calculations.js";
import { settings } from "./helpers.js";

const parsed = (text: string) => parseDay(text, new Date("2026-07-28T00:00:00Z"));

describe("ledger semantics", () => {
  it("normalizes PostgreSQL date values for API and delete URLs", () => {
    expect(normalizeDateIso(new Date("2026-07-29T00:00:00.000Z"))).toBe("2026-07-29");
    expect(normalizeDateIso("Wed Jul 29 2026 00:00:00 GMT+0000 (Coordinated Universal Time)")).toBe("2026-07-29");
  });
  it("replaces same-date work and its text advance without duplicating either", async () => {
    const store = new MemoryLedgerStore();
    const first = parsed("26/07\nBosquet 9-12 уборка\nАванс 50");
    await store.saveDay({ dateIso: first.dateIso!, sourceText: "first", parsedDetails: first, totals: calculateDay(first, settings), advanceCents: first.advanceCents });
    const replacement = parsed("26/07\nBosquet 9-13 уборка\nАванс 20");
    await store.saveDay({ dateIso: replacement.dateIso!, sourceText: "replacement", parsedDetails: replacement, totals: calculateDay(replacement, settings), advanceCents: replacement.advanceCents });
    expect((await store.getLedger()).totals).toMatchObject({ minutes: 240, earnedCents: 4000, receivedCents: 2000 });
  });

  it("keeps manual payments when a work day is replaced and supports correction", async () => {
    const store = new MemoryLedgerStore();
    const payment = await store.createPayment("2026-07-20", 10000, "cash");
    const day = parsed("26/07\nBosquet 9-12 уборка\nАванс 50");
    await store.saveDay({ dateIso: day.dateIso!, sourceText: "one", parsedDetails: day, totals: calculateDay(day, settings), advanceCents: day.advanceCents });
    await store.saveDay({ dateIso: day.dateIso!, sourceText: "two", parsedDetails: day, totals: calculateDay(day, settings), advanceCents: 0 });
    expect((await store.getLedger()).totals.receivedCents).toBe(10000);
    expect((await store.updatePayment(payment.id, { amountCents: 9000 }))?.amountCents).toBe(9000);
    expect(await store.deletePayment(payment.id)).toBe(true);
  });

  it("returns the newest ledger rows first", async () => {
    const store = new MemoryLedgerStore();
    await store.createPayment("2026-07-01", 5000);
    await store.createPayment("2026-07-28", 2000);
    expect((await store.getLedger()).rows.map((row) => row.dateIso)).toEqual(["2026-07-28", "2026-07-01"]);
  });

  it("supports backdated filters and negative outstanding balances", async () => {
    const store = new MemoryLedgerStore();
    await store.createPayment("2026-07-01", 5000);
    await store.createPayment("2026-07-20", 2000);
    expect((await store.getLedger("2026-07-10", "2026-07-31")).totals).toMatchObject({ receivedCents: 2000, outstandingCents: -2000 });
  });
});

