import { buildApp } from "../../dist/src/server.js";
import { MemoryLedgerStore } from "../../dist/src/storage/ledger-store.js";

export default async function setup(): Promise<() => Promise<void>> {
  const baseConfig = {
    PORT: 4273, HOST: "127.0.0.1", LOG_LEVEL: "silent",
    PRODUCT_RELEASE: Number(process.env.PRODUCT_RELEASE ?? 3),
    HOURLY_RATE_CENTS: 1000, ORIENTATION_FLAT_CENTS: 1000, PRACTICE_FLAT_CENTS: 1500,
    CHECKIN_FLAT_CENTS: 1000, DRYER_DEFAULT_CENTS: 390,
    PREVIEW_RATE_LIMIT_MAX: 100, PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
    DATABASE_URL: "unused", APARTMENT_IMPORT_TOKEN: "", AUTH_TEST_BYPASS: true,
  };
  const configurations = [
    baseConfig,
    { ...baseConfig, PORT: 4275 },
    { ...baseConfig, PORT: 4274, AUTH_TEST_BYPASS: false, TEAM_ACCESS_CODE: "e2e-team-code", INITIAL_CLEANER_NAME: "E2E Cleaner", INITIAL_CLEANER_PIN: "123456", SESSION_DAYS: 90 },
    { ...baseConfig, PORT: 4276, AUTH_TEST_BYPASS: false, TEAM_ACCESS_CODE: "e2e-team-code", INITIAL_CLEANER_NAME: "E2E Cleaner", INITIAL_CLEANER_PIN: "123456", SESSION_DAYS: 90 },
  ];
  const apps = await Promise.all(configurations.map((config) => buildApp(config, new MemoryLedgerStore())));
  await Promise.all(apps.map((app, index) => app.listen({ port: configurations[index]!.PORT, host: configurations[index]!.HOST })));
  return async () => { await Promise.all(apps.map((app) => app.close())); };
}
