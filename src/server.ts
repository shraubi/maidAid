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
import type { Apartment, Expense, Job, LocationSource, ParsedDay, SavedPlace, Settings, WorkType } from "./domain/types.js";
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

const supportedMapsHosts = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl"]);

export function mapsUrlsFromApartmentNote(noteBody: string | null | undefined): string[] {
  const matches = noteBody?.match(/https:\/\/[^\s<>"']+/gu) ?? [];
  const urls: string[] = [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;!?\]}]+$/u, "");
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || !supportedMapsHosts.has(url.hostname.toLocaleLowerCase("en"))) continue;
      url.hash = "";
      const normalized = url.href;
      if (!urls.includes(normalized)) urls.push(normalized);
    } catch { /* Ignore prose that only resembles a URL. */ }
  }
  return urls;
}

export async function syncApartmentNoteDryers(apartment: Apartment, ledger: LedgerStore, externalFetch: typeof fetch): Promise<number> {
  const mapsUrls = mapsUrlsFromApartmentNote(apartment.noteBody);
  let created = 0;
  for (const [index, mapsUrl] of mapsUrls.entries()) {
    try {
      let place = await ledger.findSavedPlaceByMapsUrl(mapsUrl);
      if (!place) {
        const { inferredAddress, ...location } = await resolveLocation({ mapsUrl }, externalFetch);
        place = await ledger.createSavedPlace({
          kind: "laundry", name: "Сушка", address: inferredAddress ?? null,
          note: `Из заметки квартиры ${apartment.canonicalName}`, mapsUrl, ...location,
        });
        created += 1;
      }
      if (index === 0) await ledger.setPreferredLaundry(apartment.id, place.id);
    } catch { /* Apartment saving and startup must not fail because a note link is unavailable. */ }
  }
  return created;
}

async function syncAllApartmentNoteDryers(ledger: LedgerStore, externalFetch: typeof fetch): Promise<number> {
  let created = 0;
  for (const apartment of await ledger.getActiveApartments()) created += await syncApartmentNoteDryers(apartment, ledger, externalFetch);
  return created;
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
  const type = { independent: "уборка", orientation: "ознакомление", practice: "практика", checkin: "check in", unknown: "" }[workType];
  const hours = Number((durationMinutes / 60).toFixed(2));
  const expenses = [dryerCents > 0 ? `сушка ${(dryerCents / 100).toFixed(2)}€` : "", otherExpenseCents > 0 ? `расходы ${(otherExpenseCents / 100).toFixed(2)}€` : ""].filter(Boolean).join(" + ");
  return `${name} ${hours}h ${type}${expenses ? ` ${expenses}` : ""}`;
}

async function buildStructuredDay(input: StructuredDayInput, ledger: LedgerStore, createMissing: boolean): Promise<{ parsed: ParsedDay; sourceText: string }> {
  const activeApartments = await ledger.getActiveApartments();
  const byId = new Map(activeApartments.map((apartment) => [apartment.id, apartment]));
  const byKey = apartmentLookup(activeApartments);
  const jobs: Job[] = [];
  const expenses: Expense[] = [];
  const sourceLines: string[] = [];

  for (const inputJob of input.jobs) {
    let apartment = inputJob.apartmentId ? byId.get(inputJob.apartmentId) : undefined;
    const requestedName = inputJob.newApartmentName?.trim();
    if (!apartment && requestedName) apartment = byKey.get(apartmentKey(requestedName));
    if (!apartment && requestedName && createMissing) {
      try {
        apartment = await ledger.createApartment({ canonicalName: requestedName, aliases: [], address: null, mapsUrl: null, noteBody: null, latitude: null, longitude: null, locationSource: null, locationAccuracyMeters: null });
      } catch {
        apartment = apartmentLookup(await ledger.getActiveApartments()).get(apartmentKey(requestedName));
      }
      if (apartment) {
        byId.set(apartment.id, apartment);
        for (const alias of [apartment.canonicalName, ...apartment.aliases]) byKey.set(apartmentKey(alias), apartment);
      }
    }
    if (createMissing && requestedName && !apartment) throw new Error("apartment_create_failed");
    if (!apartment && !requestedName) throw new Error("apartment_not_found");
    const object = apartment?.canonicalName ?? requestedName!;
    const durationMinutes = structuredDuration(inputJob.workType, inputJob.durationMinutes);
    const sourceLine = structuredSourceLine(object, inputJob.workType, durationMinutes, inputJob.dryerCents, inputJob.otherExpenseCents);
    const jobIndex = jobs.length;
    jobs.push({
      object, apartmentId: apartment?.id ?? null, address: apartment?.address ?? null, mapsUrl: apartment?.mapsUrl ?? null,
      noteBody: apartment?.noteBody ?? null, startMinutes: null, endMinutes: null, durationMinutes, endInferred: false,
      workType: inputJob.workType, sourceLine,
    });
    if (inputJob.dryerCents > 0) expenses.push({ category: "сушка", object, jobIndex, amountCents: inputJob.dryerCents, sourceLine });
    if (inputJob.otherExpenseCents > 0) expenses.push({ category: "расходы", object, jobIndex, amountCents: inputJob.otherExpenseCents, sourceLine });
    sourceLines.push(sourceLine);
  }

  const [year, month, day] = input.dateIso.split("-");
  const displayDate = `${day}/${month}`;
  const parsed: ParsedDay = { dateIso: input.dateIso, displayDate, kind: "actual", jobs, expenses, advanceCents: 0, unparsedLines: [], issues: [] };
  return { parsed, sourceText: [`${day}/${month}/${year}`, ...sourceLines].join("\n") };
}

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const radians = (value: number) => value * Math.PI / 180; const earth = 6_371_000;
  const dLat = radians(bLat - aLat); const dLon = radians(bLon - aLon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earth * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)));
}

