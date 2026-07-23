import type { DayTotals, Job, ParsedDay, Settings } from "./types.js";

export function calculateJobIncome(job: Job, settings: Settings): number {
  if (job.workType === "orientation") return settings.orientationFlatCents;
  if (job.workType === "practice") return settings.practiceFlatCents;
  if (
    job.workType !== "independent" ||
    job.startMinutes === null ||
    job.endMinutes === null
  ) {
    return 0;
  }
  return Math.round(((job.endMinutes - job.startMinutes) * settings.hourlyRateCents) / 60);
}

export function calculateDay(day: ParsedDay, settings: Settings): DayTotals {
  const minutes = day.jobs.reduce((sum, job) => {
    if (job.startMinutes === null || job.endMinutes === null) return sum;
    return sum + (job.endMinutes - job.startMinutes);
  }, 0);

  return {
    minutes,
    incomeCents: day.jobs.reduce(
      (sum, job) => sum + calculateJobIncome(job, settings),
      0,
    ),
    expensesCents: day.expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}
