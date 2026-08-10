import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLedgerStore } from "../src/storage/ledger-store.js";
import { parseDay } from "../src/domain/parser.js";
import { calculateDay } from "../src/domain/calculations.js";
import { settings } from "./helpers.js";
import { createPinDigest, prepareInitialCleaner } from "../src/auth.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL ledger integration", () => {
  const store = new PostgresLedgerStore(databaseUrl!);
  beforeAll(async () => { await store.initialize(await prepareInitialCleaner("Integration Cleaner", "123456")); });
  afterAll(async () => { await store.close(); });

  it("runs migrations and replaces a day and its parsed advance transactionally", async () => {
    const dateIso = "2099-12-31";
    const first = parseDay("31/12/2099\nBosquet 9-12 уборка\nАванс 50");
    await store.saveDay({ dateIso, sourceText: "first", reportText: "first report", parsedDetails: first, totals: calculateDay(first, settings), advanceCents: first.advanceCents });
    await store.createPayment(dateIso, 1000, "manual survives");
    const second = parseDay("31/12/2099\nBosquet 9-13 уборка\nАванс 20");
    await store.saveDay({ dateIso, sourceText: "second", reportText: "second report", parsedDetails: second, totals: calculateDay(second, settings), advanceCents: second.advanceCents });
    const ledger = await store.getLedger(dateIso, dateIso);
    expect(ledger.totals).toMatchObject({ minutes: 240, earnedCents: 4000, receivedCents: 3000, expensesCents: 0 });
    expect(ledger.rows.find((row) => row.rowType === "work")?.dateIso).toBe(dateIso);
    expect(await store.deleteDay(dateIso)).toBe(true);
    const afterDelete = await store.getLedger(dateIso, dateIso);
    expect(afterDelete.rows.filter((row) => row.rowType === "work")).toEqual([]);
    expect(afterDelete.totals).toMatchObject({ earnedCents: 0, receivedCents: 1000 });
  });

  it("allows two cleaners to use the same date without sharing ledger rows", async () => {
    const digest = await createPinDigest("654321");
    const second = await store.createCleaner({ name: "Integration Colleague", nameKey: "integration colleague", ...digest });
    const dateIso = "2099-12-29";
    const firstDay = parseDay("29/12/2099\nBosquet 9-12 уборка");
    const secondDay = parseDay("29/12/2099\nBosquet 9-11 уборка");
    await store.saveDay({ dateIso, sourceText: "first", reportText: "first", parsedDetails: firstDay, totals: calculateDay(firstDay, settings), advanceCents: 0 }, 1);
    await store.saveDay({ dateIso, sourceText: "second", reportText: "second", parsedDetails: secondDay, totals: calculateDay(secondDay, settings), advanceCents: 0 }, second.id);
    expect((await store.getLedger(dateIso, dateIso, 1)).totals.minutes).toBe(180);
    expect((await store.getLedger(dateIso, dateIso, second.id)).totals.minutes).toBe(120);
    await store.deleteDay(dateIso, 1); await store.deleteDay(dateIso, second.id);
  });

  it("looks up an active laundry by its Maps URL", async () => {
    const mapsUrl = `https://www.google.com/maps?q=48.857,2.353&test=${Date.now()}`;
    const place = await store.createSavedPlace({ kind: "laundry", name: "Integration dryer", address: null, note: null, mapsUrl, latitude: 48.857, longitude: 2.353, locationSource: "maps_link", locationAccuracyMeters: null });
    expect(await store.findSavedPlaceByMapsUrl(mapsUrl)).toMatchObject({ id: place.id, kind: "laundry", mapsUrl });
    await store.archiveSavedPlace(place.id);
    expect(await store.findSavedPlaceByMapsUrl(mapsUrl)).toBeNull();
  });
});
