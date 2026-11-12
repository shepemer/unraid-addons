// Public labels and workflow state shared with the research reply drafter.
import { redactText } from "./redact.js";

export function publicMediaTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().slice(0, 200);
  if (!title || redactText(title) !== title || /[<>@\\/\r\n]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[A-Z0-9]{12,}\b/.test(title)) return undefined;
  return title;
}


export function publicSlackInvestigationSummary(details = {}) {
  const approval = (details.approvals || []).find(item => item.kind === "action" && item.status === "pending");
  const classification = approval?.payload?.plan?.classification;
  const state = String(details.job?.state || "");
  const result = { state: ["detected", "queued_for_investigation", "investigating", "awaiting_action_approval", "approved_for_execution", "executing", "drafting_comment", "awaiting_resolution_approval", "closed", "failed_retryable", "failed_terminal", "blocked_needs_human"].includes(state) ? state : "unknown" };
  if (["server_action", "client_side"].includes(classification)) result.classification = classification;
  result.nextStep = state === "awaiting_action_approval" ? classification === "client_side" ? "owner_review_client_guidance" : "owner_approve_repair"
    : state === "awaiting_resolution_approval" ? "owner_approve_resolution"
      : ["failed_retryable", "failed_terminal", "blocked_needs_human"].includes(state) ? "owner_reinvestigate_or_steer"
        : state === "closed" ? "complete" : "wait_for_investigation_or_repair";
  // Include only facts already emitted by this module, never raw investigation prose.
  return result;
}
