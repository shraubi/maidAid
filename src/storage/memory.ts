import type { Balance, PendingState, Settings, StoredDay } from "../domain/types.js";
import type { Storage } from "./storage.js";

const defaultSettings: Settings = {
  hourlyRateCents: 1000,
  dryerDefaultCents: 390,
  initialMinutes: 0,
  initialIncomeCents: 0,
  initialExpensesCents: 0,
};

export class MemoryStorage implements Storage {
  private readonly messages = new Set<string>();
  private readonly pending = new Map<string, PendingState>();
  private readonly days = new Map<string, StoredDay>();

  constructor(private readonly settings: Settings = defaultSettings) {}

  async initialize(): Promise<void> {}

  async hasMessage(messageId: string): Promise<boolean> {
    return this.messages.has(messageId);
  }

  async recordMessage(messageId: string): Promise<void> {
    this.messages.add(messageId);
  }

  async getPending(userPhone: string): Promise<PendingState | null> {
    return this.pending.get(userPhone) ?? null;
  }

  async savePending(userPhone: string, pending: PendingState | null): Promise<void> {
    if (pending) this.pending.set(userPhone, pending);
    else this.pending.delete(userPhone);
  }

  async getSettings(): Promise<Settings> {
    return this.settings;
  }

  async saveDay(day: StoredDay): Promise<void> {
    if (!day.parsed.dateIso) throw new Error("Cannot save a day without a date");
    this.days.set(day.parsed.dateIso, structuredClone(day));
  }

  async getDay(dateIso: string): Promise<StoredDay | null> {
    return this.days.get(dateIso) ?? null;
  }

  async listDays(limit: number): Promise<StoredDay[]> {
    return [...this.days.values()]
      .sort((a, b) => (b.parsed.dateIso ?? "").localeCompare(a.parsed.dateIso ?? ""))
      .slice(0, limit);
  }

  async getBalance(): Promise<Balance> {
    const actualDays = [...this.days.values()].filter((day) => day.status === "actual");
    return actualDays.reduce<Balance>(
      (total, day) => ({
        minutes: total.minutes + day.totals.minutes,
        incomeCents: total.incomeCents + day.totals.incomeCents,
        expensesCents: total.expensesCents + day.totals.expensesCents,
      }),
      {
        minutes: this.settings.initialMinutes,
        incomeCents: this.settings.initialIncomeCents,
        expensesCents: this.settings.initialExpensesCents,
      },
    );
  }
}
