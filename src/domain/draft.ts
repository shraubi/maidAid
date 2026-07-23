import { formatHours, formatMoney, formatTime, workTypeLabel } from "./format.js";
import type { ParsedDay, Settings } from "./types.js";
import { calculateDay, calculateJobIncome } from "./calculations.js";

export function formatParsedDay(day: ParsedDay): string {
  const jobs = day.jobs.map((job) => {
    const inferred = job.endInferred ? " (окончание выведено из следующей работы)" : "";
    const companion = job.companion ? ` (${job.companion})` : "";
    return `${job.object} ${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)} — ${workTypeLabel(job.workType)}${companion}${inferred}`;
  });
  const expenses = day.expenses.map(
    (expense) =>
      `${expense.category.charAt(0).toUpperCase() + expense.category.slice(1)}${expense.object ? ` ${expense.object}` : ""}: ${formatMoney(expense.amountCents)}`,
  );
  const unknown = day.unparsedLines.length
    ? ["", "Не распознано:", ...day.unparsedLines.map((line) => `• ${line}`)]
    : [];
  return ["Я понял так:", "", ...jobs, ...(expenses.length ? ["", ...expenses] : []), ...unknown].join(
    "\n",
  );
}

export function generateShareText(day: ParsedDay, settings: Settings): string {
  const today = calculateDay(day, settings);
  const changed = day.kind === "actual" ? " изменения" : "";
  const scheduleLines = day.jobs.map((job) => {
    const companion = job.companion ? ` (${job.companion})` : "";
    const action = `${workTypeLabel(job.workType)}${companion}`;
    return `${job.object} ${formatTime(job.startMinutes)}-${formatTime(job.endMinutes)} ${action}`;
  });
  const workLines = day.jobs.map((job) => {
    const minutes =
      job.startMinutes !== null && job.endMinutes !== null ? job.endMinutes - job.startMinutes : 0;
    const income = calculateJobIncome(job, settings);
    const jobExpenses = day.expenses.filter((expense) => expense.object === job.object);
    const expenseText = jobExpenses.length
      ? jobExpenses.map((expense) => `${formatMoney(expense.amountCents)} ${expense.category}`).join(", ")
      : "0€";
    return `${job.object} ${formatHours(minutes)} + ${expenseText} + ${formatMoney(income)}`;
  });

  return [
    `${day.displayDate ?? day.dateIso}${changed}`,
    "",
    ...scheduleLines,
    "",
    day.displayDate ?? day.dateIso ?? "",
    "",
    ...workLines,
    "",
    `Сегодня: ${formatHours(today.minutes)} + ${formatMoney(today.incomeCents)} заработок + ${formatMoney(today.expensesCents)} расходы`,
    "",
    "Оплата наличными:",
    "",
    "Аванс:",
  ].join("\n");
}
