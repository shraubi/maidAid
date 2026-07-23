import { google, sheets_v4 } from "googleapis";
import type { Balance, PendingState, Settings, StoredDay } from "../domain/types.js";
import type { Storage } from "./storage.js";

const sheets = ["Settings", "Days", "Jobs", "Expenses", "Messages", "Pending"] as const;
const headers: Record<(typeof sheets)[number], string[]> = {
  Settings: ["key", "value"],
  Days: ["date", "status", "minutes", "income_cents", "expenses_cents", "confirmed_at"],
  Jobs: [
    "date",
    "object",
    "start_minutes",
    "end_minutes",
    "end_inferred",
    "work_type",
    "companion",
    "source_line",
  ],
  Expenses: ["date", "category", "object", "amount_cents", "source_line"],
  Messages: ["message_id", "processed_at"],
  Pending: ["phone", "json"],
};

export class GoogleSheetsStorage implements Storage {
  private readonly api: sheets_v4.Sheets;

  constructor(
    private readonly spreadsheetId: string,
    credentials: object,
  ) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.api = google.sheets({ version: "v4", auth });
  }

  async initialize(): Promise<void> {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existing = new Set(meta.data.sheets?.map((sheet) => sheet.properties?.title));
    const missing = sheets.filter((name) => !existing.has(name));
    if (missing.length) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    }
    for (const name of sheets) {
      const values = await this.read(name);
      if (!values.length) await this.writeAll(name, [headers[name]]);
    }
    const settings = await this.read("Settings");
    if (settings.length <= 1) {
      await this.writeAll("Settings", [
        headers.Settings,
        ["hourlyRateCents", "1000"],
        ["dryerDefaultCents", "390"],
        ["initialMinutes", "0"],
        ["initialIncomeCents", "0"],
        ["initialExpensesCents", "0"],
      ]);
    }
  }

  private async read(sheet: string): Promise<string[][]> {
    const result = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheet}'!A:Z`,
    });
    return (result.data.values ?? []) as string[][];
  }

  private async writeAll(sheet: string, values: Array<Array<string | number | boolean>>): Promise<void> {
    await this.api.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheet}'!A:Z`,
    });
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheet}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }

  private async append(sheet: string, values: Array<string | number | boolean>): Promise<void> {
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheet}'!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
  }

  async hasMessage(messageId: string): Promise<boolean> {
    const rows = await this.read("Messages");
    return rows.slice(1).some((row) => row[0] === messageId);
  }

  async recordMessage(messageId: string): Promise<void> {
    await this.append("Messages", [messageId, new Date().toISOString()]);
  }

  async getPending(userPhone: string): Promise<PendingState | null> {
    const rows = await this.read("Pending");
    const row = rows.slice(1).find((candidate) => candidate[0] === userPhone);
    if (!row?.[1]) return null;
    return JSON.parse(row[1]) as PendingState;
  }

  async savePending(userPhone: string, pending: PendingState | null): Promise<void> {
    const rows = await this.read("Pending");
    const filtered = rows.slice(1).filter((row) => row[0] !== userPhone);
    if (pending) filtered.push([userPhone, JSON.stringify(pending)]);
    await this.writeAll("Pending", [headers.Pending, ...filtered]);
  }

  async getSettings(): Promise<Settings> {
    const rows = await this.read("Settings");
    const values = new Map(rows.slice(1).map((row) => [row[0], Number(row[1])]));
    return {
      hourlyRateCents: values.get("hourlyRateCents") ?? 1000,
      dryerDefaultCents: values.get("dryerDefaultCents") ?? 390,
      initialMinutes: values.get("initialMinutes") ?? 0,
      initialIncomeCents: values.get("initialIncomeCents") ?? 0,
      initialExpensesCents: values.get("initialExpensesCents") ?? 0,
    };
  }

  async saveDay(day: StoredDay): Promise<void> {
    const date = day.parsed.dateIso;
    if (!date) throw new Error("Cannot save a day without a date");
    const dayRows = (await this.read("Days")).slice(1).filter((row) => row[0] !== date);
    dayRows.push([
      date,
      day.status,
      String(day.totals.minutes),
      String(day.totals.incomeCents),
      String(day.totals.expensesCents),
      day.confirmedAt,
    ]);
    await this.writeAll("Days", [headers.Days, ...dayRows]);

    const jobRows = (await this.read("Jobs")).slice(1).filter((row) => row[0] !== date);
    for (const job of day.parsed.jobs) {
      jobRows.push([
        date,
        job.object,
        String(job.startMinutes ?? ""),
        String(job.endMinutes ?? ""),
        String(job.endInferred),
        job.workType,
        job.companion ?? "",
        job.sourceLine,
      ]);
    }
    await this.writeAll("Jobs", [headers.Jobs, ...jobRows]);

    const expenseRows = (await this.read("Expenses")).slice(1).filter((row) => row[0] !== date);
    for (const expense of day.parsed.expenses) {
      expenseRows.push([
        date,
        expense.category,
        expense.object ?? "",
        String(expense.amountCents),
        expense.sourceLine,
      ]);
    }
    await this.writeAll("Expenses", [headers.Expenses, ...expenseRows]);
  }

  async getDay(dateIso: string): Promise<StoredDay | null> {
    const days = await this.read("Days");
    const row = days.slice(1).find((candidate) => candidate[0] === dateIso);
    if (!row) return null;
    const jobs = (await this.read("Jobs"))
      .slice(1)
      .filter((candidate) => candidate[0] === dateIso)
      .map((candidate) => ({
        object: candidate[1] ?? "",
        startMinutes: candidate[2] ? Number(candidate[2]) : null,
        endMinutes: candidate[3] ? Number(candidate[3]) : null,
        endInferred: candidate[4] === "true",
        workType: (candidate[5] ?? "unknown") as "independent" | "orientation" | "unknown",
        companion: candidate[6] || undefined,
        sourceLine: candidate[7] ?? "",
      }));
    const expenses = (await this.read("Expenses"))
      .slice(1)
      .filter((candidate) => candidate[0] === dateIso)
      .map((candidate) => ({
        category: candidate[1] ?? "",
        object: candidate[2] || undefined,
        amountCents: Number(candidate[3] ?? 0),
        sourceLine: candidate[4] ?? "",
      }));
    const [year, month, day] = dateIso.split("-");
    return {
      parsed: {
        dateIso,
        displayDate: `${day}/${month}`,
        kind: row[1] === "actual" ? "actual" : "schedule",
        jobs,
        expenses,
        unparsedLines: [],
        issues: [],
      },
      status: row[1] === "actual" ? "actual" : "schedule",
      totals: {
        minutes: Number(row[2] ?? 0),
        incomeCents: Number(row[3] ?? 0),
        expensesCents: Number(row[4] ?? 0),
      },
      confirmedAt: row[5] ?? "",
    };
  }

  async listDays(limit: number): Promise<StoredDay[]> {
    const rows = await this.read("Days");
    const dates = rows
      .slice(1)
      .map((row) => row[0])
      .filter((date): date is string => Boolean(date))
      .sort()
      .reverse()
      .slice(0, limit);
    return (await Promise.all(dates.map((date) => this.getDay(date)))).filter(
      (day): day is StoredDay => day !== null,
    );
  }

  async getBalance(): Promise<Balance> {
    const settings = await this.getSettings();
    const rows = await this.read("Days");
    return rows.slice(1).reduce<Balance>(
      (total, row) =>
        row[1] !== "actual"
          ? total
          : {
              minutes: total.minutes + Number(row[2] ?? 0),
              incomeCents: total.incomeCents + Number(row[3] ?? 0),
              expensesCents: total.expensesCents + Number(row[4] ?? 0),
            },
      {
        minutes: settings.initialMinutes,
        incomeCents: settings.initialIncomeCents,
        expensesCents: settings.initialExpensesCents,
      },
    );
  }
}
