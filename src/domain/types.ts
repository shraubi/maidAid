export type WorkType = "independent" | "orientation" | "unknown";
export type DayKind = "schedule" | "actual";

export interface Job {
  object: string;
  startMinutes: number | null;
  endMinutes: number | null;
  endInferred: boolean;
  workType: WorkType;
  companion?: string;
  sourceLine: string;
}

export interface Expense {
  category: string;
  object?: string;
  amountCents: number;
  sourceLine: string;
}

export type ParseIssueCode =
  | "missing_date"
  | "missing_jobs"
  | "missing_start"
  | "missing_end"
  | "missing_type"
  | "overlap";

export interface ParseIssue {
  code: ParseIssueCode;
  message: string;
  jobIndex?: number;
}

export interface ParsedDay {
  dateIso: string | null;
  displayDate: string | null;
  kind: DayKind;
  jobs: Job[];
  expenses: Expense[];
  unparsedLines: string[];
  issues: ParseIssue[];
}

export interface Settings {
  hourlyRateCents: number;
  dryerDefaultCents: number;
}

export interface DayTotals {
  minutes: number;
  incomeCents: number;
  expensesCents: number;
}
