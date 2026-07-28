import type { Apartment, ApartmentLookup } from "./types.js";

export const PUBLIC_APARTMENTS = [
  ["Bosquet", ["Bosquet"]], ["Braque 13", ["Braque 13"]],
  ["Dominique", ["Dominique", "Dominiquet"]], ["Eiffel", ["Eiffel", "Eiffe", "Eiffee"]],
  ["Euler", ["Euler"]], ["Federation", ["Federation"]], ["Ferronnerie", ["Ferronnerie"]],
  ["Flers", ["Flers"]], ["Gaston", ["Gaston"]], ["Hugo", ["Hugo"]],
  ["Lauriston 20", ["Lauriston 20"]], ["Lauriston 31", ["Lauriston 31"]],
  ["Lebouteux", ["Lebouteux"]], ["Louvre", ["Louvre"]], ["Monceau", ["Monceau"]],
  ["Montorgueil 58", ["Montorgueil 58"]], ["Opera", ["Opera", "Opéra"]],
  ["Poncelet", ["Poncelet", "Poncelet вторая квартира"]],
  ["Saint Denis", ["Saint Denis", "St Denis"]], ["Sevres", ["Sevres", "Sèvres"]],
  ["Stuart 23", ["Stuart 23", "23 Stuart"]], ["Tiquetonne", ["Tiquetonne"]],
] as const;

export function apartmentKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function apartmentLookup(apartments: Apartment[]): ApartmentLookup {
  const result: ApartmentLookup = new Map();
  for (const apartment of apartments) {
    for (const alias of [apartment.canonicalName, ...apartment.aliases]) {
      result.set(apartmentKey(alias), apartment);
    }
  }
  return result;
}

export function publicApartmentRecords(): Apartment[] {
  return PUBLIC_APARTMENTS.map(([canonicalName, aliases], index) => ({
    id: index + 1,
    sourceKey: `legacy:${apartmentKey(canonicalName).replaceAll(" ", "-")}`,
    canonicalKey: apartmentKey(canonicalName), canonicalName, aliases: [...aliases],
    address: null, mapsUrl: null, noteBody: null, active: true,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  }));
}

