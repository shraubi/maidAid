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

  app.post("/api/days", { config: { rateLimit5óÞü¶‰žËkºwµç\Û™[KŒŒNˆßB‚ˆ˜\ÝYY\Y\]X[ËŒKŒÎˆßB‚ˆ˜\ÝZœÛÛ‹\Ýš[™ÚYžPËŒŒN‚ˆ\[™[˜ÚY\Î‚ˆ	Ð˜\ÝYžKÛY\™ÙKZœÛÛ‹\ØÚ[X\ÉÎˆŒ‹ŒBˆZŽˆŒŒŒˆZ‹Y›Ü›X]ÎˆËŒŒJZŒŒŒ
Bˆ˜\Ý]\šNˆŒKŒBˆœÛÛ‹\ØÚ[XK\™Y‹\™\ÛÛ™\ŽˆËŒŒˆ™™ÎˆKŒB‚ˆ˜\Ý\]Y\ž\Ýš[™ÐKŒKŒŽ‚ˆ\[™[˜ÚY\Î‚ˆ˜\ÝYXÛÙK]\šKXÛÛ\Û™[ˆKŒŒB‚ˆ˜\Ý]\šPËŒKˆßB‚ˆ˜\Ý]\šPŒKŒNˆßB‚ˆ˜\ÝYžK\YÚ[KŒKŒˆßB‚ˆ˜\ÝYžPKŒLŒ‚ˆ\[™[˜ÚY\Î‚ˆ	Ð˜\ÝYžKØZ‹XÛÛ\[\‰ÎˆŒBˆ	Ð˜\ÝYžKÙ\œ›Ü‰ÎˆŒ‹Œˆ	Ð˜\ÝYžKÙ˜\ÝZœÛÛ‹\Ýš[™ÚYžKXÛÛ\[\‰ÎˆKŒKŒˆ	Ð˜\ÝYžKÜ›ÞKXY‰ÎˆKŒKŒˆXœÝ˜XÝ[ÙÙÚ[™Îˆ‹ŒŒBˆ]š[ÎˆKŒËŒˆ˜\ÝZœÛÛ‹\Ýš[™ÚYžNˆËŒŒBˆš[™[^K]Ø^NˆKËŒˆYÚ[^K\™\]Y\Ýˆ‹‹Œˆ[›ÎˆLŒËŒBˆ›ØÙ\ÜË]Ø\›š[™ÎˆKŒŒˆ™™ÎˆKŒBˆÙXÝ\™KZœÛÛ‹\\œÙNˆŒKŒˆÙ[]™\ŽˆËŽBˆØYXØXÚNˆËË‚ˆ˜\ÝPKŒŒŒN‚ˆ\[™[˜ÚY\Î‚ˆ™]\ÚYžNˆKŒKŒ‚ˆ™\‹KŒ
XÛÛX]ÚŒJN‚ˆÜ[Û˜[\[™[˜ÚY\Î‚ˆXÛÛX]ÚˆŒB‚ˆš[™[^K]Ø^PKËŒ‚ˆ\[™[˜ÚY\Î‚ˆ˜\ÝYY\Y\]X[ˆËŒKŒÂˆ˜\Ý\]Y\ž\Ýš[™ÎˆKŒKŒ‚ˆØY™K\™YÙ^ŽˆKŒKŒB‚ˆ›Ü™YÜ›Ý[™XÚ[ËŒËŒN‚ˆ\[™[˜ÚY\Î‚ˆÜ›ÜÜË\Ü]ÛŽˆËŒ‚ˆÚYÛ˜[Y^]ˆŒKŒ‚ˆœÙ]™[Ð‹ŒËŒÎ‚ˆÜ[Û˜[ˆYB‚ˆÛØLKŒKŒ‚ˆ\[™[˜ÚY\Î‚ˆ›Ü™YÜ›Ý[™XÚ[ˆËŒËŒBˆ˜XÚÜÜXZÎˆŒ‹ŒÂˆZ[š[X]ÚˆLŒ‹BˆZ[š\\ÜÎˆËŒKŒÂˆXÚØYÙKZœÛÛ‹Yœ›ÛKY\ÝˆKŒŒBˆ]\ØÝ\œžNˆ‹ŒŒ‚‚ˆY\œ›ÜœÐ‹ŒŒN‚ˆ\[™[˜ÚY\Î‚ˆ\ˆ‹ŒŒˆ[š\š]Îˆ‹ŒˆÙ]›ÝÝ\[ÙŽˆKŒ‹ŒˆÝ]\Ù\Îˆ‹ŒŒ‚ˆÚY[YšY\ŽˆKŒŒB‚ˆ[š\š]Ð‹ŒˆßB‚ˆ\Y‹šœÐ‹ŒˆßB‚ˆ\Ù^P‹ŒŒˆßB‚ˆ˜XÚÜÜXZÐŒ‹ŒÎ‚ˆ\[™[˜ÚY\Î‚ˆ	Ð\ØXXÜËØÛ]ZIÎˆKŒŒ‚ˆœË]ÚÙ[œÐKŒŒNˆßB‚ˆœÛÛ‹\ØÚ[XK\™Y‹\™\ÛÛ™\ËŒŒ‚ˆ\[™[˜ÚY\Î‚ˆ\]X[ˆ‹ŒŒÂ‚ˆœÛÛ‹\ØÚ[XK]˜]™\œÙPKŒŒˆßB‚ˆYÚ[^K\™\]Y\Ý‹‹Œ‚ˆ\[™[˜ÚY\Î‚ˆÛÛÚÚYNˆKŒKŒBˆ›ØÙ\ÜË]Ø\›š[™ÎˆŒŒBˆÙ]XÛÛÚÚYK\\œÙ\Žˆ‹ËŒ‚‚ˆÝ\PËŒ‹ŒNˆßB‚ˆKXØXÚPLKKŒŽˆßB‚ˆXYÚXË\Ýš[™ÐŒÌŒŒN‚ˆ\[™[˜ÚY\Î‚ˆ	ÐœšYÙ]Ù[ÜÛÝ\˜Ù[X\XÛÙXÉÎˆKKB‚ˆZ[YPËŒŒˆßB‚ˆZ[š[X]ÚLŒ‹N‚ˆ\[™[˜ÚY\Î‚ˆœ˜XÙKY^[œÚ[ÛŽˆKŒŽ‚ˆZ[š\\ÜÐËŒKŒÎˆßB‚ˆ\Ð‹ŒKŒÎˆßB‚ˆ˜[›ÚYËŒËŒMŽˆßB‚ˆÛ‹Y^][XZËYœ™YP‹ŒKŒŽˆßB‚ˆXÚØYÙKZœÛÛ‹Yœ›ÛKY\ÝKŒŒNˆßB‚ˆ]ZÙ^PËŒKŒNˆßB‚ˆ]\ØÝ\œžP‹ŒŒŽ‚ˆ\[™[˜ÚY\Î‚ˆKXØXÚNˆLKKŒ‚ˆZ[š\\ÜÎˆËŒKŒÂ‚ˆ]P‹ŒŒÎˆßB‚ˆ]˜[‹ŒŒNˆßB‚ˆËXÛÝY›\™PKŒ‚ˆÜ[Û˜[ˆYB‚ˆËXÛÛ›™XÝ[Û‹\Ýš[™Ð‹ŒMŒˆßB‚ˆËZ[KŒŒNˆßB‚ˆË\ÛÛËŒMŒ
ÐŒŒ‹Œ
N‚ˆ\[™[˜ÚY\Î‚ˆÎˆŒŒ‹Œ‚ˆË\›ÝØÛÛKŒMKŒˆßB‚ˆË]\\Ð‹Œ‹Œ‚ˆ\[™[˜ÚY\Î‚ˆËZ[ˆKŒŒBˆÜÝÜ™\ËX\œ˜^Nˆ‹ŒŒˆÜÝÜ™\ËXž]XNˆKŒŒBˆÜÝÜ™\ËY]NˆKŒÂˆÜÝÜ™\ËZ[\˜[ˆKŒ‹Œ‚ˆÐŒŒ‹Œ‚ˆ\[™[˜ÚY\Î‚ˆËXÛÛ›™XÝ[Û‹\Ýš[™Îˆ‹ŒMŒˆË\ÛÛˆËŒMŒ
ÐŒŒ‹Œ
BˆË\›ÝØÛÛˆKŒMKŒˆË]\\Îˆ‹Œ‹ŒˆÜ\ÜÎˆKŒBˆÜ[Û˜[\[™[˜ÚY\Î‚ˆËXÛÝY›\™NˆKŒ‚ˆÜ\ÜÐKŒN‚ˆ\[™[˜ÚY\Î‚ˆÜ]ŽˆŒ‹Œ‚ˆXÛØÛÛÜœÐKŒKŒNˆßB‚ˆXÛÛX]ÚŒNˆßB‚ˆ[›ËXXœÝ˜XÝ]˜[œÜÜËŒŒ‚ˆ\[™[˜ÚY\Î‚ˆÜ]ŽˆŒ‹Œ‚ˆ[›Ë\Ý\Ù\šX[^™\œÐËŒKŒˆßB‚ˆ[›ÐLŒËŒN‚ˆ\[™[˜ÚY\Î‚ˆ	Ð[›ÚœËÜ™YXÝ	ÎˆŒˆ]ÛZXË\ÛY\ˆKŒŒˆÛ‹Y^][XZËYœ™YNˆ‹ŒKŒ‚ˆ[›ËXXœÝ˜XÝ]˜[œÜÜˆËŒŒˆ[›Ë\Ý\Ù\šX[^™\œÎˆËŒKŒˆ›ØÙ\ÜË]Ø\›š[™ÎˆKŒŒˆ]ZXÚËY›Ü›X]][™\ØØ\YˆŒˆ™X[\™\]Z\™NˆŒ‹ŒˆØY™K\ÝX›K\Ýš[™ÚYžNˆ‹KŒˆÛÛšXËX›ÛÛNˆŒ‹ŒBˆ™XY\Ý™X[NˆŒ‹Œ‚ˆÜÝÜÜÐKŒŒÎ‚ˆ\[™[˜ÚY\Î‚ˆ˜[›ÚYˆËŒËŒM‚ˆXÛØÛÛÜœÎˆKŒKŒBˆÛÝ\˜ÙK[X\ZœÎˆKŒ‹ŒB‚ˆÜÝÜ™\ËX\œ˜^P‹ŒŒˆßB‚ˆÜÝÜ™\ËXž]XPKŒŒNˆßB‚ˆÜÝÜ™\ËY]PKŒÎˆßB‚ˆÜÝÜ™\ËZ[\˜[KŒ‹Œ‚ˆ\[™[˜ÚY\Î‚ˆ[™ˆŒŒ‚‚ˆ›ØÙ\ÜË]Ø\›š[™ÐŒŒNˆßB‚ˆ›ØÙ\ÜË]Ø\›š[™ÐKŒŒˆßB‚ˆ]ZXÚËY›Ü›X]][™\ØØ\YŒˆßB‚ˆ™X[\™\]Z\™PŒ‹ŒˆßB‚ˆ™X[\™\]Z\™PKŒŒˆßB‚ˆ™\]Z\™KYœ›ÛK\Ýš[™Ð‹ŒŒŽˆßB‚ˆ™]KŒˆßB‚ˆ™]\ÚYžPKŒKŒˆßB‚ˆ™™ÐKŒNˆßB‚ˆ›Û\Œ‹ŒŽ‚ˆ\[™[˜ÚY\Î‚ˆ	Ð\\ËÙ\Ý™YIÎˆKŒŽBˆÜ[Û˜[\[™[˜ÚY\Î‚ˆ	Ð›Û\Ü›Û\X[™›ÚYX\›KYXXšIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\X[™›ÚYX\›M	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\Y\Ú[‹X\›M	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\Y\Ú[‹^	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\Yœ™YXœÙX\›M	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\Yœ™YXœÙ^	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^X\›KYÛYXXšZ‰ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^X\›K[]\ÛXXšZ‰ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^X\›MYÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^X\›M[]\Û	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^[ÛÛ™ÍYÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^[ÛÛ™Í[]\Û	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^\ÍYÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^\Í[]\Û	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^\š\ØÝYÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^\š\ØÝ[]\Û	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^\ÌÎLYÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^^YÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[[^^[]\Û	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[Ü[˜œÙ^	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\[Ü[š\›[ÛžKX\›M	ÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\]Ú[ŒÌ‹X\›M[\Ý˜ÉÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\]Ú[ŒÌ‹ZXLÌ‹[\Ý˜ÉÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\]Ú[ŒÌ‹^YÛIÎˆŒ‹Œ‚ˆ	Ð›Û\Ü›Û\]Ú[ŒÌ‹^[\Ý˜ÉÎˆŒ‹Œ‚ˆœÙ]™[Îˆ‹ŒËŒÂ‚ˆØY™KXY™™\KŒ‹ŒNˆßB‚ˆØY™K\™YÙ^KŒKŒN‚ˆ\[™[˜ÚY\Î‚ˆ™]ˆKŒ‚ˆØY™K\ÝX›K\Ýš[™ÚYžP‹KŒˆßB‚ˆÙXÝ\™KZœÛÛ‹\\œÙPŒKŒˆßB‚ˆÙ[]™\ËŽNˆßB‚ˆÙ]XÛÛÚÚYK\\œÙ\‹ËŒŽˆßB‚ˆÙ]›ÝÝ\[ÙKŒ‹ŒˆßB‚ˆÚX˜[™ËXÛÛ[X[™‹ŒŒ‚ˆ\[™[˜ÚY\Î‚ˆÚX˜[™Ë\™YÙ^ˆËŒŒ‚ˆÚX˜[™Ë\™YÙ^ËŒŒˆßB‚ˆÚYÚ[™›Ð‹ŒŒˆßB‚ˆÚYÛ˜[Y^]ŒKŒˆßB‚ˆÛÛšXËX›ÛÛPŒ‹ŒN‚ˆ\[™[˜ÚY\Î‚ˆ]ÛZXË\ÛY\ˆKŒŒ‚ˆÛÝ\˜ÙK[X\ZœÐKŒ‹ŒNˆßB‚ˆÜ]Œ‹ŒˆßB‚ˆÝXÚØ˜XÚÐŒŒŽˆßB‚ˆÝ]\Ù\Ð‹ŒŒŽˆßB‚ˆÝY[ËŒLŒˆßB‚ˆÝš\[]\˜[ËŒKŒ‚ˆ\[™[˜ÚY\Î‚ˆœË]ÚÙ[œÎˆKŒŒB‚ˆ™XY\Ý™X[PŒ‹Œ‚ˆ\[™[˜ÚY\Î‚ˆ™X[\™\]Z\™NˆKŒŒ‚ˆ[žX™[˜Ú‹ŽKŒˆßB‚ˆ[žY^XÐŒËŒŽˆßB‚ˆ[žYÛØ˜žPŒ‹ŒMÎ‚ˆ\[™[˜ÚY\Î‚ˆ™\Žˆ‹KŒ
XÛÛX]ÚŒJBˆXÛÛX]ÚˆŒB‚ˆ[ž\ÛÛKŒKŒNˆßB‚ˆ[ž\˜Z[˜›ÝÐ‹ŒŒˆßB‚ˆ[ž\ÜPŒˆßB‚ˆØYXØXÚPËËˆßB‚ˆÚY[YšY\KŒŒNˆßB‚ˆÞŒŒËŒN‚ˆ\[™[˜ÚY\Î‚ˆ\ØZ[ˆŒŽŒBˆÜ[Û˜[\[™[˜ÚY\Î‚ˆœÙ]™[Îˆ‹ŒËŒÂ‚ˆ\\ØÜš\KŽKŒÎˆßB‚ˆ[™XÚK]\\ÐËŒNŒŽˆßB‚ˆš]K[›ÙPËŒ‹
\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJN‚ˆ\[™[˜ÚY\Î‚ˆØXÎˆ‹ËŒMˆXYÎˆŒÂˆ\Ë[[Ù[K[^\ŽˆKËŒˆ]Nˆ‹ŒŒÂˆš]NˆËŒËŠ\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJBˆ˜[œÚ]]™TY\‘\[™[˜ÚY\Î‚ˆH	Ð\\ËÛ›ÙIÂˆHš]BˆH\ÜÂˆHYÚš[™ØÜÜÂˆHØ\ÜÂˆHØ\ÜËY[X™YYˆHÝ[\ÂˆHÝYØ\œÜÂˆHÝ\ÜËXÛÛÜ‚ˆH\œÙ\‚ˆHÞˆHX[[‚ˆš]PËŒËŠ\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJN‚ˆ\[™[˜ÚY\Î‚ˆ\ØZ[ˆŒŽŒBˆ™\Žˆ‹KŒ
XÛÛX]ÚŒJBˆXÛÛX]ÚˆŒBˆÜÝÜÜÎˆKŒŒÂˆ›Û\ˆŒ‹Œ‚ˆ[žYÛØ˜žNˆŒ‹ŒMÂˆÜ[Û˜[\[™[˜ÚY\Î‚ˆ	Ð\\ËÛ›ÙIÎˆŒLËŒÂˆœÙ]™[Îˆ‹ŒËŒÂˆÞˆŒŒËŒB‚ˆš]\ÝËŒ‹Ê\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJN‚ˆ\[™[˜ÚY\Î‚ˆ	Ð\\ËØÚZIÎˆKŒ‹ŒÂˆ	Ðš]\ÝÙ^XÝ	ÎˆËŒ‹Âˆ	Ðš]\ÝÛ[ØÚÙ\‰ÎˆËŒ‹Êš]PËŒËŠ\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJJBˆ	Ðš]\ÝÜ™]KY›Ü›X]	ÎˆËŒ‹Âˆ	Ðš]\ÝÜ[›™\‰ÎˆËŒ‹Âˆ	Ðš]\ÝÜÛ˜\ÚÝ	ÎˆËŒ‹Âˆ	Ðš]\ÝÜÜIÎˆËŒ‹Âˆ	Ðš]\ÝÝ][ÉÎˆËŒ‹ÂˆÚZNˆKŒËŒÂˆXYÎˆŒÂˆ^XÝ]\NˆKŒˆXYÚXË\Ýš[™ÎˆŒÌŒŒBˆ]Nˆ‹ŒŒÂˆXÛÛX]ÚˆŒBˆÝY[ŽˆËŒLŒˆ[žX™[˜Úˆ‹ŽKŒˆ[žY^XÎˆŒËŒ‚ˆ[žYÛØ˜žNˆŒ‹ŒMÂˆ[ž\ÛÛˆKŒKŒBˆ[ž\˜Z[˜›ÝÎˆ‹ŒŒˆš]NˆËŒËŠ\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJBˆš]K[›ÙNˆËŒ‹
\\ËÛ›ÙPŒLËŒÊJÞŒŒËŒJBˆÚKZ\Ë[›ÙK\[›š[™Îˆ‹ŒËŒˆÜ[Û˜[\[™[˜ÚY\Î‚ˆ	Ð\\ËÛ›ÙIÎˆŒLËŒÂˆ˜[œÚ]]™TY\‘\[™[˜ÚY\Î‚ˆHš]BˆH\ÜÂˆHYÚš[™ØÜÜÂˆH\ÝÂˆHØ\ÜÂˆHØ\ÜËY[X™YYˆHÝ[\ÂˆHÝYØ\œÜÂˆHÝ\ÜËXÛÛÜ‚ˆH\œÙ\‚ˆHÞˆHX[[‚ˆÚXÚ‹ŒŒŽ‚ˆ\[™[˜ÚY\Î‚ˆ\Ù^Nˆ‹ŒŒ‚ˆÚKZ\Ë[›ÙK\[›š[™Ð‹ŒËŒ‚ˆ\[™[˜ÚY\Î‚ˆÚYÚ[™›Îˆ‹ŒŒˆÝXÚØ˜XÚÎˆŒŒ‚‚ˆ[™ŒŒŽˆßB‚ˆ›ÙŒÎˆßB