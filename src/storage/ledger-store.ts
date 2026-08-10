import { Pool, type PoolClient } from "pg";
import type { Apartment, ApartmentPlaceLink, DayTotals, LedgerTotals, LocationSource, ParsedDay, ReportSnapshot, SavedPlace, SavedPlaceKind } from "../domain/types.js";
import { apartmentKey, publicApartmentRecords } from "../domain/apartments.js";
import type { Cleaner, CleanerCredentials, InitialCleaner } from "../auth.js";

export interface ApartmentImportInput {
  sourceKey: string;
  canonicalName: string;
  aliases: string[];
  address: string;
  mapsUrl: string;
  noteBody: string;
  latitude?: number | null;
  longitude?: number | null;
  active: boolean;
}

export interface ApartmentWriteInput {
  canonicalName: string;
  aliases: string[];
  address: string | null;
  mapsUrl: string | null;
  noteBody: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: LocationSource | null;
  locationAccuracyMeters: number | null;
}

export interface SavedPlaceWriteInput {
  kind: SavedPlaceKind;
  name: string;
  address: string | null;
  note: string | null;
  mapsUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: LocationSource | null;
  locationAccuracyMeters: number | null;
  osmType?: SavedPlace["osmType"];
  osmId?: string | null;
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
  initialize(initialCleaner?: InitialCleaner | null): Promise<void>;
  health(): Promise<boolean>;
  close(): Promise<void>;
  projectDay(dateIso: string, totals: DayTotals, advanceCents: number, cleanerId?: number): Promise<ReportSnapshot>;
  saveDay(input: SaveDayInput, cleanerId?: number): Promise<{ day: StoredDay; snapshot: ReportSnapshot }>;
  deleteDay(dateIso: string, cleanerId?: number): Promise<boolean>;
  getLedger(from?: string, to?: string, cleanerId?: number): Promise<LedgerView>;
  listPeriods(cleanerId?: number): Promise<LedgerPeriod[]>;
  createPayment(dateIso: string, amountCents: number, note?: string, cleanerId?: number): Promise<Payment>;
  updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }, cleanerId?: number): Promise<Payment | null>;
  deletePayment(id: number, cleanerId?: number): Promise<boolean>;
  createCleaner(input: { name: string; nameKey: string; pinSalt: string; pinHash: string }): Promise<Cleaner>;
  findCleanerByNameKey(nameKey: string): Promise<CleanerCredentials | null>;
  getCleaner(id: number): Promise<Cleaner | null>;
  listCleaners(): Promise<Cleaner[]>;
  setCleanerPin(id: number, pinSalt: string, pinHash: string): Promise<boolean>;
  setCleanerActive(id: number, active: boolean): Promise<boolean>;
  createSession(cleanerId: number, tokenHash: string, expiresAt: Date): Promise<void>;
  getCleanerBySession(tokenHash: string): Promise<Cleaner | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteCleanerSessions(cleanerId: number): Promise<void>;
  getActiveApartments(): Promise<Apartment[]>;
  getApartment(id: number): Promise<Apartment | null>;
  createApartment(input: ApartmentWriteInput): Promise<Apartment>;
  updateApartment(id: number, input: Partial<ApartmentWriteInput>): Promise<Apartment | null>;
  importApartments(records: ApartmentImportInput[], dryRun: boolean): Promise<ApartmentImportResult>;
  getSavedPlaces(): Promise<SavedPlace[]>;
  getSavedPlace(id: number): Promise<SavedPlace | null>;
  createSavedPlace(input: SavedPlaceWriteInput): Promise<SavedPlace>;
  updateSavedPlace(id: number, input: Partial<SavedPlaceWriteInput>): Promise<SavedPlace | null>;
  archiveSavedPlace(id: number): Promise<boolean>;
  findSavedPlaceByOsm(osmType: NonNullable<SavedPlace["osmType"]>, osmId: string): Promise<SavedPlace | null>;
  getPreferredLaundry(apartmentId: number): Promise<SavedPlace | null>;
  setPreferredLaundry(apartmentId: number, placeId: number): Promise<ApartmentPlaceLink | null>;
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
  private readonly paymentOwners = new Map<number, number>();
  private readonly cleaners = new Map<number, CleanerCredentials>();
  private readonly sessions = new Map<string, { cleanerId: number; expiresAt: Date }>();
  private nextCleanerId = 1;
  private nextId = 1;
  private readonly apartments = new Map<number, Apartment>(publicApartmentRecords().map((item) => [item.id, item]));
  private nextApartmentId = this.apartments.size + 1;
  private readonly savedPlaces = new Map<number, SavedPlace>();
  private nextSavedPlaceId = 1;
  private readonly apartmentPlaceLinks = new Map<number, ApartmentPlaceLink>();

  async initialize(initialCleaner?: InitialCleaner | null): Promise<void> {
    if (initialCleaner && this.cleaners.size === 0) await this.createCleaner(initialCleaner);
  }
  async health(): Promise<boolean> { return true; }
  async close(): Promise<void> {}

  async createCleaner(input: { name: string; nameKey: string; pinSalt: string; pinHash: string }): Promise<Cleaner> {
    if ([...this.cleaners.values()].some((cleaner) => cleaner.nameKey === input.nameKey)) throw new Error("cleaner_exists");
    const now = new Date().toISOString();
    const cleaner: CleanerCredentials = { id: this.nextCleanerId++, ...input, active: true, createdAt: now, updatedAt: now };
    this.cleaners.set(cleaner.id, cleaner);
    return { id: cleaner.id, name: cleaner.name, active: cleaner.active, createdAt: now, updatedAt: now };
  }

  async findCleanerByNameKey(nameKey: string): Promise<CleanerCredentials | null> { return [...this.cleaners.values()].find((cleaner) => cleaner.nameKey === nameKey) ?? null; }
  async getCleaner(id: number): Promise<Cleaner | null> { const cleaner = this.cleaners.get(id); return cleaner ? { id, name: cleaner.name, active: cleaner.active, createdAt: cleaner.createdAt, updatedAt: cleaner.updatedAt } : null; }
  async listCleaners(): Promise<Cleaner[]> { return (await Promise.all([...this.cleaners.keys()].map((id) => this.getCleaner(id)))).filter((item): item is Cleaner => item !== null); }
  async setCleanerPin(id: number, pinSalt: string, pinHash: string): Promise<boolean> { const cleaner = this.cleaners.get(id); if (!cleaner) return false; this.cleaners.set(id, { ...cleaner, pinSalt, pinHash, updatedAt: new Date().toISOString() }); await this.deleteCleanerSessions(id); return true; }
  async setCleanerActive(id: number, active: boolean): Promise<boolean> { const cleaner = this.cleaners.get(id); if (!cleaner) return false; this.cleaners.set(id, { ...cleaner, active, updatedAt: new Date().toISOString() }); if (!active) await this.deleteCleanerSessions(id); return true; }
  async createSession(cleanerId: number, tokenHash: string, expiresAt: Date): Promise<void> { this.sessions.set(tokenHash, { cleanerId, expiresAt }); }
  async getCleanerBySession(tokenHash: string): Promise<Cleaner | null> { const session = this.sessions.get(tokenHash); if (!session || session.expiresAt <= new Date()) { this.sessions.delete(tokenHash); return null; } const cleaner = await this.getCleaner(session.cleanerId); return cleaner?.active ? cleaner : null; }
  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }
  async deleteCleanerSessions(cleanerId: number): Promise<void> { for (const [hash, session] of this.sessions) if (session.cleanerId === cleanerId) this.sessions.delete(hash); }

  private dayKey(cleanerId: number, dateIso: string): string { return `${cleanerId}:${dateIso}`; }

  private aggregate(to?: string, from?: string, excludedDate?: string, cleanerId = 1): LedgerTotals {
    const result = zeroTotals();
    for (const [key, day] of this.days) {
      if (!key.startsWith(`${cleanerId}:`)) continue;
      if ((from && day.dateIso < from) || (to && day.dateIso > to) || day.dateIso === excludedDate) continue;
      result.minutes += day.minutes;
      result.earnedCents += day.incomeCents;
      result.expensesCents += day.expensesCents;
      result.checkinCents += day.checkinCents;
    }
    for (const payment of this.payments.values()) {
      if ((this.paymentOwners.get(payment.id) ?? 1) !== cleanerId) continue;
      if ((from && payment.dateIso < from) || (to && payment.dateIso > to) || (excludedDate && payment.source === "day_text" && payment.workDate === excludedDate)) continue;
      result.receivedCents += payment.amountCents;
    }
    result.outstandingCents = result.earnedCents - result.receivedCents;
    return result;
  }

  async projectDay(dateIso: string, totals: DayTotals, advanceCents: number, cleanerId = 1): Promise<ReportSnapshot> {
    const from = monthStart(dateIso);
    const previous = this.aggregate(dateIso, from, undefined, cleanerId);
    const existing = this.days.get(this.dayKey(cleanerId, dateIso));
    if (existing) { const day = existing;
      previous.minutes -= day.minutes; previous.earnedCents -= day.incomeCents;
      previous.expensesCents -= day.expensesCents; previous.checkinCents -= day.checkinCents;
    }
    for (const payment of this.payments.values()) if ((this.paymentOwners.get(payment.id) ?? 1) === cleanerId && payment.dateIso === dateIso) previous.receivedCents -= payment.amountCents;
    previous.outstandingCents = previous.earnedCents - previous.receivedCents;
    const base = this.aggregate(dateIso, from, dateIso, cleanerId);
    const total = finishTotals({
      minutes: base.minutes + totals.minutes,
      earnedCents: base.earnedCents + totals.incomeCents,
      receivedCents: base.receivedCents + advanceCents,
      expensesCents: base.expensesCents + totals.expensesCents,
      checkinCents: base.checkinCents + totals.checkinCents,
    });
    return { previous, total };
  }

  async saveDay(input: SaveDayInput, cleanerId = 1): Promise<{ day: StoredDay; snapshot: ReportSnapshot }> {
    const updatedAt = new Date().toISOString();
    const day: StoredDay = { dateIso: input.dateIso, sourceText: input.sourceText, reportText: input.reportText, parsedDetails: input.parsedDetails, ...input.totals, updatedAt };
    this.days.set(this.dayKey(cleanerId, input.dateIso), day);
    for (const [id, payment] of this.payments) if ((this.paymentOwners.get(id) ?? 1) === cleanerId && payment.source === "day_text" && payment.workDate === input.dateIso) { this.payments.delete(id); this.paymentOwners.delete(id); }
    if (input.advanceCents > 0) {
      const id = this.nextId++;
      this.paymentOwners.set(id, cleanerId);
      this.payments.set(id, { id, dateIso: input.dateIso, amountCents: input.advanceCents, note: "–ê–≤–∞–Ω—Å –∏–∑ –æ—Ç—á—ë—Ç–∞", source: "day_text", workDate: input.dateIso, createdAt: updatedAt, updatedAt });
    }
    return { day, snapshot: await this.projectDay(input.dateIso, input.totals, input.advanceCents, cleanerId) };
  }

  async deleteDay(dateIso: string, cleanerId = 1): Promise<boolean> {
    const deleted = this.days.delete(this.dayKey(cleanerId, dateIso));
    for (const [id, payment] of this.payments) {
      if ((this.paymentOwners.get(id) ?? 1) === cleanerId && payment.source === "day_text" && payment.workDate === dateIso) { this.payments.delete(id); this.paymentOwners.delete(id); }
    }
    return deleted;
  }

  async getLedger(from?: string, to?: string, cleanerId = 1): Promise<LedgerView> {
    const rows: LedgerRow[] = [];
    for (const [key, day] of this.days) if (key.startsWith(`${cleanerId}:`) && (!from || day.dateIso >= from) && (!to || day.dateIso <= to)) rows.push({ rowType: "work", ...day });
    for (const payment of this.payments.values()) if ((this.paymentOwners.get(payment.id) ?? 1) === cleanerId && (!from || payment.dateIso >= from) && (!to || payment.dateIso <= to)) rows.push({ rowType: "payment", ...payment });
    rows.sort((a, b) => b.dateIso.localeCompare(a.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals: this.aggregate(to, from, undefined, cleanerId), rows };
  }

  async listPeriods(cleanerId = 1): Promise<LedgerPeriod[]> {
    const periods = new Set<string>();
    for (const [key, day] of this.days) if (key.startsWith(`${cleanerId}:`)) periods.add(day.dateIso.slice(0, 7));
    for (const payment of this.payments.values()) if ((this.paymentOwners.get(payment.id) ?? 1) === cleanerId) periods.add(payment.dateIso.slice(0, 7));
    return [...periods].sort((a, b) => b.localeCompare(a)).map((period) => ({ period, from: `${period}-01`, to: `${period}-31` }));
  }

  async createPayment(dateIso: string, amountCents: number, note?: string, cleanerId = 1): Promise<Payment> {
    const now = new Date().toISOString(); const id = this.nextId++;
    const payment: Payment = { id, dateIso, amountCents, note: note?.trim() || null, source: "manual", workDate: null, createdAt: now, updatedAt: now };
    this.payments.set(id, payment); this.paymentOwners.set(id, cleanerId); return payment;
  }

  async updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }, cleanerId = 1): Promise<Payment | null> {
    const current = this.payments.get(id);
    if (!current || (this.paymentOwners.get(id) ?? 1) !== cleanerId || current.source !== "manual") return null;
    const next = { ...current, dateIso: values.dateIso ?? current.dateIso, amountCents: values.amountCents ?? current.amountCents, note: values.note === undefined ? current.note : values.note?.trim() || null, updatedAt: new Date().toISOString() };
    this.payments.set(id, next); return next;
  }

  async deletePayment(id: number, cleanerId = 1): Promise<boolean> {
    const payment = this.payments.get(id);
    if ((this.paymentOwners.get(id) ?? 1) !== cleanerId || payment?.source !˜Mx∂âûÀk∫wµÁ\†§§(ÄÄÄÄÄÄÄÅ=8Å=91%PÄ°ç±ïÖπï…}•ê±ëÖ—ï}•Õº§Å<ÅUAQÅMPÅÕΩ’…çï}—ï·–ıa1UπÕΩ’…çï}—ï·–∞Å¡Ö…Õïë}ëï—Ö•±Ãıa1Uπ¡Ö…Õïë}ëï—Ö•±Ã∞(ÄÄÄÄÄÄÄÄÄÅ…ï¡Ω…—}—ï·–ıa1Uπ…ï¡Ω…—}—ï·–∞(ÄÄÄÄÄÄÄÄÄÅµ•π’—ïÃıa1Uπµ•π’—ïÃ∞ÅïÖ…πïë}çïπ—Ãıa1UπïÖ…πïë}çïπ—Ã∞Åç°ïç≠•π}çïπ—Ãıa1Uπç°ïç≠•π}çïπ—Ã∞(ÄÄÄÄÄÄÄÄÄÅï·¡ïπÕïÕ}çïπ—Ãıa1Uπï·¡ïπÕïÕ}çïπ—Ã∞Å’¡ëÖ—ïë}Ö–ıπΩ‹†§(ÄÄÄÄÄÄÄÅIQUI9%9Ä®(ÄÄÄÄÄÅÄ∞Åm•π¡’–πëÖ—ï%Õº∞Å•π¡’–πÕΩ’…çïQï·–∞Å•π¡’–π…ï¡Ω…—Qï·–∞Å)M=8πÕ—…•πù•ô‰°•π¡’–π¡Ö…Õïëï—Ö•±Ã§∞Å•π¡’–π—Ω—Ö±Ãπµ•π’—ïÃ∞Å•π¡’–π—Ω—Ö±Ãπ•πçΩµïïπ—Ã∞Å•π¡’–π—Ω—Ö±Ãπç°ïç≠•πïπ—Ã∞Å•π¡’–π—Ω—Ö±Ãπï·¡ïπÕïÕïπ—Ã∞Åç±ïÖπï…%ët§Ï(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†â1QÅI=4Å¡ÖÂµïπ—ÃÅ]!IÅç±ïÖπï…}•êÙê»Å9ÅÕΩ’…çîÙùëÖÂ}—ï·–úÅ9Å›Ω…≠}ëÖ—îÙêƒà∞Åm•π¡’–πëÖ—ï%Õº∞Åç±ïÖπï…%ët§Ï(ÄÄÄÄÄÅ•òÄ°•π¡’–πÖëŸÖπçïïπ—ÃÄ¯Ä¿§ÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†(ÄÄÄÄÄÄÄÄâ%9MIPÅ%9Q<Å¡ÖÂµïπ—ÃÄ°ç±ïÖπï…}•ê±¡ÖÂµïπ—}ëÖ—î±ÖµΩ’π—}çïπ—Ã±πΩ—î±ÕΩ’…çî±›Ω…≠}ëÖ—î§ÅY1ULÄ†êÃ∞êƒ∞ê»∞üBCBÀB√B˜FÉB„B‹ÉB˚FFFGFB¿ú∞ùëÖÂ}—ï·–ú∞êƒ§à∞(ÄÄÄÄÄÄÄÅm•π¡’–πëÖ—ï%Õº∞Å•π¡’–πÖëŸÖπçïïπ—Ã∞Åç±ïÖπï…%ët∞(ÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅçΩπÕ–Åô…Ω¥ÄÙÅµΩπ—°M—Ö…–°•π¡’–πëÖ—ï%Õº§Ï(ÄÄÄÄÄÅçΩπÕ–Å¡…ïŸ•Ω’ÃÄÙÅÖ›Ö•–Å—°•ÃπÖùù…ïùÖ—î°ç±•ïπ–∞Åç±ïÖπï…%ê∞ÄâëÖ—ï}•ÕºÄ¯ÙÄê»Å9ÅëÖ—ï}•ÕºÄÄêƒà∞Åm•π¡’–πëÖ—ï%Õº∞Åô…Ωµt§Ï(ÄÄÄÄÄÅçΩπÕ–Å—Ω—Ö∞ÄÙÅÖ›Ö•–Å—°•ÃπÖùù…ïùÖ—î°ç±•ïπ–∞Åç±ïÖπï…%ê∞ÄâëÖ—ï}•ÕºÄ¯ÙÄê»Å9ÅëÖ—ï}•ÕºÄÙÄêƒà∞Åm•π¡’–πëÖ—ï%Õº∞Åô…Ωµt§Ï(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†â=55%Pà§Ï(ÄÄÄÄÄÅ…ï—’…∏ÅÏÅëÖ‰ËÅµÖ¡Ö‰°ÕÖŸïêπ…Ω›Õl¡t§∞ÅÕπÖ¡Õ°Ω–ËÅÏÅ¡…ïŸ•Ω’Ã∞Å—Ω—Ö∞ÅÙÅÙÏ(ÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†âI=11	,à§ÏÅ—°…Ω‹Åï……Ω»ÏÅÙ(ÄÄÄÅô•πÖ±±‰ÅÏÅç±•ïπ–π…ï±ïÖÕî†§ÏÅÙ(ÄÅÙ((ÄÅÖÕÂπåÅëï±ï—ïÖ‰°ëÖ—ï%ÕºËÅÕ—…•πú∞Åç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒâΩΩ±ïÖ∏¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†â1QÅI=4Å›Ω…≠}ëÖÂÃÅ]!IÅëÖ—ï}•ÕºÙêƒÅ9Åç±ïÖπï…}•êÙê»à∞ÅmëÖ—ï%Õº∞Åç±ïÖπï…%ët§Ï(ÄÄÄÅ…ï—’…∏Ä°…ïÕ’±–π…Ω›Ω’π–Ä¸¸Ä¿§Ä¯Ä¿Ï(ÄÅÙ((ÄÅÖÕÂπåÅùï—1ïëùï»°ô…Ω¥¸ËÅÕ—…•πú∞Å—º¸ËÅÕ—…•πú∞Åç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒ1ïëùï…Y•ï‹¯ÅÏ(ÄÄÄÅçΩπÕ–ÅŸÖ±’ïÃËÅÕ—…•πùmtÄÙÅmtÏÅçΩπÕ–Åç±Ö’ÕïÃËÅÕ—…•πùmtÄÙÅmtÏ(ÄÄÄÅ•òÄ°ô…Ω¥§ÅÏÅŸÖ±’ïÃπ¡’Õ†°ô…Ω¥§ÏÅç±Ö’ÕïÃπ¡’Õ†°ÅëÖ—ï}•ÕºÄ¯ÙÄêëÌŸÖ±’ïÃπ±ïπù—°ıÄ§ÏÅÙ(ÄÄÄÅ•òÄ°—º§ÅÏÅŸÖ±’ïÃπ¡’Õ†°—º§ÏÅç±Ö’ÕïÃπ¡’Õ†°ÅëÖ—ï}•ÕºÄÙÄêëÌŸÖ±’ïÃπ±ïπù—°ıÄ§ÏÅÙ(ÄÄÄÅçΩπÕ–ÅçΩπë•—•Ω∏ÄÙÅç±Ö’ÕïÃπ±ïπù—†Ä¸Åç±Ö’ÕïÃπ©Ω•∏†àÅ9Äà§ÄËÄâQIUàÏ(ÄÄÄÅçΩπÕ–Åm—Ω—Ö±Ã∞ÅëÖÂÃ∞Å¡ÖÂµïπ—ÕtÄÙÅÖ›Ö•–ÅA…Ωµ•ÕîπÖ±∞°l(ÄÄÄÄÄÅ—°•ÃπÖùù…ïùÖ—î°—°•Ãπ¡ΩΩ∞∞Åç±ïÖπï…%ê∞ÅçΩπë•—•Ω∏∞ÅŸÖ±’ïÃ§∞(ÄÄÄÄÄÅ—°•Ãπ¡ΩΩ∞π≈’ï…‰°ÅM1PÄ®ÅI=4Å›Ω…≠}ëÖÂÃÅ]!IÅç±ïÖπï…}•êÙêëÌŸÖ±’ïÃπ±ïπù—†Ä¨Ä≈ÙÅ9ÄëÌçΩπë•—•ΩπÙÅ=IHÅ	dÅëÖ—ï}•Õº∞Å’¡ëÖ—ïë}Ö—Ä∞Ål∏∏πŸÖ±’ïÃ∞Åç±ïÖπï…%ët§∞(ÄÄÄÄÄÅ—°•Ãπ¡ΩΩ∞π≈’ï…‰°ÅM1PÄ®ÅI=4Å¡ÖÂµïπ—ÃÅ]!IÅç±ïÖπï…}•êÙêëÌŸÖ±’ïÃπ±ïπù—†Ä¨Ä≈ÙÅ9ÄëÌçΩπë•—•Ω∏π…ï¡±Öçï±∞†âëÖ—ï}•Õºà∞Äâ¡ÖÂµïπ—}ëÖ—îà•ÙÅ=IHÅ	dÅ¡ÖÂµïπ—}ëÖ—î∞Å•ëÄ∞Ål∏∏πŸÖ±’ïÃ∞Åç±ïÖπï…%ët§∞(ÄÄÄÅt§Ï(ÄÄÄÅçΩπÕ–Å…Ω›ÃËÅ1ïëùï…IΩ›mtÄÙÅl(ÄÄÄÄÄÄ∏∏πëÖÂÃπ…Ω›ÃπµÖ¿†°…Ω‹§ÄÙ¯Ä°ÏÅ…Ω›QÂ¡îËÄâ›Ω…¨àÅÖÃÅçΩπÕ–∞Ä∏∏πµÖ¡Ö‰°…Ω‹§ÅÙ§§∞(ÄÄÄÄÄÄ∏∏π¡ÖÂµïπ—Ãπ…Ω›ÃπµÖ¿†°…Ω‹§ÄÙ¯Ä°ÏÅ…Ω›QÂ¡îËÄâ¡ÖÂµïπ–àÅÖÃÅçΩπÕ–∞Ä∏∏πµÖ¡AÖÂµïπ–°…Ω‹§ÅÙ§§∞(ÄÄÄÅtπÕΩ…–†°Ñ∞Åà§ÄÙ¯ÅàπëÖ—ï%Õºπ±ΩçÖ±ïΩµ¡Ö…î°ÑπëÖ—ï%Õº§ÅÒÄ°Ñπ…Ω›QÂ¡îÄÙÙÙÄâ›Ω…¨àÄ¸Ä¥ƒÄËÄƒ§§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅ—Ω—Ö±Ã∞Å…Ω›ÃÅÙÏ(ÄÅÙ((ÄÅÖÕÂπåÅ±•Õ—Aï…•ΩëÃ°ç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒ1ïëùï…Aï…•Ωëmt¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅM1PÅ%MQ%9PÅ—Ω}ç°Ö»°¡ï…•Ωë}ëÖ—î∞Äùeeedµ54ú§ÅLÅ¡ï…•Ωê(ÄÄÄÄÄÅI=4Ä†(ÄÄÄÄÄÄÄÅM1PÅëÖ—ï}•ÕºÅLÅ¡ï…•Ωë}ëÖ—îÅI=4Å›Ω…≠}ëÖÂÃÅ]!IÅç±ïÖπï…}•êÙêƒ(ÄÄÄÄÄÄÄÅU9%=8Å10(ÄÄÄÄÄÄÄÅM1PÅ¡ÖÂµïπ—}ëÖ—îÅLÅ¡ï…•Ωë}ëÖ—îÅI=4Å¡ÖÂµïπ—ÃÅ]!IÅç±ïÖπï…}•êÙêƒ(ÄÄÄÄÄÄ§Åïπ—…•ïÃ(ÄÄÄÄÄÅ=IHÅ	dÅ¡ï…•ΩêÅM(ÄÄÄÅÄ∞Åmç±ïÖπï…%ët§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›ÃπµÖ¿†°ÏÅ¡ï…•ΩêÅÙ§ÄÙ¯Ä°ÏÅ¡ï…•ΩêËÅM—…•πú°¡ï…•Ωê§∞Åô…Ω¥ËÅÄëÌ¡ï…•ΩëÙ¥¿≈Ä∞Å—ºËÅÄëÌ¡ï…•ΩëÙ¥Ã≈ÄÅÙ§§Ï(ÄÅÙ((ÄÅÖÕÂπåÅç…ïÖ—ïAÖÂµïπ–°ëÖ—ï%ÕºËÅÕ—…•πú∞ÅÖµΩ’π—ïπ—ÃËÅπ’µâï»∞ÅπΩ—î¸ËÅÕ—…•πú∞Åç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒAÖÂµïπ–¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†(ÄÄÄÄÄÄâ%9MIPÅ%9Q<Å¡ÖÂµïπ—ÃÄ°ç±ïÖπï…}•ê±¡ÖÂµïπ—}ëÖ—î±ÖµΩ’π—}çïπ—Ã±πΩ—î±ÕΩ’…çî§ÅY1ULÄ†ê–∞êƒ∞ê»∞êÃ∞ùµÖπ’Ö∞ú§ÅIQUI9%9Ä®à∞(ÄÄÄÄÄÅmëÖ—ï%Õº∞ÅÖµΩ’π—ïπ—Ã∞ÅπΩ—î¸π—…•¥†§ÅÒÅπ’±∞∞Åç±ïÖπï…%ët∞(ÄÄÄÄ§Ï(ÄÄÄÅ…ï—’…∏ÅµÖ¡AÖÂµïπ–°…ïÕ’±–π…Ω›Õl¡t§Ï(ÄÅÙ((ÄÅÖÕÂπåÅ’¡ëÖ—ïAÖÂµïπ–°•êËÅπ’µâï»∞ÅŸÖ±’ïÃËÅÏÅëÖ—ï%Õº¸ËÅÕ—…•πúÏÅÖµΩ’π—ïπ—Ã¸ËÅπ’µâï»ÏÅπΩ—î¸ËÅÕ—…•πúÅÅπ’±∞ÅÙ∞Åç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒAÖÂµïπ–ÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅUAQÅ¡ÖÂµïπ—ÃÅMPÅ¡ÖÂµïπ—}ëÖ—îı=1M†ê»±¡ÖÂµïπ—}ëÖ—î§∞ÅÖµΩ’π—}çïπ—Ãı=1M†êÃ±ÖµΩ’π—}çïπ—Ã§∞(ÄÄÄÄÄÄÄÅπΩ—îıMÅ]!8Äê–ËÈâΩΩ±ïÖ∏ÅQ!8Äê‘Å1MÅπΩ—îÅ9∞Å’¡ëÖ—ïë}Ö–ıπΩ‹†§(ÄÄÄÄÄÅ]!IÅ•êÙêƒÅ9Åç±ïÖπï…}•êÙêÿÅ9ÅÕΩ’…çîÙùµÖπ’Ö∞úÅIQUI9%9Ä®(ÄÄÄÅÄ∞Åm•ê∞ÅŸÖ±’ïÃπëÖ—ï%ÕºÄ¸¸Åπ’±∞∞ÅŸÖ±’ïÃπÖµΩ’π—ïπ—ÃÄ¸¸Åπ’±∞∞ÅŸÖ±’ïÃππΩ—îÄÑÙÙÅ’πëïô•πïê∞ÅŸÖ±’ïÃππΩ—î¸π—…•¥†§ÅÒÅπ’±∞∞Åç±ïÖπï…%ët§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡AÖÂµïπ–°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅëï±ï—ïAÖÂµïπ–°•êËÅπ’µâï»∞Åç±ïÖπï…%êÄÙÄƒ§ËÅA…Ωµ•ÕîÒâΩΩ±ïÖ∏¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†â1QÅI=4Å¡ÖÂµïπ—ÃÅ]!IÅ•êÙêƒÅ9Åç±ïÖπï…}•êÙê»Å9ÅÕΩ’…çîÙùµÖπ’Ö∞úà∞Åm•ê∞Åç±ïÖπï…%ët§Ï(ÄÄÄÅ…ï—’…∏Ä°…ïÕ’±–π…Ω›Ω’π–Ä¸¸Ä¿§Ä¯Ä¿Ï(ÄÅÙ((ÄÅÖÕÂπåÅùï—ç—•Ÿï¡Ö…—µïπ—Ã†§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ—mt¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âM1PÄ®ÅI=4ÅÖ¡Ö…—µïπ—ÃÅ]!IÅÖç—•Ÿîı—…’îÅ=IHÅ	dÅçÖπΩπ•çÖ±}πÖµîà§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›ÃπµÖ¿°µÖ¡¡Ö…—µïπ–§Ï(ÄÅÙ((ÄÅÖÕÂπåÅùï—¡Ö…—µïπ–°•êËÅπ’µâï»§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ–ÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âM1PÄ®ÅI=4ÅÖ¡Ö…—µïπ—ÃÅ]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’îà∞Åm•ët§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡¡Ö…—µïπ–°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅç…ïÖ—ï¡Ö…—µïπ–°•π¡’–ËÅ¡Ö…—µïπ—]…•—ï%π¡’–§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ–¯ÅÏ(ÄÄÄÅçΩπÕ–ÅçÖπΩπ•çÖ±-ï‰ÄÙÅÖ¡Ö…—µïπ—-ï‰°•π¡’–πçÖπΩπ•çÖ±9Öµî§Ï(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅ%9MIPÅ%9Q<ÅÖ¡Ö…—µïπ—ÃÄ°ÕΩ’…çï}≠ï‰±çÖπΩπ•çÖ±}≠ï‰±çÖπΩπ•çÖ±}πÖµî±Ö±•ÖÕïÃ±Öëë…ïÕÃ±µÖ¡Õ}’…∞±πΩ—ï}âΩë‰±±Ö—•—’ëî±±Ωπù•—’ëî±±ΩçÖ—•Ωπ}ÕΩ’…çî±±ΩçÖ—•Ωπ}Öçç’…ÖçÂ}µï—ï…Ã±Öç—•Ÿî§(ÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–ËÈ©ÕΩπà∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰∞êƒ¿∞êƒƒ±—…’î§ÅIQUI9%9Ä®(ÄÄÄÅÄ∞ÅmÅµÖπ’Ö∞ËëÌçÖπΩπ•çÖ±-ïÂÙËëÌÖ—îππΩ‹†•ıÄ∞ÅçÖπΩπ•çÖ±-ï‰∞Å•π¡’–πçÖπΩπ•çÖ±9Öµî∞Å)M=8πÕ—…•πù•ô‰°l∏∏ππï‹ÅMï–°m•π¡’–πçÖπΩπ•çÖ±9Öµî∞Ä∏∏π•π¡’–πÖ±•ÖÕïÕt•t§∞Å•π¡’–πÖëë…ïÕÃ∞Å•π¡’–πµÖ¡ÕU…∞∞Å•π¡’–ππΩ—ï	Ωë‰∞Å•π¡’–π±Ö—•—’ëî∞Å•π¡’–π±Ωπù•—’ëî∞Å•π¡’–π±ΩçÖ—•ΩπMΩ’…çî∞Å•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…Õt§Ï(ÄÄÄÅ…ï—’…∏ÅµÖ¡¡Ö…—µïπ–°…ïÕ’±–π…Ω›Õl¡t§Ï(ÄÅÙ((ÄÅÖÕÂπåÅ’¡ëÖ—ï¡Ö…—µïπ–°•êËÅπ’µâï»∞Å•π¡’–ËÅAÖ…—•Ö∞Ò¡Ö…—µïπ—]…•—ï%π¡’–¯§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ–ÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Åç’……ïπ–ÄÙÅÖ›Ö•–Å—°•Ãπùï—¡Ö…—µïπ–°•ê§ÏÅ•òÄ†Öç’……ïπ–§Å…ï—’…∏Åπ’±∞Ï(ÄÄÄÅçΩπÕ–ÅπÖµîÄÙÅ•π¡’–πçÖπΩπ•çÖ±9ÖµîÄ¸¸Åç’……ïπ–πçÖπΩπ•çÖ±9ÖµîÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅUAQÅÖ¡Ö…—µïπ—ÃÅMPÅçÖπΩπ•çÖ±}≠ï‰Ùê»±çÖπΩπ•çÖ±}πÖµîÙêÃ±Ö±•ÖÕïÃÙê–ËÈ©ÕΩπà±Öëë…ïÕÃÙê‘±µÖ¡Õ}’…∞Ùêÿ±πΩ—ï}âΩë‰Ùê‹∞(ÄÄÄÄÄÄÄÅ±Ö—•—’ëîÙê‡±±Ωπù•—’ëîÙê‰±±ΩçÖ—•Ωπ}ÕΩ’…çîÙêƒ¿±±ΩçÖ—•Ωπ}Öçç’…ÖçÂ}µï—ï…ÃÙêƒƒ±’¡ëÖ—ïë}Ö–ıπΩ‹†§(ÄÄÄÄÄÅ]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’îÅIQUI9%9Ä®(ÄÄÄÅÄ∞Åm•ê∞ÅÖ¡Ö…—µïπ—-ï‰°πÖµî§∞ÅπÖµî∞Å)M=8πÕ—…•πù•ô‰°•π¡’–πÖ±•ÖÕïÃÄ¸Ål∏∏ππï‹ÅMï–°mπÖµî∞Ä∏∏π•π¡’–πÖ±•ÖÕïÕt•tÄËÅç’……ïπ–πÖ±•ÖÕïÃ§∞Å•π¡’–πÖëë…ïÕÃÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–πÖëë…ïÕÃÄËÅ•π¡’–πÖëë…ïÕÃ∞Å•π¡’–πµÖ¡ÕU…∞ÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–πµÖ¡ÕU…∞ÄËÅ•π¡’–πµÖ¡ÕU…∞∞Å•π¡’–ππΩ—ï	Ωë‰ÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–ππΩ—ï	Ωë‰ÄËÅ•π¡’–ππΩ—ï	Ωë‰∞Å•π¡’–π±Ö—•—’ëîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±Ö—•—’ëîÄËÅ•π¡’–π±Ö—•—’ëî∞Å•π¡’–π±Ωπù•—’ëîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±Ωπù•—’ëîÄËÅ•π¡’–π±Ωπù•—’ëî∞Å•π¡’–π±ΩçÖ—•ΩπMΩ’…çîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±ΩçÖ—•ΩπMΩ’…çîÄËÅ•π¡’–π±ΩçÖ—•ΩπMΩ’…çî∞Å•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…ÃÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…ÃÄËÅ•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…Õt§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡¡Ö…—µïπ–°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅ•µ¡Ω…—¡Ö…—µïπ—Ã°…ïçΩ…ëÃËÅ¡Ö…—µïπ—%µ¡Ω…—%π¡’—mt∞Åë…ÂI’∏ËÅâΩΩ±ïÖ∏§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ—%µ¡Ω…—IïÕ’±–¯ÅÏ(ÄÄÄÅçΩπÕ–Åç±•ïπ–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞πçΩππïç–†§Ï(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ËÅ¡Ö…—µïπ—%µ¡Ω…—IïÕ’±–ÄÙÅÏÅç…ïÖ—ïêËÄ¿∞Å’¡ëÖ—ïêËÄ¿∞ÅÕ≠•¡¡ïêËÄ¿∞ÅçΩπô±•ç—ÃËÅmtÅÙÏ(ÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†â	%8à§Ï(ÄÄÄÄÄÅçΩπÕ–Åï·•Õ—•πùIïÕ’±–ÄÙÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†âM1PÄ®ÅI=4ÅÖ¡Ö…—µïπ—ÃÅ=HÅUAQà§Ï(ÄÄÄÄÄÅçΩπÕ–Åï·•Õ—•πúÄÙÅï·•Õ—•πùIïÕ’±–π…Ω›ÃπµÖ¿°µÖ¡¡Ö…—µïπ–§Ï(ÄÄÄÄÄÅôΩ»Ä°çΩπÕ–Å…ïçΩ…êÅΩòÅ…ïçΩ…ëÃ§ÅÏ(ÄÄÄÄÄÄÄÅçΩπÕ–ÅçÖπΩπ•çÖ±-ï‰ÄÙÅÖ¡Ö…—µïπ—-ï‰°…ïçΩ…êπçÖπΩπ•çÖ±9Öµî§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅâÂMΩ’…çîÄÙÅï·•Õ—•πúπô•πê†°•—ï¥§ÄÙ¯Å•—ï¥πÕΩ’…çï-ï‰ÄÙÙÙÅ…ïçΩ…êπÕΩ’…çï-ï‰§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅâÂÖπΩπ•çÖ∞ÄÙÅï·•Õ—•πúπô•πê†°•—ï¥§ÄÙ¯Å•—ï¥πçÖπΩπ•çÖ±-ï‰ÄÙÙÙÅçÖπΩπ•çÖ±-ï‰§Ï(ÄÄÄÄÄÄÄÅ•òÄ°âÂMΩ’…çîÄòòÅâÂÖπΩπ•çÖ∞ÄòòÅâÂMΩ’…çîπ•êÄÑÙÙÅâÂÖπΩπ•çÖ∞π•ê§ÅÏ(ÄÄÄÄÄÄÄÄÄÅ…ïÕ’±–πçΩπô±•ç—Ãπ¡’Õ†°ÏÅÕΩ’…çï-ï‰ËÅ…ïçΩ…êπÕΩ’…çï-ï‰∞Å…ïÖÕΩ∏ËÄâÕΩ’…çï}≠ïÂ}Öπë}çÖπΩπ•çÖ±}≠ïÂ}ë•ÕÖù…ïîàÅÙ§ÏÅçΩπ—•π’îÏ(ÄÄÄÄÄÄÄÅÙ(ÄÄÄÄÄÄÄÅçΩπÕ–Åç’……ïπ–ÄÙÅâÂMΩ’…çîÄ¸¸ÅâÂÖπΩπ•çÖ∞Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÖ±•ÖÕïÃÄÙÅl∏∏ππï‹ÅMï–°m…ïçΩ…êπçÖπΩπ•çÖ±9Öµî∞Ä∏∏π…ïçΩ…êπÖ±•ÖÕïÕtπµÖ¿†°ŸÖ±’î§ÄÙ¯ÅŸÖ±’îπ—…•¥†§§•tÏ(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÖ±•ÖÕ-ïÂÃÄÙÅπï‹ÅMï–°Ö±•ÖÕïÃπµÖ¿°Ö¡Ö…—µïπ—-ï‰§§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÖ±•ÖÕ=›πï»ÄÙÅï·•Õ—•πúπô•πê†°•—ï¥§ÄÙ¯Å•—ï¥π•êÄÑÙÙÅç’……ïπ–¸π•êÄòòÅm•—ï¥πçÖπΩπ•çÖ±9Öµî∞Ä∏∏π•—ï¥πÖ±•ÖÕïÕtπÕΩµî†°Ö±•ÖÃ§ÄÙ¯ÅÖ±•ÖÕ-ïÂÃπ°ÖÃ°Ö¡Ö…—µïπ—-ï‰°Ö±•ÖÃ§§§§Ï(ÄÄÄÄÄÄÄÅ•òÄ°Ö±•ÖÕ=›πï»§ÅÏÅ…ïÕ’±–πçΩπô±•ç—Ãπ¡’Õ†°ÏÅÕΩ’…çï-ï‰ËÅ…ïçΩ…êπÕΩ’…çï-ï‰∞Å…ïÖÕΩ∏ËÄâÖ±•ÖÕ}âï±ΩπùÕ}—Ω}ÖπΩ—°ï…}Ö¡Ö…—µïπ–àÅÙ§ÏÅçΩπ—•π’îÏÅÙ(ÄÄÄÄÄÄÄÅçΩπÕ–ÅçΩµ¡Ö…Öâ±îÄÙÅÏÅÕΩ’…çï-ï‰ËÅ…ïçΩ…êπÕΩ’…çï-ï‰∞ÅçÖπΩπ•çÖ±-ï‰∞ÅçÖπΩπ•çÖ±9ÖµîËÅ…ïçΩ…êπçÖπΩπ•çÖ±9Öµî∞ÅÖ±•ÖÕïÃ∞ÅÖëë…ïÕÃËÅ…ïçΩ…êπÖëë…ïÕÃ∞ÅµÖ¡ÕU…∞ËÅ…ïçΩ…êπµÖ¡ÕU…∞∞ÅπΩ—ï	Ωë‰ËÅ…ïçΩ…êππΩ—ï	Ωë‰∞Å±Ö—•—’ëîËÅ…ïçΩ…êπ±Ö—•—’ëîÄ¸¸Åç’……ïπ–¸π±Ö—•—’ëîÄ¸¸Åπ’±∞∞Å±Ωπù•—’ëîËÅ…ïçΩ…êπ±Ωπù•—’ëîÄ¸¸Åç’……ïπ–¸π±Ωπù•—’ëîÄ¸¸Åπ’±∞∞ÅÖç—•ŸîËÅ…ïçΩ…êπÖç—•ŸîÅÙÏ(ÄÄÄÄÄÄÄÅ•òÄ°ç’……ïπ–ÄòòÅ)M=8πÕ—…•πù•ô‰°ÏÅÕΩ’…çï-ï‰ËÅç’……ïπ–πÕΩ’…çï-ï‰∞ÅçÖπΩπ•çÖ±-ï‰ËÅç’……ïπ–πçÖπΩπ•çÖ±-ï‰∞ÅçÖπΩπ•çÖ±9ÖµîËÅç’……ïπ–πçÖπΩπ•çÖ±9Öµî∞ÅÖ±•ÖÕïÃËÅç’……ïπ–πÖ±•ÖÕïÃ∞ÅÖëë…ïÕÃËÅç’……ïπ–πÖëë…ïÕÃ∞ÅµÖ¡ÕU…∞ËÅç’……ïπ–πµÖ¡ÕU…∞∞ÅπΩ—ï	Ωë‰ËÅç’……ïπ–ππΩ—ï	Ωë‰∞Å±Ö—•—’ëîËÅç’……ïπ–π±Ö—•—’ëî∞Å±Ωπù•—’ëîËÅç’……ïπ–π±Ωπù•—’ëî∞ÅÖç—•ŸîËÅç’……ïπ–πÖç—•ŸîÅÙ§ÄÙÙÙÅ)M=8πÕ—…•πù•ô‰°çΩµ¡Ö…Öâ±î§§ÅÏ(ÄÄÄÄÄÄÄÄÄÅ…ïÕ’±–πÕ≠•¡¡ïêÄ¨ÙÄƒÏÅçΩπ—•π’îÏ(ÄÄÄÄÄÄÄÅÙ(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÕÖŸïêÄÙÅç’……ïπ–(ÄÄÄÄÄÄÄÄÄÄ¸ÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰°ÅUAQÅÖ¡Ö…—µïπ—ÃÅMPÅÕΩ’…çï}≠ï‰Ùê»∞ÅçÖπΩπ•çÖ±}≠ï‰ÙêÃ∞ÅçÖπΩπ•çÖ±}πÖµîÙê–∞ÅÖ±•ÖÕïÃÙê‘ËÈ©ÕΩπà∞ÅÖëë…ïÕÃÙêÿ∞ÅµÖ¡Õ}’…∞Ùê‹∞ÅπΩ—ï}âΩë‰Ùê‡∞Å±Ö—•—’ëîÙê‰∞Å±Ωπù•—’ëîÙêƒ¿∞Å±ΩçÖ—•Ωπ}ÕΩ’…çîıMÅ]!8Äê‰ËÈëΩ’â±îÅ¡…ïç•Õ•Ω∏Å%LÅ9U10ÅQ!8Å±ΩçÖ—•Ωπ}ÕΩ’…çîÅ1MÄù•µ¡Ω…–úÅ9∞ÅÖç—•ŸîÙêƒƒ∞Å’¡ëÖ—ïë}Ö–ıπΩ‹†§Å]!IÅ•êÙêƒÅIQUI9%9Ä©Ä∞Åmç’……ïπ–π•ê∞Å…ïçΩ…êπÕΩ’…çï-ï‰∞ÅçÖπΩπ•çÖ±-ï‰∞Å…ïçΩ…êπçÖπΩπ•çÖ±9Öµî∞Å)M=8πÕ—…•πù•ô‰°Ö±•ÖÕïÃ§∞Å…ïçΩ…êπÖëë…ïÕÃ∞Å…ïçΩ…êπµÖ¡ÕU…∞∞Å…ïçΩ…êππΩ—ï	Ωë‰∞Å…ïçΩ…êπ±Ö—•—’ëîÄ¸¸Åç’……ïπ–π±Ö—•—’ëî∞Å…ïçΩ…êπ±Ωπù•—’ëîÄ¸¸Åç’……ïπ–π±Ωπù•—’ëî∞Å…ïçΩ…êπÖç—•Ÿït§(ÄÄÄÄÄÄÄÄÄÄËÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰°Å%9MIPÅ%9Q<ÅÖ¡Ö…—µïπ—ÃÄ°ÕΩ’…çï}≠ï‰∞ÅçÖπΩπ•çÖ±}≠ï‰∞ÅçÖπΩπ•çÖ±}πÖµî∞ÅÖ±•ÖÕïÃ∞ÅÖëë…ïÕÃ∞ÅµÖ¡Õ}’…∞∞ÅπΩ—ï}âΩë‰∞Å±Ö—•—’ëî∞Å±Ωπù•—’ëî∞Å±ΩçÖ—•Ωπ}ÕΩ’…çî∞ÅÖç—•Ÿî§ÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–ËÈ©ÕΩπà∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰±MÅ]!8Äê‡ËÈëΩ’â±îÅ¡…ïç•Õ•Ω∏Å%LÅ9U10ÅQ!8Å9U10Å1MÄù•µ¡Ω…–úÅ9∞êƒ¿§ÅIQUI9%9Ä©Ä∞Åm…ïçΩ…êπÕΩ’…çï-ï‰∞ÅçÖπΩπ•çÖ±-ï‰∞Å…ïçΩ…êπçÖπΩπ•çÖ±9Öµî∞Å)M=8πÕ—…•πù•ô‰°Ö±•ÖÕïÃ§∞Å…ïçΩ…êπÖëë…ïÕÃ∞Å…ïçΩ…êπµÖ¡ÕU…∞∞Å…ïçΩ…êππΩ—ï	Ωë‰∞Å…ïçΩ…êπ±Ö—•—’ëîÄ¸¸Åπ’±∞∞Å…ïçΩ…êπ±Ωπù•—’ëîÄ¸¸Åπ’±∞∞Å…ïçΩ…êπÖç—•Ÿït§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅµÖ¡¡ïêÄÙÅµÖ¡¡Ö…—µïπ–°ÕÖŸïêπ…Ω›Õl¡t§Ï(ÄÄÄÄÄÄÄÅ•òÄ°ç’……ïπ–§ÅÏÅï·•Õ—•πúπÕ¡±•çî°ï·•Õ—•πúπ•πëï·=ò°ç’……ïπ–§∞Äƒ∞ÅµÖ¡¡ïê§ÏÅ…ïÕ’±–π’¡ëÖ—ïêÄ¨ÙÄƒÏÅÙ(ÄÄÄÄÄÄÄÅï±ÕîÅÏÅï·•Õ—•πúπ¡’Õ†°µÖ¡¡ïê§ÏÅ…ïÕ’±–πç…ïÖ—ïêÄ¨ÙÄƒÏÅÙ(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅ•òÄ°ë…ÂI’∏§ÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†âI=11	,à§ÏÅï±ÕîÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†â=55%Pà§Ï(ÄÄÄÄÄÅ…ï—’…∏Å…ïÕ’±–Ï(ÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏÅÖ›Ö•–Åç±•ïπ–π≈’ï…‰†âI=11	,à§ÏÅ—°…Ω‹Åï……Ω»ÏÅÙ(ÄÄÄÅô•πÖ±±‰ÅÏÅç±•ïπ–π…ï±ïÖÕî†§ÏÅÙ(ÄÅÙ(((ÄÅÖÕÂπåÅùï—MÖŸïëA±ÖçïÃ†§ËÅA…Ωµ•ÕîÒMÖŸïëA±Öçïmt¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âM1PÄ®ÅI=4ÅÕÖŸïë}¡±ÖçïÃÅ]!IÅÖç—•Ÿîı—…’îÅ=IHÅ	dÅπÖµîà§ÏÅ…ï—’…∏Å…ïÕ’±–π…Ω›ÃπµÖ¿°µÖ¡MÖŸïëA±Öçî§Ï(ÄÅÙ((ÄÅÖÕÂπåÅùï—MÖŸïëA±Öçî°•êËÅπ’µâï»§ËÅA…Ωµ•ÕîÒMÖŸïëA±ÖçîÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âM1PÄ®ÅI=4ÅÕÖŸïë}¡±ÖçïÃÅ]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’îà∞Åm•ët§ÏÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡MÖŸïëA±Öçî°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅç…ïÖ—ïMÖŸïëA±Öçî°•π¡’–ËÅMÖŸïëA±Öçï]…•—ï%π¡’–§ËÅA…Ωµ•ÕîÒMÖŸïëA±Öçî¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅ%9MIPÅ%9Q<ÅÕÖŸïë}¡±ÖçïÃÄ°≠•πê±πÖµî±Öëë…ïÕÃ±πΩ—î±µÖ¡Õ}’…∞±±Ö—•—’ëî±±Ωπù•—’ëî±±ΩçÖ—•Ωπ}ÕΩ’…çî±±ΩçÖ—•Ωπ}Öçç’…ÖçÂ}µï—ï…Ã±ΩÕµ}—Â¡î±ΩÕµ}•ê§(ÄÄÄÄÄÅY1ULÄ†êƒ∞ê»∞êÃ∞ê–∞ê‘∞êÿ∞ê‹∞ê‡∞ê‰∞êƒ¿∞êƒƒ§(ÄÄÄÄÄÅ=8Å=91%PÄ°ΩÕµ}—Â¡î±ΩÕµ}•ê§Å]!IÅΩÕµ}—Â¡îÅ%LÅ9=PÅ9U10Å9ÅΩÕµ}•êÅ%LÅ9=PÅ9U10Å<ÅUAQÅMPÅÖç—•Ÿîı—…’î±’¡ëÖ—ïë}Ö–ıπΩ‹†§(ÄÄÄÄÄÅIQUI9%9Ä®(ÄÄÄÅÄ∞Åm•π¡’–π≠•πê∞Å•π¡’–ππÖµî∞Å•π¡’–πÖëë…ïÕÃ∞Å•π¡’–ππΩ—î∞Å•π¡’–πµÖ¡ÕU…∞∞Å•π¡’–π±Ö—•—’ëî∞Å•π¡’–π±Ωπù•—’ëî∞Å•π¡’–π±ΩçÖ—•ΩπMΩ’…çî∞Å•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…Ã∞Å•π¡’–πΩÕµQÂ¡îÄ¸¸Åπ’±∞∞Å•π¡’–πΩÕµ%êÄ¸¸Åπ’±±t§Ï(ÄÄÄÅ…ï—’…∏ÅµÖ¡MÖŸïëA±Öçî°…ïÕ’±–π…Ω›Õl¡t§Ï(ÄÅÙ((ÄÅÖÕÂπåÅ’¡ëÖ—ïMÖŸïëA±Öçî°•êËÅπ’µâï»∞Å•π¡’–ËÅAÖ…—•Ö∞ÒMÖŸïëA±Öçï]…•—ï%π¡’–¯§ËÅA…Ωµ•ÕîÒMÖŸïëA±ÖçîÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Åç’……ïπ–ÄÙÅÖ›Ö•–Å—°•Ãπùï—MÖŸïëA±Öçî°•ê§ÏÅ•òÄ†Öç’……ïπ–§Å…ï—’…∏Åπ’±∞Ï(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°ÅUAQÅÕÖŸïë}¡±ÖçïÃÅMPÅ≠•πêÙê»±πÖµîÙêÃ±Öëë…ïÕÃÙê–±πΩ—îÙê‘±µÖ¡Õ}’…∞Ùêÿ±±Ö—•—’ëîÙê‹±±Ωπù•—’ëîÙê‡±±ΩçÖ—•Ωπ}ÕΩ’…çîÙê‰±±ΩçÖ—•Ωπ}Öçç’…ÖçÂ}µï—ï…ÃÙêƒ¿±’¡ëÖ—ïë}Ö–ıπΩ‹†§Å]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’îÅIQUI9%9Ä©Ä∞Åm•ê∞Å•π¡’–π≠•πêÄ¸¸Åç’……ïπ–π≠•πê∞Å•π¡’–ππÖµîÄ¸¸Åç’……ïπ–ππÖµî∞Å•π¡’–πÖëë…ïÕÃÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–πÖëë…ïÕÃÄËÅ•π¡’–πÖëë…ïÕÃ∞Å•π¡’–ππΩ—îÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–ππΩ—îÄËÅ•π¡’–ππΩ—î∞Å•π¡’–πµÖ¡ÕU…∞ÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–πµÖ¡ÕU…∞ÄËÅ•π¡’–πµÖ¡ÕU…∞∞Å•π¡’–π±Ö—•—’ëîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±Ö—•—’ëîÄËÅ•π¡’–π±Ö—•—’ëî∞Å•π¡’–π±Ωπù•—’ëîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±Ωπù•—’ëîÄËÅ•π¡’–π±Ωπù•—’ëî∞Å•π¡’–π±ΩçÖ—•ΩπMΩ’…çîÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±ΩçÖ—•ΩπMΩ’…çîÄËÅ•π¡’–π±ΩçÖ—•ΩπMΩ’…çî∞Å•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…ÃÄÙÙÙÅ’πëïô•πïêÄ¸Åç’……ïπ–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…ÃÄËÅ•π¡’–π±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…Õt§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡MÖŸïëA±Öçî°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅÖ…ç°•ŸïMÖŸïëA±Öçî°•êËÅπ’µâï»§ËÅA…Ωµ•ÕîÒâΩΩ±ïÖ∏¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âUAQÅÕÖŸïë}¡±ÖçïÃÅMPÅÖç—•ŸîıôÖ±Õî±’¡ëÖ—ïë}Ö–ıπΩ‹†§Å]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’îà∞Åm•ët§ÏÅ…ï—’…∏Ä°…ïÕ’±–π…Ω›Ω’π–Ä¸¸Ä¿§Ä¯Ä¿Ï(ÄÅÙ((ÄÅÖÕÂπåÅô•πëMÖŸïëA±Öçï	Â=Õ¥°ΩÕµQÂ¡îËÅ9Ωπ9’±±Öâ±îÒMÖŸïëA±ÖçïlâΩÕµQÂ¡îât¯∞ÅΩÕµ%êËÅÕ—…•πú§ËÅA…Ωµ•ÕîÒMÖŸïëA±ÖçîÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰†âM1PÄ®ÅI=4ÅÕÖŸïë}¡±ÖçïÃÅ]!IÅΩÕµ}—Â¡îÙêƒÅ9ÅΩÕµ}•êÙê»Å9ÅÖç—•Ÿîı—…’îà∞ÅmΩÕµQÂ¡î∞ÅΩÕµ%ët§ÏÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡MÖŸïëA±Öçî°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅùï—A…ïôï……ïë1Ö’πë…‰°Ö¡Ö…—µïπ—%êËÅπ’µâï»§ËÅA…Ωµ•ÕîÒMÖŸïëA±ÖçîÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°ÅM1PÅ¡±Öçî∏®ÅI=4ÅÖ¡Ö…—µïπ—}¡±Öçï}±•π≠ÃÅ±•π¨Å)=%8ÅÕÖŸïë}¡±ÖçïÃÅ¡±ÖçîÅ=8Å¡±Öçîπ•êı±•π¨π¡±Öçï}•êÅ]!IÅ±•π¨πÖ¡Ö…—µïπ—}•êÙêƒÅ9Å±•π¨π¡…ïôï……ïêı—…’îÅ9Å¡±ÖçîπÖç—•Ÿîı—…’ïÄ∞ÅmÖ¡Ö…—µïπ—%ët§Ï(ÄÄÄÅ…ï—’…∏Å…ïÕ’±–π…Ω›Õl¡tÄ¸ÅµÖ¡MÖŸïëA±Öçî°…ïÕ’±–π…Ω›Õl¡t§ÄËÅπ’±∞Ï(ÄÅÙ((ÄÅÖÕÂπåÅÕï—A…ïôï……ïë1Ö’πë…‰°Ö¡Ö…—µïπ—%êËÅπ’µâï»∞Å¡±Öçï%êËÅπ’µâï»§ËÅA…Ωµ•ÕîÒ¡Ö…—µïπ—A±Öçï1•π¨ÅÅπ’±∞¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å—°•Ãπ¡ΩΩ∞π≈’ï…‰°Ä(ÄÄÄÄÄÅ%9MIPÅ%9Q<ÅÖ¡Ö…—µïπ—}¡±Öçï}±•π≠ÃÄ°Ö¡Ö…—µïπ—}•ê±¡±Öçï}•ê±¡…ïôï……ïê§ÅM1PÄêƒ∞ê»±—…’î(ÄÄÄÄÄÅ]!IÅa%MQLÄ°M1PÄƒÅI=4ÅÖ¡Ö…—µïπ—ÃÅ]!IÅ•êÙêƒÅ9ÅÖç—•Ÿîı—…’î§(ÄÄÄÄÄÄÄÅ9Åa%MQLÄ°M1PÄƒÅI=4ÅÕÖŸïë}¡±ÖçïÃÅ]!IÅ•êÙê»Å9Å≠•πêÙù±Ö’πë…‰úÅ9ÅÖç—•Ÿîı—…’î§(ÄÄÄÄÄÅ=8Å=91%PÄ°Ö¡Ö…—µïπ—}•ê§Å<ÅUAQÅMPÅ¡±Öçï}•êıa1Uπ¡±Öçï}•ê±¡…ïôï……ïêı—…’î±’¡ëÖ—ïë}Ö–ıπΩ‹†§(ÄÄÄÄÄÅIQUI9%9Ä®(ÄÄÄÅÄ∞ÅmÖ¡Ö…—µïπ—%ê∞Å¡±Öçï%ët§Ï(ÄÄÄÅçΩπÕ–Å…Ω‹ÄÙÅ…ïÕ’±–π…Ω›Õl¡tÏÅ…ï—’…∏Å…Ω‹Ä¸ÅÏÅÖ¡Ö…—µïπ—%êËÅ9’µâï»°…Ω‹πÖ¡Ö…—µïπ—}•ê§∞Å¡±Öçï%êËÅ9’µâï»°…Ω‹π¡±Öçï}•ê§∞Å¡…ïôï……ïêËÅ	ΩΩ±ïÖ∏°…Ω‹π¡…ïôï……ïê§∞Åç…ïÖ—ïë–ËÅπï‹ÅÖ—î°M—…•πú°…Ω‹πç…ïÖ—ïë}Ö–§§π—Ω%M=M—…•πú†§∞Å’¡ëÖ—ïë–ËÅπï‹ÅÖ—î°M—…•πú°…Ω‹π’¡ëÖ—ïë}Ö–§§π—Ω%M=M—…•πú†§ÅÙÄËÅπ’±∞Ï(ÄÅÙ)Ù