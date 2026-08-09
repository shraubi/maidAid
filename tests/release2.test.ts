import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import { MemoryLedgerStore } from "../src/storage/ledger-store.js";

const config: Config = {
  PORT: 3000,
  HOST: "127.0.0.1",
  LOG_LEVEL: "silent",
  PRODUCT_RELEASE: 2,
  HOURLY_RATE_CENTS: 1000,
  ORIENTATION_FLAT_CENTS: 1000,
  PRACTICE_FLAT_CENTS: 1500,
  CHECKIN_FLAT_CENTS: 1000,
  DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100,
  PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_URL: "postgresql://unused",
  APARTMENT_IMPORT_TOKEN: "",
};

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("release two places", () => {
  it("creates every place type using the location fallback order", async () => {
    const externalFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("nominatim")) {
        return new Response(JSON.stringify([{ lat: "48.8566", lon: "2.3522" }]), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    app = await buildApp(config, new MemoryLedgerStore(), externalFetch);

    const apartmentResponse = await app.inject({
      method: "POST",
      url: "/api/apartments",
      payload: { canonicalName: "Квартира А", aliases: [], address: "1 rue Exemple, Paris" },
    });
    expect(apartmentResponse.statusCode).toBe(201);
    const apartment = apartmentResponse.json().apartment;
    expect(apartment).toMatchObject({ locationSource: "address", latitude: 48.8566, longitude: 2.3522 });

    const laundryResponse = await app.inject({
      method: "POST",
      url: "/api/places",
      payload: {
        kind: "laundry",
        name: "Сушка А",
        mapsUrl: "https://www.google.com/maps?q=48.857,2.353",
        apartmentId: apartment.id,
      },
    });
    expect(laundryResponse.statusCode).toBe(201);
    expect(laundryResponse.json().place).toMatchObject({ kind: "laundry", locationSource: "maps_link", latitude: 48.857, longitude: 2.353 });

    const partnerResponse = await app.inject({
      method: "POST",
      url: "/api/places",
      payload: { kind: "partner_restaurant", name: "Партнёр А" },
    });
    expect(partnerResponse.statusCode).toBe(201);
    expect(partnerResponse.json().place).toMatchObject({ kind: "partner_restaurant", latitude: null, longitude: null });

    const partner = partnerResponse.json().place;
    const locatedPartner = await app.inject({
      method: "PATCH",
      url: `/api/places/${partner.id}`,
      payload: { latitude: 48.858, longitude: 2.354, locationSource: "geolocation", locationAccuracyMeters: 25 },
    });
    expect(locatedPartner.json().place).toMatchObject({ locationSource: "geolocation", locationAccuracyMeters: 25 });

    const apartmentDetail = await app.inject({ method: "GET", url: `/api/apartments/${apartment.id}` });
    expect(apartmentDetail.json().preferredLaundry).toMatchObject({ name: "Сушка А" });
    expect((await app.inject({ method: "GET", url: "/api/places" })).json().places).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/api/apartments/${apartment.id}/nearby-laundries` })).statusCode).toBe(404);
  });
});
