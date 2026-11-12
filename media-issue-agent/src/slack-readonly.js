// Public media labels shared with the research reply drafter.
import { redactText } from "./redact.js";

// Preserve extracted time scopes without inventing a calendar limit or a
// default window. The newest message remains authoritative when extraction is
// absent or contradictory; the research worker resolves it from conversation.
export function publicResearchTimeframe(value = {}) {
  if (!value || typeof value !== "object") return {};
  const periods = ["periodDays", "periodMonths", "periodYears"].filter(key => value[key] != null);
  const hasDates = value.startDate != null || value.endDate != null;
  const modes = Number(value.allTime === true) + periods.length + Number(hasDates);
  if (modes !== 1) return {};
  if (value.allTime === true) return { allTime: true };
  if (periods.length) {
    const key = periods[0];
    return Number.isSafeInteger(value[key]) && value[key] > 0 ? { [key]: value[key] } : {};
  }
  const result = {};
  for (const key of ["startDate", "endDate"]) {
    if (value[key] == null) continue;
    const date = value[key];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || date.startsWith("0000") || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return {};
    result[key] = date;
  }
  if (result.startDate && result.endDate && result.startDate > result.endDate) return {};
  return result;
}

export function publicMediaTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().slice(0, 200);
  if (!title || redactText(title) !== title || /[<>@\\/\r\n]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[A-Z0-9]{12,}\b/.test(title)) return undefined;
  return title;
}
