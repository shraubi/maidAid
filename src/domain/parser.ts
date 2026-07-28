import type { ApartmentLookup, Expense, Job, ParsedDay, ParseIssue, WorkType } from "./types.js";
import { apartmentKey } from "./apartments.js";

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/;
const INTERVAL_RE = /\(?\b(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\b\)?/;
const TIME_RE = /\(?\b(\d{1,2}):(\d{2})\b\)?/;
const DURATION_RE = /\b(\d+(?:[.,]\d{1,2})?)\s*(?:h|ч(?:ас(?:а|ов)?)?)\b/iu;
const EXPENSE_RE = /(сушк[аиу]?|метро|хими[яю]|расход(?:ы)?)/iu;
const AMOUNT_RE = /-?\d+(?:[.,]\d{1,2})?\s*€?/gu;
const CHECKIN_RE = /\bcheck[\s-]*in\b|самостоятельн[\p{L}]*\s+заселен[\p{L}]*|заселен[\p{L}]*/iu;
const TYPE_RE = /(самостоятельн[\p{L}]*(?:\s+(?:работ[\p{L}]*|уборк[\p{L}]*))?|уборк[\p{L}]*|ознакомлен[\p{L}]*|знакомств[\p{L}]*|практик[\p{L}]*|\bcheck[\s-]*in\b|заселен[\p{L}]*)/giu;
const TYPE_HINT_RE = /(самостоятель|уборк|ознакомлен|знакомств|практик|check[\s-]*in|заселен)/iu;
const TIME_TOKEN_RE = /\b\d{1,2}:\d{2}\b/gu;
const FLAT_ACTIVITY_DEFAULT_MINUTES = 60;
const CHECKIN_DEFAULT_MINUTES = 30;

function normalizeLine(line: string): string {
  return line.replace(/\u00a0/g, " ").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
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
  if (/практик/u.test(lower)) return "practice";
  if (/ознакомлен|знакомств/u.test(lower)) return "orientation";
  if (/самостоятель|уборк/u.test(lower)) return "independent";
  return "unknown";
}

function normalizeObject(value: string, apartments?: ApartmentLookup): string {
  const cleaned = value
    .replace(/^\s*\d+\s*[.)-]\s*/u, "")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .replace(/\s+/g, " ").trim();
  const apartment = apartments?.get(apartmentKey(cleaned));
  if (apartment) return apartment.canonicalName;
  return cleaned.split(" ").map((part) => /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function extractCompanion(line: string, apartments?: ApartmentLookup): string | undefined {
  for (const match of line.matchAll(/\(([^)]+)\)/g)) {
    const value = match[1]!.trim();
    if (!/\d{1,2}(?::\d{2})?(?:\s*-\s*\d{1,2}(?::\d{2})?)?/.test(value) && !TYPE_HINT_RE.test(value)) return normalizeObject(value, apartments);
  }
  return undefined;
}

function amountCents(raw: string): number | null {
  const value = Number(raw.replace("€", "").replace(",", ".").trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

function amountMatches(line: string): Array<{ value: number; index: number; raw: string }> {
  return [...line.matchAll(AMOUNT_RE)].flatMap((match) => {
    const value = amountCents(match[0]);
    return value === null ? [] : [{ value, index: match.index ?? 0, raw: match[0] }];
  });
}

function parseDurationExpenses(line: string, durationEnd: number): Expense[] {
  return line.slice(durationEnd).split("+").flatMap((segment) => {
    const amount = segment.match(/\d+(?:[.,]\d{1,2})?\s*€?/u)?.[0];
    const value = amount ? amountCents(amount) : null;
    if (value === null) return [];
    return [{ category: /сушк/iu.test(segment) ? "сушка" : "расходы", amountCents: value, sourceLine: line }];
  });
}

function parseExpenseSegment(line: string, dryerDefaultCents: number, apartments?: ApartmentLookup): Expense[] | null {
  const categoryMatch = line.match(EXPENSE_RE);
  const onlyAmounts = /^[\s+]*(?:\d+(?:[.,]\d{1,2})?\s*€?[\s+]*)+$/u.test(line);
  if (!categoryMatch && !onlyAmounts) return null;
  const matches = amountMatches(line);
  if (!matches.length) {
    if (!categoryMatch?.[0].toLocaleLowerCase("ru").startsWith("сушк")) return null;
    return [{ category: "сушка", amountCents: dryerDefaultCents, sourceLine: line }];
  }
  const categoryIndex = categoryMatch?.index ?? 0;
  const categoryEnd = categoryIndex + (categoryMatch?.[0].length ?? 0);
  const firstAmount = matches[0]!;
  const objectRaw = categoryMatch
    ? line.slice(categoryEnd, firstAmount.index).replace(/[():+]/g, " ").trim()
    : "";
  const firstCategory = categoryMatch
    ? (categoryMatch[0].toLocaleLowerCase("ru").startsWith("сушк") ? "сушка" : categoryMatch[0].toLocaleLowerCase("ru"))
    : null;
  return matches.map((match, index) => ({
    category: index === 0 && firstCategory
      ? firstCategory
      : index === 1 && matches.length === 2 && firstCategory === "расходы"
        ? "сушка"
        : "расходы",
    object: index === 0 && objectRaw ? normalizeObject(objectRaw, apartments) : undefined,
    amountCents: match.value,
    sourceLine: line,
  }));
}

function extractInlineExpenses(line: string, dryerDefaultCents: number, apartments?: ApartmentLookup): { expenses: Expense[]; remainder: string } {
  const category = line.match(EXPENSE_RE);
  if (!category || category.index === undefined) return { expenses: [], remainder: line };
  const prefix = line.slice(0, category.index);
  const amountBeforeCategory = prefix.match(/\d+(?:[.,]\d{1,2})?\s*€?\s*$/u);
  const expenseStart = amountBeforeCategory?.index ?? category.index;
  const segment = line.slice(expenseStart);
  const expenses = parseExpenseSegment(segment, dryerDefaultCents, apartments) ?? [];
  return { expenses, remainder: line.slice(0, expenseStart).replace(/[\s+,:;-]+$/u, "").trim() };
}

function parseAdvance(line: string): { cents?: number; invalid?: boolean } | null {
  if (!/^аванс(?:\s|:|$)/iu.test(line)) return null;
  const rawMatches = [...line.matchAll(AMOUNT_RE)];
  if (!rawMatches.length || rawMatches.some((match) => amountCents(match[0]) === null)) return { invalid: true };
  return { cents: rawMatches.reduce((sum, match) => sum + (amountCents(match[0]) ?? 0), 0) };
}

function parseJob(originalLine: string, dryerDefaultCents: number, apartments?: ApartmentLookup): { job: Job; inlineExpenses: Expense[] } | null {
  const boldObject = originalLine.match(/\*([^*]+)\*/)?.[1];
  let line = normalizeLine(originalLine.replace(/\*/g, ""));
  let type = detectType(line);
  const companion = extractCompanion(line, apartments);
  const durationHint = line.match(DURATION_RE);
  const extracted = durationHint ? { expenses: [] as Expense[], remainder: line } : extractInlineExpenses(line, dryerDefaultCents, apartments);
  line = extracted.remainder;
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  let durationMinutes: number | null = null;
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
    const duration = line.match(DURATION_RE);
    if (duration?.index !== undefined) {
      durationMinutes = Math.round(Number(duration[1]!.replace(",", ".")) * 60);
      if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 24 * 60) return null;
      extracted.expenses.splice(0, extracted.expenses.length, ...parseDurationExpenses(line, duration.index + duration[0].length));
      line = line.slice(0, duration.index);
      if (startMinutes !== null) endMinutes = startMinutes + durationMinutes;
      if (type === "unknown") type = "independent";
    }
  }
  line = line
    .replace(/\s*\/.*$/u, " ")
    .replace(TYPE_RE, " ")
    .replace(/\b[A-Z]{1,3}\d{2,5}\b\s*(?:flight\s+number)?/giu, " ")
    .replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/g, " ")
    .replace(TIME_TOKEN_RE, " ").replace(/изменения?/giu, " ")
    .replace(/\s+-\s+|^\s*-\s*|\s*-\s*$/g, " ").replace(/\s+/g, " ").trim();
  const object = boldObject ? normalizeObject(boldObject, apartments) : normalizeObject(line, apartments);
  if (!object || (startMinutes === null && durationMinutes === null)) return null;
  const apartment = apartments?.get(apartmentKey(object));
  const job: Job = {
    object, apartmentId: apartment?.id ?? null, address: apartment?.address ?? null,
    mapsUrl: apartment?.mapsUrl ?? null, noteBody: apartment?.noteBody ?? null,
    startMinutes, endMinutes, durationMinutes, endInferred: false, workType: type, companion, sourceLine: originalLine,
  };
  for (const expense of extracted.expenses) expense.object = object;
  return { job, inlineExpenses: extracted.expenses };
}

