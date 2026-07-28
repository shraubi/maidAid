import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { calculateDay } from "./domain/calculations.js";
import { generateShareText } from "./domain/draft.js";
import { parseDay } from "./domain/parser.js";
import type { Settings } from "./domain/types.js";
import { loadConfig, type Config } from "./config.js";
import { PostgresLedgerStore, type LedgerStore } from "./storage/ledger-store.js";

const previewBody = z.object({ kind: z.enum(["actual", "schedule"]).optional(), text: z.string().trim().min(1).max(32 * 1024) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paymentCreate = z.object({ dateIso: date, amountCents: z.number().int().positive(), note: z.string().max(500).optional() }).strict();
const paymentPatch = z.object({ dateIso: date.optional(), amountCents: z.number().int().positive().optional(), note: z.string().max(500).nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0);
const paymentParams = z.object({ id: z.coerce.number().int().positive() });
const ledgerQuery = z.object({ from: date.optional(), to: date.optional() });

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const publicRoot = moduleDirectory.includes(`${sep}dist${sep}`) ? resolve(moduleDirectory, "../../public") : resolve(moduleDirectory, "../public");

export async function buildApp(config: Config = loadConfig(), providedStore?: LedgerStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: true });
  const settings: Settings = {
    hourlyRateCents: config.HOURLY_RATE_CENTS,
    orientationFlatCents: config.ORIENTATION_FLAT_CENTS,
    practiceFlatCents: config.PRACTICE_FLAT_CENTS,
    checkinFlatCents: config.CHECKIN_FLAT_CENTS,
    dryerDefaultCents: config.DRYER_DEFAULT_CENTS,
  };
  const ledger = providedStore ?? new PostgresLedgerStore(config.DATABASE_URL);
  await ledger.initialize();
  app.addHook("onClose", async () => ledger.close());
  await app.register(rateLimit, { global: false, max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW });
  await app.register(fastifyStatic, { root: publicRoot, wildcard: false });

  app.get("/health", async (_request, reply) => {
    const database = await ledger.health();
    return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "unavailable", service: "MaidAid", database });
  });

  app.post("/api/preview", { bodyLimit: 32 * 1024, config: { rateLimit: { max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW } } }, async (request, reply) => {
    const input = previewBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request", issues: input.error.issues.map(({ path, message }) => ({ path, message })) });
    const parsed = parseDay(input.data.text, new Date(), settings.dryerDefaultCents);
    if (input.data.kind) parsed.kind = input.data.kind;
    const totals = calculateDay(parsed, settings);
    const canShare = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    const snapshot = canShare && parsed.dateIso ? await ledger.projectDay(parsed.dateIso, totals, parsed.advanceCents) : null;
    return { parsed, totals, advanceCents: parsed.advanceCents, projectedBalance: snapshot?.total.outstandingCents ?? null, snapshot, issues: parsed.issues, unparsedLines: parsed.unparsedLines, canShare, shareText: canShare && snapshot ? generateShareText(parsed, settings, snapshot) : "" };
  });

  app.post("/api/days", { config: { rateLimit: { max: config.PREVIEW_RATE_LIMIT_MAX, timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW } } }, async (request, reply) => {
    const input = previewBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid_request" });
    const parsed = parseDay(input.data.text, new Date(), settings.dryerDefaultCents);
    if (input.data.kind) parsed.kind = input.data.kind;
    const canSave = parsed.dateIso !== null && parsed.jobs.length > 0 && parsed.issues.length === 0 && parsed.unparsedLines.length === 0;
    if (!canSave || !parsed.dateIso) return reply.code(422).send({ error: "invalid_day" });
    const saved = await ledger.saveDay({ dateIso: parsed.dateIso, sourceText: input.data.text, parsedDetails: parsed, totals: calculateDay(parsed, settings), advanceCents: parsed.advanceCents });
    return { day: saved.day, runningBalance: saved.snapshot.total.outstandingCents, snapshot: saved.snapshot, shareText: generateShareText(parsed, settings, saved.snapshot) };
  });

  app.get("/api/ledger", async (request, reply) => {
    const query = ledgerQuery.safeParse(request.query);
    if (!query.success || (query.data.from && query.data.to && query.data.from > query.data.to)) return reply.code(400).send({ error: "invalid_request" });
    return ledger.getLedger(query.data.from, query.data.to);
  });

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
  return app;
}

async function start(): Promise<void> { const config = loadConfig(); const app = await buildApp(config); await app.listen({ port: config.PORT, host: config.HOST }); }
const entryPoint = typeof process !== "undefined" && process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await start();
