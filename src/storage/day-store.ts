import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DayTotals } from "../domain/types.js";

export interface StoredDay extends DayTotals {
  dateIso: string;
  updatedAt: string;
}

export class DayStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS daily_totals (
        date_iso TEXT PRIMARY KEY,
        minutes INTEGER NOT NULL,
        income_cents INTEGER NOT NULL,
        expenses_cents INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
  }

  save(dateIso: string, totals: DayTotals): StoredDay {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO daily_totals (date_iso, minutes, income_cents, expenses_cents, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date_iso) DO UPDATE SET
        minutes = excluded.minutes,
        income_cents = excluded.income_cents,
        expenses_cents = excluded.expenses_cents,
        updated_at = excluded.updated_at
    `).run(dateIso, totals.minutes, totals.incomeCents, totals.expensesCents, updatedAt);
    return { dateIso, ...totals, updatedAt };
  }

  get(dateIso: string): StoredDay | null {
    const row = this.database.prepare(`
      SELECT date_iso, minutes, income_cents, expenses_cents, updated_at
      FROM daily_totals WHERE date_iso = ?
    `).get(dateIso) as Record<string, string | number> | undefined;
    return row ? {
      dateIso: String(row.date_iso),
      minutes: Number(row.minutes),
      incomeCents: Number(row.income_cents),
      expensesCents: Number(row.expenses_cents),
      updatedAt: String(row.updated_at),
    } : null;
  }

  close(): void {
    this.database.close();
  }
}
