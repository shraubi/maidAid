import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import { MemoryLedgerStore } from "../src/storage/ledger-store.js";

const config: Config = {
  PORT: 3000, HOST: "127.0.0.1", LOG_LEVEL: "silent",
  HOURLY_RATE_CENTS: 1000, ORIENTATION_FLAT_CENTS: 1000, PRACTICE_FLAT_CENTS: 1500,
  CHECKIN_FLAT_CENTS: 1000, DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100, PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_URL: "postgresql://unused",
  APARTMENT_IMPORT_TOKEN: "test-import-token", APARTMENT_CACHE_TTL_MS: 30_000,
};

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("MaidAid HTTP API", () => {
  it("returns a projected preview and authoritative share text after save", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const text = "26/07\nBosquet 9-12 уборка\nсушка 4.2 + 11.67\n16:00 check in Dominique";
    const preview = await app.inject({ method: "POST", url: "/api/preview", payload: { text } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ canShare: true, totals: { minutes: 180, incomeCents: 4000, checkinCents: 1000, expensesCents: 1587 }, projectedBalance: 4000 });
    const saved = await app.inject({ method: "POST", url: "/api/days", payload: { text } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().shareText).toContain("Bosquet 3h + 4.20€ сушка + 11.67€ расходы");
    expect(saved.json().runningBalance).toBe(4000);
  });

  it("creates, edits and deletes manual payments", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const created = await app.inject({ method: "POST", url: "/api/payments", payload: { dateIso: "2026-07-20", amountCents: 20000, note: "Аванс" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().payment.id;
    expect((await app.inject({ method: "PATCH", url: `/api/payments/${id}`, payload: { amountCents: 19000 } })).json().payment.amountCents).toBe(19000);
    expect((await app.inject({ method: "GET", url: "/api/ledger?from=2026-07-01&to=2026-07-31" })).json().totals.receivedCents).toBe(19000);
    expect((await app.inject({ method: "DELETE", url: `/api/payments/${id}` })).statusCode).toBe(204);
  });

  it("updates an existing work day without creating a duplicate", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    await app.inject({ method: "POST", url: "/api/days", payload: { text: "26/07\nBosquet 9-12 уборка" } });
    await app.inject({ method: "POST", url: "/api/days", payload: { text: "26/07\nBosquet 9-12 уборка расходы 5€ + 3.9€" } });
    const ledger = (await app.inject({ method: "GET", url: "/api/ledger?from=2026-07-26&to=2026-07-26" })).json();
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ expensesCents: 890, sourceText: expect.stringContaining("5€") });
  });

  it("keeps text-derived payments protected from manual mutation", async () => {
    const store = new MemoryLedgerStore(); app = await buildApp(config, store);
    await app.inject({ method: "POST", url: "/api/days", payload: { text: "26/07\nBosquet 9-12 уборка\nАванс 50" } });
    const payment = (await app.inject({ method: "GET", url: "/api/ledger" })).json().rows.find((row: { source?: string }) => row.source === "day_text");
    expect((await app.inject({ method: "DELETE", url: `/api/payments/${payment.id}` })).statusCode).toBe(404);
  });

  it("rejects invalid input and serves a database-aware health endpoint", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    expect((await app.inject({ method: "POST", url: "/api/preview", payload: { text: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", database: true });
    expect((await app.inject({ method: "GET", url: "/" })).headers["content-type"]).toContain("text/html");
    expect((await app.inject({ method: "GET", url: "/apartment.html" })).headers["content-type"]).toContain("text/html");
  });

  it("protects, dry-runs and idempotently applies apartment imports", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const payload = { apartments: [{
      sourceKey: "source-bosquet", canonicalName: "Bosquet", aliases: ["Bosquet Test"],
      address: "Test address", mapsUrl: "https://www.google.com/maps/search/?api=1&query=Test",
      noteBody: "<script>alert(1)</script>", active: true,
    }] };
    expect((await app.inject({ method: "POST", url: "/api/admin/apartments/import", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/apartments/import", headers: { authorization: "Bearer wrong-token" }, payload })).statusCode).toBe(401);
    const headers = { authorization: "Bearer test-import-token" };
    const dryRun = await app.inject({ method: "POST", url: "/api/admin/apartments/import?dryRun=true", headers, payload });
    expect(dryRun.json()).toMatchObject({ dryRun: true, accepted: 1, updated: 1, conflicts: [] });
    const before = await app.inject({ method: "POST", url: "/api/preview", payload: { text: "26/07\nBosquet Test 9-12 уборка" } });
    expect(before.json().parsed.jobs[0]).toMatchObject({
      apartmentId: null, address: null, mapsUrl: null, noteBody: null,
    });
    const imported = await app.inject({ method: "POST", url: "/api/admin/apartments/import", headers, payload });
    expect(imported.json()).toMatchObject({ dryRun: false, accepted: 1, updated: 1, conflicts: [] });
    const preview = await app.inject({ method: "POST", url: "/api/preview", payload: { text: "26/07\nBosquet Test 9-12 уборка" } });
    expect(preview.json().parsed.jobs[0]).toMatchObject({
      object: "Bosquet",
      address: "Test address",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=Test",
      noteBody: "<script>alert(1)</script>",
    });
    const messyText = "28/07/2098 изменения\n*Bosquet Test* 9:00–12:00 - самостоятельная уборка / комментарий\nсушка 4,20 + 1.30\n16:00 check-in Bosquet Test - самостоятельное заселение\nАванс: 20€";
    const messyPreview = await app.inject({ method: "POST", url: "/api/preview", payload: { text: messyText } });
    expect(messyPreview.json()).toMatchObject({ canShare: true, advanceCents: 2000, totals: { minutes: 180, incomeCents: 4000, expensesCents: 550 } });
    expect(messyPreview.json().parsed.jobs).toEqual([
      expect.objectContaining({ object: "Bosquet", apartmentId: expect.any(Number), address: "Test address" }),
      expect.objectContaining({ object: "Bosquet", apartmentId: expect.any(Number), workType: "checkin" }),
    ]);
    expect((await app.inject({ method: "POST", url: "/api/days", payload: { text: messyText } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/ledger?from=2098-07-28&to=2098-07-28" })).json().rows).toHaveLength(2);
    expect((await app.inject({ method: "DELETE", url: "/api/days/2098-07-28" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/ledger?from=2098-07-28&to=2098-07-28" })).json()).toMatchObject({ totals: { earnedCents: 0, receivedCents: 0 }, rows: [] });
    const repeated = await app.inject({ method: "POST", url: "/api/admin/apartments/import", headers, payload });
    expect(repeated.json()).toMatchObject({ accepted: 1, skipped: 1, conflicts: [] });
  });
});

