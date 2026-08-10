import { createPinDigest, createSessionToken, normalizeCleanerName, prepareInitialCleaner, validPin } from "./auth.js";
import { loadConfig } from "./config.js";
import { PostgresLedgerStore } from "./storage/ledger-store.js";

function usage(): never {
  throw new Error("Usage: npm run users -- list | reset-pin <name> <six-digit-pin> | disable <name> | enable <name> | expire-sessions <name> | issue-session [name]");
}

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const store = new PostgresLedgerStore(config.DATABASE_URL);

try {
  await store.initialize(await prepareInitialCleaner(config.INITIAL_CLEANER_NAME ?? "", config.INITIAL_CLEANER_PIN ?? ""));
  if (command === "list") {
    for (const cleaner of await store.listCleaners()) process.stdout.write(`${cleaner.active ? "active" : "disabled"}\t${cleaner.name}\n`);
  } else if (command === "issue-session") {
    const requestedName = args[0];
    const cleaner = requestedName
      ? await store.findCleanerByNameKey(normalizeCleanerName(requestedName))
      : (await store.listCleaners()).find((item) => item.active) ?? null;
    if (!cleaner?.active) throw new Error(requestedName ? `Active cleaner not found: ${requestedName}` : "No active cleaner exists");
    const { token, tokenHash } = createSessionToken();
    await store.createSession(cleaner.id, tokenHash, new Date(Date.now() + 15 * 60_000));
    process.stdout.write(token);
  } else {
    const name = args[0] ?? "";
    const cleaner = await store.findCleanerByNameKey(normalizeCleanerName(name));
    if (!cleaner) throw new Error(`Cleaner not found: ${name}`);
    if (command === "reset-pin") {
      const nextPin = args[1] ?? ""; if (!validPin(nextPin)) usage();
      const digest = await createPinDigest(nextPin); await store.setCleanerPin(cleaner.id, digest.pinSalt, digest.pinHash);
      process.stdout.write(`PIN reset and sessions expired for ${cleaner.name}\n`);
    } else if (command === "disable" || command === "enable") {
      await store.setCleanerActive(cleaner.id, command === "enable");
      process.stdout.write(`${cleaner.name} ${command === "enable" ? "enabled" : "disabled"}\n`);
    } else if (command === "expire-sessions") {
      await store.deleteCleanerSessions(cleaner.id); process.stdout.write(`Sessions expired for ${cleaner.name}\n`);
    } else usage();
  }
} finally { await store.close(); }
