import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export interface Cleaner {
  id: number;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CleanerCredentials extends Cleaner {
  nameKey: string;
  pinSalt: string;
  pinHash: string;
}

export interface InitialCleaner {
  name: string;
  nameKey: string;
  pinSalt: string;
  pinHash: string;
}

export function normalizeCleanerName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export function validPin(value: string): boolean { return /^\d{6}$/.test(value); }

export async function createPinDigest(pin: string, salt = randomBytes(16).toString("base64url")): Promise<{ pinSalt: string; pinHash: string }> {
  const derived = await scrypt(pin, salt, 64) as Buffer;
  return { pinSalt: salt, pinHash: derived.toString("base64url") };
}

export async function verifyPin(pin: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await scrypt(pin, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function prepareInitialCleaner(name: string, pin: string): Promise<InitialCleaner | null> {
  const cleanName = name.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!cleanName && !pin) return null;
  if (!cleanName || !validPin(pin)) throw new Error("INITIAL_CLEANER_NAME and a six-digit INITIAL_CLEANER_PIN must be configured together");
  return { name: cleanName, nameKey: normalizeCleanerName(cleanName), ...await createPinDigest(pin) };
}
