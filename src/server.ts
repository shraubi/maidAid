import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { calculateDay } from "./domain/calculations.js";
import { generateShareText } from "./domain/draft.js";
import { parseDay } from "./domain/parser.js";
import type { Expense, Job, LocationSource, ParsedDay, SavedPlace, Settings, WorkType } from "./domain/types.js";
import { apartmentKey, apartmentLookup } from "./domain/apartments.js";
import { loadConfig, type Config } from "./config.js";
import { PostgresLedgerStore, type LedgerStore } from "./storage/ledger-store.js";
import { createPinDigest, createSessionToken, hashSessionToken, normalizeCleanerName, prepareInitialCleaner, validPin, verifyPin, type Cleaner } from "./auth.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}, "Invalid calendar date");
const textDayBody = z.object({ kind: z.enum(["actual", "schedule"]).optional(), text: z.string().trim().min(1).max(32 * 1024) }).strict();
const structuredJob = z.object({
  apartmentId: z.number().int().positive().optional(),
  newApartmentName: z.string().trim().min(1).max(200).optional(),
  workType: z.enum(["independent", "orientation", "practice", "checkin"]),
  durationMinutes: z.number().int().min(30).max(300).refine((value) => value % 30 === 0).optional(),
  dryerCents: z.number().int().nonnegative().default(0),
  otherExpenseCents: z.number().int().nonnegative().default(0),
}).strict().superRefine((value, context) => {
  if ((value.apartmentId == null) === (value.newApartmentName == null)) context.addIssue({ code: "custom", message: "Choose one apartment", path: ["apartmentId"] });
  if (value.workType === "independent" && value.durationMinutes == null) context.addIssue({ code: "custom", message: "Cleaning duration is required", path: ["durationMinutes"] });
  if (value.workType !== "independent" && (value.dryerCents > 0 || value.otherExpenseCents > 0)) context.addIssue({ code: "custom", message: "Expenses apply only to cleaning work", path: ["dryerCents"] });
});
const structuredDayBody = z.object({ format: z.literal("structured"), dateIso: date, jobs: z.array(structuredJob).min(1).max(50) }).strict();
const previewBody = z.union([textDayBody, structuredDayBody]);
const paymentCreate = z.object({ dateIso: date, amountCents: z.number().int().positive(), note: z.string().max(500).optional() }).strict();
const paymentPatch = z.object({ dateIso: date.optional(), amountCents: z.number().int().positive().optional(), note: z.string().max(500).nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0);
const paymentParams = z.object({ id: z.coerce.number().int().positive() });
const ledgerQuery = z.object({ from: date.optional(), to: date.optional() });
const apartmentImportItem = z.object({
  sourceKey: z.string().trim().min(1).max(200),
  canonicalName: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100),
  address: z.string().trim().min(1).max(1000),
  mapsUrl: z.string().url().refine((value) => {
    const url = new URL(value); return url.protocol === "https:" && ["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl"].includes(url.hostname);
  }, "Expected an HTTPS Google Maps URL"),
  noteBody: z.string().min(1).max(128 * 1024),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  active: z.boolean(),
}).strict();
const apartmentImportBody = z.object({ apartments: z.array(apartmentImportItem).min(1).max(100) }).strict();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const locationSource = z.enum(["address", "maps_link", "pin", "geolocation", "import", "osm"]);
const locationInput = {
  address: nullableText(1000), mapsUrl: z.string().url().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
  locationSource: locationSource.nullable().optional(), locationAccuracyMeters: z.number().nonnegative().max(100_000).nullable().optional(),
};
const apartmentCreate = z.object({
  canonicalName: z.string().trim().min(1).max(200), aliases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  noteBody: nullableText(128 * 1024), ...locationInput,
}).strict();
const apartmentPatch = apartmentCreate.partial();
const placeCreate = z.object({
  kind: z.enum(["laundry", "partner_restaurant"]), name: z.string().trim().max(200).optional(),
  note: nullableText(20_000), apartmentId: z.number().int().positive().optional(), ...locationInput,
}).strict();
const placePatch = placeCreate.omit({ apartmentId: true }).partial();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const osmCandidate = z.object({
  osmType: z.enum(["node", "way", "relation"]), osmId: z.string().min(1), name: z.string().min(1).max(500),
  address: z.string().max(1000).nullable(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
}).strict();
const laundryLinkBody = z.union([z.object({ placeId: z.number().int().positive() }).strict(), z.object({ candidate: osmCandidate }).strict()]);
const cleanerName = z.string().trim().min(1).max(80);
const pin = z.string().regex(/^\d{6}$/);
const loginBody = z.object({ name: cleanerName, pin }).strict();
const registerBody = z.object({ teamCode: z.string().min(1).max(200), name: cleanerName, pin }).strict();

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const publicRoot = moduleDirectory.includes(`${sep}dist${sep}`) ? resolve(moduleDirectory, "../../public") : resolve(moduleDirectory, "../public");
const projectRoot = moduleDirectory.includes(`${sep}dist${sep}`) ? resolve(moduleDirectory, "../..") : resolve(moduleDirectory, "..");
const leafletRoot = resolve(projectRoot, "node_modules/leaflet/dist");

function monthEnd(dateIso: string): string {
  const year = Number(dateIso.slice(0, 4)); const month = Number(dateIso.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dateIso.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [`maidaid_session=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, secure ? "Secure" : ""].filter(Boolean).join("; ");
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual); const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function coordinatePair(value: string): { latitude: number; longitude: number } | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]); const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
}

export function coordinatesFromMapsUrl(value: string | null | undefined): { latitude: number; longitude: number } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const pathCoordinates = url.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (pathCoordinates) return coordinatePair(`${pathCoordinates[1]},${pathCoordinates[2]}`);
    const dataCoordinates = url.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (dataCoordinates) return coordinatePair(`${dataCoordinates[1]},${dataCoordinates[2]}`);
    for (const key of ["query", "q", "ll", "destination", "daddr"]) {
      const coordinates = coordinatePair(url.searchParams.get(key) ?? "");
      if (coordinates) return coordinates;
    }
  } catch { /* Invalid URLs are rejected by request validation. */ }
  return null;
}

function hasLegacyBrokenCoordinates(item: { mapsUrl: string | null; latitude?: number | null; longitude?: number | null; locationSource?: LocationSource | null }): boolean {
  if (item.locationSource !== "maps_link" || item.longitude !== 0 || item.latitude == null || !item.mapsUrl || coordinatesFromMapsUrl(item.mapsUrl)) return false;
  try {
    const url = new URL(item.mapsUrl);
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    const leadingNumber = query.match(/^\s*(-?\d+(?:\.\d+)?)\s+/);
    return leadingNumber != null && Number(leadingNumber[1]) === item.latitude;
  } catch { return false; }
}

async function resolveLocation(input: Record<string, unknown>, externalFetch: typeof fetch): Promise<{ latitude: number | null; longitude: number | null; locationSource: LocationSource | null; locationAccuracyMeters: number | null; inferredAddress?: string }> {
  const latitude = typeof input.latitude === "number" ? input.latitude : null;
  const longitude = typeof input.longitude === "number" ? input.longitude : null;
  if (latitude != null && longitude != null) return { latitude, longitude, locationSource: input.locationSource as LocationSource ?? "pin", locationAccuracyMeters: typeof input.locationAccuracyMeters === "number" ? input.locationAccuracyMeters : null };
  const mapsUrl = typeof input.mapsUrl === "string" ? input.mapsUrl : null;
  let expandedMapsUrl = mapsUrl;
  let inferredAddress = "";
  if (mapsUrl) {
    try {
      const shortUrl = new URL(mapsUrl);
      if (shortUrl.hostname === "maps.app.goo.gl") {
        const response = await externalFetch(shortUrl, { redirect: "manual", headers: { "user-agent": "MaidAid/0.1" }, signal: AbortSignal.timeout(6_000) });
        const redirect = response.headers.get("location") ?? response.url;
        if (redirect) {
          const expanded = new URL(redirect, shortUrl);
          if (["google.com", "www.google.com", "maps.google.com"].includes(expanded.hostname)) {
            expandedMapsUrl = expanded.href;
            const query = expanded.searchParams.get("q") ?? expanded.searchParams.get("query") ?? "";
            if (query && !coordinatePair(query)) inferredAddress = query;
          }
        }
      }
    } catch { /* The original link is still saved and can be fixed manually. */ }
  }
  const fromUrl = coordinatesFromMapsUrl(expandedMapsUrl);
  if (fromUrl) return { ...fromUrl, locationSource: "maps_link", locationAccuracyMeters: null };
  const address = (typeof input.address === "string" ? input.address.trim() : "") || inferredAddress;
  if (address) {
    const addressCandidates = [address];
    if (inferredAddress.includes(",")) addressCandidates.push(inferredAddress.slice(inferredAddress.indexOf(",") + 1).trim());
    for (const candidate of [...new Set(addressCandidates)]) {
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", candidate); url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "1");
        const response = await externalFetch(url, { headers: { "user-agent": "MaidAid/0.1", accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
        if (response.ok) {
          const body = await response.json() as Array<{ lat?: string; lon?: string }>;
          const hit = body[0]; const resolvedLatitude = Number(hit?.lat); const resolvedLongitude = Number(hit?.lon);
          if (Number.isFinite(resolvedLatitude) && Number.isFinite(resolvedLongitude)) return { latitude: resolvedLatitude, longitude: resolvedLongitude, locationSource: "address", locationAccuracyMeters: null, ...(inferredAddress ? { inferredAddress } : {}) };
        }
      } catch { /* Try the next address variant before falling back to manual placement. */ }
    }
  }
  return { latitude: null, longitude: null, locationSource: null, locationAccuracyMeters: null, ...(inferredAddress ? { inferredAddress } : {}) };
}

export async function repairLegacyMapCoordinates(ledger: LedgerStore, externalFetch: typeof fetch, delayMilliseconds = 1_100): Promise<number> {
  const apartments = (await ledger.getActiveApartments()).filter(hasLegacyBrokenCoordinates);
  const places = (await ledger.getSavedPlaces()).filter(hasLegacyBrokenCoordinates);
  const targets = [
    ...apartments.map((item) => ({ item, update: (location: Awaited<ReturnType<typeof resolveLocation>>) => ledger.updateApartment(item.id, location) })),
    ...places.map((item) => ({ item, update: (location: Awaited<ReturnType<typeof resolveLocation>>) => ledger.updateSavedPlace(item.id, location) })),
  ];
  let repaired = 0;
  for (const [index, target] of targets.entries()) {
    if (index > 0 && delayMilliseconds > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMilliseconds));
    const location = await resolveLocation({ address: target.item.address, mapsUrl: target.item.mapsUrl }, externalFetch);
    if (location.latitude == null || location.longitude == null) continue;
    await target.update(location); repaired += 1;
  }
  return repaired;
}

type StructuredDayInput = z.infer<typeof structuredDayBody>;

function structuredDuration(workType: WorkType, durationMinutes?: number): number {
  if (workType === "independent") return durationMinutes ?? 180;
  return workType === "checkin" ? 30 : 60;
}

function structuredSourceLine(name: string, workType: WorkType, durationMinutes: number, dryerCents: number, otherExpenseCents: number): string {
  const type = { independent: "ÑƒĞ±Ğ¾Ñ€ĞºĞ°", orientation: "Ğ¾Ğ·Ğ½Ğ°ĞºĞ¾Ğ¼Ğ»ĞµĞ½Ğ¸Ğµ", practice: "Ğ¿Ñ€Ğ°ĞºÑ‚Ğ¸ĞºĞ°", checkin: "check in", unknown: "" }[workType];
  const hours = Number((durationMinutes / 60).toFixed(2));
  const expenses = [dryerCents > 0 ? `ÑÑƒÑˆĞºĞ° ${(dryerCents / 100).toFixed(2)}â‚¬` : "", otherExpenseCents > 0 ? `Ñ€Ğ°ÑÑ…Ğ¾Ğ´Ñ‹ ${(otherExpenseCents / 100).toFixed(2)}â‚¬` : ""].filter(Boolean).join(" + ");
  return `${name} ${hours}h ${type}${expenses ? ` ${expenses}` : ""}`;
}

async function buildStructuredDay(input: StructuredDayInput, ledger: LedgerStore, createMissing: boolean): Promise<{ parsed: ParsedDay; sourceText: string }> {
  const activeApartments = await ledger.getActiveApartments();
  const byId = new Map(aã]º¶‰Ëkºwµç@üì…‘‘É•ÍÌè¥¹™•ÉÉ•‘‘‘É•ÍÌô€èíô¤°€¸¸¹±½…Ñ¥½¸ô¤ìÉ•ÑÕÉ¸ì…Á…ÉÑµ•¹Ğôì(€€€ô…Ñ ìÉ•ÑÕÉ¸É•Á±ä¹½‘” ĞÀä¤¹Í•¹¡ì•ÉÉ½Èè€‰…Á…ÉÑµ•¹Ñ}•á¥ÍÑÌˆô¤ìô(€ô¤ì((€…ÁÀ¹•Ğ ˆ½…Á¤½Á±…•Ìˆ°…Íå¹Œ€¡}É•ÅÕ•ÍĞ°É•Á±ä¤€ôøÁÉ½‘ÕÑI•±•…Í”€øô€È€üìÁ±…•Ìè…İ…¥Ğ±•‘•È¹•ÑM…Ù•‘A±…•Ì ¤ô€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤¤ì(€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½Á±…•Ìˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€¡ÁÉ½‘ÕÑI•±•…Í”€ğ€È¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞ¥¹ÁÕĞ€ôÁ±…•É•…Ñ”¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì¥˜€ …¥¹ÁÕĞ¹ÍÕ•ÍÌñğ€¡¥¹ÁÕĞ¹ÍÕ•ÍÌ€˜˜¥¹ÁÕĞ¹‘…Ñ„¹­¥¹€ôôô€‰Á…ÉÑ¹•É}É•ÍÑ…ÕÉ…¹Ğˆ€˜˜€…¥¹ÁÕĞ¹‘…Ñ„¹¹…µ”¤¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞì¥¹™•ÉÉ•‘‘‘É•ÍÌ°€¸¸¹±½…Ñ¥½¸ô€ô…İ…¥ĞÉ•Í½±Ù•1½…Ñ¥½¸¡¥¹ÁÕĞ¹‘…Ñ„°•áÑ•É¹…±•Ñ ¤ì(€€€½¹ÍĞÁ±…”€ô…İ…¥Ğ±•‘•È¹É•…Ñ•M…Ù•‘A±…”¡ì­¥¹è¥¹ÁÕĞ¹‘…Ñ„¹­¥¹°¹…µ”è¥¹ÁÕĞ¹‘…Ñ„¹¹…µ”ñğ€‹B‡FF#BëBÀˆ°…‘‘É•ÍÌè¥¹ÁÕĞ¹‘…Ñ„¹…‘‘É•ÍÌ€üü¥¹™•ÉÉ•‘‘‘É•ÍÌ€üü¹Õ±°°¹½Ñ”è¥¹ÁÕĞ¹‘…Ñ„¹¹½Ñ”€üü¹Õ±°°µ…ÁÍUÉ°è¥¹ÁÕĞ¹‘…Ñ„¹µ…ÁÍUÉ°€üü¹Õ±°°€¸¸¹±½…Ñ¥½¸ô¤ì(€€€¥˜€¡¥¹ÁÕĞ¹‘…Ñ„¹­¥¹€ôôô€‰±…Õ¹‘Éäˆ€˜˜¥¹ÁÕĞ¹‘…Ñ„¹…Á…ÉÑµ•¹Ñ%¤…İ…¥Ğ±•‘•È¹Í•ÑAÉ•™•ÉÉ•‘1…Õ¹‘Éä¡¥¹ÁÕĞ¹‘…Ñ„¹…Á…ÉÑµ•¹Ñ%°Á±…”¹¥¤ì(€€€É•ÑÕÉ¸É•Á±ä¹½‘” ÈÀÄ¤¹Í•¹¡ìÁ±…”ô¤ì(€ô¤ì(€…ÁÀ¹Á…Ñ  ˆ½…Á¤½Á±…•Ì¼é¥ˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€¡ÁÉ½‘ÕÑI•±•…Í”€ğ€È¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞÁ…É…µÌ€ô¥‘A…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì½¹ÍĞ¥¹ÁÕĞ€ôÁ±…•A…Ñ ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌñğ€…¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞÕÉÉ•¹Ğ€ô…İ…¥Ğ±•‘•È¹•ÑM…Ù•‘A±…”¡Á…É…µÌ¹‘…Ñ„¹¥¤ì¥˜€ …ÕÉÉ•¹Ğ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰Á±…•}¹½Ñ}™½Õ¹ˆô¤ì(€€€¥˜€ ¡¥¹ÁÕĞ¹‘…Ñ„¹­¥¹€üüÕÉÉ•¹Ğ¹­¥¹¤€ôôô€‰Á…ÉÑ¹•É}É•ÍÑ…ÕÉ…¹Ğˆ€˜˜¥¹ÁÕĞ¹‘…Ñ„¹¹…µ”€„ôôÕ¹‘•™¥¹•€˜˜€…¥¹ÁÕĞ¹‘…Ñ„¹¹…µ”¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞ±½…Ñ¥½¹¡…¹•€ô¥¹ÁÕĞ¹‘…Ñ„¹…‘‘É•ÍÌ€„ôôÕ¹‘•™¥¹•ñğ¥¹ÁÕĞ¹‘…Ñ„¹µ…ÁÍUÉ°€„ôôÕ¹‘•™¥¹•ñğ¥¹ÁÕĞ¹‘…Ñ„¹±…Ñ¥ÑÕ‘”€„ôôÕ¹‘•™¥¹•ñğ¥¹ÁÕĞ¹‘…Ñ„¹±½¹¥ÑÕ‘”€„ôôÕ¹‘•™¥¹•ì(€€€½¹ÍĞÉ•Í½±Ù•€ô±½…Ñ¥½¹¡…¹•€ü…İ…¥ĞÉ•Í½±Ù•1½…Ñ¥½¸¡¥¹ÁÕĞ¹‘…Ñ„°•áÑ•É¹…±•Ñ ¤€èì±…Ñ¥ÑÕ‘”èÕÉÉ•¹Ğ¹±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”èÕÉÉ•¹Ğ¹±½¹¥ÑÕ‘”°±½…Ñ¥½¹M½ÕÉ”èÕÉÉ•¹Ğ¹±½…Ñ¥½¹M½ÕÉ”°±½…Ñ¥½¹ÕÉ…å5•Ñ•ÉÌèÕÉÉ•¹Ğ¹±½…Ñ¥½¹ÕÉ…å5•Ñ•ÉÌ°¥¹™•ÉÉ•‘‘‘É•ÍÌèÕ¹‘•™¥¹•ôì(€€€½¹ÍĞì¥¹™•ÉÉ•‘‘‘É•ÍÌ°€¸¸¹±½…Ñ¥½¸ô€ôÉ•Í½±Ù•ì(€€€½¹ÍĞÙ…±Õ•Ì€ôì€¸¸¹¥¹ÁÕĞ¹‘…Ñ„°€¸¸¸¡¥¹ÁÕĞ¹‘…Ñ„¹…‘‘É•ÍÌ€ôôôÕ¹‘•™¥¹•€˜˜¥¹™•ÉÉ•‘‘‘É•ÍÌ€üì…‘‘É•ÍÌè¥¹™•ÉÉ•‘‘‘É•ÍÌô€èíô¤°€¸¸¸¡¥¹ÁÕĞ¹‘…Ñ„¹­¥¹€ôôô€‰±…Õ¹‘Éäˆ€˜˜€…¥¹ÁÕĞ¹‘…Ñ„¹¹…µ”€üì¹…µ”è€‹B‡FF#BëBÀˆô€èíô¤°€¸¸¹±½…Ñ¥½¸ôì(€€€½¹ÍĞÁ±…”€ô…İ…¥Ğ±•‘•È¹ÕÁ‘…Ñ•M…Ù•‘A±…”¡Á…É…µÌ¹‘…Ñ„¹¥°Ù…±Õ•Ì¤ìÉ•ÑÕÉ¸ìÁ±…”ôì(€ô¤ì(€…ÁÀ¹‘•±•Ñ” ˆ½…Á¤½Á±…•Ì¼é¥ˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€¡ÁÉ½‘ÕÑI•±•…Í”€ğ€È¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞÁ…É…µÌ€ô¥‘A…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€É•ÑÕÉ¸…İ…¥Ğ±•‘•È¹…É¡¥Ù•M…Ù•‘A±…”¡Á…É…µÌ¹‘…Ñ„¹¥¤€üÉ•Á±ä¹½‘” ÈÀĞ¤¹Í•¹ ¤€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰Á±…•}¹½Ñ}™½Õ¹ˆô¤ì(€ô¤ì((€…ÁÀ¹•Ğ ˆ½…Á¤½…Á…ÉÑµ•¹ÑÌ¼é¥½¹•…É‰äµ±…Õ¹‘É¥•Ìˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€¡ÁÉ½‘ÕÑI•±•…Í”€ğ€Ì¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞÁ…É…µÌ€ô¥‘A…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞ…Á…ÉÑµ•¹Ğ€ô…İ…¥Ğ±•‘•È¹•ÑÁ…ÉÑµ•¹Ğ¡Á…É…µÌ¹‘…Ñ„¹¥¤ì¥˜€ ……Á…ÉÑµ•¹Ğ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰…Á…ÉÑµ•¹Ñ}¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞÁÉ•™•ÉÉ•‘1…Õ¹‘Éä€ô…İ…¥Ğ±•‘•È¹•ÑAÉ•™•ÉÉ•‘1…Õ¹‘Éä¡…Á…ÉÑµ•¹Ğ¹¥¤ì(€€€¥˜€¡…Á…ÉÑµ•¹Ğ¹±…Ñ¥ÑÕ‘”€ôô¹Õ±°ñğ…Á…ÉÑµ•¹Ğ¹±½¹¥ÑÕ‘”€ôô¹Õ±°¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÈÈ¤¹Í•¹¡ì•ÉÉ½Èè€‰…Á…ÉÑµ•¹Ñ}±½…Ñ¥½¹}É•ÅÕ¥É•ˆ°ÁÉ•™•ÉÉ•‘1…Õ¹‘Éäô¤ì(€€€½¹ÍĞÅÕ•Éä€ôm½ÕĞé©Í½¹umÑ¥µ•½ÕĞèÄÁtì¡¹İÉmp‰Í¡½Ápˆõp‰±…Õ¹‘Éåp‰t¡…É½Õ¹èÔÀÀÀ°‘í…Á…ÉÑµ•¹Ğ¹±…Ñ¥ÑÕ‘•ô°‘í…Á…ÉÑµ•¹Ğ¹±½¹¥ÑÕ‘•ô¤í¹İÉmp‰…µ•¹¥Ñåpˆõp‰‘Éå•Ép‰t¡…É½Õ¹èÔÀÀÀ°‘í…Á…ÉÑµ•¹Ğ¹±…Ñ¥ÑÕ‘•ô°‘í…Á…ÉÑµ•¹Ğ¹±½¹¥ÑÕ‘•ô¤ì¤í½ÕĞ•¹Ñ•ÈÑ…Ìí€ì(€€€ÑÉäì(€€€€€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ•áÑ•É¹…±•Ñ  ‰¡ÑÑÁÌè¼½½Ù•ÉÁ…ÍÌµ…Á¤¹‘”½…Á¤½¥¹Ñ•ÉÁÉ•Ñ•Èˆ°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ĞµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½àµİİÜµ™½É´µÕÉ±•¹½‘•ˆ°€‰ÕÍ•Èµ…•¹Ğˆè€‰5…¥‘¥¼À¸Äˆô°‰½‘äè¹•ÜUI1M•…É¡A…É…µÌ¡ì‘…Ñ„èÅÕ•Éäô¤°Í¥¹…°è‰½ÉÑM¥¹…°¹Ñ¥µ•½ÕĞ ÄÉ|ÀÀÀ¤ô¤ì(€€€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤Ñ¡É½Ü¹•ÜÉÉ½È ‰½Ù•ÉÁ…ÍÍ}Õ¹…Ù…¥±…‰±”ˆ¤ì(€€€€€½¹ÍĞ‰½‘ä€ô…İ…¥ĞÉ•ÍÁ½¹Í”¹©Í½¸ ¤…Ìì•±•µ•¹ÑÌüèÉÉ…äñìÑåÁ”è€‰¹½‘”ˆğ€‰İ…äˆğ€‰É•±…Ñ¥½¸ˆì¥è¹Õµ‰•Èì±…Ğüè¹Õµ‰•Èì±½¸üè¹Õµ‰•Èì•¹Ñ•Èüèì±…Ğüè¹Õµ‰•Èì±½¸üè¹Õµ‰•ÈôìÑ…ÌüèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œøôøôì(€€€€€½¹ÍĞ…¹‘¥‘…Ñ•Ì€ô€¡‰½‘ä¹•±•µ•¹ÑÌ€üümt¤¹™±…Ñ5…À ¡•±•µ•¹Ğ¤€ôøì(€€€€€€€½¹ÍĞ±…Ñ¥ÑÕ‘”€ô•±•µ•¹Ğ¹±…Ğ€üü•±•µ•¹Ğ¹•¹Ñ•Èü¹±…Ğì½¹ÍĞ±½¹¥ÑÕ‘”€ô•±•µ•¹Ğ¹±½¸€üü•±•µ•¹Ğ¹•¹Ñ•Èü¹±½¸ì(€€€€€€€¥˜€¡±…Ñ¥ÑÕ‘”€ôô¹Õ±°ñğ±½¹¥ÑÕ‘”€ôô¹Õ±°¤É•ÑÕÉ¸mtì(€€€€€€€½¹ÍĞÑ…Ì€ô•±•µ•¹Ğ¹Ñ…Ì€üüíôì½¹ÍĞÍÑÉ••Ğ€ômÑ…Íl‰…‘‘Èé¡½ÕÍ•¹Õµ‰•È‰t°Ñ…Íl‰…‘‘ÈéÍÑÉ••Ğ‰ut¹™¥±Ñ•È¡	½½±•…¸¤¹©½¥¸ ˆ€ˆ¤ì(€€€€€€€É•ÑÕÉ¸mì½ÍµQåÁ”è•±•µ•¹Ğ¹ÑåÁ”°½Íµ%èMÑÉ¥¹œ¡•±•µ•¹Ğ¹¥¤°¹…µ”èÑ…Ì¹¹…µ”€üü€‹BFBÃFB×FB÷BÃF<ˆ°…‘‘É•ÍÌèÍÑÉ••Ğñğ¹Õ±°°±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”°‘¥ÍÑ…¹•5•Ñ•ÉÌè‘¥ÍÑ…¹•5•Ñ•ÉÌ¡…Á…ÉÑµ•¹Ğ¹±…Ñ¥ÑÕ‘”„°…Á…ÉÑµ•¹Ğ¹±½¹¥ÑÕ‘”„°±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”¤°‘Éå•É½¹™¥Éµ•èÑ…Ì¹…µ•¹¥Ñä€ôôô€‰‘Éå•ÈˆñğÑ…Ì¹‘Éå•È€ôôô€‰å•Ìˆ°µ…ÁÍUÉ°è¡ÑÑÁÌè¼½İİÜ¹½½±”¹½´½µ…ÁÌ½Í•…É ¼ı…Á¤ôÄ™ÅÕ•Éäô‘í±…Ñ¥ÑÕ‘•ô°‘í±½¹¥ÑÕ‘•õ€õtì(€€€€€ô¤¹Í½ÉĞ ¡„°ˆ¤€ôø„¹‘¥ÍÑ…¹•5•Ñ•ÉÌ€´ˆ¹‘¥ÍÑ…¹•5•Ñ•ÉÌ¤¹Í±¥” À°€Ì¤ì(€€€€€É•ÑÕÉ¸ìÁÉ•™•ÉÉ•‘1…Õ¹‘Éä°…¹‘¥‘…Ñ•Ìôì(€€€ô…Ñ ìÉ•ÑÕÉ¸É•Á±ä¹½‘” ÔÀÌ¤¹Í•¹¡ì•ÉÉ½Èè€‰±…Õ¹‘Éå}Í•…É¡}Õ¹…Ù…¥±…‰±”ˆ°ÁÉ•™•ÉÉ•‘1…Õ¹‘Éäô¤ìô(€ô¤ì(€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½…Á…ÉÑµ•¹ÑÌ¼é¥½±…Õ¹‘Éäµ±¥¹­Ìˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€¡ÁÉ½‘ÕÑI•±•…Í”€ğ€È¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰¹½Ñ}™½Õ¹ˆô¤ì(€€€½¹ÍĞÁ…É…µÌ€ô¥‘A…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì½¹ÍĞ¥¹ÁÕĞ€ô±…Õ¹‘Éå1¥¹­	½‘ä¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌñğ€…¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€±•ĞÁ±…”èM…Ù•‘A±…”ğ¹Õ±°€ô¹Õ±°ì(€€€¥˜€ ‰Á±…•%ˆ¥¸¥¹ÁÕĞ¹‘…Ñ„¤Á±…”€ô…İ…¥Ğ±•‘•È¹•ÑM…Ù•‘A±…”¡¥¹ÁÕĞ¹‘…Ñ„¹Á±…•%¤ì(€€€•±Í”ì(€€€€€½¹ÍĞ…¹‘¥‘…Ñ”€ô¥¹ÁÕĞ¹‘…Ñ„¹…¹‘¥‘…Ñ”ì(€€€€€Á±…”€ô…İ…¥Ğ±•‘•È¹™¥¹‘M…Ù•‘A±…•	å=Í´¡…¹‘¥‘…Ñ”¹½ÍµQåÁ”°…¹‘¥‘…Ñ”¹½Íµ%¤€üü…İ…¥Ğ±•‘•È¹É•…Ñ•M…Ù•‘A±…”¡ì­¥¹è€‰±…Õ¹‘Éäˆ°¹…µ”è…¹‘¥‘…Ñ”¹¹…µ”°…‘‘É•ÍÌè…¹‘¥‘…Ñ”¹…‘‘É•ÍÌ°¹½Ñ”è¹Õ±°°µ…ÁÍUÉ°è¡ÑÑÁÌè¼½İİÜ¹½½±”¹½´½µ…ÁÌ½Í•…É ¼ı…Á¤ôÄ™ÅÕ•Éäô‘í…¹‘¥‘…Ñ”¹±…Ñ¥ÑÕ‘•ô°‘í…¹‘¥‘…Ñ”¹±½¹¥ÑÕ‘•õ€°±…Ñ¥ÑÕ‘”è…¹‘¥‘…Ñ”¹±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”è…¹‘¥‘…Ñ”¹±½¹¥ÑÕ‘”°±½…Ñ¥½¹M½ÕÉ”è€‰½Í´ˆ°±½…Ñ¥½¹ÕÉ…å5•Ñ•ÉÌè¹Õ±°°½ÍµQåÁ”è…¹‘¥‘…Ñ”¹½ÍµQåÁ”°½Íµ%è…¹‘¥‘…Ñ”¹½Íµ%ô¤ì(€€€ô(€€€¥˜€ …Á±…”ñğÁ±…”¹­¥¹€„ôô€‰±…Õ¹‘Éäˆ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}±…Õ¹‘Éäˆô¤ì(€€€½¹ÍĞ±¥¹¬€ô…İ…¥Ğ±•‘•È¹Í•ÑAÉ•™•ÉÉ•‘1…Õ¹‘Éä¡Á…É…µÌ¹‘…Ñ„¹¥°Á±…”¹¥¤ìÉ•ÑÕÉ¸±¥¹¬€üìÁ±…”°±¥¹¬ô€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰…Á…ÉÑµ•¹Ñ}¹½Ñ}™½Õ¹ˆô¤ì(€ô¤ì((€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½ÁÉ•Ù¥•Üˆ°ì‰½‘å1¥µ¥Ğè€ÌÈ€¨€ÄÀÈĞ°½¹™¥œèìÉ…Ñ•1¥µ¥Ğèìµ…àè½¹™¥œ¹AIY%]}IQ}1%5%Q}5`°Ñ¥µ•]¥¹‘½Üè½¹™¥œ¹AIY%]}IQ}1%5%Q}]%9=\ôôô°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞ¥¹ÁÕĞ€ôÁÉ•Ù¥•İ	½‘ä¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆ°¥ÍÍÕ•Ìè¥¹ÁÕĞ¹•ÉÉ½È¹¥ÍÍÕ•Ì¹µ…À ¡ìÁ…Ñ °µ•ÍÍ…”ô¤€ôø€¡ìÁ…Ñ °µ•ÍÍ…”ô¤¤ô¤ì(€€€±•ĞÁ…ÉÍ•èA…ÉÍ•‘…äì±•ĞÍ½ÕÉ•Q•áĞèÍÑÉ¥¹œì(€€€ÑÉäì(€€€€€¥˜€ ‰™½Éµ…Ğˆ¥¸¥¹ÁÕĞ¹‘…Ñ„¤€¡ìÁ…ÉÍ•°Í½ÕÉ•Q•áĞô€ô…İ…¥Ğ‰Õ¥±‘MÑÉÕÑÕÉ•‘…ä¡¥¹ÁÕĞ¹‘…Ñ„°±•‘•È°™…±Í”¤¤ì(€€€€€•±Í”ìÁ…ÉÍ•€ô…İ…¥ĞÁ…ÉÍ”¡¥¹ÁÕĞ¹‘…Ñ„¹Ñ•áĞ¤ìÍ½ÕÉ•Q•áĞ€ô¥¹ÁÕĞ¹‘…Ñ„¹Ñ•áĞì¥˜€¡¥¹ÁÕĞ¹‘…Ñ„¹­¥¹¤Á…ÉÍ•¹­¥¹€ô¥¹ÁÕĞ¹‘…Ñ„¹­¥¹ìô(€€€ô…Ñ ìÉ•ÑÕÉ¸É•Á±ä¹½‘” ĞÈÈ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}‘…äˆô¤ìô(€€€½¹ÍĞÑ½Ñ…±Ì€ô…±Õ±…Ñ•…ä¡Á…ÉÍ•°Í•ÑÑ¥¹Ì¤ì(€€€½¹ÍĞ…¹M¡…É”€ôÁ…ÉÍ•¹‘…Ñ•%Í¼€„ôô¹Õ±°€˜˜Á…ÉÍ•¹©½‰Ì¹±•¹Ñ €ø€À€˜˜Á…ÉÍ•¹¥ÍÍÕ•Ì¹±•¹Ñ €ôôô€À€˜˜Á…ÉÍ•¹Õ¹Á…ÉÍ•‘1¥¹•Ì¹±•¹Ñ €ôôô€Àì(€€€½¹ÍĞ±•…¹•É%€ôÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥ì(€€€½¹ÍĞÍ¹…ÁÍ¡½Ğ€ô…¹M¡…É”€˜˜Á…ÉÍ•¹‘…Ñ•%Í¼€ü…İ…¥Ğ±•‘•È¹ÁÉ½©•Ñ…ä¡Á…ÉÍ•¹‘…Ñ•%Í¼°Ñ½Ñ…±Ì°Á…ÉÍ•¹…‘Ù…¹••¹ÑÌ°±•…¹•É%¤€è¹Õ±°ì(€€€½¹ÍĞ¡…Í1…Ñ•É¹ÑÉ¥•Ì€ôÁ…ÉÍ•¹‘…Ñ•%Í¼€ü€¡…İ…¥Ğ±•‘•È¹•Ñ1•‘•È¡Á…ÉÍ•¹‘…Ñ•%Í¼°µ½¹Ñ¡¹¡Á…ÉÍ•¹‘…Ñ•%Í¼¤°±•…¹•É%¤¤¹É½İÌ¹Í½µ” ¡É½Ü¤€ôøÉ½Ü¹‘…Ñ•%Í¼€øÁ…ÉÍ•¹‘…Ñ•%Í¼„¤€è™…±Í”ì(€€€É•ÑÕÉ¸ìÁ…ÉÍ•°Í½ÕÉ•Q•áĞ°Ñ½Ñ…±Ì°…‘Ù…¹••¹ÑÌèÁ…ÉÍ•¹…‘Ù…¹••¹ÑÌ°ÁÉ½©•Ñ•‘	…±…¹”èÍ¹…ÁÍ¡½Ğü¹Ñ½Ñ…°¹½ÕÑÍÑ…¹‘¥¹•¹ÑÌ€üü¹Õ±°°Í¹…ÁÍ¡½Ğ°¥ÍÍÕ•ÌèÁ…ÉÍ•¹¥ÍÍÕ•Ì°Õ¹Á…ÉÍ•‘1¥¹•ÌèÁ…ÉÍ•¹Õ¹Á…ÉÍ•‘1¥¹•Ì°…¹M¡…É”°¡…Í1…Ñ•É¹ÑÉ¥•Ì°Í¡…É•Q•áĞè…¹M¡…É”€˜˜Í¹…ÁÍ¡½Ğ€ü•¹•É…Ñ•M¡…É•Q•áĞ¡Á…ÉÍ•°Í•ÑÑ¥¹Ì°Í¹…ÁÍ¡½Ğ¤€è€ˆˆôì(€ô¤ì((€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½‘…åÌˆ°ì½¹™¥œèìÉ…Ñ•1¥µ¥Ğèìµ…àè½¹™¥œ¹AIY%]}IQ}1%5%Q}5`°Ñ¥µ•]¥¹‘½Üè½¹™¥œ¹AIY%]}IQ}1%5%Q}]%9=\ôôô°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞ¥¹ÁÕĞ€ôÁÉ•Ù¥•İ	½‘ä¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€±•ĞÁ…ÉÍ•èA…ÉÍ•‘…äì±•ĞÍ½ÕÉ•Q•áĞèÍÑÉ¥¹œì(€€€ÑÉäì(€€€€€¥˜€ ‰™½Éµ…Ğˆ¥¸¥¹ÁÕĞ¹‘…Ñ„¤€¡ìÁ…ÉÍ•°Í½ÕÉ•Q•áĞô€ô…İ…¥Ğ‰Õ¥±‘MÑÉÕÑÕÉ•‘…ä¡¥¹ÁÕĞ¹‘…Ñ„°±•‘•È°ÑÉÕ”¤¤ì(€€€€€•±Í”ìÁ…ÉÍ•€ô…İ…¥ĞÁ…ÉÍ”¡¥¹ÁÕĞ¹‘…Ñ„¹Ñ•áĞ¤ìÍ½ÕÉ•Q•áĞ€ô¥¹ÁÕĞ¹‘…Ñ„¹Ñ•áĞì¥˜€¡¥¹ÁÕĞ¹‘…Ñ„¹­¥¹¤Á…ÉÍ•¹­¥¹€ô¥¹ÁÕĞ¹‘…Ñ„¹­¥¹ìô(€€€ô…Ñ ìÉ•ÑÕÉ¸É•Á±ä¹½‘” ĞÈÈ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}‘…äˆô¤ìô(€€€½¹ÍĞ…¹M…Ù”€ôÁ…ÉÍ•¹‘…Ñ•%Í¼€„ôô¹Õ±°€˜˜Á…ÉÍ•¹©½‰Ì¹±•¹Ñ €ø€À€˜˜Á…ÉÍ•¹¥ÍÍÕ•Ì¹±•¹Ñ €ôôô€À€˜˜Á…ÉÍ•¹Õ¹Á…ÉÍ•‘1¥¹•Ì¹±•¹Ñ €ôôô€Àì(€€€¥˜€ ……¹M…Ù”ñğ€…Á…ÉÍ•¹‘…Ñ•%Í¼¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÈÈ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}‘…äˆô¤ì(€€€½¹ÍĞÑ½Ñ…±Ì€ô…±Õ±…Ñ•…ä¡Á…ÉÍ•°Í•ÑÑ¥¹Ì¤ì(€€€½¹ÍĞ±•…¹•É%€ôÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥ì(€€€½¹ÍĞÁÉ½©•Ñ•€ô…İ…¥Ğ±•‘•È¹ÁÉ½©•Ñ…ä¡Á…ÉÍ•¹‘…Ñ•%Í¼°Ñ½Ñ…±Ì°Á…ÉÍ•¹…‘Ù…¹••¹ÑÌ°±•…¹•É%¤ì(€€€½¹ÍĞÉ•Á½ÉÑQ•áĞ€ô•¹•É…Ñ•M¡…É•Q•áĞ¡Á…ÉÍ•°Í•ÑÑ¥¹Ì°ÁÉ½©•Ñ•¤ì(€€€½¹ÍĞÍ…Ù•€ô…İ…¥Ğ±•‘•È¹Í…Ù•…ä¡ì‘…Ñ•%Í¼èÁ…ÉÍ•¹‘…Ñ•%Í¼°Í½ÕÉ•Q•áĞ°Á…ÉÍ•‘•Ñ…¥±ÌèÁ…ÉÍ•°Ñ½Ñ…±Ì°…‘Ù…¹••¹ÑÌèÁ…ÉÍ•¹…‘Ù…¹••¹ÑÌ°É•Á½ÉÑQ•áĞô°±•…¹•É%¤ì(€€€É•ÑÕÉ¸ì‘…äèÍ…Ù•¹‘…ä°ÉÕ¹¹¥¹	…±…¹”èÍ…Ù•¹Í¹…ÁÍ¡½Ğ¹Ñ½Ñ…°¹½ÕÑÍÑ…¹‘¥¹•¹ÑÌ°Í¹…ÁÍ¡½ĞèÍ…Ù•¹Í¹…ÁÍ¡½Ğ°Í¡…É•Q•áĞèÉ•Á½ÉÑQ•áĞôì(€ô¤ì((€…ÁÀ¹‘•±•Ñ” ˆ½…Á¤½‘…åÌ¼é‘…Ñ•%Í¼ˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞÁ…É…µÌ€ôè¹½‰©•Ğ¡ì‘…Ñ•%Í¼è‘…Ñ”ô¤¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì(€€€¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€É•ÑÕÉ¸€¡…İ…¥Ğ±•‘•È¹‘•±•Ñ•…ä¡Á…É…µÌ¹‘…Ñ„¹‘…Ñ•%Í¼°ÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥¤¤€üÉ•Á±ä¹½‘” ÈÀĞ¤¹Í•¹ ¤€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰‘…å}¹½Ñ}™½Õ¹ˆô¤ì(€ô¤ì((€…ÁÀ¹•Ğ ˆ½…Á¤½±•‘•Èˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞÅÕ•Éä€ô±•‘•ÉEÕ•Éä¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹ÅÕ•Éä¤ì(€€€¥˜€ …ÅÕ•Éä¹ÍÕ•ÍÌñğ€¡ÅÕ•Éä¹‘…Ñ„¹™É½´€˜˜ÅÕ•Éä¹‘…Ñ„¹Ñ¼€˜˜ÅÕ•Éä¹‘…Ñ„¹™É½´€øÅÕ•Éä¹‘…Ñ„¹Ñ¼¤¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞ±•…¹•É%€ôÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥ì(€€€½¹ÍĞÙ¥•Ü€ô…İ…¥Ğ±•‘•È¹•Ñ1•‘•È¡ÅÕ•Éä¹‘…Ñ„¹™É½´°ÅÕ•Éä¹‘…Ñ„¹Ñ¼°±•…¹•É%¤ì(€€€½¹ÍĞÉ½İÌ€ô…İ…¥ĞAÉ½µ¥Í”¹…±°¡Ù¥•Ü¹É½İÌ¹µ…À¡…Íå¹Œ€¡É½Ü¤€ôøì(€€€€€¥˜€¡É½Ü¹É½İQåÁ”€„ôô€‰İ½É¬ˆ¤É•ÑÕÉ¸É½Üì(€€€€€½¹ÍĞÍ¹…ÁÍ¡½Ğ€ô…İ…¥Ğ±•‘•È¹ÁÉ½©•Ñ…ä¡É½Ü¹‘…Ñ•%Í¼°ì(€€€€€€€µ¥¹ÕÑ•ÌèÉ½Ü¹µ¥¹ÕÑ•Ì°¥¹½µ••¹ÑÌèÉ½Ü¹¥¹½µ••¹ÑÌ°•áÁ•¹Í•Í•¹ÑÌèÉ½Ü¹•áÁ•¹Í•Í•¹ÑÌ°¡•­¥¹•¹ÑÌèÉ½Ü¹¡•­¥¹•¹ÑÌ°(€€€€€ô°É½Ü¹Á…ÉÍ•‘•Ñ…¥±Ì¹…‘Ù…¹••¹ÑÌ°±•…¹•É%¤ì(€€€€€É•ÑÕÉ¸ì€¸¸¹É½Ü°É•Á½ÉÑQ•áĞè•¹•É…Ñ•M¡…É•Q•áĞ¡É½Ü¹Á…ÉÍ•‘•Ñ…¥±Ì°Í•ÑÑ¥¹Ì°Í¹…ÁÍ¡½Ğ¤ôì(€€€ô¤¤ì(€€€É•ÑÕÉ¸ì€¸¸¹Ù¥•Ü°É½İÌôì(€ô¤ì((€…ÁÀ¹•Ğ ˆ½…Á¤½Á•É¥½‘Ìˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôø€¡ìÁ•É¥½‘Ìè…İ…¥Ğ±•‘•È¹±¥ÍÑA•É¥½‘Ì¡ÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥¤ô¤¤ì((€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½Á…åµ•¹ÑÌˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞ¥¹ÁÕĞ€ôÁ…åµ•¹ÑÉ•…Ñ”¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€É•ÑÕÉ¸É•Á±ä¹½‘” ÈÀÄ¤¹Í•¹¡ìÁ…åµ•¹Ğè…İ…¥Ğ±•‘•È¹É•…Ñ•A…åµ•¹Ğ¡¥¹ÁÕĞ¹‘…Ñ„¹‘…Ñ•%Í¼°¥¹ÁÕĞ¹‘…Ñ„¹…µ½Õ¹Ñ•¹ÑÌ°¥¹ÁÕĞ¹‘…Ñ„¹¹½Ñ”°ÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥¤ô¤ì(€ô¤ì((€…ÁÀ¹Á…Ñ  ˆ½…Á¤½Á…åµ•¹ÑÌ¼é¥ˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞÁ…É…µÌ€ôÁ…åµ•¹ÑA…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì½¹ÍĞ¥¹ÁÕĞ€ôÁ…åµ•¹ÑA…Ñ ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌñğ€…¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€½¹ÍĞÁ…åµ•¹Ğ€ô…İ…¥Ğ±•‘•È¹ÕÁ‘…Ñ•A…åµ•¹Ğ¡Á…É…µÌ¹‘…Ñ„¹¥°¥¹ÁÕĞ¹‘…Ñ„°ÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥¤ì(€€€É•ÑÕÉ¸Á…åµ•¹Ğ€üìÁ…åµ•¹Ğô€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰Á…åµ•¹Ñ}¹½Ñ}™½Õ¹ˆô¤ì(€ô¤ì((€…ÁÀ¹‘•±•Ñ” ˆ½…Á¤½Á…åµ•¹ÑÌ¼é¥ˆ°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€½¹ÍĞÁ…É…µÌ€ôÁ…åµ•¹ÑA…É…µÌ¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹Á…É…µÌ¤ì(€€€¥˜€ …Á…É…µÌ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆô¤ì(€€€É•ÑÕÉ¸€¡…İ…¥Ğ±•‘•È¹‘•±•Ñ•A…åµ•¹Ğ¡Á…É…µÌ¹‘…Ñ„¹¥°ÕÉÉ•¹Ñ±•…¹•È¡É•ÅÕ•ÍĞ¤¹¥¤¤€üÉ•Á±ä¹½‘” ÈÀĞ¤¹Í•¹ ¤€èÉ•Á±ä¹½‘” ĞÀĞ¤¹Í•¹¡ì•ÉÉ½Èè€‰Á…åµ•¹Ñ}¹½Ñ}™½Õ¹ˆô¤ì(€ô¤ì((€…ÁÀ¹Á½ÍĞ ˆ½…Á¤½…‘µ¥¸½…Á…ÉÑµ•¹ÑÌ½¥µÁ½ÉĞˆ°ì‰½‘å1¥µ¥Ğè€ÄØ€¨€ÄÀÈĞ€¨€ÄÀÈĞô°…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€¥˜€ …½¹™¥œ¹AIQ59Q}%5A=IQ}Q=-8¤É•ÑÕÉ¸É•Á±ä¹½‘” ÔÀÌ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥µÁ½ÉÑ}‘¥Í…‰±•ˆô¤ì(€€€½¹ÍĞ…ÕÑ¡½É¥é…Ñ¥½¸€ôÉ•ÅÕ•ÍĞ¹¡•…‘•ÉÌ¹…ÕÑ¡½É¥é…Ñ¥½¸ì(€€€½¹ÍĞÁÉ½Ù¥‘•€ô…ÕÑ¡½É¥é…Ñ¥½¸ü¹ÍÑ…ÉÑÍ]¥Ñ  ‰	•…É•È€ˆ¤€ü…ÕÑ¡½É¥é…Ñ¥½¸¹Í±¥” Ü¤€è€ˆˆì(€€€½¹ÍĞ•áÁ•Ñ•‘	Õ™™•È€ô	Õ™™•È¹™É½´¡½¹™¥œ¹AIQ59Q}%5A=IQ}Q=-8¤ì(€€€½¹ÍĞÁÉ½Ù¥‘•‘	Õ™™•È€ô	Õ™™•È¹™É½´¡ÁÉ½Ù¥‘•¤ì(€€€¥˜€¡•áÁ•Ñ•‘	Õ™™•È¹±•¹Ñ €„ôôÁÉ½Ù¥‘•‘	Õ™™•È¹±•¹Ñ ñğ€…Ñ¥µ¥¹M…™•ÅÕ…°¡•áÁ•Ñ•‘	Õ™™•È°ÁÉ½Ù¥‘•‘	Õ™™•È¤¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÄ¤¹Í•¹¡ì•ÉÉ½Èè€‰Õ¹…ÕÑ¡½É¥é•ˆô¤ì(€€€½¹ÍĞ¥¹ÁÕĞ€ô…Á…ÉÑµ•¹Ñ%µÁ½ÉÑ	½‘ä¹Í…™•A…ÉÍ”¡É•ÅÕ•ÍĞ¹‰½‘ä¤ì(€€€¥˜€ …¥¹ÁÕĞ¹ÍÕ•ÍÌ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀÀ¤¹Í•¹¡ì•ÉÉ½Èè€‰¥¹Ù…±¥‘}É•ÅÕ•ÍĞˆ°¥ÍÍÕ•Ìè¥¹ÁÕĞ¹•ÉÉ½È¹¥ÍÍÕ•Ì¹µ…À ¡ìÁ…Ñ °µ•ÍÍ…”ô¤€ôø€¡ìÁ…Ñ °µ•ÍÍ…”ô¤¤ô¤ì(€€€½¹ÍĞÍ••¹M½ÕÉ•Ì€ô¹•ÜM•ĞñÍÑÉ¥¹œø ¤ì½¹ÍĞÍ••¹…¹½¹¥…°€ô¹•ÜM•ĞñÍÑÉ¥¹œø ¤ì½¹ÍĞ‘ÕÁ±¥…Ñ•½¹™±¥ÑÌèÉÉ…äñìÍ½ÕÉ•-•äèÍÑÉ¥¹œìÉ•…Í½¸èÍÑÉ¥¹œôø€ômtì(€€€™½È€¡½¹ÍĞ¥Ñ•´½˜¥¹ÁÕĞ¹‘…Ñ„¹…Á…ÉÑµ•¹ÑÌ¤ì(€€€€€½¹ÍĞ…¹½¹¥…°€ô…Á…ÉÑµ•¹Ñ-•ä¡¥Ñ•´¹…¹½¹¥…±9…µ”¤ì(€€€€€¥˜€¡Í••¹M½ÕÉ•Ì¹¡…Ì¡¥Ñ•´¹Í½ÕÉ•-•ä¤ñğÍ••¹…¹½¹¥…°¹¡…Ì¡…¹½¹¥…°¤¤‘ÕÁ±¥…Ñ•½¹™±¥ÑÌ¹ÁÕÍ ¡ìÍ½ÕÉ•-•äè¥Ñ•´¹Í½ÕÉ•-•ä°É•…Í½¸è€‰‘ÕÁ±¥…Ñ•}¥¹}Á…å±½…ˆô¤ì(€€€€€Í••¹M½ÕÉ•Ì¹…‘¡¥Ñ•´¹Í½ÕÉ•-•ä¤ìÍ••¹…¹½¹¥…°¹…‘¡…¹½¹¥…°¤ì(€€€ô(€€€¥˜€¡‘ÕÁ±¥…Ñ•½¹™±¥ÑÌ¹±•¹Ñ ¤É•ÑÕÉ¸É•Á±ä¹½‘” ĞÀä¤¹Í•¹¡ìÉ•…Ñ•è€À°ÕÁ‘…Ñ•è€À°Í­¥ÁÁ•è€À°½¹™±¥ÑÌè‘ÕÁ±¥…Ñ•½¹™±¥ÑÌô¤ì(€€€½¹ÍĞ‘ÉåIÕ¸€ô€¡É•ÅÕ•ÍĞ¹ÅÕ•Éä…Ìì‘ÉåIÕ¸üèÍÑÉ¥¹œô¤¹‘ÉåIÕ¸€ôôô€‰ÑÉÕ”ˆì(€€€½¹ÍĞÉ•ÍÕ±Ğ€ô…İ…¥Ğ±•‘•È¹¥µÁ½ÉÑÁ…ÉÑµ•¹ÑÌ¡¥¹ÁÕĞ¹‘…Ñ„¹…Á…ÉÑµ•¹ÑÌ°‘ÉåIÕ¸¤ì(€€€É•ÑÕÉ¸ì‘ÉåIÕ¸°…•ÁÑ•èÉ•ÍÕ±Ğ¹É•…Ñ•€¬É•ÍÕ±Ğ¹ÕÁ‘…Ñ•€¬É•ÍÕ±Ğ¹Í­¥ÁÁ•°€¸¸¹É•ÍÕ±Ğôì(€ô¤ì(€™½È€¡½¹ÍĞÉ½ÕÑ”½˜lˆ½Ñ½‘…äˆ°€ˆ½µ…Àˆ°€ˆ½±•‘•Èˆ°€ˆ½µ…À½…Á…ÉÑµ•¹ÑÌ¼é¥ˆ°€ˆ½…Á…ÉÑµ•¹Ğ¹¡Ñµ°‰t¤…ÁÀ¹•Ğ¡É½ÕÑ”°…Íå¹Œ€¡}É•ÅÕ•ÍĞ°É•Á±ä¤€ôøÉ•Á±ä¹Í•¹‘¥±” ‰¥¹‘•à¹¡Ñµ°ˆ¤¤ì(€É•ÑÕÉ¸…ÁÀì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ…ÉĞ ¤èAÉ½µ¥Í”ñÙ½¥øì½¹ÍĞ½¹™¥œ€ô±½…‘½¹™¥œ ¤ì½¹ÍĞ…ÁÀ€ô…İ…¥Ğ‰Õ¥±‘ÁÀ¡½¹™¥œ¤ì…İ…¥Ğ…ÁÀ¹±¥ÍÑ•¸¡ìÁ½ÉĞè½¹™¥œ¹A=IP°¡½ÍĞè½¹™¥œ¹!=MPô¤ìô)½¹ÍĞ•¹ÑÉåA½¥¹Ğ€ôÑåÁ•½˜ÁÉ½•ÍÌ€„ôô€‰Õ¹‘•™¥¹•ˆ€˜˜ÁÉ½•ÍÌ¹…ÉÙlÅt€üÁ…Ñ¡Q½¥±•UI0¡É•Í½±Ù”¡ÁÉ½•ÍÌ¹…ÉÙlÅt¤¤¹¡É•˜€è€ˆˆì)¥˜€¡¥µÁ½ÉĞ¹µ•Ñ„¹ÕÉ°€ôôô•¹ÑÉåA½¥¹Ğ¤…İ…¥ĞÍÑ…ÉĞ ¤ì(