import type { Expense, Job, ParsedDay, ParseIssue, WorkType } from "./types.js";

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/;
const INTERVAL_RE = /\(?\b(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\b\)?/;
const TIME_RE = /\(?\b(\d{1,2}):(\d{2})\b\)?/;
const EXPENSE_RE = /(сушк[аиу]?|метро|хими[яю]|расход(?:ы)?)/iu;
const AMOUNT_RE = /(\d+(?:[.,]\d{1,2})?)\s*€?/u;
const TYPE_RE =
  /(самостоятельн(?:о|ая|ую|ой)?(?:\s+работ[аыу])?|уборк[ауы]?|ознакомлени[еяю]?|знакомств[оа]|практик[аиу]?)/giu;
const TYPE_HINT_RE = /(самостоятель|уборк|ознакомлен|знакомств|практик)/iu;
const TIME_TOKEN_RE = /\b\d{1,2}:\d{2}\b/gu;
const FLAT_ACTIVITY_DEFAULT_MINUTES = 60;

const aliases = new Map<string, string>([
  ["eiffe", "Eiffel"],
  ["eiffee", "Eiffel"],
  ["eiffel", "Eiffel"],
  ["eiffe", "Eiffel"],
  ["opera", "Opera"],
  ["opéra", "Opera"],
  ["federation", "Federation"],
]);

function normalizeLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMinutes(hoursRaw: string, minutesRaw?: string): number | null {
  const hours = Number(hoursRaw);
  const minutes = minutesRaw === undefined ? 0 : Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
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
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    dateIso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    displayDate: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`,
  };
}

function detectType(line: string): WorkType {
  const lower = line.toLocaleLowerCase("ru");
  if (/практик/u.test(lower)) return "practice";
  if (/ознакомлен|знакомств/u.test(lower)) return "orientation";
  if (/самостоятель|уборк/u.test(lower)) return "independent";
  return "unknown";
}

function normalizeObject(value: string): string {
  const cleaned = value
    .replace(/^\s*\d+\s*[.)-]\s*/u, "")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const alias = aliases.get(cleaned.toLocaleLowerCase("en"));
  if (alias) return alias;
  return cleaned
    .split(" ")
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function extractCompanion(line: string): string | undefined {
  for (const match of line.matchAll(/\(([^)]+)\)/g)) {
    const value = match[1]!.trim();
    if (
      !/\d{1,2}(?::\d{2})?(?:\s*-\s*\d{1,2}(?::\d{2})?)?/.test(value) &&
      !TYPE_HINT_RE.test(value)
    ) {
      return normalizeObject(value);
    }
  }
  return undefined;
}

function extractInlineExpense(line: string): { expense?: Expense; remainder: string } {
  const categoryMatch = line.match(EXPENSE_RE);
  if (!categoryMatch || categoryMatch.index === undefined) return { remainder: line };
  const afterCategory = line.slice(categoryMatch.index + categoryMatch[0].length);
  const amountMatch = afterCategory.match(AMOUNT_RE);
  if (!amountMatch || amountMatch.index === undefined) return { remainder: line };
  const amount = Number(amountMatch[1]!.replace(",", "."));
  const segmentEnd =
    categoryMatch.index + categoryMatch[0].length + amountMatch.index + amountMatch[0].length;
  const beforeExpense = line.slice(0, categoryMatch.index).replace(/[\s+,:;-]+$/u, "");
  const afterExpense = line.slice(segmentEnd).replace(/^[\s+,:;-]+/u, "");
  const remainder = `${beforeExpense} ${afterExpense}`.trim();
  return {
    remainder,
    expense: {
      category: categoryMatch[0].toLocaleLowerCase("ru").startsWith("сушк")
        ? "сушка"
        : categoryMatch[0].toLocaleLowerCase("ru"),
      amountCents: Math.round(amount * 100),
      sourceLine: line,
    },
  };
}

function parseStandaloneExpense(line: string, dryerDefaultCents: number): Expense | null {
  const category = line.match(EXPENSE_RE);
  const amount = line.match(AMOUNT_RE);
  if (!category || category.index === undefined) return null;
  const isDryer = category[0].toLocaleLowerCase("ru").startsWith("сушк");
  if (!amount || amount.index === undefined) {
    if (!isDryer) return null;
    const objectPart = line.slice(category.index + category[0].length).replace(/[():]/g, " ").trim();
    return {
      category: "сушка",
      object: objectPart ? normalizeObject(objectPart) : undefined,
      amountCents: dryerDefaultCents,
      sourceLine: line,
    };
  }
  const objectPart = line
    .slice(category.index + category[0].length, amount.index)
    .replace(/[():]/g, " ")
    .trim();
  return {
    category: isDryer ? "сушка" : category[0].toLocaleLowerCase("ru"),
    object: objectPart ? normalizeObject(objectPart) : undefined,
    amountCents: Math.round(Number(amount[1]!.replace(",", ".")) * 100),
    sourceLine: line,
  };
}

function parseJob(originalLine: string): { job: Job; inlineExpense?: Expense } | null {
  const boldObject = originalLine.match(/\*([^*]+)\*/)?.[1];
  let line = normalizeLine(originalLine.replace(/\*/g, ""));
  const type = detectType(line);
  const companion = extractCompanion(line);
  const { expense, remainder } = extractInlineExpense(line);
  line = remainder;

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
    .replace(TYPE_RE, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\([^)]*$/g, " ")
    .replace(TIME_TOKEN_RE, " ")
    .replace(/изменения?/giu, " ")
    .replace(/\s+-\s+|^\s*-\s*|\s*-\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let object = boldObject ? normalizeObject(boldObject) : normalizeObject(line);
  // A bare number left after a bold object is commonly a duplicated hour marker.
  if (boldObject) object = normalizeObject(boldObject);
  if (!object || startMinutes === null) return null;

  const job: Job = {
    object,
    startMinutes,
    endMinutes,
    endInferred: false,
    workType: type,
    companion,
    sourceLine: originalLine,
  };
  if (expense) expense.object = object;
  return { job, inlineExpense: expense };
}

function inferEndsAndIssues(jobs: Job[]): ParseIssue[] {
  const issues: ParseIssue[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    const next = jobs[index + 1];
    if (job.endMinutes === null && next?.startMinutes !== null && next?.startMinutes !== undefined) {
      job.endMinutes = next.startMinutes;
      job.endInferred = true;
    }
    if (
      job.startMinutes !== null &&
      job.endMinutes === null &&
      (job.workType === "orientation" || job.workType === "practice")
    ) {
      job.endMinutes = job.startMinutes + FLAT_ACTIVITY_DEFAULT_MINUTES;
      job.endInferred = true;
    }
    if (job.startMinutes === null) {
      issues.push({ code: "missing_start", jobIndex: index, message: `Нет начала для ${job.object}` });
    } else if (job.endMinutes === null) {
      issues.push({ code: "missing_end", jobIndex: index, message: `Нет окончания для ${job.object}` });
    } else if (job.endMinutes <= job.startMinutes) {
      issues.push({
        code: "overlap",
        jobIndex: index,
        message: `Некорректный интервал у ${job.object}`,
      });
    }
    if (job.workType === "unknown") {
      issues.push({ code: "missing_type", jobIndex: index, message: `Не указан тип для ${job.object}` });
    }
    if (
      next?.startMinutes !== null &&
      next?.startMinutes !== undefined &&
      job.endMinutes !== null &&
      job.endMinutes > next.startMinutes
    ) {
      issues.push({
        code: "overlap",
        jobIndex: index,
        message: `${job.object} пересекается со следующей работой`,
      });
    }
  }
  return issues;
}

export function parseDay(text: string, now = new Date(), dryerDefaultCents = 390): ParsedDay {
  const date = parseDate(text, now);
  const sourceLines = text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);
  const lines: string[] = [];
  for (const line of sourceLines) {
    const intervalOnly = INTERVAL_RE.test(line) &&
      line.replace(INTERVAL_RE, "").replace(/[()]/g, "").trim() === "";
    if (intervalOnly && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`;
    } else {
      lines.push(line);
    }
  }
  const jobs: Job[] = [];
  const expenses: Expense[] = [];
  const unparsedLines: string[] = [];

  for (const line of lines) {
    if (DATE_RE.test(line) && line.replace(DATE_RE, "").trim().match(/^(изменения?)?$/iu)) continue;
    const standaloneExpense = EXPENSE_RE.test(line) && !INTERVAL_RE.test(line) && !TIME_RE.test(line);
    if (standaloneExpense) {
      const expense = parseStandaloneExpense(line, dryerDefaultCents);
      if (expense) expenses.push(expense);
      else unparsedLines.push(line);
      continue;
    }
    const parsed = parseJob(line);
    if (!parsed) {
      unparsedLines.push(line);
      continue;
    }
    jobs.push(parsed.job);
    if (parsed.inlineExpense) expenses.push(parsed.inlineExpense);
  }

  const issues = inferEndsAndIssues(jobs);
  if (!date) issues.unshift({ code: "missing_date", message: "Не указана дата" });
  if (!jobs.length) issues.push({ code: "missing_jobs", message: "Не найдена ни одна работа" });
  return {
    dateIso: date?.dateIso ?? null,
    displayDate: date?.displayDate ?? null,
    kind: /изменения?/iu.test(text) || expenses.length > 0 ? "actual" : "schedule",
    jobs,
    expenses,
    unparsedLines,
    issues,
  };
}

