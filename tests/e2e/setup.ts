import { buildApp } from "../../dist/src/server.js";
import { MemoryLedgerStore } from "../../dist/src/storage/ledger-store.js";

export default async function setup(): Promise<() => Promise<void>> {
  const config = {
    PORT: 4173, HOST: "127.0.0.1", LOG_LEVEL: "silent",
    PRODUCT_RELEASE: Number(process.env.PRODUCT_RELEASE ?? 3),
    HOURLY_RATE_CENTS: 1000, ORIENTATION_FLAT_CENTS: 1000, PRACTICE_FLAT_CENTS: 1500,
    CHECKIN_FLAT_CENTS: 1000, DRYER_DEFAULT_CENTS: 390,
    PREVIEW_RATE_LIMIT_MAX: 100, PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
    DATABASE_URL: "unused", APARTMENT_IMPORT_TOKEN: "",
  };
  const app = await buildApp(config, new MemoryLedgerStore());
  await app.listen({ port: config.PORT, host: config.HOST });
  return async () => { await app.close(); };
}
