import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { MaidAid } from "./app/maidAid.js";
import { loadConfig, parseGoogleCredentials } from "./config.js";
import {
  extractIncomingMessages,
  verifyMetaSignature,
  WhatsAppClient,
} from "./integrations/whatsapp.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/storage.js";

const config = loadConfig();
const app = Fastify({ logger: { level: config.LOG_LEVEL } });

if (config.WHATSAPP_ACCESS_TOKEN && !config.META_APP_SECRET) {
  throw new Error("META_APP_SECRET is required when WhatsApp sending is enabled");
}

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: "utf8",
  runFirst: true,
  routes: ["/webhook"],
});

let storage: Storage;
if (config.USE_MEMORY_STORAGE) {
  storage = new MemoryStorage();
} else {
  if (!config.GOOGLE_SHEET_ID || !config.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS) {
    throw new Error("Google Sheets configuration is required unless USE_MEMORY_STORAGE=true");
  }
  storage = new GoogleSheetsStorage(
    config.GOOGLE_SHEET_ID,
    parseGoogleCredentials(config.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS),
  );
}
await storage.initialize();
const maidAid = new MaidAid(storage);

const whatsApp =
  config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID
    ? new WhatsAppClient(
        config.WHATSAPP_ACCESS_TOKEN,
        config.WHATSAPP_PHONE_NUMBER_ID,
        config.WHATSAPP_API_VERSION,
        config.ALLOWED_USER_PHONE,
      )
    : null;

app.get("/health", async () => ({ status: "ok", service: "MaidAid" }));

app.get("/webhook", async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  if (
    query["hub.mode"] === "subscribe" &&
    query["hub.verify_token"] === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  ) {
    return reply.type("text/plain").send(query["hub.challenge"]);
  }
  return reply.code(403).send({ error: "verification_failed" });
});

app.post("/webhook", async (request, reply) => {
  const raw = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
  const signature = request.headers["x-hub-signature-256"];
  if (
    !verifyMetaSignature(
      raw,
      Array.isArray(signature) ? signature[0] : signature,
      config.META_APP_SECRET,
    )
  ) {
    return reply.code(401).send({ error: "invalid_signature" });
  }

  // Acknowledge Meta only after the small, bounded processing loop completes.
  for (const message of extractIncomingMessages(request.body)) {
    if (message.from !== config.ALLOWED_USER_PHONE) {
      request.log.warn({ from: message.from }, "Ignored message from a non-allowlisted number");
      continue;
    }
    if (await storage.hasMessage(message.id)) continue;
    const responses = await maidAid.handle(message.from, message.text, message.actionId);
    if (whatsApp) {
      for (const response of responses) await whatsApp.send(response);
    } else {
      request.log.info({ responses }, "WhatsApp credentials absent; response not sent");
    }
    await storage.recordMessage(message.id);
  }
  return reply.send({ status: "ok" });
});

await app.listen({ port: config.PORT, host: config.HOST });
