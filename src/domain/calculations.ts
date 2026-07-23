import type { DayTotals, ParsedDay, Settings } from "./types.js";

export function calculateDay(day: ParsedDay, settings: Settings): DayTotals {
  const minutes = day.jobs.reduce((sum, job) => {
    if (job.startMinutes === null || job.endMinutes === null) return sum;
    return sum + (job.endMinutes - job.startMinutes);
  }, 0);

  return {
    minutes,
    incomeCents: Math.round((minutes * settings.hourlyRateCents) / 60),
    expensesCents: day.expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}
