import { buildApp } from "../dist/src/server.js";
import { MemoryLedgerStore } from "../dist/src/storage/ledger-store.js";

const port = Number(process.env.LOCAL_PREVIEW_PORT ?? 4173);
const host = "127.0.0.1";
const config = {
  PORT: port,
  HOST: host,
  LOG_LEVEL: "info",
  PRODUCT_RELEASE: 1,
  HOURLY_RATE_CENTS: 1000,
  ORIENTATION_FLAT_CENTS: 1000,
  PRACTICE_FLAT_CENTS: 1500,
  CHECKIN_FLAT_CENTS: 1000,
  DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100,
  PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_URL: "unused",
  APARTMENT_IMPORT_TOKEN: "",
};

const app = await buildApp(config, new MemoryLedgerStore());
await app.listen({ port, host });

const close = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
