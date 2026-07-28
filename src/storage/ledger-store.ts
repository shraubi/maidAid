import { Pool, type PoolClient } from "pg";
import type { DayTotals, LedgerTotals, ParsedDay, ReportSnapshot } from "../domain/types.js";

export interface StoredDay extends DayTotals {
  dateIso: string;
  sourceText: string;
  parsedDetails: ParsedDay;
  updatedAt: string;
}

export interface Payment {
  id: number;
  dateIso: string;
  amountCents: number;
  note: string | null;
  source: "manual" | "day_text";
  workDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LedgerRow =
  | ({ rowType: "work" } & StoredDay)
  | ({ rowType: "payment" } & Payment);

export interface LedgerView {
  totals: LedgerTotals;
  rows: LedgerRow[];
}

export interface SaveDayInput {
  dateIso: string;
  sourceText: string;
  parsedDetails: ParsedDay;
  totals: DayTotals;
  advanceCents: number;
}

export interface LedgerStore {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
  close(): Promise<void>;
  projectDay(dateIso: string, totals: DayTotals, advanceCents: number): Promise<ReportSnapshot>;
  saveDay(input: SaveDayInput): Promise<{ day: StoredDay; snapshot: ReportSnapshot }>;
  getLedger(from?: string, to?: string): Promise<LedgerView>;
  createPayment(dateIso: string, amountCents: number, note?: string): Promise<Payment>;
  updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }): Promise<Payment | null>;
  deletePayment(id: number): Promise<boolean>;
}

const zeroTotals = (): LedgerTotals => ({
  minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0,
  expensesCents: 0, checkinCents: 0,
});

function finishTotals(value: Omit<LedgerTotals, "outstandingCents">): LedgerTotals {
  return { ...value, outstandingCents: value.earnedCents - value.receivedCents };
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly days = new Map<string, StoredDay>();
  private readonly payments = new Map<number, Payment>();
  private nextId = 1;

  async initialize(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
  async close(): Promise<void> {}

  private aggregate(to?: string, from?: string, excludedDate?: string): LedgerTotals {
    const result = zeroTotals();
    for (const day of this.days.values()) {
      if ((from && day.dateIso < from) || (to && day.dateIso > to) || day.dateIso === excludedDate) continue;
      result.minutes += day.minutes;
      result.earnedCents += day.incomeCents;
      result.expensesCents += day.expensesCents;
      result.checkinCents += day.checkinCents;
    }
    for (const payment of this.payments.values()) {
      if ((from && payment.dateIso < from) || (to && payment.dateIso > to) || (excludedDate && payment.source === "day_text" && payment.workDate === excludedDate)) continue;
      result.receivedCents += payment.amountCents;
    }
    result.outstandingCents = result.earnedCents - result.receivedCents;
    return result;
  }

  async projectDay(dateIso: string, totals: DayTotals, advanceCents: number): Promise<ReportSnapshot> {
    const previous = this.aggregate(new Date(`${dateIso}T00:00:00Z`).toISOString().slice(0, 10));
    for (const day of this.days.values()) if (day.dateIso === dateIso) {
      previous.minutes -= day.minutes; previous.earnedCents -= day.incomeCents;
      previous.expensesCents -= day.expensesCents; previous.checkinCents -= day.checkinCents;
    }
    for (const payment of this.payments.values()) if (payment.dateIso === dateIso) previous.receivedCents -= payment.amountCents;
    previous.outstandingCents = previous.earnedCents - previous.receivedCents;
    const base = this.aggregate(dateIso, undefined, dateIso);
    const total = finishTotals({
      minutes: base.minutes + totals.minutes,
      earnedCents: base.earnedCents + totals.incomeCents,
      receivedCents: base.receivedCents + advanceCents,
      expensesCents: base.expensesCents + totals.expensesCents,
      checkinCents: base.checkinCents + totals.checkinCents,
    });
    return { previous, total };
  }

  async saveDay(input: SaveDayInput): Promise<{ day: StoredDay; snapshot: ReportSnapshot }> {
    const updatedAt = new Date().toISOString();
    const day: StoredDay = { dateIso: input.dateIso, sourceText: input.sourceText, parsedDetails: input.parsedDetails, ...input.totals, updatedAt };
    this.days.set(input.dateIso, day);
    for (const [id, payment] of this.payments) if (payment.source === "day_text" && payment.workDate === input.dateIso) this.payments.delete(id);
    if (input.advanceCents > 0) {
      const id = this.nextId++;
      this.payments.set(id, { id, dateIso: input.dateIso, amountCents: input.advanceCents, note: "Аванс из отчёта", source: "day_text", workDate: input.dateIso, createdAt: updatedAt, updatedAt });
    }
    return { day, snapshot: await this.projectDay(input.dateIso, input.totals, input.advanceCents) };
  }

  async getLedger(from?: string, to?: string): Promise<LedgerView> {
    const rows: LedgerRow[] = [];
    for (const day of this.days.values()) if ((!from || day.dateIso >= from) && (!to || day.dateIso <= to)) rows.push({ rowType: "work", ...day });
    for (const payment of this.payments.values()) if ((!from || payment.dateIso >= from) && (!to || payment.dateIso <= to)) rows.push({ rowType: "payment", ...payment });
    rows.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals: this.aggregate(to, from), rows };
  }

  async createPayment(dateIso: string, amountCents: number, note?: string): Promise<Payment> {
    const now = new Date().toISOString(); const id = this.nextId++;
    const payment: Payment = { id, dateIso, amountCents, note: note?.trim() || null, source: "manual", workDate: null, createdAt: now, updatedAt: now };
    this.payments.set(id, payment); return payment;
  }

  async updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }): Promise<Payment | null> {
    const current = this.payments.get(id);
    if (!current || current.source !== "manual") return null;
    const next = { ...current, dateIso: values.dateIso ?? current.dateIso, amountCents: values.amountCents ?? current.amountCents, note: values.note === undefined ? current.note : values.note?.trim() || null, updatedAt: new Date().toISOString() };
    this.payments.set(id, next); return next;
  }

  async deletePayment(id: number): Promise<boolean> {
    const payment = this.payments.get(id);
    return payment?.source === "manual" ? this.payments.delete(id) : false;
  }
}