export async function buildApp(config: Config = loadConfig(), providedStore?: LedgerStore, externalFetch: typeof fetch = fetch): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: true });
  const productRelease = config.PRODUCT_RELEASE ?? 2;
  const settings: Settings = {
    hourlyRateCents: config.HOURLY_RATE_CENTS,
    orientationFlatCents: config.ORIENTATION_FLAT_CENTS,
    practiceFlatCents: config.PRACTICE_FLAT_CENTS,
    checkinFlatCents: config.CHECKIN_FLAT_CENTS,
    dryerDefaultCents: config.DRYER_DEFAULT_CENTS,
  };
  const ledger = providedStore ?? new PostgresLedgerStore(config.DATABASE_URL);
  const configuredInitialCleaner = await prepareInitialCleaner(config.INITIAL_CLEANER_NAME ?? "", config.INITIAL_CLEANER_PIN ?? "");
  const initialCleaner = configuredInitialCleaner ?? (config.AUTH_TEST_BYPASS ? await prepareInitialCleaner("Test Cleaner", "123456") : null);
  await ledger.initialize(initialCleaner);
  let bypassCleaner = config.AUTH_TEST_BYPASS ? (await ledger.listCleaners())[0] ?? null : null;
  if (config.AUTH_TEST_BYPASS && !bypassCleaner) {
    const digest = await createPinDigest("123456");
    bypassCleaner = await ledger.createCleaner({ name: "Test Cleaner", nameKey: normalizeCleanerName("Test Cleaner"), ...digest });
  }
  app.addHook("onListen", () => {
    void repairLegacyMapCoordinates(ledger, externalFetch)
      .then((repairedLocations) => { if (repairedLocations > 0) app.log.info({ repairedLocations }, "repaired legacy map coordinates"); })
      .catch((error) => app.log.error({ err: error }, "failed to repair legacy map coordinates"));
    if (productRelease >= 2) void syncAllApartmentNoteDryers(ledger, externalFetch)
      .then((createdNoteDryers) => { if (createdNoteDryers > 0) app.log.info({ createdNoteDryers }, "imported dryers from apartment notes"); })
      .catch((error) => app.log.error({ err: error }, "failed to import dryers from apartment notes"));
  });
  const parse = async (text: string) => parseDay(text, new Date(), settings.dryerDefaultCents, apartmentLookup(await ledger.getActiveApartments()));
  app.addHook("onClose", async () => ledger.close());
  await app.register(rateLimit, { global: false, max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW });
  await app.register(fastifyStatic, {
    root: publicRoot,
    wildcard: false,
    cacheControl: false,
    setHeaders(response, filePath) {
      if (filePath.endsWith("sw.js")) {
        response.setHeader("Cache-Control", "no-store");
        return;
      }
      if (/\.(?:html|js|css|webmanifest)$/.test(filePath)) response.setHeader("Cache-Control", "no-cache");
    },
  });
  await app.register(fastifyStatic, { root: leafletRoot, prefix: "/vendor/leaflet/", decorateReply: false, cacheControl: true, maxAge: "30d" });

  const authenticatedCleaners = new WeakMap<object, Cleaner>();
  const publicApiPaths = new Set(["/api/app-config", "/api/auth/me", "/api/auth/login", "/api/auth/register", "/api/auth/logout"]);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (!path.startsWith("/api/") || publicApiPaths.has(path) || path === "/api/admin/apartments/import") return;
    if (config.AUTH_TEST_BYPASS && bypassCleaner) { authenticatedCleaners.set(request, bypassCleaner); return; }
    const token = cookieValue(request.headers.cookie, "maidaid_session");
    const cleaner = token ? await ledger.getCleanerBySession(hashSessionToken(token)) : null;
    if (!cleaner) return reply.code(401).send({ error: "authentication_required" });
    authenticatedCleaners.set(request, cleaner);
  });
  const currentCleaner = (request: object): Cleaner => {
    const cleaner = authenticatedCleaners.get(request);
    if (!cleaner) throw new Error("authenticated cleaner missing");
    return cleaner;
  };

  const startSession = async (request: { protocol: string }, reply: { header(name: string, value: string): unknown }, cleaner: Cleaner) => {
    const sessionDays = config.SESSION_DAYS ?? 90;
    const expiresAt = new Date(Date.now() + sessionDays * 86_400_000);
    const { token, tokenHash } = createSessionToken();
    await ledger.createSession(cleaner.id, tokenHash, expiresAt);
    reply.header("Set-Cookie", sessionCookie(token, sessionDays * 86_400, request.protocol === "https"));
  };

  app.get("/health", async (_request, reply) => {
    const database = await ledger.health();
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "unavailable", service: "MaidAid", database });
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (config.AUTH_TEST_BYPASS && bypassCleaner) return { cleaner: bypassCleaner };
    const token = cookieValue(request.headers.cookie, "maidaid_session");
    const cleaner = token ? await ledger.getCleanerBySession(hashSessionToken(token)) : null;
    return cleaner ? { cleaner } : reply.code(401).send({ error: "authentication_required" });
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = loginBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const cleaner = await ledger.findCleanerByNameKey(normalizeCleanerName(input.data.name));
    if (!cleaner || !cleaner.active || !await verifyPin(input.data.pin, cleaner.pinSalt, cleaner.pinHash)) return reply.code(401).send({ error: "invalid_credentials" });
    await startSession(request, reply, cleaner);
    return { cleaner: { id: cleaner.id, name: cleaner.name, active: cleaner.active, createdAt: cleaner.createdAt, updatedAt: cleaner.updatedAt } };
  });

  app.post("/api/auth/register", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = registerBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const teamCode = config.TEAM_ACCESS_CODE ?? "";
    if (!teamCode) return reply.code(503).send({ error: "registration_disabled" });
    if (!secretMatches(input.data.teamCode, teamCode)) return reply.code(401).send({ error: "invalid_team_code" });
    const name = input.data.name.normalize("NFKC").trim().replace(/\s+/g, " ");
    const digest = await createPinDigest(input.data.pin);
    try {
      const cleaner = await ledger.createCleaner({ name, nameKey: normalizeCleanerName(name), ...digest });
      await startSession(request, reply, cleaner);
      return reply.code(201).send({ cleaner });
    } catch (error) { return (error as Error).message === "cleaner_exists" ? reply.code(409).send({ error: "cleaner_exists" }) : reply.code(500).send({ error: "registration_failed" }); }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = cookieValue(request.headers.cookie, "maidaid_session");
    if (token) await ledger.deleteSession(hashSessionToken(token));
    reply.header("Set-Cookie", sessionCookie("", 0, request.protocol === "https"));
    return reply.code(204).send();
  });

  app.get("/api/app-config", async () => ({ productRelease }));

  app.get("/api/apartments", async () => ({ apartments: await ledger.getActiveApartments() }));
  app.get("/api/apartments/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params); if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const apartment = await ledger.getApartment(params.data.id); if (!apartment) return reply.code(404).send({ error: "apartment_not_found" });
    return { apartment, preferredLaundry: productRelease >= 2 ? await ledger.getPreferredLaundry(apartment.id) : null };
  });
  app.post("/api/apartments", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const input = apartmentCreate.safeParse(request.body); if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const { inferredAddress, ...location } = await resolveLocation(input.data, externalFetch);
    try {
      const apartment = await ledger.createApartment({ canonicalName: input.data.canonicalName, aliases: input.data.aliases, address: input.data.address ?? inferredAddress ?? null, mapsUrl: input.data.mapsUrl ?? null, noteBody: input.data.noteBody ?? null, ...location });
      if (productRelease >= 2) await syncApartmentNoteDryers(apartment, ledger, externalFetch);
      return reply.code(201).send({ apartment });
    } catch { return reply.code(409).send({ error: "apartment_exists" }); }
  });
  app.patch("/api/apartments/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params); const input = apartmentPatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const current = await ledger.getApartment(params.data.id); if (!current) return reply.code(404).send({ error: "apartment_not_found" });
    const locationChanged = input.data.address !== undefined || input.data.mapsUrl !== undefined || input.data.latitude !== undefined || input.data.longitude !== undefined;
    const resolved = locationChanged ? await resolveLocation(input.data, externalFetch) : { latitude: current.latitude, longitude: current.longitude, locationSource: current.locationSource, locationAccuracyMeters: current.locationAccuracyMeters, inferredAddress: undefined };
    const { inferredAddress, ...location } = resolved;
    try {
      const apartment = await ledger.updateApartment(params.data.id, { ...input.data, ...(input.data.address === undefined && inferredAddress ? { address: inferredAddress } : {}), ...location });
      if (apartment && productRelease >= 2 && input.data.noteBody !== undefined) await syncApartmentNoteDryers(apartment, ledger, externalFetch);
      return { apartment };
    } catch { return reply.code(409).send({ error: "apartment_exists" }); }
  });

  app.get("/api/places", async (_request, reply) => productRelease >= 2 ? { places: await ledger.getSavedPlaces() } : reply.code(404).send({ error: "not_found" }));
  app.post("/api/places", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const input = placeCreate.safeParse(request.body); if (!input.success || (input.success && input.data.kind === "partner_restaurant" && !input.data.name)) return reply.code(400).send({ error: "invalid_request" });
    const { inferredAddress, ...location } = await resolveLocation(input.data, externalFetch);
    const place = await ledger.createSavedPlace({ kind: input.data.kind, name: input.data.name || "Сушка", address: input.data.address ?? inferredAddress ?? null, note: input.data.note ?? null, mapsUrl: input.data.mapsUrl ?? null, ...location });
    if (input.data.kind === "laundry" && input.data.apartmentId) await ledger.setPreferredLaundry(input.data.apartmentId, place.id);
    return reply.code(201).send({ place });
  });
  app.patch("/api/places/:id", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const params = idParams.safeParse(request.params); const input = placePatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const current = await ledger.getSavedPlace(params.data.id); if (!current) return reply.code(404).send({ error: "place_not_found" });
    if ((input.data.kind ?? current.kind) === "partner_restaurant" && input.data.name !== undefined && !input.data.name) return reply.code(400).send({ error: "invalid_request" });
    const locationChanged = input.data.address !== undefined || input.data.mapsUrl !== undefined || input.data.latitude !== undefined || input.data.longitude !== undefined;
    const resolved = locationChanged ? await resolveLocation(input.data, externalFetch) : { latitude: current.latitude, longitude: current.longitude, locationSource: current.locationSource, locationAccuracyMeters: current.locationAccuracyMeters, inferredAddress: undefined };
    const { inferredAddress, ...location } = resolved;
    const values = { ...input.data, ...(input.data.address === undefined && inferredAddress ? { address: inferredAddress } : {}), ...(input.data.kind === "laundry" && !input.data.name ? { name: "Сушка" } : {}), ...location };
    const place = await ledger.updateSavedPlace(params.data.id, values); return { place };
  });
  app.delete("/api/places/:id", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const params = idParams.safeParse(request.params); if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    return await ledger.archiveSavedPlace(params.data.id) ? reply.code(204).send() : reply.code(404).send({ error: "place_not_found" });
  });

  app.get("/api/apartments/:id/nearby-laundries", async (request, reply) => {
    if (productRelease < 3) return reply.code(404).send({ error: "not_found" });
    const params = idParams.safeParse(request.params); if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const apartment = await ledger.getApartment(params.data.id); if (!apartment) return reply.code(404).send({ error: "apartment_not_found" });
    const preferredLaundry = await ledger.getPreferredLaundry(apartment.id);
    if (apartment.latitude == null || apartment.longitude == null) return reply.code(422).send({ error: "apartment_location_required", preferredLaundry });
    const query = `[out:json][timeout:10];(nwr[\"shop\"=\"laundry\"](around:5000,${apartment.latitude},${apartment.longitude});nwr[\"amenity\"=\"dryer\"](around:5000,${apartment.latitude},${apartment.longitude}););out center tags;`;
    try {
      const response = await externalFetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MaidAid/0.1" }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error("overpass_unavailable");
      const body = await response.json() as { elements?: Array<{ type: "node" | "way" | "relation"; id: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> }> };
      const candidates = (body.elements ?? []).flatMap((element) => {
        const latitude = element.lat ?? element.center?.lat; const longitude = element.lon ?? element.center?.lon;
        if (latitude == null || longitude == null) return [];
        const tags = element.tags ?? {}; const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
        return [{ osmType: element.type, osmId: String(element.id), name: tags.name ?? "Прачечная", address: street || null, latitude, longitude, distanceMeters: distanceMeters(apartment.latitude!, apartment.longitude!, latitude, longitude), dryerConfirmed: tags.amenity === "dryer" || tags.dryer === "yes", mapsUrl: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` }];
      }).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 3);
      return { preferredLaundry, candidates };
    } catch { return reply.code(503).send({ error: "laundry_search_unavailable", preferredLaundry }); }
  });
  app.post("/api/apartments/:id/laundry-links", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const params = idParams.safeParse(request.params); const input = laundryLinkBody.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    let place: SavedPlace | null = null;
    if ("placeId" in input.data) place = await ledger.getSavedPlace(input.data.placeId);
    else {
      const candidate = input.data.candidate;
      place = await ledger.findSavedPlaceByOsm(candidate.osmType, candidate.osmId) ?? await ledger.createSavedPlace({ kind: "laundry", name: candidate.name, address: candidate.address, note: null, mapsUrl: `https://www.google.com/maps/search/?api=1&query=${candidate.latitude},${candidate.longitude}`, latitude: candidate.latitude, longitude: candidate.longitude, locationSource: "osm", locationAccuracyMeters: null, osmType: candidate.osmType, osmId: candidate.osmId });
    }
    if (!place || place.kind !== "laundry") return reply.code(400).send({ error: "invalid_laundry" });
    const link = await ledger.setPreferredLaundry(params.data.id, place.id); return link ? { place, link } : reply.code(404).send({ error: "apartment_not_found" });
  });

  app.post("/api/preview", { bodyLimit: 32 * 1024, config: { rateLimit: { max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW } } }, async (request, reply) => {
    const input = previewBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request", issues: input.error.issues.map(({ path, message }) => ({ path, message })) });
    let parsed: ParsedDay; let sourceText: string;
    try {
      if ("format" in input.data) ({ parsed, sourceText } = await buildStructuredDay(input.data, ledger, false));
      else { parsed = await parse(input.data.text); sourceText = input.data.text; if (input.data.kind) parsed.kind = input.data.kind; }
    } catch { return reply.code(422).send({ error: "invalid_day" }); }
    const totals = calculateDay(parsed, settings);
    const canShare = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    const cleanerId = currentCleaner(request).id;
    const snapshot = canShare && parsed.dateIso ? await ledger.projectDay(parsed.dateIso, totals, parsed.advanceCents, cleanerId) : null;
    const hasLaterEntries = parsed.dateIso ? (await ledger.getLedger(parsed.dateIso, monthEnd(parsed.dateIso), cleanerId)).rows.some((row) => row.dateIso > parsed.dateIso!) : false;
    return { parsed, sourceText, totals, advanceCents: parsed.advanceCents, projectedBalance: snapshot?.total.outstandingCents ?? null, snapshot, issues: parsed.issues, unparsedLines: parsed.unparsedLines, canShare, hasLaterEntries, shareText: canShare && snapshot ? generateShareText(parsed, settings, snapshot) : "" };
  });

  app.post("/api/days", { config: { rateLimit: { max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW } } }, async (request, reply) => {
    const input = previewBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    let parsed: ParsedDay; let sourceText: string;
    try {
      if ("format" in input.data) ({ parsed, sourceText } = await buildStructuredDay(input.data, ledger, true));
      else { parsed = await parse(input.data.text); sourceText = input.data.text; if (input.data.kind) parsed.kind = input.data.kind; }
    } catch { return reply.code(422).send({ error: "invalid_day" }); }
    const canSave = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    if (!canSave || !parsed.dateIso) return reply.code(422).send({ error: "invalid_day" });
    const totals = calculateDay(parsed, settings);
    const cleanerId = currentCleaner(request).id;
    const projected = await ledger.projectDay(parsed.dateIso, totals, parsed.advanceCents, cleanerId);
    const reportText = generateShareText(parsed, settings, projected);
    const saved = await ledger.saveDay({ dateIso: parsed.dateIso, sourceText, parsedDetails: parsed, totals, advanceCents: parsed.advanceCents, reportText }, cleanerId);
    return { day: saved.day, runningBalance: saved.snapshot.total.outstandingCents, snapshot: saved.snapshot, shareText: reportText };
  });

  app.delete("/api/days/:dateIso", async (request, reply) => {
    const params = z.object({ dateIso: date }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    return (await ledger.deleteDay(params.data.dateIso, currentCleaner(request).id)) ? reply.code(204).send() : reply.code(404).send({ error: "day_not_found" });
  });

  app.get("/api/ledger", async (request, reply) => {
    const query = ledgerQuery.safeParse(request.query);
    if (!query.success || (query.data.from && query.data.to && query.data.from > query.data.to)) return reply.code(400).send({ error: "invalid_request" });
    const cleanerId = currentCleaner(request).id;
    const view = await ledger.getLedger(query.data.from, query.data.to, cleanerId);
    const rows = await Promise.all(view.rows.map(async (row) => {
      if (row.rowType !== "work") return row;
      const snapshot = await ledger.projectDay(row.dateIso, {
        minutes: row.minutes, incomeCents: row.incomeCents, expensesCents: row.expensesCents, checkinCents: row.checkinCents,
      }, row.parsedDetails.advanceCents, cleanerId);
      return { ...row, reportText: generateShareText(row.parsedDetails, settings, snapshot) };
    }));
    return { ...view, rows };
  });

  app.get("/api/periods", async (request) => ({ periods: await ledger.listPeriods(currentCleaner(request).id) }));

  app.post("/api/payments", async (request, reply) => {
    const input = paymentCreate.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    return reply.code(201).send({ payment: await ledger.createPayment(input.data.dateIso, input.data.amountCents, input.data.note, currentCleaner(request).id) });
  });

  app.patch("/api/payments/:id", async (request, reply) => {
    const params = paymentParams.safeParse(request.params); const input = paymentPatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const payment = await ledger.updatePayment(params.data.id, input.data, currentCleaner(request).id);
    return payment ? { payment } : reply.code(404).send({ error: "payment_not_found" });
  });

  app.delete("/api/payments/:id", async (request, reply) => {
    const params = paymentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    return (await ledger.deletePayment(params.data.id, currentCleaner(request).id)) ? reply.code(204).send() : reply.code(404).send({ error: "payment_not_found" });
  });

  app.post("/api/admin/apartments/import", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    if (!config.APARTMENT_IMPORT_TOKEN) return reply.code(503).send({ error: "import_disabled" });
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expectedBuffer = Buffer.from(config.APARTMENT_IMPORT_TOKEN);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) return reply.code(401).send({ error: "unauthorized" });
    const input = apartmentImportBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request", issues: input.error.issues.map(({ path, message }) => ({ path, message })) });
    const seenSources = new Set<string>(); const seenCanonical = new Set<string>(); const duplicateConflicts: Array<{ sourceKey: string; reason: string }> = [];
    for (const item of input.data.apartments) {
      const canonical = apartmentKey(item.canonicalName);
      if (seenSources.has(item.sourceKey) || seenCanonical.has(canonical)) duplicateConflicts.push({ sourceKey: item.sourceKey, reason: "duplicate_in_payload" });
      seenSources.add(item.sourceKey); seenCanonical.add(canonical);
    }
    if (duplicateConflicts.length) return reply.code(409).send({ created: 0, updated: 0, skipped: 0, conflicts: duplicateConflicts });
    const dryRun = (request.query as { dryRun?: string }).dryRun === "true";
    const result = await ledger.importApartments(input.data.apartments, dryRun);
    if (!dryRun && productRelease >= 2) await syncAllApartmentNoteDryers(ledger, externalFetch);
    return { dryRun, accepted: result.created + result.updated + result.skipped, ...result };
  });
  for (const route of ["/today", "/map", "/ledger", "/map/apartments/:id", "/apartment.html"]) app.get(route, async (_request, reply) => reply.sendFile("index.html"));
  return app;
}

async function start(): Promise<void> { const config = loadConfig(); const app = await buildApp(config); await app.listen({ port: config.PORT, host: config.HOST }); }
const entryPoint = typeof process !== "undefined" && process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await start();
