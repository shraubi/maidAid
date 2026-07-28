export type WorkType = "independent" | "orientation" | "practice" | "checkin" | "unknown";
export type DayKind = "schedule" | "actual";

export interface Job {
  object: string;
  apartmentId: number | null;
  address: string | null;
  mapsUrl: string | null;
  noteBody: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
  durationMinutes: number | null;
  endInferred: boolean;
  workType: WorkType;
  companion?: string;
  sourceLine: string;
}

export interface Apartment {
  id: number;
  sourceKey: string;
  canonicalKey: string;
  canonicalName: string;
  aliases: string[];
  address: string | null;
  mapsUrl: string | null;
  noteBody: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ApartmentLookup = Map<string, Apartment>;

export interface Expense {
  category: string;
  object?: string;
  jobIndex?: number;
  amountCents: number;
  sourceLine: string;
}

export type ParseIssueCode =
  | "missing_date"
  | "missing_jobs"
  | "missing_start"
  | "missing_end"
  | "missing_type"
  | "invalid_payment"
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
  advanceCents: number;
  unparsedLines: string[];
  issues: ParseIssue[];
}

export interface Settings {
  hourlyRateCents: number;
  orientationFlatCents: number;
  practiceFlatCents: number;
  checkinFlatCents: number;
  dryerDefaultCents: number;
}

export interface DayTotals {
  minutes: number;
  incomeCents: number;
  checkinCents: number;
  expensesCents: number;
}

export interface LedgerTotals {
  minutes: number;
  earnedCents: number;
  receivedCents: number;
  outstandingCents: number;
  expensesCents: number;
  checkinCents: number;
}

export interface ReportSnapshot {
  previous: LedgerTotals;
  total: LedgerTotals;
}

