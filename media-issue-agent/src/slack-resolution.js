// Public resolution review is built from controlled labels and bounded counts.
// Never publish the private execution summary, action prose, or draft comment.
const OUTCOMES = Object.freeze({
  fixed: "The repair reports the issue fixed.",
  partially_fixed: "The repair reports the issue partially fixed.",
  not_reproducible: "The reported problem could not be reproduced.",
  client_side: "The issue was classified as client-side; no server-side repair was needed.",
  needs_operator_decision: "The repair needs an owner decision.",
  failed_retryable: "The repair failed and can be retried.",
  failed_terminal: "The repair failed and needs owner guidance."
});
const VERIFICATION = Object.freeze({
  passed: "Verification passed.",
  failed: "Verification failed.",
  not_applicable: "Server-side repair verification was not applicable."
});

function ownLabel(labels, value, fallback) {
  return typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : fallback;
}

function completedActionCategory(action) {
  if (!action || action.status !== "completed_by_codex" || typeof action.summary !== "string") return null;
  const text = action.summary.trim().toLowerCase().replace(/^(?:i|we)\s+/, "");
  // Only classify a recorded, completed step. Negated, hypothetical and proposed
  // descriptions must not become claims that a change occurred.
  if (/\b(?:not|no|never|without|would|could|should|planned|proposed|recommended|pending)\b/.test(text)) return null;
  const categories = [
    [/^(?:checked|verified|inspected|probed|tested)\b/, "inspection and verification"],
    [/^(?:refreshed|scanned|analy[sz]ed)\b/, "library scan or metadata refresh"],
    [/^(?:imported)\b/, "library import"],
    [/^(?:downloaded|replaced|reacquired|grabbed)\b/, "media acquisition or replacement"],
    [/^(?:deleted|removed|cleaned)\b/, "media or queue cleanup"],
    [/^(?:cancelled|canceled)\b/, "queue cancellation"],
    [/^(?:blocked|blocklisted|blacklisted|suppressed)\b/, "unwanted-source suppression"],
    [/^(?:monitored|unmonitored)\b/, "monitoring changes"],
    [/^(?:transcoded|remuxed)\b/, "media processing"],
    [/^(?:repaired|fixed)\b/, "media repair"],
    [/^(?:updated|configured|changed)\b/, "service or metadata updates"]
  ];
  return categories.find(([pattern]) => pattern.test(text))?.[1] || null;
}

export function publicSlackResolution(details = {}) {
  const approvals = Array.isArray(details.approvals) ? details.approvals : [];
  const pending = approvals.filter(approval => approval?.kind === "resolution" && approval.status === "pending")
    .sort((left, right) => (Number(right.id) || 0) - (Number(left.id) || 0))[0];
  if (!pending) return "There is no repair result awaiting final review.";
  const payload = pending.payload && typeof pending.payload === "object" ? pending.payload : {};
  const result = payload.executionResult && typeof payload.executionResult === "object" ? payload.executionResult : {};
  const parts = [ownLabel(OUTCOMES, result.outcome, "The repair outcome is not available for public review.")];
  const completed = result.actionsExecuted;
  if (Number.isSafeInteger(completed) && completed >= 0 && completed <= 10000) {
    parts.push(`${completed} completed ${completed === 1 ? "step was" : "steps were"} recorded.`);
  }
  const actions = Array.isArray(result.actions) ? result.actions.slice(0, 10000) : [];
  const categories = [...new Set(actions.map(completedActionCategory).filter(Boolean))];
  if (categories.length) parts.push(`Recorded step categories: ${categories.join(", ")}.`);
  parts.push(ownLabel(VERIFICATION, result.verification?.status, "Verification status is unavailable."));
  parts.push(payload.closeIssue === false
    ? "Final approval will post the resolution update and keep the issue open."
    : "Final approval will post the resolution update and close the issue.");
  return parts.join(" ");
}
