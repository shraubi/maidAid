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
import type { LocationSource, SavedPlace, Settings } from "./domain/types.js";
import { apartmentKey, apartmentLookup } from "./domain/apartments.js";
import { loadConfig, type Config } from "./config.js";
import { PostgresLedgerStore, type LedgerStore } from "./storage/ledger-store.js";

const previewBody = z.object({ kind: z.enum(["actual", "schedule"]).optional(), text: z.string().trim().min(1).max(32 * 1024) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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
  kind: z.enum(["laundry", "partner_restaurant"]), name: z.string().trim().min(1).max(200),
  note: nullableText(20_000), apartmentId: z.number().int().positive().optional(), ...locationInput,
}).strict();
const placePatch = placeCreate.omit({ apartmentId: true }).partial();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const osmCandidate = z.object({
  osmType: z.enum(["node", "way", "relation"]), osmId: z.string().min(1), name: z.string().min(1).max(500),
  address: z.string().max(1000).nullable(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
}).strict();
const laundryLinkBody = z.union([z.object({ placeId: z.number().int().positive() }).strict(), z.object({ candidate: osmCandidate }).strict()]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const publicRoot = moduleDirectory.includes(`${sep}dist${sep}`) ? resolve(moduleDirectory, "../../public") : resolve(moduleDirectory, "../public");
const projectRoot = moduleDirectory.includes(`${sep}dist${sep}`) ? resolve(moduleDirectory, "../..") : resolve(moduleDirectory, "..");
const leafletRoot = resolve(projectRoot, "node_modules/leaflet/dist");

function coordinatesFromMapsUrl(value: string | null | undefined): { latitude: number; longitude: number } | null {
  if (!value) return null;
  const match = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) ?? value.match(/[?&](?:query|q)=(-?\d+(?:\.\d+)?)[,%20]+(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const latitude = Number(match[1]); const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
}

async function resolveLocation(input: Record<string, unknown>, externalFetch: typeof fetch): Promise<{ latitude: number | null; longitude: number | null; locationSource: LocationSource | null; locationAccuracyMeters: number | null }> {
  const latitude = typeof input.latitude === "number" ? input.latitude : null;
  const longitude = typeof input.longitude === "number" ? input.longitude : null;
  if (latitude != null && longitude != null) return { latitude, longitude, locationSource: input.locationSource as LocationSource ?? "pin", locationAccuracyMeters: typeof input.locationAccuracyMeters === "number" ? input.locationAccuracyMeters : null };
  const fromUrl = coordinatesFromMapsUrl(typeof input.mapsUrl === "string" ? input.mapsUrl : null);
  if (fromUrl) return { ...fromUrl, locationSource: "maps_link", locationAccuracyMeters: null };
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (address) {
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", address); url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "1");
      const response = await externalFetch(url, { headers: { "user-agent": "MaidAid/0.1", accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
      if (response.ok) {
        const body = await response.json() as Array<{ lat?: string; lon?: string }>;
        const hit = body[0]; const resolvedLatitude = Number(hit?.lat); const resolvedLongitude = Number(hit?.lon);
        if (Number.isFinite(resolvedLatitude) && Number.isFinite(resolvedLongitude)) return { latitude: resolvedLatitude, longitude: resolvedLongitude, locationSource: "address", locationAccuracyMeters: null };
      }
    } catch { /* A place may still be saved without coordinates. */ }
  }
  return { latitude: null, longitude: null, locationSource: null, locationAccuracyMeters: null };
}

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const radians = (value: number) => value * Math.PI / 180; const earth = 6_371_000;
  const dLat = radians(bLat - aLat); const dLon = radians(bLon - aLon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earth * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)));
}

export async function buildApp(config: Config = loadConfig(), providedStore?: LedgerStore, externalFetch: typeof fetch = fetch): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: true });
  const productRelease = config.PRODUCT_RELEASE ?? 1;
  const settings: Settings = {
    hourlyRateCents: config.HOURLY_RATE_CENTS,
    orientationFlatCents: config.ORIENTATION_FLAT_CENTS,
    practiceFlatCents: config.PRACTICE_FLAT_CENTS,
    checkinFlatCents: config.CHECKIN_FLAT_CENTS,
    dryerDefaultCents: config.DRYER_DEFAULT_CENTS,
  };
  const ledger = providedStore ?? new PostgresLedgerStore(config.DATABASE_URL);
  await ledger.initialize();
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

  app.get("/health", async (_request, reply) => {
    const database = await ledger.health();
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "unavailable", service: "MaidAid", database });
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
    const location = await resolveLocation(input.data, externalFetch);
    try {
      const apartment = await ledger.createApartment({ canonicalName: input.data.canonicalName, aliases: input.data.aliases, address: input.data.address ?? null, mapsUrl: input.data.mapsUrl ?? null, noteBody: input.data.noteBody ?? null, ...location });
      return reply.code(201).send({ apartment });
    } catch { return reply.code(409).send({ error: "apartment_exists" }); }
  });
  app.patch("/api/apartments/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params); const input = apartmentPatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const current = await ledger.getApartment(params.data.id); if (!current) return reply.code(404).send({ error: "apartment_not_found" });
    const locationChanged = input.data.address !== undefined || input.data.mapsUrl !== undefined || input.data.latitude !== undefined || input.data.longitude !== undefined;
    const location = locationChanged ? await resolveLocation(input.data, externalFetch) : { latitude: current.latitude, longitude: current.longitude, locationSource: current.locationSource, locationAccuracyMeters: current.locationAccuracyMeters };
    try {
      const apartment = await ledger.updateApartment(params.data.id, { ...input.data, ...location }); return { apartment };
    } catch { return reply.code(409).send({ error: "apartment_exists" }); }
  });

  app.get("/api/places", async (_request, reply) => productRelease >= 2 ? { places: await ledger.getSavedPlaces() } : reply.code(404).send({ error: "not_found" }));
  app.post("/api/places", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const input = placeCreate.safeParse(request.body); if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const location = await resolveLocation(input.data, externalFetch);
    const place = await ledger.createSavedPlace({ kind: input.data.kind, name: input.data.name, address: input.data.address ?? null, note: input.data.note ?? null, mapsUrl: input.data.mapsUrl ?? null, ...location });
    if (input.data.kind === "laundry" && input.data.apartmentId) await ledger.setPreferredLaundry(input.data.apartmentId, place.id);
    return reply.code(201).send({ place });
  });
  app.patch("/api/places/:id", async (request, reply) => {
    if (productRelease < 2) return reply.code(404).send({ error: "not_found" });
    const params = idParams.safeParse(request.params); const input = placePatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const current = await ledger.getSavedPlace(params.data.id); if (!current) return reply.code(404).send({ error: "place_not_found" });
    const locationChanged = input.data.address !== undefined || input.data.mapsUrl !== undefined || input.data.latitude !== undefined || input.data.longitude !== undefined;
    const location = locationChanged ? await resolveLocation(input.data, externalFetch) : { latitude: current.latitude, longitude: current.longitude, locationSource: current.locationSource, locationAccuracyMeters: current.locationAccuracyMeters };
    const place = await ledger.updateSavedPlace(params.data.id, { ...input.data, ...location }); return { place };
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
    const parsed = await parse(input.data.text);
    if (input.data.kind) parsed.kind = input.data.kind;
    const totals = calculateDay(parsed, settings);
    const canShare = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    const snapshot = canShare && parsed.dateIso ? await ledger.projectDay(parsed.dateIso, totals, parsed.advanceCents) : null;
    return { parsed, totals, advanceCents: parsed.advanceCents, projectedBalance: snapshot?.total.outstandingCents ?? null, snapshot, issues: parsed.issues, unparsedLines: parsed.unparsedLines, canShare, shareText: canShare && snapshot ? generateShareText(parsed, settings, snapshot) : "" };
  });

  app.post("/api/days", { config: { rateLimit: { max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW } } }, async (request, reply) => {
    const input = previewBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const parsed = await parse(input.data.text);
    if (input.data.kind) parsed.kind = input.data.kind;
    const canSave = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    if (!canSave || !parsed.dateIso) return reply.code(422).send({ error: "invalid_day" });
    const totals = calculateDay(parsed, settings);
    const projected = await ledger.projectDay(parsed.dateIso, totals, parsed.advanceCents);
    const reportText = generateShareText(parsed, settings, projected);
    const saved = await ledger.saveDay({ dateIso: parsed.dateIso, sourceText: input.data.text, parsedDetails: parsed, totals, advanceCents: parsed.advanceCents, reportText });
    return { day: saved.day, runningBalance: saved.snapshot.total.outstandingCents, snapshot: saved.snapshot, shareText: reportText };
  });

  app.delete("/api/days/:dateIso", async (request, reply) => {
    const params = z.object({ dateIso: date }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    return (await ledger.deleteDay(params.data.dateIso)) ? reply.code(204).send() : reply.code(404).send({ error: "day_not_found" });
  });

  app.get("/api/ledger", async (request, reply) => {
    const query = ledgerQuery.safeParse(request.query);
    if (!query.success || (query.data.from && query.data.to && query.data.from > query.data.to)) return reply.code(400).send({ error: "invalid_request" });
    return ledger.getLedger(query.data.from, query.data.to);
  });

  app.get("/api/periods", async () => ({ periods: await ledger.listPeriods() }));

  app.post("/api/payments", async (request, reply) => {
    const input = paymentCreate.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    return reply.code(201).send({ payment: await ledger.createPayment(input.data.dateIso, input.data.amountCents, input.data.note) });
  });

  app.patch("/api/payments/:id", async (request, reply) => {
    const params = paymentParams.safeParse(request.params); const input = paymentPatch.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "invalid_request" });
    const payment = await ledger.updatePayment(params.data.id, input.data);
    return payment ? { payment } : reply.code(404).send({ error: "payment_not_found" });
  });

  app.delete("/api/payments/:id", async (request, reply) => {
    const params = paymentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    return (await ledger.deletePayment(params.data.id)) ? reply.code(204).send() : reply.code(404).send({ error: "payment_not_found" });
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
    return { dryRun, accepted: result.created + result.updated + result.skipped, ...result };
  });
  for (const route of ["/today", "/map", "/ledger", "/map/apartments/:id"]) app.get(route, async (_request, reply) => reply.sendFile("index.html"));
  return app;
}

async function start(): Promise<void> { const config = loadConfig(); const app = await buildApp(config); await app.listen({ port: config.PORT, host: config.HOST }); }
const entryPoint = typeof process !== "undefined" && process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await start();
