import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  HOURLY_RATE_CENTS: z.coerce.number().int().nonnegative().default(1000),
  ORIENTATION_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1000),
  PRACTICE_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1500),
  CHECKIN_FLAT_CENTS: z.coerce.number().int().nonnegative().default(1000),
  DRYER_DEFAULT_CENTS: z.coerce.number().int().nonnegative().default(390),
  PREVIEW_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  PREVIEW_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  DATABASE_URL: z.string().min(1).default("postgresql://maidaid:maidaid@127.0.0.1:5432/maidaid"),
});

export type Config = z.infer<typeof schema>;
export function loadConfig(): Config { return schema.parse(process.env); }
