import { describe, expect, it } from "vitest";
import { parseDay } from "../src/domain/parser.js";

const now = new Date("2026-07-28T00:00:00Z");

describe("parseDay", () => {
  it("parses every amount on an expense line and attaches it to the preceding job", () => {
    const parsed = parseDay(`26/07

Bosquet 9:00-12:00 - самостоятельная уборка / ключ от Вероники у вас
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

  it("treats a standalone random amount as an expense", () => {
    const parsed = parseDay("26/07\nBosquet 9-12 уборка\n7.25", now);
    expect(parsed.expenses).toEqual([expect.objectContaining({ object: "Bosquet", category: "расходы", amountCents: 725 })]);
    expect(parsed.unparsedLines).toEqual([]);
  });

  it("canonicalizes apartment aliases and one-character typos through the generated dictionary", () => {
    const parsed = parseDay("26/07\nDominiquet 9-12 уборка\n13:00-14:00 St Denis уборка", now);
    expect(parsed.jobs.map((job) => job.object)).toEqual(["Dominique", "Saint Denis"]);
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
});
