import { describe, expect, it } from "vitest";
import {
  APARTMENT_STORAGE_KEY,
  buildMapTarget,
  readSelectedApartment,
  uniqueApartments,
  writeSelectedApartment,
} from "../public/apartment-tools.js";

const apartment = {
  apartmentId: 7,
  object: "Opéra",
  address: "10 Rue de l'Opéra, Paris",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Opera",
  noteBody: "Code 1234\n<script>alert(1)</script>",
};

function memoryStorage(initial = new Map()) {
  return {
    getItem: (key) => initial.get(key) ?? null,
    setItem: (key, value) => initial.set(key, value),
    values: initial,
  };
}

describe("apartment preview helpers", () => {
  it("keeps recognized apartments once in first-appearance order", () => {
    expect(uniqueApartments([
      apartment,
      { apartmentId: null, object: "Unknown" },
      { ...apartment, object: "Opéra duplicate" },
      { ...apartment, apartmentId: 9, object: "Bosquet", address: "1 rue Test", noteBody: null },
    ])).toEqual([
      expect.objectContaining({ id: 7, name: "Opéra" }),
      expect.objectContaining({ id: 9, name: "Bosquet" }),
    ]);
  });

  it("builds native Android, iOS and iPadOS targets", () => {
    expect(buildMapTarget(apartment.address, apartment.mapsUrl, { userAgent: "Android" })).toEqual({
      href: "geo:0,0?q=10%20Rue%20de%20l'Op%C3%A9ra%2C%20Paris",
      external: false,
    });
    expect(buildMapTarget(apartment.address, apartment.mapsUrl, { userAgent: "iPhone" })?.href).toBe(
      "maps://?q=10%20Rue%20de%20l'Op%C3%A9ra%2C%20Paris",
    );
    expect(buildMapTarget(apartment.address, apartment.mapsUrl, { userAgent: "Macintosh", maxTouchPoints: 5 })?.href)
      .toMatch(/^maps:\/\//);
  });

  it("uses a safe imported desktop URL or an address-search fallback", () => {
    expect(buildMapTarget(apartment.address, apartment.mapsUrl, { userAgent: "Windows" })).toEqual({
      href: apartment.mapsUrl,
      external: true,
    });
    expect(buildMapTarget("5 avenue Émile", "javascript:alert(1)", { userAgent: "Windows" })?.href)
      .toBe("https://www.google.com/maps/search/?api=1&query=5%20avenue%20%C3%89mile");
    expect(buildMapTarget(null, apartment.mapsUrl, { userAgent: "Windows" })).toBeNull();
  });

  it("stores only normalized selected-apartment data and safely restores it", () => {
    const storage = memoryStorage();
    const selected = uniqueApartments([apartment])[0];
    expect(writeSelectedApartment(storage, selected)).toBe(true);
    expect(JSON.parse(storage.values.get(APARTMENT_STORAGE_KEY))).toEqual(selected);
    expect(readSelectedApartment(storage)).toEqual(selected);
    expect(readSelectedApartment(memoryStorage(new Map([[APARTMENT_STORAGE_KEY, "{bad json"]])))).toBeNull();
  });

  it("preserves multiline and HTML-like notes as inert data", () => {
    const selected = uniqueApartments([apartment])[0];
    expect(selected.noteBody).toBe("Code 1234\n<script>alert(1)</script>");
  });
});
