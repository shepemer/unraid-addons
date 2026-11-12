// Public media labels shared with the research reply drafter.
import { redactText } from "./redact.js";

export function publicMediaTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().slice(0, 200);
  if (!title || redactText(title) !== title || /[<>@\\/\r\n]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[A-Z0-9]{12,}\b/.test(title)) return undefined;
  return title;
}
