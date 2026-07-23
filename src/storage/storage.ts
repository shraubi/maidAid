import type { Balance, PendingState, Settings, StoredDay } from "../domain/types.js";

export interface Storage {
  initialize(): Promise<void>;
  hasMessage(messageId: string): Promise<boolean>;
  recordMessage(messageId: string): Promise<void>;
  getPending(userPhone: string): Promise<PendingState | null>;
  savePending(userPhone: string, pending: PendingState | null): Promise<void>;
  getSettings(): Promise<Settings>;
  saveDay(day: StoredDay): Promise<void>;
  getDay(dateIso: string): Promise<StoredDay | null>;
  listDays(limit: number): Promise<StoredDay[]>;
  getBalance(): Promise<Balance>;
}
