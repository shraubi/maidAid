import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  PRODUCT_RELEASE: z.coerce.number().int().min(1).max(3).default(2),
  HOURLY_RATE_CENTS: z.coerce.number().int().nonnegative().default(1000),
  ORIENTATION_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1000),
  PRACTICE_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1500),
  CHECKIN_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1000),
  DRYER_DEFAULT_CENTS: z.coerce.number().int().nonnegative().default(390),
  PREVIEW_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  PREVIEW_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  DATABASE_URL: z.string().min(1),
  APARTMENT_IMPORT_TOKEN: z.string().default(""),
  TEAM_ACCESS_CODE: z.string().default(""),
  INITIAL_CLEANER_NAME: z.string().default(""),
  INITIAL_CLEANER_PIN: z.string().default(""),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
});

type ParsedConfig = z.infer<typeof schema>;
type AuthConfigKey = "TEAM_ACCESS_CODE" | "INITIAL_CLEANER_NAME" | "INITIAL_CLEANER_PIN" | "SESSION_DAYS";
export type Config = Omit<ParsedConfig, "PRODUCT_RELEASE" | AuthConfigKey> & Partial<Pick<ParsedConfig, AuthConfigKey>> & {
  PRODUCT_RELEASE?: number;
  /** Unit tests may bypass HTTP authentication while storage remains cleaner-scoped. */
  AUTH_TEST_BYPASS?: boolean;
  /** Legacy test/deployment input; the apartment API is now database-backed. */
  APARTMENT_CACHE_TTL_MS?: number;
};
export function loadConfig(): Config { return schema.parse(process.env); }
