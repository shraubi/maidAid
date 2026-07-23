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

const previewBody = z.object({
  kind: z.enum(["actual", "schedule"]).optional(),
  text: z.string().trim().min(1).max(32 * 1024),
}).strict();

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const publicRoot = moduleDirectory.includes(`${sep}dist${sep}`)
  ? resolve(moduleDirectory, "../../public")
  : resolve(moduleDirectory, "../public");

export async function buildApp(config: Config = loadConfig()): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true,
  });
  const settings: Settings = {
    hourlyRateCents: config.HOURLY_RATE_CENTS,
    orientationFlatCents: config.ORIENTATION_FLAT_CENTS,
    practiceFlatCents: config.PRACTICE_FLAT_CENTS,
    dryerDefaultCents: config.DRYER_DEFAULT_CENTS,
  };

  await app.register(rateLimit, {
    global: false,
    max: config.PREVIEW_RATE_LIMIT_MAX,
    timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW,
  });
  await app.register(fastifyStatic, {
    root: publicRoot,
    wildcard: false,
  });

  app.get("/health", async () => ({ status: "ok", service: "MaidAid" }));

  app.post(
    "/api/preview",
    {
      bodyLimit: 32 * 1024,
      config: {
        rateLimit: {
          max: config.PREVIEW_RATE_LIMIT_MAX,
          timeWindow: config.PREVIEW_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const input = previewBody.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({
          error: "invalid_request",
          issues: input.error.issues.map(({ path, message }) => ({ path, message })),
        });
      }

      const parsed = parseDay(input.data.text, new Date(), settings.dryerDefaultCents);
      if (input.data.kind) parsed.kind = input.data.kind;
      const totals = calculateDay(parsed, settings);
      const canShare =
        parsed.dateIso !== null &&
        parsed.jobs.length > 0 &&
        parsed.issues.length === 0 &&
        parsed.unparsedLines.length === 0;

      return {
        parsed,
        totals,
        issues: parsed.issues,
        unparsedLines: parsed.unparsedLines,
        canShare,
        shareText: canShare ? generateShareText(parsed, settings) : "",
      };
    },
  );

  return app;
}

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ port: config.PORT, host: config.HOST });
}

const entryPoint =
  typeof process !== "undefined" && process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : "";
if (import.meta.url === entryPoint) {
  await start();
}
