import type { DayTotals, Job, ParsedDay, Settings } from "./types.js";

export function jobMinutes(job: Job): number {
  if (job.durationMinutes !== null) return job.durationMinutes;
  return job.startMinutes !== null && job.endMinutes !== null ? job.endMinutes - job.startMinutes : 0;
}

export function calculateJobIncome(job: Job, settings: Settings): number {
  if (job.workType === "checkin") return settings.checkinFlatCents;
  if (job.workType === "orientation") return settings.orientationFlatCents;
  if (job.workType === "practice") return settings.practiceFlatCents;
  if (job.workType !== "independent") return 0;
  return Math.round((jobMinutes(job) * settings.hourlyRateCents) / 60);
}

export function calculateDay(day: ParsedDay, settings: Settings): DayTotals {
  const minutes = day.jobs.reduce((sum, job) => {
    return job.workType === "independent" ? sum + jobMinutes(job) : sum;
  }, 0);
  const checkinCents = day.jobs
    .filter((job) => job.workType === "checkin")
    .reduce((sum, job) => sum + calculateJobIncome(job, settings), 0);
  return {
    minutes,
    incomeCents: day.jobs.reduce((sum, job) => sum + calculateJobIncome(job, settings), 0),
    checkinCents,
    expensesCents: day.expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}

