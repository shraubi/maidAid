import { describe, expect, it } from "vitest";
import { parseDay } from "../src/domain/parser.js";

describe("parseDay", () => {
  it("parses the provided schedule and infers an omitted end", () => {
    const parsed = parseDay(
      `19/07

*EIFFE* - ознакомление 11 (11:00)
*Federation* - самостоятельная работа (12:00-15:30)
*Lauriston 31* - ознакомление (16:00-16:30)`,
      new Date("2026-07-23T00:00:00Z"),
    );

    expect(parsed.dateIso).toBe("2026-07-19");
    expect(parsed.kind).toBe("schedule");
    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.jobs).toHaveLength(3);
    expect(parsed.jobs[0]).toMatchObject({
      object: "Eiffel",
      startMinutes: 660,
      endMinutes: 720,
      endInferred: true,
      workType: "orientation",
    });
    expect(parsed.jobs[1]).toMatchObject({
      object: "Federation",
      startMinutes: 720,
      endMinutes: 930,
      workType: "independent",
    });
    expect(parsed.jobs[2]).toMatchObject({
      object: "Lauriston 31",
      startMinutes: 960,
      endMinutes: 990,
      workType: "orientation",
    });
    expect(parsed.issues).toEqual([]);
  });

  it("parses actual work with names before and after intervals and a dryer expense", () => {
    const parsed = parseDay(
      `19/07 изменения

Eiffel 11:00-14:00 самостоятельно
14:30-15:00 Lauriston 31 ознакомление (Вероника)
15:30-18:00 Opera ознакомление (Ана)
Сушка Eiffel 3.90`,
      new Date("2026-07-23T00:00:00Z"),
    );

    expect(parsed.kind).toBe("actual");
    expect(parsed.jobs.map((job) => job.object)).toEqual(["Eiffel", "Lauriston 31", "Opera"]);
    expect(parsed.jobs[1]?.companion).toBe("Вероника");
    expect(parsed.jobs[2]?.companion).toBe("Ана");
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ category: "сушка", object: "Eiffel", amountCents: 390 }),
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it("uses a nominal hour for a flat-priced activity with no end", () => {
    const parsed = parseDay(
      `19/07
15:30 Opera ознакомление ( Ана)`,
      new Date("2026-07-23T00:00:00Z"),
    );
    expect(parsed.jobs[0]).toMatchObject({
      object: "Opera",
      startMinutes: 930,
      endMinutes: 990,
      endInferred: true,
      workType: "orientation",
      companion: "Ана",
    });
    expect(parsed.issues).toEqual([]);
  });

  it("still requires an end for hourly cleaning", () => {
    const parsed = parseDay(
      `19/07
Eiffel 11:00 самостоятельно`,
      new Date("2026-07-23T00:00:00Z"),
    );
    expect(parsed.jobs[0]?.endMinutes).toBeNull();
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: "missing_end", jobIndex: 0 }),
    );
  });

  it("removes the separator before an inline expense and links it to the job", () => {
    const parsed = parseDay(
      `19/07 изменения
Eiffel 11:00-14:00 уборка самостоятельно + сушка 3.9
14:30 Lauriston 31 ознакомление (Вероника)
15:30-16 Opera ознакомление ( Ана)`,
      new Date("2026-07-23T00:00:00Z"),
    );

    expect(parsed.jobs.map((job) => job.object)).toEqual(["Eiffel", "Lauriston 31", "Opera"]);
    expect(parsed.expenses).toEqual([
      expect.objectContaining({ category: "сушка", object: "Eiffel", amountCents: 390 }),
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it("preserves an unknown line", () => {
    const parsed = parseDay(
      `19/07
Eiffel 11-14 самостоятельно
потом может ещё куда-нибудь`,
      new Date("2026-07-23T00:00:00Z"),
    );
    expect(parsed.unparsedLines).toEqual(["потом может ещё куда-нибудь"]);
  });

  it("detects overlapping work", () => {
    const parsed = parseDay(
      `19/07
Eiffel 11-14 самостоятельно
Opera 13-15 ознакомление (Ана)`,
      new Date("2026-07-23T00:00:00Z"),
    );
    expect(parsed.issues.some((issue) => issue.code === "overlap")).toBe(true);
  });

  it("removes list numbering and ignores a repeated type description", () => {
    const parsed = parseDay(
      `19/07
1. 10:00 St Denis ознакомление (ознакомление через видос по итогу, хз как это считат)
2. 11:00-12:00 Opera самостоятельно`,
      new Date("2026-07-23T00:00:00Z"),
    );

    expect(parsed.jobs[0]).toMatchObject({
      object: "St Denis",
      startMinutes: 600,
      endMinutes: 660,
      endInferred: true,
      workType: "orientation",
    });
    expect(parsed.jobs[0]?.companion).toBeUndefined();
  });

  it("parses practice and joins an interval wrapped onto the next line", () => {
    const parsed = parseDay(
      `19/07
3. Ferronnerie Практика (13:10
14:00–16:30`,
      new Date("2026-07-23T00:00:00Z"),
    );

    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0]).toMatchObject({
      object: "Ferronnerie",
      startMinutes: 840,
      endMinutes: 990,
      workType: "practice",
    });
    expect(parsed.jobs[0]?.companion).toBeUndefined();
    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });
});

