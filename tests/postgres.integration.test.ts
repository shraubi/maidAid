import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLedgerStore } from "../src/storage/ledger-store.js";
import { parseDay } from "../src/domain/parser.js";
import { calculateDay } from "../src/domain/calculations.js";
import { settings } from "./helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL ledger integration", () => {
  const store = new PostgresLedgerStore(databaseUrl!);
  beforeAll(async () => { await store.initialize(); });
  afterAll(async () => { await store.close(); });

  it("runs migrations and replaces a day and its parsed advance transactionally", async () => {
    const dateIso = "2099-12-31";
    const first = parseDay("31/12/2099\nBosquet 9-12 уборка\nАванс 50");
    await store.saveDay({ dateIso, sourceText: "first", parsedDetails: first, totals: calculateDay(first, settings), advanceCents: first.advanceCents });
    await store.createPayment(dateIso, 1000, "manual survives");
    const second = parseDay("31/12/2099\nBosquet 9-13 уборка\nАванс 20");
    await store.saveDay({ dateIso, sourceText: "second", parsedDetails: second, totals: calculateDay(second, settings), advanceCents: second.advanceCents });
    const ledger = await store.getLedger(dateIso, dateIso);
    expect(ledger.totals).toMatchObject({ minutes: 240, earnedCents: 4000, receivedCents: 3000, expensesCents: 0 });
    expect(ledger.rows.find((row) => row.rowType === "work")?.dateIso).toBe(dateIso);
    expect(await store.deleteDay(dateIso)).toBe(true);
    const afterDelete = await store.getLedger(dateIso, dateIso);
    expect(afterDelete.rows.filter((row) => row.rowType === "work")).toEqual([]);
    expect(afterDelete.totals).toMatchObject({ earnedCents: 0, receivedCents: 1000 });
  });
});

