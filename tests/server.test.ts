import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const config: Config = {
  PORT: 3000,
  HOST: "127.0.0.1",
  LOG_LEVEL: "silent",
  HOURLY_RATE_CENTS: 1000,
  ORIENTATION_FLAT_CENTS: 1000,
  PRACTICE_FLAT_CENTS: 1500,
  DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100,
  PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_PATH: ":memory:",
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("MaidAid HTTP API", () => {
  it("previews an actual day without storing a draft", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        kind: "actual",
        text: "19/07 изменения\nEiffel 11-14 самостоятельно\nСушка Eiffel",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      parsed: { kind: "actual", displayDate: "19/07" },
      totals: { minutes: 180, incomeCents: 3000, expensesCents: 390 },
      issues: [],
      unparsedLines: [],
      canShare: true,
    });
    expect(response.json()).not.toHaveProperty("draftId");
  });

  it("auto-detects a schedule when the request omits kind", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: { text: "19/07\nEiffel 11-14 самостоятельно" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ parsed: { kind: "schedule" }, canShare: true });
    expect(body.shareText).toContain("Eiffel 3h + 30,00€");
    expect(body.shareText).toContain("Сегодня: 3h + 30,00€ заработок");
    expect(body.shareText).not.toContain("0,00€ расходы");
    expect(body.shareText).not.toContain("Оплата наличными:");
    expect(body.shareText).not.toContain("Аванс:");
  });

  it("saves confirmed totals idempotently with the last entry winning", async () => {
    app = await buildApp(config);
    const first = await app.inject({
      method: "POST", url: "/api/days",
      payload: { text: "19/07\nEiffel 11-14 самостоятельно" },
    });
    const last = await app.inject({
      method: "POST", url: "/api/days",
      payload: { text: "19/07\nEiffel 11-15 самостоятельно" },
    });

    expect(first.statusCode).toBe(200);
    expect(last.json().day).toMatchObject({
      dateIso: "2026-07-19", minutes: 240, incomeCents: 4000, expensesCents: 0,
    });
  });

  it("returns cleaned preview data and activity-specific pricing", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        text: `19/07
1. 10:00-11:00 St Denis ознакомление (ознакомление через видос по итогу, хз как это считат)
3. Ferronnerie Практика (13:10
14:00–16:30
4. 17:00-19:00 Opera самостоятельно`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      parsed: {
        jobs: [
          { object: "St Denis", workType: "orientation" },
          { object: "Ferronnerie", workType: "practice" },
          { object: "Opera", workType: "independent" },
        ],
      },
      totals: { minutes: 330, incomeCents: 4500, expensesCents: 0 },
      canShare: true,
    });
    expect(response.json().parsed.jobs[0]).not.toHaveProperty("companion");
    expect(response.json().parsed.jobs[1]).not.toHaveProperty("companion");
  });

  it("accepts a flat-priced activity without an explicit end", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: { text: "19/07\n15:30 Opera ознакомление ( Ана)" },
    });

    expect(response.json()).toMatchObject({
      parsed: {
        jobs: [{
          object: "Opera",
          startMinutes: 930,
          endMinutes: 990,
          workType: "orientation",
        }],
      },
      totals: { minutes: 60, incomeCents: 1000, expensesCents: 0 },
      issues: [],
      canShare: true,
    });
  });

  it("keeps an inline dryer expense attached to one apartment", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        text: `19/07 изменения
Eiffel 11:00-14:00 уборка самостоятельно + сушка 3.9
14:30 Lauriston 31 ознакомление (Вероника)
15:30-16 Opera ознакомление ( Ана)`,
      },
    });
    const body = response.json();

    expect(body).toMatchObject({
      parsed: {
        jobs: [
          { object: "Eiffel", workType: "independent" },
          { object: "Lauriston 31", workType: "orientation" },
          { object: "Opera", workType: "orientation" },
        ],
        expenses: [{ category: "сушка", object: "Eiffel", amountCents: 390 }],
      },
      totals: { minutes: 270, incomeCents: 5000, expensesCents: 390 },
      issues: [],
      canShare: true,
    });
    expect(body.shareText).toContain("Eiffel 3h + 3,90€ сушка + 30,00€");
    expect(body.shareText).not.toContain("Eiffel +");
  });

  it("blocks sharing for parse issues and unrecognized lines", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        kind: "actual",
        text: "19/07\nEiffel 11:00 самостоятельно\nпотом может ещё куда-нибудь",
      },
    });
    const body = response.json();
    expect(body.canShare).toBe(false);
    expect(body.shareText).toBe("");
    expect(body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_end" })]));
    expect(body.unparsedLines).toEqual(["потом может ещё куда-нибудь"]);
  });

  it("lets the user correct the original message and receive a ready report", async () => {
    app = await buildApp(config);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        kind: "actual",
        text: "19/07 изменения\nEiffel 11:00 самостоятельно",
      },
    });
    expect(invalid.json()).toMatchObject({
      canShare: false,
      shareText: "",
      issues: [expect.objectContaining({ code: "missing_end" })],
    });

    const corrected = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: {
        kind: "actual",
        text: "19/07 изменения\nEiffel 11:00-14:00 самостоятельно\nСушка Eiffel 3,90",
      },
    });
    expect(corrected.json()).toMatchObject({
      canShare: true,
      totals: { minutes: 180, incomeCents: 3000, expensesCents: 390 },
    });
    expect(corrected.json().shareText).toContain(
      "Сегодня: 3h + 30,00€ заработок + 3,90€ расходы",
    );
  });

  it("rejects invalid bodies", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      payload: { kind: "unknown", text: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects request bodies larger than 32 KB", async () => {
    app = await buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/preview",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ kind: "actual", text: "x".repeat(33 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it("serves health and the PWA shell without legacy routes", async () => {
    app = await buildApp(config);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).headers["content-type"]).toContain("text/html");
    expect((await app.inject({ method: "GET", url: "/manifest.webmanifest" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/sw.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/webhook" })).statusCode).toBe(404);
  });
});
