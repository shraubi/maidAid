import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, coordinatesFromMapsUrl, repairLegacyMapCoordinates } from "../src/server.js";
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
  it("does not parse an encoded street address as latitude and zero longitude", () => {
    expect(coordinatesFromMapsUrl("https://www.google.com/maps?q=31%20Rue%20Lauriston%2C%20Paris")).toBeNull();
    expect(coordinatesFromMapsUrl("https://www.google.com/maps?q=48.857%2C2.353")).toEqual({ latitude: 48.857, longitude: 2.353 });
    expect(coordinatesFromMapsUrl("https://www.google.com/maps/place/Test/data=!3d48.858!4d2.354")).toEqual({ latitude: 48.858, longitude: 2.354 });
  });

  it("repairs coordinates created by the legacy encoded-space parser", async () => {
    const store = new MemoryLedgerStore();
    const apartment = await store.createApartment({
      canonicalName: "Legacy coordinates", aliases: [], address: "31 Rue Lauriston, Paris",
      mapsUrl: "https://www.google.com/maps?q=31%20Rue%20Lauriston%2C%20Paris", noteBody: null,
      latitude: 31, longitude: 0, locationSource: "maps_link", locationAccuracyMeters: null,
    });
    const externalFetch = vi.fn(async () => new Response(JSON.stringify([{ lat: "48.8701", lon: "2.2894" }]), { status: 200 })) as unknown as typeof fetch;

    expect(await repairLegacyMapCoordinates(store, externalFetch, 0)).toBe(1);
    expect(await store.getApartment(apartment.id)).toMatchObject({ latitude: 48.8701, longitude: 2.2894, locationSource: "address" });
  });

  it("creates every place type using the location fallback order", async () => {
    const externalFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("maps.app.goo.gl")) {
        return new Response(null, { status: 302, headers: { location: "https://maps.google.com/maps?q=Laverie+Test,+48+Rue+de+Berri,+75008+Paris" } });
      }
      if (String(input).includes("nominatim")) {
        const query = new URL(String(input)).searchParams.get("q") ?? "";
        if (query.startsWith("Laverie Test")) return new Response("[]", { status: 200 });
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

    const numericAddressResponse = await app.inject({
      method: "POST",
      url: "/api/apartments",
      payload: { canonicalName: "Numeric address", aliases: [], address: "31 Rue Lauriston, Paris", mapsUrl: "https://www.google.com/maps?q=31%20Rue%20Lauriston%2C%20Paris" },
    });
    expect(numericAddressResponse.json().apartment).toMatchObject({ locationSource: "address", latitude: 48.8566, longitude: 2.3522 });

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

    const shortLinkLaundry = await app.inject({
      method: "POST",
      url: "/api/places",
      payload: { kind: "laundry", mapsUrl: "https://maps.app.goo.gl/example" },
    });
    expect(shortLinkLaundry.json().place).toMatchObject({ name: "Сушка", address: "Laverie Test, 48 Rue de Berri, 75008 Paris", locationSource: "address", latitude: 48.8566, longitude: 2.3522 });

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
    expect((await app.inject({ method: "GET", url: "/api/places" })).json().places).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: `/api/apartments/${apartment.id}/nearby-laundries` })).statusCode).toBe(404);
  });
});

