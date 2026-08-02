import { Pool, type PoolClient } from "pg";
import type { Apartment, DayTotals, LedgerTotals, ParsedDay, ReportSnapshot } from "../domain/types.js";
import { apartmentKey, publicApartmentRecords } from "../domain/apartments.js";

export interface ApartmentImportInput {
  sourceKey: string;
  canonicalName: string;
  aliases: string[];
  address: string;
  mapsUrl: string;
  noteBody: string;
  active: boolean;
}

export interface ApartmentImportResult {
  created: number;
  updated: number;
  skipped: number;
  conflicts: Array<{ sourceKey: string; reason: string }>;
}

export interface StoredDay extends DayTotals {
  dateIso: string;
  sourceText: string;
  reportText: string | null;
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
  reportText: string;
}

export interface LedgerPeriod {
  period: string;
  from: string;
  to: string;
}

export interface LedgerStore {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
  close(): Promise<void>;
  projectDay(dateIso: string, totals: DayTotals, advanceCents: number): Promise<ReportSnapshot>;
  saveDay(input: SaveDayInput): Promise<{ day: StoredDay; snapshot: ReportSnapshot }>;
  deleteDay(dateIso: string): Promise<boolean>;
  getLedger(from?: string, to?: string): Promise<LedgerView>;
  listPeriods(): Promise<LedgerPeriod[]>;
  createPayment(dateIso: string, amountCents: number, note?: string): Promise<Payment>;
  updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }): Promise<Payment | null>;
  deletePayment(id: number): Promise<boolean>;
  getActiveApartments(): Promise<Apartment[]>;
  importApartments(records: ApartmentImportInput[], dryRun: boolean): Promise<ApartmentImportResult>;
}

const zeroTotals = (): LedgerTotals => ({
  minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0,
  expensesCents: 0, checkinCents: 0,
});

function monthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

