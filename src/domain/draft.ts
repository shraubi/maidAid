import { formatHours, formatMoneyCompact } from "./format.js";
import type { LedgerTotals, ParsedDay, ReportSnapshot, Settings } from "./types.js";
import { calculateDay, calculateJobIncome, jobMinutes } from "./calculations.js";

const emptyTotals = (): LedgerTotals => ({
  minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0,
  expensesCents: 0, checkinCents: 0,
});

function summaryLine(label: string, totals: LedgerTotals): string {
  const parts = [`${formatHours(totals.minutes).replace("h", " h")}`];
  parts.push(totals.expensesCents > 0 ? `${formatMoneyCompact(totals.expensesCents)} расходы` : "0€");
  if (totals.checkinCents > 0) parts.push(`${formatMoneyCompact(totals.checkinCents)} check in`);
  return `${label}: ${parts.join(" + ")}`;
}

export function generateShareText(day: ParsedDay, settings: Settings, snapshot?: ReportSnapshot): string {
  const today = calculateDay(day, settings);
  const fallbackTotal: LedgerTotals = {
    minutes: today.minutes,
    earnedCents: today.incomeCents,
    receivedCents: day.advanceCents,
    outstandingCents: today.incomeCents - day.advanceCents,
    expensesCents: today.expensesCents,
    checkinCents: today.checkinCents,
  };
  const report = snapshot ?? { previous: emptyTotals(), total: fallbackTotal };
  const workLines: string[] = [];
  for (const [jobIndex, job] of day.jobs.entries()) {
    if (job.workType === "checkin") {
      workLines.push(`Check in ${formatMoneyCompact(calculateJobIncome(job, settings))}`);
      continue;
    }
    const minutes = jobMinutes(job);
    const jobExpenses = day.expenses.filter((expense) => (expense.jobIndex === jobIndex || (expense.jobIndex == null && expense.object === job.object)) && expense.amountCents > 0);
    const dryerCents = jobExpenses.filter((expense) => expense.category === "сушка").reduce((sum, expense) => sum + expense.amountCents, 0);
    const otherCents = jobExpenses.filter((expense) => expense.category !== "сушка").reduce((sum, expense) => sum + expense.amountCents, 0);
    const dryer = dryerCents > 0 ? `${formatMoneyCompact(dryerCents)} сушка` : "0";
    const other = otherCents > 0 ? `${formatMoneyCompact(otherCents)} расходы` : "0";
    workLines.push(`${job.object} ${formatHours(minutes)} + ${dryer} + ${other}`);
  }
  const unmatched = day.expenses.filter((expense) => expense.jobIndex == null && (!expense.object || !day.jobs.some((job) => job.object === expense.object)));
  if (unmatched.length) workLines.push(unmatched.map((expense) => `${formatMoneyCompact(expense.amountCents)} ${expense.category}`).join(" + "));

  const receivedToday = Math.max(0, report.total.receivedCents - report.previous.receivedCents);
  const result = [day.displayDate ?? day.dateIso ?? "", workLines.join("\n"), "",
    summaryLine("Сегодня", { ...emptyTotals(), minutes: today.minutes, earnedCents: today.incomeCents,
      expensesCents: today.expensesCents, checkinCents: today.checkinCents }), "",
    summaryLine("Было", report.previous), "",
    summaryLine("Всего", report.total), "",
    `Оплата наличными:${receivedToday > 0 ? ` ${formatMoneyCompact(receivedToday)}` : ""}`,
    `Аванс: ${formatMoneyCompact(report.total.receivedCents)}`];
  return result.join("\n");
}

