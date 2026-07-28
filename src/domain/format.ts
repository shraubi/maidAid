export function formatTime(minutes: number | null): string {
  if (minutes === null) return "?";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatHours(minutes: number): string {
  const value = String(Number((minutes / 60).toFixed(2)));
  return `${value}h`;
}

export function formatMoney(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")}€`;
}

export function formatMoneyCompact(cents: number): string {
  const value = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return `${value}€`;
}

export function workTypeLabel(type: "independent" | "orientation" | "practice" | "checkin" | "unknown"): string {
  if (type === "independent") return "Самостоятельная уборка";
  if (type === "orientation") return "Ознакомление";
  if (type === "practice") return "Практика";
  if (type === "checkin") return "Check in";
  return "Тип не указан";
}