function finishTotals(value: Omit<LedgerTotals, "outstandingCents">): LedgerTotals {
  return { ...value, outstandingCents: value.earnedCents - value.receivedCents };
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly days = new Map<string, StoredDay>();
  private readonly payments = new Map<number, Payment>();
  private nextId = 1;
  private readonly apartments = new Map<number, Apartment>(publicApartmentRecords().map((item) => [item.id, item]));
  private nextApartmentId = this.apartments.size + 1;

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
    const from = monthStart(dateIso);
    const previous = this.aggregate(dateIso, from);
    for (const day of this.days.values()) if (day.dateIso === dateIso) {
      previous.minutes -= day.minutes; previous.earnedCents -= day.incomeCents;
      previous.expensesCents -= day.expensesCents; previous.checkinCents -= day.checkinCents;
    }
    for (const payment of this.payments.values()) if (payment.dateIso === dateIso) previous.receivedCents -= payment.amountCents;
    previous.outstandingCents = previous.earnedCents - previous.receivedCents;
    const base = this.aggregate(dateIso, from, dateIso);
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
    const day: StoredDay = { dateIso: input.dateIso, sourceText: input.sourceText, reportText: input.reportText, parsedDetails: input.parsedDetails, ...input.totals, updatedAt };
    this.days.set(input.dateIso, day);
    for (const [id, payment] of this.payments) if (payment.source === "day_text" && payment.workDate === input.dateIso) this.payments.delete(id);
    if (input.advanceCents > 0) {
      const id = this.nextId++;
      this.payments.set(id, { id, dateIso: input.dateIso, amountCents: input.advanceCents, note: "Аванс из отчёта", source: "day_text", workDate: input.dateIso, createdAt: updatedAt, updatedAt });
    }
    return { day, snapshot: await this.projectDay(input.dateIso, input.totals, input.advanceCents) };
  }

  async deleteDay(dateIso: string): Promise<boolean> {
    const deleted = this.days.delete(dateIso);
    for (const [id, payment] of this.payments) {
      if (payment.source === "day_text" && payment.workDate === dateIso) this.payments.delete(id);
    }
    return deleted;
  }

  async getLedger(from?: string, to?: string): Promise<LedgerView> {
    const rows: LedgerRow[] = [];
    for (const day of this.days.values()) if ((!from || day.dateIso >= from) && (!to || day.dateIso <= to)) rows.push({ rowType: "work", ...day });
    for (const payment of this.payments.values()) if ((!from || payment.dateIso >= from) && (!to || payment.dateIso <= to)) rows.push({ rowType: "payment", ...payment });
    rows.sort((a, b) => b.dateIso.localeCompare(a.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals: this.aggregate(to, from), rows };
  }

  async listPeriods(): Promise<LedgerPeriod[]> {
    const periods = new Set<string>();
    for (const day of this.days.values()) periods.add(day.dateIso.slice(0, 7));
    for (const payment of this.payments.values()) periods.add(payment.dateIso.slice(0, 7));
    return [...periods].sort((a, b) => b.localeCompare(a)).map((period) => ({ period, from: `${period}-01`, to: `${period}-31` }));
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

  async getActiveApartments(): Promise<Apartment[]> {
    return [...this.apartments.values()].filter(({ active }) => active).map((item) => ({ ...item, aliases: [...item.aliases] }));
  }

  async importApartments(records: ApartmentImportInput[], dryRun: boolean): Promise<ApartmentImportResult> {
    const working = new Map([...this.apartments].map(([id, item]) => [id, { ...item, aliases: [...item.aliases] }]));
    const result: ApartmentImportResult = { created: 0, updated: 0, skipped: 0, conflicts: [] };
    for (const record of records) {
      const canonicalKey = apartmentKey(record.canonicalName);
      const bySource = [...working.values()].find((item) => item.sourceKey === record.sourceKey);
      const byCanonical = [...working.values()].find((item) => item.canonicalKey === canonicalKey);
      if (bySource && byCanonical && bySource.id !== byCanonical.id) {
        result.conflicts.push({ sourceKey: record.sourceKey, reason: "source_key_and_canonical_key_disagree" }); continue;
      }
      const current = bySource ?? byCanonical;
      const aliases = [...new Set([record.canonicalName, ...record.aliases].map((value) => value.trim()))];
      const aliasKeys = new Set(aliases.map(apartmentKey));
      const aliasOwner = [...working.values()].find((item) => item.id !== current?.id && [item.canonicalName, ...item.aliases].some((alias) => aliasKeys.has(apartmentKey(alias))));
      if (aliasOwner) { result.conflicts.push({ sourceKey: record.sourceKey, reason: "alias_belongs_to_another_apartment" }); continue; }
      const now = new Date().toISOString();
      const next: Apartment = {
        id: current?.id ?? this.nextApartmentId++, sourceKey: record.sourceKey, canonicalKey,
        canonicalName: record.canonicalName, aliases, address: record.address, mapsUrl: record.mapsUrl,
        noteBody: record.noteBody, active: record.active, createdAt: current?.createdAt ?? now, updatedAt: now,
      };
      if (!current) { working.set(next.id, next); result.created += 1; }
      else if (JSON.stringify({ ...current, id: 0, createdAt: "", updatedAt: "" }) === JSON.stringify({ ...next, id: 0, createdAt: "", updatedAt: "" })) result.skipped += 1;
      else { working.set(next.id, next); result.updated += 1; }
    }
    if (!dryRun) { this.apartments.clear(); for (const [id, item] of working) this.apartments.set(id, item); }
    return result;
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

export function normalizeDateIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value);
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

function mapDay(row: Record<string, unknown>): StoredDay {
  return {
    dateIso: normalizeDateIso(row.date_iso), sourceText: String(row.source_text), reportText: row.report_text == null ? null : String(row.report_text), parsedDetails: row.parsed_details as ParsedDay,
    minutes: Number(row.minutes), incomeCents: Number(row.earned_cents), checkinCents: Number(row.checkin_cents),
    expensesCents: Number(row.expenses_cents), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapPayment(row: Record<string, unknown>): Payment {
  return {
    id: Number(row.id), dateIso: normalizeDateIso(row.payment_date), amountCents: Number(row.amount_cents),
    note: row.note == null ? null : String(row.note), source: String(row.source) as Payment["source"],
    workDate: row.work_date == null ? null : normalizeDateIso(row.work_date),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapApartment(row: Record<string, unknown>): Apartment {
  return {
    id: Number(row.id), sourceKey: String(row.source_key), canonicalKey: String(row.canonical_key),
    canonicalName: String(row.canonical_name), aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    address: row.address == null ? null : String(row.address), mapsUrl: row.maps_url == null ? null : String(row.maps_url),
    noteBody: row.note_body == null ? null : String(row.note_body), active: Boolean(row.active),
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
        report_text text,
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
      CREATE TABLE IF NOT EXISTS apartments (
        id bigserial PRIMARY KEY,
        source_key text NOT NULL UNIQUE,
        canonical_key text NOT NULL UNIQUE,
        canonical_name text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
        address text,
        maps_url text,
        note_body text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS apartments_active_idx ON apartments (active);
      ALTER TABLE work_days ADD COLUMN IF NOT EXISTS report_text text;
    `);
    for (const apartment of publicApartmentRecords()) {
      await this.pool.query(`
        INSERT INTO apartments (source_key, canonical_key, canonical_name, aliases, active)
        VALUES ($1, $2, $3, $4::jsonb, true)
        ON CONFLICT (canonical_key) DO NOTHING
      `, [apartment.sourceKey, apartment.canonicalKey, apartment.canonicalName, JSON.stringify(apartment.aliases)]);
    }
    await this.pool.query(`
      WITH recalculated AS (
        SELECT day.date_iso, COALESCE(SUM(
          CASE WHEN job->>'workType' = 'independent'
            THEN COALESCE(
              NULLIF(job->>'durationMinutes', '')::int,
              NULLIF(job->>'endMinutes', '')::int - NULLIF(job->>'startMinutes', '')::int,
              0
            )
            ELSE 0
          END
        ), 0)::int AS minutes
        FROM work_days AS day
        LEFT JOIN LATERAL jsonb_array_elements(COALESCE(day.parsed_details->'jobs', '[]'::jsonb)) AS job ON true
        GROUP BY day.date_iso
      )
      UPDATE work_days AS day
      SET minutes = recalculated.minutes
      FROM recalculated
      WHERE day.date_iso = recalculated.date_iso AND day.minutes IS DISTINCT FROM recalculated.minutes
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
    const from = monthStart(dateIso);
    const [previous, baseResult] = await Promise.all([
      this.aggregate(this.pool, "date_iso >= $2 AND date_iso < $1", [dateIso, from]),
      this.pool.query(`
        SELECT
          COALESCE((SELECT SUM(minutes) FROM work_days WHERE date_iso >= $2 AND date_iso <= $1 AND date_iso <> $1), 0)::int AS minutes,
          COALESCE((SELECT SUM(earned_cents) FROM work_days WHERE date_iso >= $2 AND date_iso <= $1 AND date_iso <> $1), 0)::int AS earned_cents,
          COALESCE((SELECT SUM(expenses_cents) FROM work_days WHERE date_iso >= $2 AND date_iso <= $1 AND date_iso <> $1), 0)::int AS expenses_cents,
          COALESCE((SELECT SUM(checkin_cents) FROM work_days WHERE date_iso >= $2 AND date_iso <= $1 AND date_iso <> $1), 0)::int AS checkin_cents,
          COALESCE((SELECT SUM(amount_cents) FROM payments WHERE payment_date >= $2 AND payment_date <= $1 AND NOT (source='day_text' AND work_date=$1)), 0)::int AS received_cents
      `, [dateIso, from]),
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
        INSERT INTO work_days (date_iso, source_text, report_text, parsed_details, minutes, earned_cents, checkin_cents, expenses_cents, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
        ON CONFLICT (date_iso) DO UPDATE SET source_text=EXCLUDED.source_text, parsed_details=EXCLUDED.parsed_details,
          report_text=EXCLUDED.report_text,
          minutes=EXCLUDED.minutes, earned_cents=EXCLUDED.earned_cents, checkin_cents=EXCLUDED.checkin_cents,
          expenses_cents=EXCLUDED.expenses_cents, updated_at=now()
        RETURNING *
      `, [input.dateIso, input.sourceText, input.reportText, JSON.stringify(input.parsedDetails), input.totals.minutes, input.totals.incomeCents, input.totals.checkinCents, input.totals.expensesCents]);
      await client.query("DELETE FROM payments WHERE source='day_text' AND work_date=$1", [input.dateIso]);
      if (input.advanceCents > 0) await client.query(
        "INSERT INTO payments (payment_date, amount_cents, note, source, work_date) VALUES ($1,$2,'Аванс из отчёта','day_text',$1)",
        [input.dateIso, input.advanceCents],
      );
      const from = monthStart(input.dateIso);
      const previous = await this.aggregate(client, "date_iso >= $2 AND date_iso < $1", [input.dateIso, from]);
      const total = await this.aggregate(client, "date_iso >= $2 AND date_iso <= $1", [input.dateIso, from]);
      await client.query("COMMIT");
      return { day: mapDay(saved.rows[0]), snapshot: { previous, total } };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async deleteDay(dateIso: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM work_days WHERE date_iso=$1", [dateIso]);
    return (result.rowCount ?? 0) > 0;
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
    ].sort((a, b) => b.dateIso.localeCompare(a.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals, rows };
  }

  async listPeriods(): Promise<LedgerPeriod[]> {
    const result = await this.pool.query(`
      SELECT DISTINCT to_char(period_date, 'YYYY-MM') AS period
      FROM (
        SELECT date_iso AS period_date FROM work_days
        UNION ALL
        SELECT payment_date AS period_date FROM payments
      ) entries
      ORDER BY period DESC
    `);
    return result.rows.map(({ period }) => ({ period: String(period), from: `${period}-01`, to: `${period}-31` }));
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

  async getActiveApartments(): Promise<Apartment[]> {
    const result = await this.pool.query("SELECT * FROM apartments WHERE active=true ORDER BY canonical_name");
    return result.rows.map(mapApartment);
  }

  async importApartments(records: ApartmentImportInput[], dryRun: boolean): Promise<ApartmentImportResult> {
    const client = await this.pool.connect();
    const result: ApartmentImportResult = { created: 0, updated: 0, skipped: 0, conflicts: [] };
    try {
      await client.query("BEGIN");
      const existingResult = await client.query("SELECT * FROM apartments FOR UPDATE");
      const existing = existingResult.rows.map(mapApartment);
      for (const record of records) {
        const canonicalKey = apartmentKey(record.canonicalName);
        const bySource = existing.find((item) => item.sourceKey === record.sourceKey);
        const byCanonical = existing.find((item) => item.canonicalKey === canonicalKey);
        if (bySource && byCanonical && bySource.id !== byCanonical.id) {
          result.conflicts.push({ sourceKey: record.sourceKey, reason: "source_key_and_canonical_key_disagree" }); continue;
        }
        const current = bySource ?? byCanonical;
        const aliases = [...new Set([record.canonicalName, ...record.aliases].map((value) => value.trim()))];
        const aliasKeys = new Set(aliases.map(apartmentKey));
        const aliasOwner = existing.find((item) => item.id !== current?.id && [item.canonicalName, ...item.aliases].some((alias) => aliasKeys.has(apartmentKey(alias))));
        if (aliasOwner) { result.conflicts.push({ sourceKey: record.sourceKey, reason: "alias_belongs_to_another_apartment" }); continue; }
        const comparable = { sourceKey: record.sourceKey, canonicalKey, canonicalName: record.canonicalName, aliases, address: record.address, mapsUrl: record.mapsUrl, noteBody: record.noteBody, active: record.active };
        if (current && JSON.stringify({ sourceKey: current.sourceKey, canonicalKey: current.canonicalKey, canonicalName: current.canonicalName, aliases: current.aliases, address: current.address, mapsUrl: current.mapsUrl, noteBody: current.noteBody, active: current.active }) === JSON.stringify(comparable)) {
          result.skipped += 1; continue;
        }
        const saved = current
          ? await client.query(`UPDATE apartments SET source_key=$2, canonical_key=$3, canonical_name=$4, aliases=$5::jsonb, address=$6, maps_url=$7, note_body=$8, active=$9, updated_at=now() WHERE id=$1 RETURNING *`, [current.id, record.sourceKey, canonicalKey, record.canonicalName, JSON.stringify(aliases), record.address, record.mapsUrl, record.noteBody, record.active])
          : await client.query(`INSERT INTO apartments (source_key, canonical_key, canonical_name, aliases, address, maps_url, note_body, active) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`, [record.sourceKey, canonicalKey, record.canonicalName, JSON.stringify(aliases), record.address, record.mapsUrl, record.noteBody, record.active]);
        const mapped = mapApartment(saved.rows[0]);
        if (current) { existing.splice(existing.indexOf(current), 1, mapped); result.updated += 1; }
        else { existing.push(mapped); result.created += 1; }
      }
      if (dryRun) await client.query("ROLLBACK"); else await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