function inferEndsAndIssues(jobs: Job[]): ParseIssue[] {
  const issues: ParseIssue[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    const next = jobs[index + 1];
    if (job.durationMinutes !== null) {
      // Duration-only report lines have no wall-clock interval to infer or overlap-check.
    } else if (job.endMinutes === null && job.startMinutes !== null && job.workType === "checkin") {
      job.endMinutes = job.startMinutes + CHECKIN_DEFAULT_MINUTES;
      job.endInferred = true;
    } else if (job.endMinutes === null && next?.startMinutes !== null && next?.startMinutes !== undefined) {
      job.endMinutes = next.startMinutes;
      job.endInferred = true;
    } else if (job.startMinutes !== null && job.endMinutes === null && (job.workType === "orientation" || job.workType === "practice")) {
      job.endMinutes = job.startMinutes + FLAT_ACTIVITY_DEFAULT_MINUTES;
      job.endInferred = true;
    }
    if (job.durationMinutes !== null) continue;
    if (job.startMinutes === null) issues.push({ code: "missing_start", jobIndex: index, message: `Нет начала для ${job.object}` });
    else if (job.endMinutes === null) issues.push({ code: "missing_end", jobIndex: index, message: `Нет окончания для ${job.object}` });
    else if (job.endMinutes <= job.startMinutes) issues.push({ code: "overlap", jobIndex: index, message: `Некорректный интервал у ${job.object}` });
    if (job.workType === "unknown") issues.push({ code: "missing_type", jobIndex: index, message: `Не указан тип для ${job.object}` });
    if (next?.startMinutes != null && job.endMinutes !== null && job.endMinutes > next.startMinutes) {
      issues.push({ code: "overlap", jobIndex: index, message: `${job.object} пересекается со следующей работой` });
    }
  }
  return issues;
}

