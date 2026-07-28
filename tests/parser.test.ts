import { describe, expect, it } from "vitest";
import { parseDay as parseRaw } from "../src/domain/parser.js";
import { apartmentLookup, publicApartmentRecords } from "../src/domain/apartments.js";
import { calculateDay } from "../src/domain/calculations.js";
import { settings } from "./helpers.js";

const now = new Date("2026-07-28T00:00:00Z");
const apartments = apartmentLookup(publicApartmentRecords());
const parseDay = (text: string, current = new Date(), dryerDefaultCents = 390) => parseRaw(text, current, dryerDefaultCents, apartments);

describe("parseDay", () => {
  it("parses every amount on an expense line and attaches it to the preceding job", () => {
    const parsed = parseDay(`26/07

Bosquet 9:00-12:00 - самостоятельная уборка / комментарий
сушка 4.2 + 11.67

Dominique 12:30-15:30 - самостоятельная уборка
сушка 6 + 5.13

16:00 check in Dominiquet - самостоятельное заселение / LX638 flight number`, now);

    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.jobs).toEqual([
      expect.objectContaining({ object: "Bosquet", startMinutes: 540, endMinutes: 720, workType: "independent" }),
      expect.objectContaining({ object: "Dominique", startMinutes: 750, endMinutes: 930, workType: "independent" }),
      expect.objectContaining({ object: "Dominique", startMinutes: 960, endMinutes: 990, endInferred: true, workType: "checkin" }),
    ]);
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ object: "Bosquet", category: "сушка", amountCents: 420 }),
      expect.objectContaining({ object: "Bosquet", category: "расходы", amountCents: 1167 }),
      expect.objectContaining({ object: "Dominique", category: "сушка", amountCents: 600 }),
      expect.objectContaining({ object: "Dominique", category: "расходы", amountCents: 513 }),
    ]);
  });

  it("parses inline amounts written before their expense categories", () => {
    const parsed = parseDay("26/07\nSt Denis 11:30-15:30 самостоятельная уборка 3.6€ сушка + 12.5€ расходы", now);
    expect(parsed.issues).toEqual([]);
    expect(parsed.jobs[0]).toMatchObject({ object: "Saint Denis", startMinutes: 690, endMinutes: 930 });
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ object: "Saint Denis", category: "сушка", amountCents: 360 }),
      expect.objectContaining({ object: "Saint Denis", category: "расходы", amountCents: 1250 }),
    ]);
  });

  it("treats the unlabeled second amount after expenses as dryer cost", () => {
    const parsed = parseDay("26/07\nSt Denis 11:30-15:30 самостоятельная уборка расходы 12.5€ +3.6€", now);
    expect(parsed.issues).toEqual([]);
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ object: "Saint Denis", category: "расходы", amountCents: 1250 }),
      expect.objectContaining({ object: "Saint Denis", category: "сушка", amountCents: 360 }),
    ]);
  });

  it("treats a standalone random amount as an expense", () => {
    const parsed = parseDay("26/07\nBosquet 9-12 уборка\n7.25", now);
    expect(parsed.expenses).toEqual([expect.objectContaining({ object: "Bosquet", category: "расходы", amountCents: 725 })]);
    expect(parsed.unparsedLines).toEqual([]);
  });

  it("canonicalizes exact apartment aliases through the database-shaped lookup", () => {
    const parsed = parseDay("26/07\nDominiquet 9-12 уборка\n13:00-14:00 St Denis уборка", now);
    expect(parsed.jobs.map((job) => job.object)).toEqual(["Dominique", "Saint Denis"]);
    const unknown = parseDay("26/07\nBosqet 9-12 уборка", now);
    expect(unknown.jobs[0]).toMatchObject({ object: "Bosqet", apartmentId: null });
  });

  it("sums supported advance formats", () => {
    const parsed = parseDay("26/07\nBosquet 9-12 уборка\nАванс 50\nАванс: 25,50€", now);
    expect(parsed.advanceCents).toBe(7550);
    expect(parsed.issues).toEqual([]);
  });

  it("rejects negative advances", () => {
    const parsed = parseDay("26/07\nBosquet 9-12 уборка\nАванс: -25€", now);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: "invalid_payment" }));
  });

  it("still requires an end for hourly cleaning", () => {
    const parsed = parseDay("26/07\nBosquet 9:00 самостоятельная уборка", now);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: "missing_end" }));
  });

  it("uses a duration after a start time to calculate the end", () => {
    const parsed = parseDay("26/07\n15:30 Opera 2.5h уборка самостоятельно", now);
    expect(parsed.issues).toEqual([]);
    expect(parsed.jobs[0]).toMatchObject({
      object: "Opera",
      startMinutes: 930,
      endMinutes: 1080,
      durationMinutes: 150,
      workType: "independent",
    });
  });

  it("keeps list, alias, companion and wrapped-interval behavior", () => {
    const parsed = parseDay(`19/07
1. *EIFFE* - ознакомление 11 (11:00)
2. 12:00-15:30 Federation самостоятельная работа
3. Ferronnerie Практика (13:10
16:00–16:30`, now);
    expect(parsed.jobs.map((job) => job.object)).toEqual(["Eiffel", "Federation", "Ferronnerie"]);
    expect(parsed.jobs[0]).toMatchObject({ endMinutes: 720, endInferred: true, workType: "orientation" });
    expect(parsed.jobs[2]).toMatchObject({ startMinutes: 960, endMinutes: 990, workType: "practice" });
    expect(parsed.issues).toEqual([]);
  });

  it("accepts duration-only report lines with trailing expenses", () => {
    const parsed = parseDay(`**19/07**
Eiffel 3h + 3.9 сушка + 0€
Opéra 2.5h + 0 + 0
Tiquetonne 3h + 3.60€ сушка + 5.09€ расходы`, now);
    expect(parsed.issues).toEqual([]);
    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.jobs).toEqual([
      expect.objectContaining({ object: "Eiffel", durationMinutes: 180, workType: "independent" }),
      expect.objectContaining({ object: "Opera", durationMinutes: 150, workType: "independent" }),
      expect.objectContaining({ object: "Tiquetonne", durationMinutes: 180, workType: "independent" }),
    ]);
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ object: "Eiffel", category: "сушка", amountCents: 390 }),
      expect.objectContaining({ object: "Tiquetonne", category: "сушка", amountCents: 360 }),
      expect.objectContaining({ object: "Tiquetonne", category: "расходы", amountCents: 509 }),
    ]);
    expect(calculateDay(parsed, settings)).toMatchObject({ minutes: 510, incomeCents: 8500, expensesCents: 1259 });
  });
});

