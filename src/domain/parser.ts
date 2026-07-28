import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Expense, Job, ParsedDay, ParseIssue, WorkType } from "./types.js";

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/;
const INTERVAL_RE = /\(?\b(\d{1,2})(?::(\d{2}))?\s*[-â€“â€”]\s*(\d{1,2})(?::(\d{2}))?\b\)?/;
const TIME_RE = /\(?\b(\d{1,2}):(\d{2})\b\)?/;
const EXPENSE_RE = /(ÑÑƒÑˆÐº[Ð°Ð¸Ñƒ]?|Ð¼ÐµÑ‚Ñ€Ð¾|Ñ…Ð¸Ð¼Ð¸[ÑÑŽ]|Ñ€Ð°ÑÑ…Ð¾Ð´(?:Ñ‹)?)/iu;
const AMOUNT_RE = /-?\d+(?:[.,]\d{1,2})?\s*â‚¬?/gu;
const CHECKIN_RE = /\bcheck[\s-]*in\b|ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒÐ½[\p{L}]*\s+Ð·Ð°ÑÐµÐ»ÐµÐ½[\p{L}]*|Ð·Ð°ÑÐµÐ»ÐµÐ½[\p{L}]*/iu;
const TYPE_RE = /(ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒÐ½[\p{L}]*(?:\s+(?:Ñ€Ð°Ð±Ð¾Ñ‚[\p{L}]*|ÑƒÐ±Ð¾Ñ€Ðº[\p{L}]*))?|ÑƒÐ±Ð¾Ñ€Ðº[\p{L}]*|Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½[\p{L}]*|Ð·Ð½Ð°ÐºÐ¾Ð¼ÑÑ‚Ð²[\p{L}]*|Ð¿Ñ€Ð°ÐºÑ‚Ð¸Ðº[\p{L}]*|\bcheck[\s-]*in\b|Ð·Ð°ÑÐµÐ»ÐµÐ½[\p{L}]*)/giu;
const TYPE_HINT_RE = /(ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒ|ÑƒÐ±Ð¾Ñ€Ðº|Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½|Ð·Ð½Ð°ÐºÐ¾Ð¼ÑÑ‚Ð²|Ð¿Ñ€Ð°ÐºÑ‚Ð¸Ðº|check[\s-]*in|Ð·Ð°ÑÐµÐ»ÐµÐ½)/iu;
const TIME_TOKEN_RE = /\b\d{1,2}:\d{2}\b/gu;
const FLAT_ACTIVITY_DEFAULT_MINUTES = 60;
const CHECKIN_DEFAULT_MINUTES = 30;

interface ApartmentDictionary { apartments?: Array<{ name: string; aliases?: string[] }> }

function apartmentKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function loadApartmentAliases(): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const dictionary = JSON.parse(readFileSync(resolve(process.cwd(), "data/apartments.json"), "utf8")) as ApartmentDictionary;
    for (const apartment of dictionary.apartments ?? []) {
      for (const alias of [apartment.name, ...(apartment.aliases ?? [])]) result.set(apartmentKey(alias), apartment.name);
    }
  } catch { /* Parsing unknown names still works if no generated dictionary is present. */ }
  return result;
}

const aliases = loadApartmentAliases();

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