export function parseDay(text: string, now = new Date(), dryerDefaultCents = 390, apartments?: ApartmentLookup): ParsedDay {
  const date = parseDate(text, now);
  const sourceLines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const lines: string[] = [];
  for (const line of sourceLines) {
    const intervalOnly = INTERVAL_RE.test(line) && line.replace(INTERVAL_RE, "").replace(/[()]/g, "").trim() === "";
    if (intervalOnly && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`;
    else lines.push(line);
  }
  const jobs: Job[] = [];
  const expenses: Expense[] = [];
  const unparsedLines: string[] = [];
  const paymentIssues: ParseIssue[] = [];
  let advanceCents = 0;
  let lastObject: string | undefined;

  for (const line of lines) {
    const lineDate = parseDate(line, now);
    if (lineDate && lineDate.dateIso === date?.dateIso && /^(изменения?)?$/iu.test(line.replace(DATE_RE, "").replace(/[*_`]/g, "").trim())) continue;
    const advance = parseAdvance(line);
    if (advance) {
      if (advance.invalid) paymentIssues.push({ code: "invalid_payment", message: `Некорректный аванс: ${line}` });
      else advanceCents += advance.cents ?? 0;
      continue;
    }
    const standaloneExpense = !INTERVAL_RE.test(line) && !TIME_RE.test(line) && !DURATION_RE.test(line) ? parseExpenseSegment(line, dryerDefaultCents, apartments) : null;
    if (standaloneExpense) {
      for (const expense of standaloneExpense) {
        if (!expense.object && lastObject) expense.object = lastObject;
        expenses.push(expense);
      }
      continue;
    }
    const parsed = parseJob(line, dryerDefaultCents, apartments);
    if (!parsed) { unparsedLines.push(line); continue; }
    jobs.push(parsed.job);
    expenses.push(...parsed.inlineExpenses);
    lastObject = parsed.job.object;
  }
  const issues = [...paymentIssues, ...inferEndsAndIssues(jobs)];
  if (!date) issues.unshift({ code: "missing_date", message: "Не указана дата" });
  if (!jobs.length) issues.push({ code: "missing_jobs", message: "Не найдена ни одна работа" });
  return {
    dateIso: date?.dateIso ?? null,
    displayDate: date?.displayDate ?? null,
    kind: /изменения?/iu.test(text) || expenses.length > 0 || advanceCents > 0 ? "actual" : "schedule",
    jobs, expenses, advanceCents, unparsedLines, issues,
  };
}

