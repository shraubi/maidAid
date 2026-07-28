import { formatHours, formatMoneyCompact } from "./format.js";
import type { LedgerTotals, ParsedDay, ReportSnapshot, Settings } from "./types.js";
import { calculateDay, calculateJobIncome } from "./calculations.js";

const emptyTotals = (): LedgerTotals => ({
  minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0,
  expensesCents: 0, checkinCents: 0,
});

function summaryLine(label: string, totals: LedgerTotals): string {
  const parts = [`${formatHours(totals.minutes).replace("h", " h")}`];
  if (totals.expensesCents > 0) parts.push(`${formatMoneyCompact(totals.expensesCents)} расходы`);
  if (totals.checkinCents > 0) parts.push(`${formatMoneyCompact(totals.checkinCents)} check in`);
  return `${label} : ${parts.join(" + ")}`;
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
  for (const job of day.jobs) {
    if (job.workType === "checkin") {
      workLines.push(`Check in ${formatMoneyCompact(calculateJobIncome(job, settings))}`);
      continue;
    }
    const minutes = job.startMinutes !== null && job.endMinutes !== null ? job.endMinutes - job.startMinutes : 0;
    const parts = [formatHours(minutes)];
    const jobExpenses = day.expenses.filter((expense) => expense.object === job.object && expense.amountCents > 0);
    parts.push(...jobExpenses.map((expense) => `${formatMoneyCompact(expense.amountCents)} ${expense.category}`));
    if (job.workType === "orientation" || job.workType === "practice") {
      parts.push(formatMoneyCompact(calculateJobIncome(job, settings)));
    }
    workLines.push(`${job.object}\n${parts.join(" + ")}`);
  }
  const unmatched = day.expenses.filter((expense) => !expense.object || !day.jobs.some((job) => job.object === expense.object));
  if (unmatched.length) workLines.push(unmatched.map((expense) => `${formatMoneyCompact(expense.amountCents)} ${expense.category}`).join(" + "));

  const result = [
    day.displayDate ?? day.dateIso ?? "", "", workLines.join("\n\n"), "",
    summaryLine("Было", report.previous), "",
    summaryLine("Всего", report.total), "",
    `Оплата наличными: ${formatMoneyCompact(report.total.earnedCents)}`,
    `Аванс: ${formatMoneyCompact(report.total.receivedCents)}`,
  ];
  if (day.advanceCents > 0) {
    result.push(`Аванс сегодня: ${formatMoneyCompact(day.advanceCents)}`);
    result.push(`Остаток: ${formatMoneyCompact(report.total.outstandingCents)}`);
  }
  return result.join("\n");
}