function canonicalApartment(value: string): string | null {
  const candidate = apartmentKey(value);
  const exact = aliases.get(candidate);
  if (exact) return exact;
  let best: { name: string; distance: number } | null = null;
  for (const [alias, name] of aliases) {
    const allowed = alias.length >= 12 ? 2 : alias.length >= 5 ? 1 : 0;
    const distance = editDistance(candidate, alias);
    if (distance <= allowed && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name ?? null;
}

function normalizeLine(line: string): string {
  return line.replace(/\u00a0/g, " ").replace(/[â€“â€”]/g, "-").replace(/\s+/g, " ").trim();
}

function parseMinutes(hoursRaw: string, minutesRaw?: string): number | null {
  const hours = Number(hoursRaw);
  const minutes = minutesRaw === undefined ? 0 : Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function parseTimeAnswer(value: string): number | null {
  const match = normalizeLine(value).match(/^(\d{1,2})(?::(\d{2}))?$/);
  return match ? parseMinutes(match[1]!, match[2]) : null;
}

function parseDate(text: string, now: Date): { dateIso: string; displayDate: string } | null {
  const match = text.match(DATE_RE);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return {
    dateIso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    displayDate: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`,
  };
}

function detectType(line: string): WorkType {
  const lower = line.toLocaleLowerCase("ru");
  if (CHECKIN_RE.test(lower)) return "checkin";
  if (/Ð¿Ñ€Ð°ÐºÑ‚Ð¸Ðº/u.test(lower)) return "practice";
  if (/Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½|Ð·Ð½Ð°ÐºÐ¾Ð¼ÑÑ‚Ð²/u.test(lower)) return "orientation";
  if (/ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒ|ÑƒÐ±Ð¾Ñ€Ðº/u.test(lower)) return "independent";
  return "unknown";
}

function normalizeObject(value: string): string {
  const cleaned = value
    .replace(/^\s*\d+\s*[.)-]\s*/u, "")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .replace(/\s+/g, " ").trim();
  const alias = canonicalApartment(cleaned);
  if (alias) return alias;
  return cleaned.split(" ").map((part) => /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function extractCompanion(line: string): string | undefined {
  for (const match of line.matchAll(/\(([^)]+)\)/g)) {
    const value = match[1]!.trim();
    if (!/\d{1,2}(?::\d{2})?(?:\s*-\s*\d{1,2}(?::\d{2})?)?/.test(value) && !TYPE_HINT_RE.test(value)) return normalizeObject(value);
  }
  return undefined;
}

function amountCents(raw: string): number | null {
  const value = Number(raw.replace("â‚¬", "").replace(",", ".").trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

function amountMatches(line: string): Array<{ value: number; index: number; raw: string }> {
  return [...line.matchAll(AMOUNT_RE)].flatMap((match) => {
    const value = amountCents(match[0]);
    return value === null ? [] : [{ value, index: match.index ?? 0, raw: match[0] }];
  });
}

function parseExpenseSegment(line: string, dryerDefaultCents: number): Expense[] | null {
  const categoryMatch = line.match(EXPENSE_RE);
  const onlyAmounts = /^[\s+]*(?:\d+(?:[.,]\d{1,2})?\s*â‚¬?[\s+]*)+$/u.test(line);
  if (!categoryMatch && !onlyAmounts) return null;
  const matches = amountMatches(line);
  if (!matches.length) {
    if (!categoryMatch?.[0].toLocaleLowerCase("ru").startsWith("ÑÑƒÑˆÐº")) return null;
    return [{ category: "ÑÑƒÑˆÐºÐ°", amountCents: dryerDefaultCents, sourceLine: line }];
  }
  const categoryIndex = categoryMatch?.index ?? 0;
  const categoryEnd = categoryIndex + (categoryMatch?.[0].length ?? 0);
  const firstAmount = matches[0]!;
  const objectRaw = categoryMatch
    ? line.slice(categoryEnd, firstAmount.index).replace(/[():+]/g, " ").trim()
    : "";
  return matches.map((match, index) => ({
    category: index === 0 && categoryMatch
      ? (categoryMatch[0].toLocaleLowerCase("ru").startsWith("ÑÑƒÑˆÐº") ? "ÑÑƒÑˆÐºÐ°" : categoryMatch[0].toLocaleLowerCase("ru"))
      : "Ñ€Ð°ÑÑ…Ð¾Ð´Ñ‹",
    object: index === 0 && objectRaw ? normalizeObject(objectRaw) : undefined,
    amountCents: match.value,
    sourceLine: line,
  }));
}

function extractInlineExpenses(line: string, dryerDefaultCents: number): { expenses: Expense[]; remainder: string } {
  const category = line.match(EXPENSE_RE);
  if (!category || category.index === undefined) return { expenses: [], remainder: line };
  const segment = line.slice(category.index);
  const expenses = parseExpenseSegment(segment, dryerDefaultCents) ?? [];
  return { expenses, remainder: line.slice(0, category.index).replace(/[\s+,:;-]+$/u, "").trim() };
}

function parseAdvance(line: string): { cents?: number; invalid?: boolean } | null {
  if (!/^Ð°Ð²Ð°Ð½Ñ(?:\s|:|$)/iu.test(line)) return null;
  const rawMatches = [...line.matchAll(AMOUNT_RE)];
  if (!rawMatches.length || rawMatches.some((match) => amountCents(match[0]) === null)) return { invalid: true };
  return { cents: rawMatches.reduce((sum, match) => sum + (amountCents(match[0]) ?? 0), 0) };
}

function parseJob(originalLine: string, dryerDefaultCents: number): { job: Job; inlineExpenses: Expense[] } | null {
  const boldObject = originalLine.match(/\*([^*]+)\*/)?.[1];
  let line = normalizeLine(originalLine.replace(/\*/g, ""));
  const type = detectType(line);
  const companion = extractCompanion(line);
  const extracted = extractInlineExpenses(line, dryerDefaultCents);
  line = extracted.remainder;
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  const interval = line.match(INTERVAL_RE);
  if (interval) {
    startMinutes = parseMinutes(interval[1]!, interval[2]);
    endMinutes = parseMinutes(interval[3]!, interval[4]);
    line = line.replace(interval[0], " ");
  } else {
    const single = line.match(TIME_RE);
    if (single) {
      startMinutes = parseMinutes(single[1]!, single[2]);
      line = line.replace(single[0], " ");
    }
  }
  line = line
    .replace(/\s*\/.*$/u, " ")
    .replace(TYPE_RE, " ")
    .replace(/\b[A-Z]{1,3}\d{2,5}\b\s*(?:flight\s+number)?/giu, " ")
    .replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/g, " ")
    .replace(TIME_TOKEN_RE, " ").replace(/Ð¸Ð·Ð¼ÐµÐ½ÐµÐ½Ð¸Ñ?/giu, " ")
    .replace(/\s+-\s+|^\s*-\s*|\s*-\s*$/g, " ").replace(/\s+/g, " ").trim();
  const object = boldObject ? normalizeObject(boldObject) : normalizeObject(line);
  if (!object || startMinutes === null) return null;
  const job: Job = { object, startMinutes, endMinutes, endInferred: false, workType: type, companion, sourceLine: originalLine };
  for (const expense of extracted.expenses) expense.object = object;
  return { job, inlineExpenses: extracted.expenses };
}

function inferEndsAndIssues(jobs: Job[]): ParseIssue[] {
  const issues: ParseIssue[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    const next = jobs[index + 1];
    if (job.endMinutes === null && job.startMinutes !== null && job.workType === "checkin") {
      job.endMinutes = job.startMinutes + CHECKIN_DEFAULT_MINUTES;
      job.endInferred = true;
    } else if (job.endMinutes === null && next?.startMinutes !== null && next?.startMinutes !== undefined) {
      job.endMinutes = next.startMinutes;
      job.endInferred = true;
    } else if (job.startMinutes !== null && job.endMinutes === null && (job.workType === "orientation" || job.workType === "practice")) {
      job.endMinutes = job.startMinutes + FLAT_ACTIVITY_DEFAULT_MINUTES;
      job.endInferred = true;
    }
    if (job.startMinutes === null) issues.push({ code: "missing_start", jobIndex: index, message: `ÐÐµÑ‚ Ð½Ð°Ñ‡Ð°Ð»Ð° Ð´Ð»Ñ ${job.object}` });
    else if (job.endMinutes === null) issues.push({ code: "missing_end", jobIndex: index, message: `ÐÐµÑ‚ Ð¾ÐºÐ¾Ð½Ñ‡Ð°Ð½Ð¸Ñ Ð´Ð»Ñ ${job.object}` });
    else if (job.endMinutes <= job.startMinutes) issues.push({ code: "overlap", jobIndex: index, message: `ÐÐµÐºÐ¾Ñ€Ñ€ÐµÐºÑ‚Ð½Ñ‹Ð¹ Ð¸Ð½Ñ‚ÐµÑ€Ð²Ð°Ð» Ñƒ ${job.object}` });
    if (job.workType === "unknown") issues.push({ code: "missing_type", jobIndex: index, message: `ÐÐµ ÑƒÐºÐ°Ð·Ð°Ð½ Ñ‚Ð¸Ð¿ Ð´Ð»Ñ ${job.object}` });
    if (next?.startMinutes != null && job.endMinutes !== null && job.endMinutes > next.startMinutes) {
      issues.push({ code: "overlap", jobIndex: index, message: `${job.object} Ð¿ÐµÑ€ÐµÑÐµÐºÐ°ÐµÑ‚ÑÑ ÑÐ¾ ÑÐ»ÐµÐ´ÑƒÑŽÑ‰ÐµÐ¹ Ñ€Ð°Ð±Ð¾Ñ‚Ð¾Ð¹` });
    }
  }
  return issues;
}

export function parseDay(text: string, now = new Date(), dryerDefaultCents = 390): ParsedDay {
  const date = parseDate(text, now);
  const sourceLines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const lines: string[] = [];
  for (const line of sourceLines) {
    const intervalOnly = INTERVAL_RE.test(line) && line.replace(INTERVAL_RE, "").replace(/[()]/g, "").trim() === "";
    if (intervalOnly && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`;
    else lines.push(line);
  }
  const jobs: Job[] = [];
  cons÷~-¢G§²ÚîÆ­yÒ&F•÷FW‡B#°¢v÷&´FFS¢7G&–ærÂçVÆÃ°¢7&VFVDC¢7G&–æs°¢WFFVDC¢7G&–æs°§Ð ¦W‡÷'BG—RÆVFvW%&÷rÐ¢Â‡²&÷uG—S¢'v÷&²"Òb7F÷&VDF’¢Â‡²&÷uG—S¢'–ÖVçB"Òb–ÖVçB“° ¦W‡÷'B–çFW&f6RÆVFvW%f–Wr°¢F÷FÇ3¢ÆVFvW%F÷FÇ3°¢&÷w3¢ÆVFvW%&÷uµÓ°§Ð ¦W‡÷'B–çFW&f6R6fTF”–çWB°¢FFT—6ó¢7G&–æs°¢6÷W&6UFW‡C¢7G&–æs°¢'6VDFWF–Ç3¢'6VDF“°¢F÷FÇ3¢F•F÷FÇ3°¢Gfæ6T6VçG3¢çVÖ&W#°§Ð ¦W‡÷'B–çFW&f6RÆVFvW%7F÷&R°¢–æ—F–Æ—¦R‚“¢&öÖ—6SÇfö–Cã°¢†VÇF‚‚“¢&öÖ—6SÆ&ööÆVãã°¢6Æ÷6R‚“¢&öÖ—6SÇfö–Cã°¢&ö¦V7DF’†FFT—6ó¢7G&–ærÂF÷FÇ3¢F•F÷FÇ2ÂGfæ6T6VçG3¢çVÖ&W"“¢&öÖ—6SÅ&W÷'E6æ6†÷Cã°¢6fTF’†–çWC¢6fTF”–çWB“¢&öÖ—6SÇ²F“¢7F÷&VDF“²6æ6†÷C¢&W÷'E6æ6†÷BÓã°¢vWDÆVFvW"†g&öÓó¢7G&–ærÂFóó¢7G&–ær“¢&öÖ—6SÄÆVFvW%f–Wsã°¢7&VFU–ÖVçB†FFT—6ó¢7G&–ærÂÖ÷VçD6VçG3¢çVÖ&W"Âæ÷FSó¢7G&–ær“¢&öÖ—6SÅ–ÖVçCã°¢WFFU–ÖVçB†–C¢çVÖ&W"ÂfÇVW3¢²FFT—6óó¢7G&–æs²Ö÷VçD6VçG3ó¢çVÖ&W#²æ÷FSó¢7G&–ærÂçVÆÂÒ“¢&öÖ—6SÅ–ÖVçBÂçVÆÃã°¢FVÆWFU–ÖVçB†–C¢çVÖ&W"“¢&öÖ—6SÆ&ööÆVãã°§Ð ¦6öç7B¦W&õF÷FÇ2Ò‚“¢ÆVFvW%F÷FÇ2Óâ‡°¢Ö–çWFW3¢ÂV&æVD6VçG3¢Â&V6V—fVD6VçG3¢Â÷WG7FæF–æt6VçG3¢À¢W‡Vç6W46VçG3¢Â6†V6¶–ä6VçG3¢À§Ò“° ¦gVæ7F–öâf–æ—6…F÷FÇ2‡fÇVS¢öÖ—CÄÆVFvW%F÷FÇ2Â&÷WG7FæF–æt6VçG2#â“¢ÆVFvW%F÷FÇ2°¢&WGW&â²ââçfÇVRÂ÷WG7FæF–æt6VçG3¢fÇVRæV&æVD6VçG2ÒfÇVRç&V6V—fVD6VçG2Ó°§Ð ¦W‡÷'B6Æ72ÖVÖ÷'”ÆVFvW%7F÷&R–×ÆVÖVçG2ÆVFvW%7F÷&R°¢&—fFR&VFöæÇ’F—2ÒæWrÖÇ7G&–ærÂ7F÷&VDF“â‚“°¢&—fFR&VFöæÇ’–ÖVçG2ÒæWrÖÆçVÖ&W"Â–ÖVçCâ‚“°¢&—fFRæW‡D–BÒ° ¢7–æ2–æ—F–Æ—¦R‚“¢&öÖ—6SÇfö–Câ·Ð¢7–æ2†VÇF‚‚“¢&öÖ—6SÆ&ööÆVãâ²&WGW&âG'VS²Ð¢7–æ26Æ÷6R‚“¢&öÖ—6SÇfö–Câ·Ð ¢&—fFRvw&VvFR‡Fóó¢7G&–ærÂg&öÓó¢7G&–ærÂW†6ÇVFVDFFSó¢7G&–ær“¢ÆVFvW%F÷FÇ2°¢6öç7B&W7VÇBÒ¦W&õF÷FÇ2‚“°¢f÷"†6öç7BF’öbF†—2æF—2çfÇVW2‚’’°¢–b‚†g&öÒbbF’æFFT—6òÂg&öÒ’ÇÂ‡FòbbF’æFFT—6òâFò’ÇÂF’æFFT—6òÓÓÒW†6ÇVFVDFFR’6öçF–çVS°¢&W7VÇBæÖ–çWFW2³ÒF’æÖ–çWFW3°¢&W7VÇBæV&æVD6VçG2³ÒF’æ–æ6öÖT6VçG3°¢&W7VÇBæW‡Vç6W46VçG2³ÒF’æW‡Vç6W46VçG3°¢&W7VÇBæ6†V6¶–ä6VçG2³ÒF’æ6†V6¶–ä6VçG3°¢Ð¢f÷"†6öç7B–ÖVçBöbF†—2ç–ÖVçG2çfÇVW2‚’’°¢–b‚†g&öÒbb–ÖVçBæFFT—6òÂg&öÒ’ÇÂ‡Fòbb–ÖVçBæFFT—6òâFò’ÇÂ†W†6ÇVFVDFFRbb–ÖVçBç6÷W&6RÓÓÒ&F•÷FW‡B"bb–ÖVçBçv÷&´FFRÓÓÒW†6ÇVFVDFFR’’6öçF–çVS°¢&W7VÇBç&V6V—fVD6VçG2³Ò–ÖVçBæÖ÷VçD6VçG3°¢Ð¢&W7VÇBæ÷WG7FæF–æt6VçG2Ò&W7VÇBæV&æVD6VçG2Ò&W7VÇBç&V6V—fVD6VçG3°¢&WGW&â&W7VÇC°¢Ð ¢7–æ2&ö¦V7DF’†FFT—6ó¢7G&–ærÂF÷FÇ3¢F•F÷FÇ2ÂGfæ6T6VçG3¢çVÖ&W"“¢&öÖ—6SÅ&W÷'E6æ6†÷Câ°¢6öç7B&Wf–÷W2ÒF†—2ævw&VvFR†æWrFFR†G¶FFT—6÷ÕC££¦’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ’“°¢f÷"†6öç7BF’öbF†—2æF—2çfÇVW2‚’’–b†F’æFFT—6òÓÓÒFFT—6ò’°¢&Wf–÷W2æÖ–çWFW2ÓÒF’æÖ–çWFW3²&Wf–÷W2æV&æVD6VçG2ÓÒF’æ–æ6öÖT6VçG3°¢&Wf–÷W2æW‡Vç6W46VçG2ÓÒF’æW‡Vç6W46VçG3²&Wf–÷W2æ6†V6¶–ä6VçG2ÓÒF’æ6†V6¶–ä6VçG3°¢Ð¢f÷"†6öç7B–ÖVçBöbF†—2ç–ÖVçG2çfÇVW2‚’’–b‡–ÖVçBæFFT—6òÓÓÒFFT—6ò’&Wf–÷W2ç&V6V—fVD6VçG2ÓÒ–ÖVçBæÖ÷VçD6VçG3°¢&Wf–÷W2æ÷WG7FæF–æt6VçG2Ò&Wf–÷W2æV&æVD6VçG2Ò&Wf–÷W2ç&V6V—fVD6VçG3°¢6öç7B&6RÒF†—2ævw&VvFR†FFT—6òÂVæFVf–æVBÂFFT—6ò“°¢6öç7BF÷FÂÒf–æ—6…F÷FÇ2‡°¢Ö–çWFW3¢&6RæÖ–çWFW2²F÷FÇ2æÖ–çWFW2À¢V&æVD6VçG3¢&6RæV&æVD6VçG2²F÷FÇ2æ–æ6öÖT6VçG2À¢&V6V—fVD6VçG3¢&6Rç&V6V—fVD6VçG2²Gfæ6T6VçG2À¢W‡Vç6W46VçG3¢&6RæW‡Vç6W46VçG2²F÷FÇ2æW‡Vç6W46VçG2À¢6†V6¶–ä6VçG3¢&6Ræ6†V6¶–ä6VçG2²F÷FÇ2æ6†V6¶–ä6VçG2À¢Ò“°¢&WGW&â²&Wf–÷W2ÂF÷FÂÓ°¢Ð ¢7–æ26fTF’†–çWC¢6fTF”–çWB“¢&öÖ—6SÇ²F“¢7F÷&VDF“²6æ6†÷C¢&W÷'E6æ6†÷BÓâ°¢6öç7BWFFVDBÒæWrFFR‚’çFô•4õ7G&–ær‚“°¢6öç7BF“¢7F÷&VDF’Ò²FFT—6ó¢–çWBæFFT—6òÂ6÷W&6UFW‡C¢–çWBç6÷W&6UFW‡BÂ'6VDFWF–Ç3¢–çWBç'6VDFWF–Ç2Âââæ–çWBçF÷FÇ2ÂWFFVDBÓ°¢F†—2æF—2ç6WB†–çWBæFFT—6òÂF’“°¢f÷"†6öç7B¶–BÂ–ÖVçEÒöbF†—2ç–ÖVçG2’–b‡–ÖVçBç6÷W&6RÓÓÒ&F•÷FW‡B"bb–ÖVçBçv÷&´FFRÓÓÒ–çWBæFFT—6ò’F†—2ç–ÖVçG2æFVÆWFR†–B“°¢–b†–çWBæGfæ6T6VçG2â’°¢6öç7B–BÒF†—2ææW‡D–B²³°¢F†—2ç–ÖVçG2ç6WB†–BÂ²–BÂFFT—6ó¢–çWBæFFT—6òÂÖ÷VçD6VçG3¢–çWBæGfæ6T6VçG2Âæ÷FS¢-	-Ýrí-}-"Â6÷W&6S¢&F•÷FW‡B"Âv÷&´FFS¢–çWBæFFT—6òÂ7&VFVDC¢WFFVDBÂWFFVDBÒ“°¢Ð¢&WGW&â²F’Â6æ6†÷C¢v—BF†—2ç&ö¦V7DF’†–çWBæFFT—6òÂ–çWBçF÷FÇ2Â–çWBæGfæ6T6VçG2’Ó°¢Ð ¢7–æ2vWDÆVFvW"†g&öÓó¢7G&–ærÂFóó¢7G&–ær“¢&öÖ—6SÄÆVFvW%f–Wsâ°¢6öç7B&÷w3¢ÆVFvW%&÷uµÒÒµÓ°¢f÷"†6öç7BF’öbF†—2æF—2çfÇVW2‚’’–b‚‚g&öÒÇÂF’æFFT—6òãÒg&öÒ’bb‚FòÇÂF’æFFT—6òÃÒFò’’&÷w2çW6‚‡²&÷uG—S¢'v÷&²"ÂââæF’Ò“°¢f÷"†6öç7B–ÖVçBöbF†—2ç–ÖVçG2çfÇVW2‚’’–b‚‚g&öÒÇÂ–ÖVçBæFFT—6òãÒg&öÒ’bb‚FòÇÂ–ÖVçBæFFT—6òÃÒFò’’&÷w2çW6‚‡²&÷uG—S¢'–ÖVçB"Âââç–ÖVçBÒ“°¢&÷w2ç6÷'B‚†Â"’ÓâæFFT—6òæÆö6ÆT6ö×&R†"æFFT—6ò’ÇÂ†ç&÷uG—RÓÓÒ'v÷&²"òÓ¢’“°¢&WGW&â²F÷FÇ3¢F†—2ævw&VvFR‡FòÂg&öÒ’Â&÷w2Ó°¢Ð ¢7–æ27&VFU–ÖVçB†FFT—6ó¢7G&–ærÂÖ÷VçD6VçG3¢çVÖ&W"Âæ÷FSó¢7G&–ær“¢&öÖ—6SÅ–ÖVçCâ°¢6öç7Bæ÷rÒæWrFFR‚’çFô•4õ7G&–ær‚“²6öç7B–BÒF†—2ææW‡D–B²³°¢6öç7B–ÖVçC¢–ÖVçBÒ²–BÂFFT—6òÂÖ÷VçD6VçG2Âæ÷FS¢æ÷FSòçG&–Ò‚’ÇÂçVÆÂÂ6÷W&6S¢&ÖçVÂ"Âv÷&´FFS¢çVÆÂÂ7&VFVDC¢æ÷rÂWFFVDC¢æ÷rÓ°¢F†—2ç–ÖVçG2ç6WB†–BÂ–ÖVçB“²&WGW&â–ÖVçC°¢Ð ¢7–æ2WFFU–ÖVçB†–C¢çVÖ&W"ÂfÇVW3¢²FFT—6óó¢7G&–æs²Ö÷VçD6VçG3ó¢çVÖ&W#²æ÷FSó¢7G&–ærÂçVÆÂÒ“¢&öÖ—6SÅ–ÖVçBÂçVÆÃâ°¢6öç7B7W'&VçBÒF†—2ç–ÖVçG2ævWB†–B“°¢–b‚7W'&VçBÇÂ7W'&VçBç6÷W&6RÓÒ&ÖçVÂ"’&WGW&âçVÆÃ°¢6öç7BæW‡BÒ²ââæ7W'&VçBÂFFT—6ó¢fÇVW2æFFT—6òóò7W'&VçBæFFT—6òÂÖ÷VçD6VçG3¢fÇVW2æÖ÷VçD6VçG2óò7W'&VçBæÖ÷VçD6VçG2Âæ÷FS¢fÇVW2ææ÷FRÓÓÒVæFVf–æVBò7W'&VçBææ÷FR¢fÇVW2ææ÷FSòçG&–Ò‚’ÇÂçVÆÂÂWFFVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’Ó°¢F†—2ç–ÖVçG2ç6WB†–BÂæW‡B“²&WGW&âæW‡C°¢Ð ¢7–æ2FVÆWFU–ÖVçB†–C¢çVÖ&W"“¢&öÖ—6SÆ&ööÆVãâ°¢6öç7B–ÖVçBÒF†—2ç–ÖVçG2ævWB†–B“°¢&WGW&â–ÖVçCòç6÷W&6RÓÓÒ&ÖçVÂ"òF†—2ç–ÖVçG2æFVÆWFR†–B’¢fÇ6S°¢Ð§Ð ¦gVæ7F–öâÖF÷FÇ2‡&÷s¢&V6÷&CÇ7G&–ærÂ7G&–ærÂçVÖ&W"ÂçVÆÃâ“¢ÆVFvW%F÷FÇ2°¢6öç7BV&æVD6VçG2ÒçVÖ&W"‡&÷ræV&æVEö6VçG2óò“°¢6öç7B&V6V—fVD6VçG2ÒçVÖ&W"‡&÷rç&V6V—fVEö6VçG2óò“°¢&WGW&â°¢Ö–çWFW3¢çVÖ&W"‡&÷ræÖ–çWFW2óò’ÂV&æVD6VçG2Â&V6V—fVD6VçG2À¢÷WG7FæF–æt6VçG3¢V&æVD6VçG2Ò&V6V—fVD6VçG2À¢W‡Vç6W46VçG3¢çVÖ&W"‡&÷ræW‡Vç6W5ö6VçG2óò’Â6†V6¶–ä6VçG3¢çVÖ&W"‡&÷ræ6†V6¶–åö6VçG2óò’À¢Ó°§Ð ¦gVæ7F–öâÖF’‡&÷s¢&V6÷&CÇ7G&–ærÂVæ¶æ÷vãâ“¢7F÷&VDF’°¢&WGW&â°¢FFT—6ó¢7G&–ær‡&÷ræFFUö—6ò’Â6÷W&6UFW‡C¢7G&–ær‡&÷rç6÷W&6U÷FW‡B’Â'6VDFWF–Ç3¢&÷rç'6VEöFWF–Ç22'6VDF’À¢Ö–çWFW3¢çVÖ&W"‡&÷ræÖ–çWFW2’Â–æ6öÖT6VçG3¢çVÖ&W"‡&÷ræV&æVEö6VçG2’Â6†V6¶–ä6VçG3¢çVÖ&W"‡&÷ræ6†V6¶–åö6VçG2’À¢W‡Vç6W46VçG3¢çVÖ&W"‡&÷ræW‡Vç6W5ö6VçG2’ÂWFFVDC¢æWrFFR…7G&–ær‡&÷rçWFFVEöB’’çFô•4õ7G&–ær‚’À¢Ó°§Ð ¦gVæ7F–öâÖ–ÖVçB‡&÷s¢&V6÷&CÇ7G&–ærÂVæ¶æ÷vãâ“¢–ÖVçB°¢&WGW&â°¢–C¢çVÖ&W"‡&÷ræ–B’ÂFFT—6ó¢7G&–ær‡&÷rç–ÖVçEöFFR’ÂÖ÷VçD6VçG3¢çVÖ&W"‡&÷ræÖ÷VçEö6VçG2’À¢æ÷FS¢&÷rææ÷FRÓÒçVÆÂòçVÆÂ¢7G&–ær‡&÷rææ÷FR’Â6÷W&6S¢7G&–ær‡&÷rç6÷W&6R’2–ÖVçE²'6÷W&6R%ÒÀ¢v÷&´FFS¢&÷rçv÷&µöFFRÓÒçVÆÂòçVÆÂ¢7G&–ær‡&÷rçv÷&µöFFR’À¢7&VFVDC¢æWrFFR…7G&–ær‡&÷ræ7&VFVEöB’’çFô•4õ7G&–ær‚’ÂWFFVDC¢æWrFFR…7G&–ær‡&÷rçWFFVEöB’’çFô•4õ7G&–ær‚’À¢Ó°§Ð ¦W‡÷'B6Æ72÷7Fw&W4ÆVFvW%7F÷&R–×ÆVÖVçG2ÆVFvW%7F÷&R°¢&—fFR&VFöæÇ’ööÃ¢ööÃ°¢6öç7G'V7F÷"†6öææV7F–öå7G&–æs¢7G&–ær’²F†—2çööÂÒæWrööÂ‡²6öææV7F–öå7G&–ærÒ“²Ð ¢7–æ2–æ—F–Æ—¦R‚“¢&öÖ—6SÇfö–Câ°¢v—BF†—2çööÂçVW'’† ¢5$TDRD$ÄR”bäõBU„•5E2v÷&µöF—2€¢FFUö—6òFFR$”Ô%’´U’Â6÷W&6U÷FW‡BFW‡BäõBåTÄÂÂ'6VEöFWF–Ç2§6öæ"äõBåTÄÂÀ¢Ö–çWFW2–çFVvW"äõBåTÄÂ4„T4²†Ö–çWFW2ãÒ’ÂV&æVEö6VçG2–çFVvW"äõBåTÄÂ4„T4²†V&æVEö6VçG2ãÒ’À¢6†V6¶–åö6VçG2–çFVvW"äõBåTÄÂDTdTÅB4„T4²†6†V6¶–åö6VçG2ãÒ’À¢W‡Vç6W5ö6VçG2–çFVvW"äõBåTÄÂ4„T4²†W‡Vç6W5ö6VçG2ãÒ’ÂWFFVEöBF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚¢“°¢5$TDRD$ÄR”bäõBU„•5E2–ÖVçG2€¢–B&–w6W&–Â$”Ô%’´U’Â–ÖVçEöFFRFFRäõBåTÄÂÂÖ÷VçEö6VçG2–çFVvW"äõBåTÄÂ4„T4²†Ö÷VçEö6VçG2â’À¢æ÷FRFW‡BÂ6÷W&6RFW‡BäõBåTÄÂ4„T4²‡6÷W&6R”â‚vÖçVÂrÂvF•÷FW‡Br’’À¢v÷&µöFFRFFR$TdU$Tä4U2v÷&µöF—2†FFUö—6ò’ôâDTÄUDR444DRÀ¢7&VFVEöBF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’ÂWFFVEöBF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚¢“°¢5$TDRTä•TR”äDU‚”bäõBU„•5E2–ÖVçG5ööæUöF•÷FW‡Bôâ–ÖVçG2‡v÷&µöFFR’t„U$R6÷W&6RÒvF•÷FW‡Bs°¢5$TDR”äDU‚”bäõBU„•5E2–ÖVçG5öFFUö–G‚ôâ–ÖVçG2‡–ÖVçEöFFR“°¢“°¢Ð ¢7–æ2†VÇF‚‚“¢&öÖ—6SÆ&ööÆVãâ²G'’²v—BF†—2çööÂçVW'’‚%4TÄT5B"“²&WGW&âG'VS²Ò6F6‚²&WGW&âfÇ6S²ÒÐ¢7–æ26Æ÷6R‚“¢&öÖ—6SÇfö–Câ²v—BF†—2çööÂæVæB‚“²Ð ¢&—fFR7–æ2vw&VvFR†6Æ–VçC¢ööÂÂööÄ6Æ–VçBÂ6öæF—F–öâÒ%E%TR"ÂfÇVW3¢Væ¶æ÷våµÒÒµÒ“¢&öÖ—6SÄÆVFvW%F÷FÇ3â°¢6öç7B&W7VÇBÒv—B6Æ–VçBçVW'’† ¢4TÄT5@¢4ôÄU44R‚…4TÄT5B5TÒ†Ö–çWFW2’e$ôÒv÷&µöF—2t„U$RG¶6öæF—F–öçÒ’Â“£¦–çB2Ö–çWFW2À¢4ôÄU44R‚…4TÄT5B5TÒ†V&æVEö6VçG2’e$ôÒv÷&µöF—2t„U$RG¶6öæF—F–öçÒ’Â“£¦–çB2V&æVEö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†W‡Vç6W5ö6VçG2’e$ôÒv÷&µöF—2t„U$RG¶6öæF—F–öçÒ’Â“£¦–çB2W‡Vç6W5ö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†6†V6¶–åö6VçG2’e$ôÒv÷&µöF—2t„U$RG¶6öæF—F–öçÒ’Â“£¦–çB26†V6¶–åö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†Ö÷VçEö6VçG2’e$ôÒ–ÖVçG2t„U$RG¶6öæF—F–öâç&WÆ6TÆÂ‚&FFUö—6ò"Â'–ÖVçEöFFR"—Ò’Â“£¦–çB2&V6V—fVEö6VçG0¢ÂfÇVW2“°¢&WGW&âÖF÷FÇ2‡&W7VÇBç&÷w5³Ò“°¢Ð ¢7–æ2&ö¦V7DF’†FFT—6ó¢7G&–ærÂF÷FÇ3¢F•F÷FÇ2ÂGfæ6T6VçG3¢çVÖ&W"“¢&öÖ—6SÅ&W÷'E6æ6†÷Câ°¢6öç7B·&Wf–÷W2Â&6U&W7VÇEÒÒv—B&öÖ—6RæÆÂ…°¢F†—2ævw&VvFR‡F†—2çööÂÂ&FFUö—6òÂC"Â¶FFT—6õÒ’À¢F†—2çööÂçVW'’† ¢4TÄT5@¢4ôÄU44R‚…4TÄT5B5TÒ†Ö–çWFW2’e$ôÒv÷&µöF—2t„U$RFFUö—6òÃÒCäBFFUö—6òÃâC’Â“£¦–çB2Ö–çWFW2À¢4ôÄU44R‚…4TÄT5B5TÒ†V&æVEö6VçG2’e$ôÒv÷&µöF—2t„U$RFFUö—6òÃÒCäBFFUö—6òÃâC’Â“£¦–çB2V&æVEö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†W‡Vç6W5ö6VçG2’e$ôÒv÷&µöF—2t„U$RFFUö—6òÃÒCäBFFUö—6òÃâC’Â“£¦–çB2W‡Vç6W5ö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†6†V6¶–åö6VçG2’e$ôÒv÷&µöF—2t„U$RFFUö—6òÃÒCäBFFUö—6òÃâC’Â“£¦–çB26†V6¶–åö6VçG2À¢4ôÄU44R‚…4TÄT5B5TÒ†Ö÷VçEö6VçG2’e$ôÒ–ÖVçG2t„U$R–ÖVçEöFFRÃÒCäBäõB‡6÷W&6SÒvF•÷FW‡BräBv÷&µöFFSÒC’’Â“£¦–çB2&V6V—fVEö6VçG0¢Â¶FFT—6õÒ’À¢Ò“°¢6öç7B&6RÒÖF÷FÇ2†&6U&W7VÇBç&÷w5³Ò“°¢6öç7BF÷FÂÒf–æ—6…F÷FÇ2‡°¢Ö–çWFW3¢&6RæÖ–çWFW2²F÷FÇ2æÖ–çWFW2ÂV&æVD6VçG3¢&6RæV&æVD6VçG2²F÷FÇ2æ–æ6öÖT6VçG2À¢&V6V—fVD6VçG3¢&6Rç&V6V—fVD6VçG2²Gfæ6T6VçG2ÂW‡Vç6W46VçG3¢&6RæW‡Vç6W46VçG2²F÷FÇ2æW‡Vç6W46VçG2À¢6†V6¶–ä6VçG3¢&6Ræ6†V6¶–ä6VçG2²F÷FÇ2æ6†V6¶–ä6VçG2À¢Ò“°¢&WGW&â²&Wf–÷W2ÂF÷FÂÓ°¢Ð ¢7–æ26fTF’†–çWC¢6fTF”–çWB“¢&öÖ—6SÇ²F“¢7F÷&VDF“²6æ6†÷C¢&W÷'E6æ6†÷BÓâ°¢6öç7B6Æ–VçBÒv—BF†—2çööÂæ6öææV7B‚“°¢G'’°¢v—B6Æ–VçBçVW'’‚$$Tt”â"“°¢6öç7B6fVBÒv—B6Æ–VçBçVW'’† ¢”å4U%B”åDòv÷&µöF—2†FFUö—6òÂ6÷W&6U÷FW‡BÂ'6VEöFWF–Ç2ÂÖ–çWFW2ÂV&æVEö6VçG2Â6†V6¶–åö6VçG2ÂW‡Vç6W5ö6VçG2ÂWFFVEöB¢dÅTU2‚CÂC"ÂC3£¦§6öæ"ÂCBÂCRÂCbÂCrÂæ÷r‚’¢ôâ4ôädÄ”5B†FFUö—6ò’DòUDDR4UB6÷W&6U÷FW‡CÔU„4ÅTDTBç6÷W&6U÷FW‡BÂ'6VEöFWF–Ç3ÔU„4ÅTDTBç'6VEöFWF–Ç2À¢Ö–çWFW3ÔU„4ÅTDTBæÖ–çWFW2ÂV&æVEö6VçG3ÔU„4ÅTDTBæV&æVEö6VçG2Â6†V6¶–åö6VçG3ÔU„4ÅTDTBæ6†V6¶–åö6VçG2À¢W‡Vç6W5ö6VçG3ÔU„4ÅTDTBæW‡Vç6W5ö6VçG2ÂWFFVEöCÖæ÷r‚¢$UEU$ä”är ¢Â¶–çWBæFFT—6òÂ–çWBç6÷W&6UFW‡BÂ¥4ôâç7G&–æv–g’†–çWBç'6VDFWF–Ç2’Â–çWBçF÷FÇ2æÖ–çWFW2Â–çWBçF÷FÇ2æ–æ6öÖT6VçG2Â–çWBçF÷FÇ2æ6†V6¶–ä6VçG2Â–çWBçF÷FÇ2æW‡Vç6W46VçG5Ò“°¢v—B6Æ–VçBçVW'’‚$DTÄUDRe$ôÒ–ÖVçG2t„U$R6÷W&6SÒvF•÷FW‡BräBv÷&µöFFSÒC"Â¶–çWBæFFT—6õÒ“°¢–b†–çWBæGfæ6T6VçG2â’v—B6Æ–VçBçVW'’€¢$”å4U%B”åDò–ÖVçG2‡–ÖVçEöFFRÂÖ÷VçEö6VçG2Âæ÷FRÂ6÷W&6RÂv÷&µöFFR’dÅTU2‚CÂC"Â}	-Ýrí-}-rÂvF•÷FW‡BrÂC’"À¢¶–çWBæFFT—6òÂ–çWBæGfæ6T6VçG5ÒÀ¢“°¢6öç7B&Wf–÷W2Òv—BF†—2ævw&VvFR†6Æ–VçBÂ&FFUö—6òÂC"Â¶–çWBæFFT—6õÒ“°¢6öç7BF÷FÂÒv—BF†—2ævw&VvFR†6Æ–VçBÂ&FFUö—6òÃÒC"Â¶–çWBæFFT—6õÒ“°¢v—B6Æ–VçBçVW'’‚$4ôÔÔ•B"“°¢&WGW&â²F“¢ÖF’‡6fVBç&÷w5³Ò’Â6æ6†÷C¢²&Wf–÷W2ÂF÷FÂÒÓ°¢Ò6F6‚†W'&÷"’²v—B6Æ–VçBçVW'’‚%$ôÄÄ$4²"“²F‡&÷rW'&÷#²Ð¢f–æÆÇ’²6Æ–VçBç&VÆV6R‚“²Ð¢Ð ¢7–æ2vWDÆVFvW"†g&öÓó¢7G&–ærÂFóó¢7G&–ær“¢&öÖ—6SÄÆVFvW%f–Wsâ°¢6öç7BfÇVW3¢7G&–æuµÒÒµÓ²6öç7B6ÆW6W3¢7G&–æuµÒÒµÓ°¢–b†g&öÒ’²fÇVW2çW6‚†g&öÒ“²6ÆW6W2çW6‚†FFUö—6òãÒBG·fÇVW2æÆVæwF‡Ö“²Ð¢–b‡Fò’²fÇVW2çW6‚‡Fò“²6ÆW6W2çW6‚†FFUö—6òÃÒBG·fÇVW2æÆVæwF‡Ö“²Ð¢6öç7B6öæF—F–öâÒ6ÆW6W2æÆVæwF‚ò6ÆW6W2æ¦ö–â‚"äB"’¢%E%TR#°¢6öç7B·F÷FÇ2ÂF—2Â–ÖVçG5ÒÒv—B&öÖ—6RæÆÂ…°¢F†—2ævw&VvFR‡F†—2çööÂÂ6öæF—F–öâÂfÇVW2’À¢F†—2çööÂçVW'’†4TÄT5B¢e$ôÒv÷&µöF—2t„U$RG¶6öæF—F–öçÒõ$DU"%’FFUö—6òÂWFFVEöFÂfÇVW2’À¢F†—2çööÂçVW'’†4TÄT5B¢e$ôÒ–ÖVçG2t„U$RG¶6öæF—F–öâç&WÆ6TÆÂ‚&FFUö—6ò"Â'–ÖVçEöFFR"—Òõ$DU"%’–ÖVçEöFFRÂ–FÂfÇVW2’À¢Ò“°¢6öç7B&÷w3¢ÆVFvW%&÷uµÒÒ°¢ââæF—2ç&÷w2æÖ‚‡&÷r’Óâ‡²&÷uG—S¢'v÷&²"26öç7BÂââæÖF’‡&÷r’Ò’’À¢ââç–ÖVçG2ç&÷w2æÖ‚‡&÷r’Óâ‡²&÷uG—S¢'–ÖVçB"26öç7BÂââæÖ–ÖVçB‡&÷r’Ò’’À¢Òç6÷'B‚†Â"’ÓâæFFT—6òæÆö6ÆT6ö×&R†"æFFT—6ò’ÇÂ†ç&÷uG—RÓÓÒ'v÷&²"òÓ¢’“°¢&WGW&â²F÷FÇ2Â&÷w2Ó°¢Ð ¢7–æ27&VFU–ÖVçB†FFT—6ó¢7G&–ærÂÖ÷VçD6VçG3¢çVÖ&W"Âæ÷FSó¢7G&–ær“¢&öÖ—6SÅ–ÖVçCâ°¢6öç7B&W7VÇBÒv—BF†—2çööÂçVW'’€¢$”å4U%B”åDò–ÖVçG2‡–ÖVçEöFFRÆÖ÷VçEö6VçG2Ææ÷FRÇ6÷W&6R’dÅTU2‚CÂC"ÂC2ÂvÖçVÂr’$UEU$ä”är¢"À¢¶FFT—6òÂÖ÷VçD6VçG2Âæ÷FSòçG&–Ò‚’ÇÂçVÆÅÒÀ¢“°¢&WGW&âÖ–ÖVçB‡&W7VÇBç&÷w5³Ò“°¢Ð ¢7–æ2WFFU–ÖVçB†–C¢çVÖ&W"ÂfÇVW3¢²FFT—6óó¢7G&–æs²Ö÷VçD6VçG3ó¢çVÖ&W#²æ÷FSó¢7G&–ærÂçVÆÂÒ“¢&öÖ—6SÅ–ÖVçBÂçVÆÃâ°¢6öç7B&W7VÇBÒv—BF†—2çööÂçVW'’† ¢UDDR–ÖVçG24UB–ÖVçEöFFSÔ4ôÄU44R‚C"Ç–ÖVçEöFFR’ÂÖ÷VçEö6VçG3Ô4ôÄU44R‚C2ÆÖ÷VçEö6VçG2’À¢æ÷FSÔ44Rt„TâCC£¦&ööÆVâD„TâCRTÅ4Ræ÷FRTäBÂWFFVEöCÖæ÷r‚¢t„U$R–CÒCäB6÷W&6SÒvÖçVÂr$UEU$ä”är ¢Â¶–BÂfÇVW2æFFT—6òóòçVÆÂÂfÇVW2æÖ÷VçD6VçG2óòçVÆÂÂfÇVW2ææ÷FRÓÒVæFVf–æVBÂfÇVW2ææ÷FSòçG&–Ò‚’ÇÂçVÆÅÒ“°¢&WGW&â&W7VÇBç&÷w5³ÒòÖ–ÖVçB‡&W7VÇBç&÷w5³Ò’¢çVÆÃ°¢Ð ¢7–æ2FVÆWFU–ÖVçB†–C¢çVÖ&W"“¢&öÖ—6SÆ&ööÆVãâ°¢6öç7B&W7VÇBÒv—BF†—2çööÂçVW'’‚$DTÄUDRe$ôÒ–ÖVçG2t„U$R–CÒCäB6÷W&6SÒvÖçVÂr"Â¶–EÒ“°¢&WGW&â‡&W7VÇBç&÷t6÷VçBóò’â°¢Ð§Ð 