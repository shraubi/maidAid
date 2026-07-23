import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v23.0"),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().optional(),
  ALLOWED_USER_PHONE: z.string().regex(/^\d+$/),
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: z.string().optional(),
  USE_MEMORY_STORAGE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  return schema.parse(process.env);
}

export function parseGoogleCredentials(raw: string): object {
  const json = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json) as object;
}
