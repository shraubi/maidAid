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
  initialMinutes: number;
  initialIncomeCents: number;
  initialExpensesCents: number;
}

export interface DayTotals {
  minutes: number;
  incomeCents: number;
  expensesCents: number;
}

export interface StoredDay {
  parsed: ParsedDay;
  totals: DayTotals;
  status: DayKind;
  confirmedAt: string;
}

export interface Balance extends DayTotals {}

export interface PendingState {
  mode: "parsed" | "awaiting_actual" | "awaiting_replacement" | "awaiting_answer";
  kind: DayKind;
  parsed?: ParsedDay;
  awaiting?: {
    field: "end" | "start" | "type";
    jobIndex: number;
  };
}

export interface BotButton {
  id: string;
  title: string;
}

export interface BotResponse {
  text: string;
  buttons?: BotButton[];
}
