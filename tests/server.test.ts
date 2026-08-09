import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import { MemoryLedgerStore } from "../src/storage/ledger-store.js";

const config: Config = {
  PORT: 3000, HOST: "127.0.0.1", LOG_LEVEL: "silent",
  PRODUCT_RELEASE: 3,
  HOURLY_RATE_CENTS: 1000, ORIENTATION_FLAT_CENTS: 1000, PRACTICE_FLAT_CENTS: 1500,
  CHECKIN_FLAT_CENTS: 1000, DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100, PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_URL: "postgresql://unused",
  APARTMENT_IMPORT_TOKEN: "test-import-token",
};

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("MaidAid HTTP API", () => {
  it("exposes only release-one product capabilities by default", async () => {
    app = await buildApp({ ...config, PRODUCT_RELEASE: 1 }, new MemoryLedgerStore());
    expect((await app.inject({ method: "GET", url: "/api/app-config" })).json()).toEqual({ productRelease: 1 });
    expect((await app.inject({ method: "GET", url: "/api/apartments" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/apartments", payload: { canonicalName: "Hidden", aliases: [] } })).statusCode).toBe(404);
    const located = await app.inject({ method: "PATCH", url: "/api/apartments/1", payload: { latitude: 48.8566, longitude: 2.3522, locationSource: "pin" } });
    expect(located.statusCode).toBe(200);
    expect(located.json().apartment).toMatchObject({ id: 1, latitude: 48.8566, longitude: 2.3522 });
    expect((await app.inject({ method: "GET", url: "/api/places" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/apartments/1/nearby-laundries" })).statusCode).toBe(404);
  });

  it("prevents stale service workers and app shells", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    expect((await app.inject({ method: "GET", url: "/sw.js" })).headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: "/app.js" })).headers["cache-control"]).toBe("no-cache");
  });

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
    const workRow = (await app.inject({ method: "GET", url: "/api/ledger?from=2026-07-01&to=2026-07-31" })).json().rows.find((row: { rowType: string }) => row.rowType === "work");
    expect(workRow.reportText).toBe(saved.json().shareText);
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
    expect((await app.inject({ method: "GET", url: "/map/apartments/1" })).headers["content-type"]).toContain("text/html");
  });

  it("creates apartments and saved places without mixing their storage", async () => {
    const externalFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("nominatim")) return new Response(JSON.stringify([{ lat: "48.8566", lon: "2.3522" }]), { status: 200 });
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    app = await buildApp(config, new MemoryLedgerStore(), externalFetch);
    const createdApartment = await app.inject({ method: "POST", url: "/api/apartments", payload: { canonicalName: "Test Flat", aliases: [], address: "Paris" } });
    expect(createdApartment.statusCode).toBe(201);
    expect(createdApartment.json().apartment).toMatchObject({ canonicalName: "Test Flat", latitude: 48.8566, locationSource: "address" });
    const apartmentId = createdApartment.json().apartment.id;
    const createdPlace = await app.inject({ method: "POST", url: "/api/places", payload: { kind: "laundry", name: "Good Dryer", latitude: 48.857, longitude: 2.353, locationSource: "pin", apartmentId } });
    expect(createdPlace.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/places" })).json().places).toEqual([expect.objectContaining({ kind: "laundry", name: "Good Dryer" })]);
    expect((await app.inject({ method: "GET", url: `/api/apartments/${apartmentId}` })).json().preferredLaundry).toMatchObject({ name: "Good Dryer" });
  });

  it("previews structured work without creating apartments and creates them idempotently on save", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const bosquet = (await app.inject({ method: "GET", url: "/api/apartments" })).json().apartments.find((item: { canonicalName: string }) => item.canonicalName === "Bosquet");
    const payload = { format: "structured", dateIso: "2026-08-09", jobs: [
      { apartmentId: bosquet.id, workType: "independent", durationMinutes: 180, dryerCents: 390, otherExpenseCents: 500 },
      { newApartmentName: "Nouvelle Rue", workType: "orientation", dryerCents: 0, otherExpenseCents: 0 },
    ] };
    const preview = await app.inject({ method: "POST", url: "/api/preview", payload });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ canShare: true, totals: { minutes: 180, incomeCents: 4000, expensesCents: 890 } });
    expect((await app.inject({ method: "GET", url: "/api/apartments" })).json().apartments).not.toContainEqual(expect.objectContaining({ canonicalName: "Nouvelle Rue" }));

    const saved = await app.inject({ method: "POST", url: "/api/days", payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().day.parsedDetails.jobs[1]).toMatchObject({ object: "Nouvelle Rue", workType: "orientation", durationMinutes: 60 });
    const afterFirstSave = (await app.inject({ method: "GET", url: "/api/apartments" })).json().apartments.filter((item: { canonicalName: string }) => item.canonicalName === "Nouvelle Rue");
    expect(afterFirstSave).toEqual([expect.objectContaining({ address: null, latitude: null })]);
    expect((await app.inject({ method: "POST", url: "/api/days", payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/apartments" })).json().apartments.filter((item: { canonicalName: string }) => item.canonicalName === "Nouvelle Rue")).toHaveLength(1);
  });

  it("accepts a laundry without an invented name", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const response = await app.inject({ method: "POST", url: "/api/places", payload: { kind: "laundry", address: "24 Pl. du Marché Saint-Honoré" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().place).toMatchObject({ kind: "laundry", name: "Сушка", address: "24 Pl. du Marché Saint-Honoré" });
  });

  it("returns the three nearest OSM laundries and links a confirmed candidate", async () => {
    const externalFetch = vi.fn(async () => new Response(JSON.stringify({ elements: [
      { type: "node", id: 3, lat: 48.86, lon: 2.36, tags: { name: "Far" } },
      { type: "node", id: 1, lat: 48.8567, lon: 2.3523, tags: { name: "Nearest", amenity: "dryer" } },
      { type: "way", id: 2, center: { lat: 48.857, lon: 2.354 }, tags: { name: "Middle", shop: "laundry" } },
      { type: "node", id: 4, lat: 48.87, lon: 2.37, tags: { name: "Excluded fourth" } },
    ] }), { status: 200 })) as unknown as typeof fetch;
    app = await buildApp(config, new MemoryLedgerStore(), externalFetch);
    const apartment = (await app.inject({ method: "POST", url: "/api/apartments", payload: { canonicalName: "Located", aliases: [], latitude: 48.8566, longitude: 2.3522, locationSource: "pin" } })).json().apartment;
    const nearby = await app.inject({ method: "GET", url: `/api/apartments/${apartment.id}/nearby-laundries` });
    expect(nearby.statusCode).toBe(200);
    expect(nearby.json().candidates).toHaveLength(3);
    expect(nearby.json().candidates[0]).toMatchObject({ name: "Nearest", dryerConfirmed: true });
    const candidate = nearby.json().candidates[0];
    const linked = await app.inject({ method: "POST", url: `/api/apartments/${apartment.id}/laundry-links`, payload: { candidate: { osmType: candidate.osmType, osmId: candidate.osmId, name: candidate.name, address: candidate.address, latitude: candidate.latitude, longitude: candidate.longitude } } });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().place).toMatchObject({ name: "Nearest", osmId: "1" });
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
