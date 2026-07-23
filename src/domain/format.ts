export function formatTime(minutes: number | null): string {
  if (minutes === null) return "?";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(2).replace(/0$/, "")}h`;
}

export function formatMoney(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")}€`;
}

export function workTypeLabel(
  type: "independent" | "orientation" | "practice" | "unknown",
): string {
  if (type === "independent") return "Самостоятельная уборка";
  if (type === "orientation") return "Ознакомление";
  if (type === "practice") return "Практика";
  return "Тип не указан";
}