function mapTotals(row: Record<string, string | number | null>): LedgerTotals {
  const earnedCents = Number(row.earned_cents ?? 0);
  const receivedCents = Number(row.received_cents ?? 0);
  return {
    minutes: Number(row.minutes ?? 0), earnedCents, receivedCents,
    outstandingCents: earnedCents - receivedCents,
    expensesCents: Number(row.expenses_cents ?? 0), checkinCents: Number(row.checkin_cents ?? 0),
  };
}

function mapDay(row: Record<string, unknown>): StoredDay {
  return {
    dateIso: String(row.date_iso), sourceText: String(row.source_text), parsedDetails: row.parsed_details as ParsedDay,
    minutes: Number(row.minutes), incomeCents: Number(row.earned_cents), checkinCents: Number(row.checkin_cents),
    expensesCents: Number(row.expenses_cents), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapPayment(row: Record<string, unknown>): Payment {
  return {
    id: Number(row.id), dateIso: String(row.payment_date), amountCents: Number(row.amount_cents),
    note: row.note == null ? null : String(row.note), source: String(row.source) as Payment["source"],
    workDate: row.work_date == null ? null : String(row.work_date),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PostgresLedgerStore implements LedgerStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS work_days (
        date_iso date PRIMARY KEY, source_text text NOT NULL, parsed_details jsonb NOT NULL,
        minutes integer NOT NULL CHECK (minutes >= 0), earned_cents integer NOT NULL CHECK (earned_cents >= 0),
        checkin_cents integer NOT NULL DEFAULT 0 CHECK (checkin_cents >= 0),
        expenses_cents integer NOT NULL CHECK (expenses_cents >= 0), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id bigserial PRIMARY KEY, payment_date date NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents > 0),
        note text, source text NOT NULL CHECK (source IN ('manual', 'day_text')),
        work_date date REFERENCES work_days(date_iso) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS payments_one_day_text ON payments (work_date) WHERE source = 'day_text';
      CREATE INDEX IF NOT EXISTS payments_date_idx ON payments (payment_date);
    `);
  }

  async health(): Promise<boolean> { try { await this.pool.query("SELECT 1"); return true; } catch { return false; } }
  async close(): Promise<void> { await this.pool.end(); }

  private async aggregate(client: Pool | PoolClient, condition = "TRUE", values: unknown[] = []): Promise<LedgerTotals> {
    const result = await client.query(`
      SELECT
        COALESCE((SELECT SUM(minutes) FROM work_days WHERE ${condition}), 0)::int AS minutes,
        COALESCE((SELECT SUM(earned_cents) FROM work_days WHERE ${condition}), 0)::int AS earned_cents,
        COALESCE((SELECT SUM(expenses_cents) FROM work_days WHERE ${condition}), 0)::int AS expenses_cents,
        COALESCE((SELECT SUM(checkin_cents) FROM work_days WHERE ${condition}), 0)::int AS checkin_cents,
        COALESCE((SELECT SUM(amount_cents) FROM payments WHERE ${condition.replaceAll("date_iso", "payment_date")}), 0)::int AS received_cents
    `, values);
    return mapTotals(result.rows[0]);
  }

  async projectDay(dateIso: string, totals: DayTotals, advanceCents: number): Promise<ReportSnapshot> {
    const [previous, baseResult] = await Promise.all([
      this.aggregate(this.pool, "date_iso < $1", [dateIso]),
      this.pool.query(`
        SELECT
          COALESCE((SELECT SUM(minutes) FROM work_days WHERE date_iso <= $1 AND date_iso <> $1), 0)::int AS minutes,
          COALESCE((SELECT SUM(earned_cents) FROM work_days WHERE date_iso <= $1 AND date_iso <> $1), 0)::int AS earned_cents,
          COALESCE((SELECT SUM(expenses_cents) FROM work_days WHERE date_iso <= $1 AND date_iso <> $1), 0)::int AS expenses_cents,
          COALESCE((SELECT SUM(checkin_cents) FROM work_days WHERE date_iso <= $1 AND date_iso <> $1), 0)::int AS checkin_cents,
          COALESCE((SELECT SUM(amount_cents) FROM payments WHERE payment_date <= $1 AND NOT (source='day_text' AND work_date=$1)), 0)::int AS received_cents
      `, [dateIso]),
    ]);
    const base = mapTotals(baseResult.rows[0]);
    const total = finishTotals({
      minutes: base.minutes + totals.minutes, earnedCents: base.earnedCents + totals.incomeCents,
      receivedCents: base.receivedCents + advanceCents, expensesCents: base.expensesCents + totals.expensesCents,
      checkinCents: base.checkinCents + totals.checkinCents,
    });
    return { previous, total };
  }

  async saveDay(input: SaveDayInput): Promise<{ day: StoredDay; snapshot: ReportSnapshot }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query(`
        INSERT INTO work_days (date_iso, source_text, parsed_details, minutes, earned_cents, checkin_cents, expenses_cents, updated_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now())
        ON CONFLICT (date_iso) DO UPDATE SET source_text=EXCLUDED.source_text, parsed_details=EXCLUDED.parsed_details,
          minutes=EXCLUDED.minutes, earned_cents=EXCLUDED.earned_cents, checkin_cents=EXCLUDED.checkin_cents,
          expenses_cents=EXCLUDED.expenses_cents, updated_at=now()
        RETURNING *
      `, [input.dateIso, input.sourceText, JSON.stringify(input.parsedDetails), input.totals.minutes, input.totals.incomeCents, input.totals.checkinCents, input.totals.expensesCents]);
      await client.query("DELETE FROM payments WHERE source='day_text' AND work_date=$1", [input.dateIso]);
      if (input.advanceCents > 0) await client.query(
        "INSERT INTO payments (payment_date, amount_cents, note, source, work_date) VALUES ($1,$2,'Аванс из отчёта','day_text',$1)",
        [input.dateIso, input.advanceCents],
      );
      const previous = await this.aggregate(client, "date_iso < $1", [input.dateIso]);
      const total = await this.aggregate(client, "date_iso <= $1", [input.dateIso]);
      await client.query("COMMIT");
      return { day: mapDay(saved.rows[0]), snapshot: { previous, total } };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getLedger(from?: string, to?: string): Promise<LedgerView> {
    const values: string[] = []; const clauses: string[] = [];
    if (from) { values.push(from); clauses.push(`date_iso >= $${values.length}`); }
    if (to) { values.push(to); clauses.push(`date_iso <= $${values.length}`); }
    const condition = clauses.length ? clauses.join(" AND ") : "TRUE";
    const [totals, days, payments] = await Promise.all([
      this.aggregate(this.pool, condition, values),
      this.pool.query(`SELECT * FROM work_days WHERE ${condition} ORDER BY date_iso, updated_at`, values),
      this.pool.query(`SELECT * FROM payments WHERE ${condition.replaceAll("date_iso", "payment_date")} ORDER BY payment_date, id`, values),
    ]);
    const rows: LedgerRow[] = [
      ...days.rows.map((row) => ({ rowType: "work" as const, ...mapDay(row) })),
      ...payments.rows.map((row) => ({ rowType: "payment" as const, ...mapPayment(row) })),
    ].sort((a, b) => a.dateIso.localeCompare(b.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals, rows };
  }

  async createPayment(dateIso: string, amountCents: number, note?: string): Promise<Payment> {
    const result = await this.pool.query(
      "INSERT INTO payments (payment_date,amount_cents,note,source) VALUES ($1,$2,$3,'manual') RETURNING *",
      [dateIso, amountCents, note?.trim() || null],
    );
    return mapPayment(result.rows[0]);
  }

  async updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }): Promise<Payment | null> {
    const result = await this.pool.query(`
      UPDATE payments SET payment_date=COALESCE($2,payment_date), amount_cents=COALESCE($3,amount_cents),
        note=CASE WHEN $4::boolean THEN $5 ELSE note END, updated_at=now()
      WHERE id=$1 AND source='manual' RETURNING *
    `, [id, values.dateIso ?? null, values.amountCents ?? null, values.note !== undefined, values.note?.trim() || null]);
    return result.rows[0] ? mapPayment(result.rows[0]) : null;
  }

  async deletePayment(id: number): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM payments WHERE id=$1 AND source='manual'", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
