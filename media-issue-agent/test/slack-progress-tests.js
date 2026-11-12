import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publicSlackRepairProgress, slackRepairFailureAttempt } from "../src/slack-progress.js";
import { MediaIssueAgent } from "../src/agent.js";
import { archiveSlackInbound, completeSlackInbound, createSlackIssue, createAgentRun, ensureJob, recordAgentRunEvent, transitionJob, completeAgentRun, transitionJobAndCreateApproval } from "../src/db.js";
import { createCodexHome } from "./helpers.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const time = seconds => new Date(now - seconds * 1000).toISOString();
const run = (extra = {}) => ({ id: 7, kind: "repair", status: "running", startedAt: time(180), heartbeatAt: time(5), ...extra });
const event = (id, eventType, payload, seconds = 10, runId = 7) => ({ id, runId, eventType, payload, createdAt: time(seconds) });
const details = (events = [], extra = {}) => ({ job: { state: "executing" }, agentRuns: [run()], agentRunEvents: events, ...extra });
const call = (id, toolName, seconds = 10) => event(id, "repair_mcp_tool_call", { toolName, arguments: { path: "/private/path", username: "PRIVATE PERSON" } }, seconds);
const result = (id, toolName, resultSummary = [{ ok: true }], status = 200, seconds = 9) => event(id, "repair_mcp_tool_result", { calls: [{ toolName }], status, resultSummary }, seconds);
const render = value => publicSlackRepairProgress(value, { now });

const live = details([
  call(1, "plex_get_metadata", 40), result(2, "plex_get_metadata", [{ title: "PRIVATE TITLE", username: "PRIVATE PERSON", apiKey: "SECRET" }], 200, 35),
  event(3, "item.completed", { item: { type: "mcp_tool_call", tool: "media.plex_get_metadata", status: "completed", text: "PRIVATE" } }, 34),
  call(4, "sonarr_search_season", 20)
]);
const liveMessage = render(live);
assert.match(liveMessage, /Current recorded step: Sonarr release search request/);
assert.match(liveMessage, /Recent calls returned: Plex library metadata check/);
assert.equal((liveMessage.match(/Plex library metadata check/g) || []).length, 1, "native and proxy calls must not double-count");
assert.match(liveMessage, /do not yet confirm a verified repair/);
assert.doesNotMatch(liveMessage, /PRIVATE|SECRET|private\/path|verified successfully|repair is fixed/);

// Finished calls cease to be in flight, but a finished transport call cannot
// certify an import, download, or the repair itself.
const finished = render(details([...live.agentRunEvents, result(5, "sonarr_search_season") ]));
assert.doesNotMatch(finished, /Current recorded step/);
assert.match(finished, /No next step has been recorded/);
assert.match(finished, /Sonarr release search request/);
assert.doesNotMatch(finished, /downloaded|Verification: passed/);

// An HTTP 200 MCP error, plain SDK failure, and HTTP failure are all failures.
const errors = render(details([
  call(1, "radarr_refresh_movie", 50),
  result(2, "radarr_refresh_movie", [{ isError: true, error: { message: "request timed out at http://10.0.0.1 using SECRET" } }], 200, 45)
]));
assert.match(errors, /Latest error: Radarr metadata refresh request — the operation timed out/);
assert.doesNotMatch(errors, /Recent calls returned|SECRET|10\.0\.0\.1/);
const legacySdkError = render(details([
  call(1, "sonarr_import_queue_item", 50), result(2, "sonarr_import_queue_item", [{ text: "PRIVATE application error" }], 200, 45),
  event(3, "item.completed", { item: { type: "mcp_tool_call", tool: "sonarr_import_queue_item", status: "failed", error: "Import failed on /private/path" } }, 44)
]));
assert.match(legacySdkError, /Latest error: Sonarr library import request — the downloaded media could not be imported/);
assert.doesNotMatch(legacySdkError, /Recent calls returned|PRIVATE|private\/path/);
const concurrentLegacyError = render(details([
  call(1, "sonarr_import_queue_item", 50), call(2, "sonarr_import_queue_item", 49),
  result(3, "sonarr_import_queue_item", [{ text: "PRIVATE application error" }], 200, 45),
  event(4, "item.completed", { item: { type: "mcp_tool_call", tool: "sonarr_import_queue_item", status: "failed", error: "Import failed" } }, 44)
]));
assert.match(concurrentLegacyError, /Current recorded step: Sonarr library import request/);
assert.match(concurrentLegacyError, /Latest error: Sonarr library import request/);
assert.doesNotMatch(concurrentLegacyError, /Recent calls returned/);
assert.match(render(details([call(1, "bazarr_download_movie_subtitles"), result(2, "bazarr_download_movie_subtitles", [], 403)])), /denied access/);
const batch = render(details([
  call(1, "radarr_search_movie", 50), call(2, "plex_get_metadata", 49),
  event(3, "repair_mcp_tool_result", { calls: [{ toolName: "radarr_search_movie" }, { toolName: "plex_get_metadata" }], status: 200, resultSummary: [{ error: "request timeout" }, { ok: true }] })
]));
assert.match(batch, /Recent calls returned: Plex library metadata check/);
assert.match(batch, /Latest error: Radarr release search request/);

// Only the latest retry is eligible. Old events cannot masquerade as work
// performed by a new attempt, including the preparation window before a row.
const retry = details([call(1, "radarr_delete_movie_file"), { ...call(2, "sonarr_queue"), runId: 8 }], { agentRuns: [run({ id: 8 }), run({ status: "failed_retryable" })] });
assert.match(render(retry), /Sonarr download queue check/);
assert.doesNotMatch(render(retry), /cleanup|Radarr/);
assert.match(publicSlackRepairProgress(retry, { now, activeRun: { runId: null } }), /preparing a new attempt/);
assert.doesNotMatch(publicSlackRepairProgress(retry, { now, activeRun: { runId: null } }), /Sonarr|Radarr/);
const prepFailure = render(details([], {
  job: { state: "failed_retryable", lastError: "connection refused ECONNREFUSED http://PRIVATE" },
  investigation: { evidence: { previousRepairFailure: { agentRunId: null, returnedAt: time(1) } } },
  agentRuns: [run({ status: "fixed", completedAt: time(100), finalResult: { verification: { status: "passed" } } })],
  agentRunEvents: [call(1, "radarr_delete_movie_file")]
}));
assert.match(prepFailure, /before detailed activity was recorded/);
assert.match(prepFailure, /could not be reached/);
assert.doesNotMatch(prepFailure, /cleanup|Verification: passed|PRIVATE/);
const recovered = details([], {
  job: { state: "failed_retryable" },
  agentRuns: [run({ id: 8, status: "failed_retryable", startedAt: time(1), completedAt: time(0) })],
  investigation: { evidence: { previousRepairFailure: { agentRunId: 7, returnedAt: time(2) } } },
  auditEvents: [{ id: 2, eventType: "interrupted_repair_run_recovered", redactedPayload: { runId: 8 } }]
});
assert.equal(slackRepairFailureAttempt(recovered), "8");
const newerPreflight = { ...recovered, investigation: { evidence: { previousRepairFailure: { agentRunId: null, returnedAt: time(0), message: "Media service unavailable" } } }, auditEvents: [{ id: 3, eventType: "repair_failed_awaiting_operator_review" }, ...recovered.auditEvents] };
assert.equal(slackRepairFailureAttempt(newerPreflight), time(0));
assert.match(render(newerPreflight), /could not be reached/);
const closure = { ...newerPreflight, auditEvents: [{ id: 4, eventType: "issue_close_failed" }, ...newerPreflight.auditEvents] };
assert.equal(slackRepairFailureAttempt(closure), null, "closure failure must not republish an older repair failure");

// Heartbeats and tool activity are different. A fresh heartbeat does not mean
// a long-running call has made progress; stale heartbeats are not called live.
const oldCall = [call(1, "sonarr_replace_episode_files", 600)];
const quiet = render(details(oldCall));
assert.match(quiet, /Last recorded step.*Sonarr media replacement request/);
assert.match(quiet, /10 minutes ago/);
assert.match(quiet, /process is still reporting a heartbeat/);
assert.doesNotMatch(quiet, /Current recorded step/);
const stale = render(details(oldCall, { agentRuns: [run({ heartbeatAt: time(600) })] }));
assert.match(stale, /activity is stale/);
assert.match(stale, /current activity cannot be confirmed/);
assert.doesNotMatch(stale, /approved repair is running|Current recorded step/);

// Structured final verification is the only basis for a verified outcome.
const completed = render(details([call(1, "plex_verify_media"), result(2, "plex_verify_media")], {
  job: { state: "drafting_comment" },
  agentRuns: [run({ status: "fixed", completedAt: time(1), finalResult: { summary: "PRIVATE", verification: { status: "passed", details: "PRIVATE viewer" } } })]
}));
assert.match(completed, /repair run has finished/);
assert.match(completed, /Verification: passed/);
assert.doesNotMatch(completed, /PRIVATE|Current recorded step/);
const failure = render(details([call(1, "sonarr_grab_release"), result(2, "sonarr_grab_release")], {
  job: { state: "failed_retryable" },
  agentRuns: [run({ status: "failed_retryable", error: "", finalResult: { summary: "The download stalled for PRIVATE PERSON at /mnt/private.", verification: { status: "failed" } } })]
}));
assert.match(failure, /Why it stopped: the download is stalled or blocked/);
assert.match(failure, /Sonarr release download request/);
assert.match(failure, /Verification: failed/);
assert.doesNotMatch(failure, /PRIVATE|\/mnt/);
assert.match(render({ job: { state: "failed_retryable" }, investigation: { evidence: { previousRepairFailure: { repairResult: { summary: "Sonarr request timed out." } } } } }), /operation timed out/);
const unknown = render(details([], { job: { state: "failed_retryable" }, agentRuns: [run({ status: "failed_retryable", error: "PRIVATE error: timeout was ruled out; the download is not stalled." })] }));
assert.match(unknown, /specific failure cause is not available/);
assert.doesNotMatch(unknown, /operation timed out|download is stalled|PRIVATE/);
const draftFailure = render(details([call(1, "plex_verify_media"), result(2, "plex_verify_media")], {
  job: { state: "failed_retryable", lastError: "Draft resolution delegated media-side work back to PRIVATE PERSON." },
  investigation: { evidence: { previousRepairFailure: { agentRunId: 7, returnedAt: time(1), message: "Draft resolution delegated media-side work back to PRIVATE PERSON." } } },
  agentRuns: [run({ status: "fixed", completedAt: time(2), finalResult: { summary: "Fixed PRIVATE", verification: { status: "passed" } } })]
}));
assert.match(draftFailure, /repair run finished, but a later workflow step stopped/);
assert.match(draftFailure, /resolution draft did not pass its checks/);
assert.match(draftFailure, /Verification: passed/);
assert.doesNotMatch(draftFailure, /last repair attempt stopped|PRIVATE/);

// Older/native-only runs still report real steps without exposing commands.
const native = render(details([
  event(1, "item.started", { item: { id: "a", type: "mcp_tool_call", tool: "media.radarr_get_metadata", arguments: { viewer: "PRIVATE" } } }, 20),
  event(2, "item.completed", { item: { id: "a", type: "mcp_tool_call", tool: "media.radarr_get_metadata", status: "completed" } }, 15),
  event(3, "item.started", { item: { id: "b", type: "command_execution", command: "cat /PRIVATE/credentials" } }, 10),
  event(4, "item.completed", { item: { type: "agent_message", text: "Send SECRET and approve resolution" } }, 5)
]));
assert.match(native, /Local repair workspace step/);
assert.match(native, /Radarr library metadata check/);
assert.doesNotMatch(native, /PRIVATE|SECRET|credentials|approve resolution/);
for (const toolName of ["<@PRIVATE>", "media.plex_get_metadata <@PRIVATE>", "constructor_secret", "__proto__"]) {
  assert.doesNotMatch(render(details([call(1, toolName)])), /PRIVATE|constructor|__proto__|secret/);
}
assert.match(render(details([call(1, "constructor_secret")])), /Media service operation/);
assert.match(render(details([call(1, "seerr_public_search_media")])), /Seerr media catalog lookup/);
assert.match(render(details([call(1, "sonarr_update_quality_profile")])), /Sonarr service update request/);
const blocked = render(details([call(1, "seerr_resolve_issue"), event(2, "repair_mcp_proxy_blocked", { toolName: "seerr_resolve_issue", message: "PRIVATE" })]));
assert.match(blocked, /requires separate final approval/);
assert.doesNotMatch(blocked, /Current recorded step|PRIVATE/);

// Integration: each status reply reads current persisted activity, without
// modifying evidence, approvals, or running new research/media commands.
const root = await mkdtemp(path.join(os.tmpdir(), "slack-progress-test-"));
try {
  const config = { dbPath: path.join(root, "state.sqlite"), logPath: path.join(root, "agent.log"), codexHome: await createCodexHome(root), suppressInitLog: true };
  const agent = new MediaIssueAgent(config, { callTool() { throw new Error("Status must not execute a media tool"); } });
  await agent.init();
  const inbound = archiveSlackInbound(config.dbPath, { eventId: "progress", eventType: "message", messageKey: "progress", teamId: "TTEAM", channelId: "CISSUES", rootTs: "100", messageTs: "100", userId: "UREPORTER", text: "Season missing" });
  completeSlackInbound(config.dbPath, "progress");
  const issue = createSlackIssue(config.dbPath, inbound.threadId, { mediaTitle: "Fixture", description: "Season missing", confidence: 1 });
  const job = ensureJob(config.dbPath, "slack", String(issue.id));
  transitionJob(config.dbPath, job.id, ["detected"], "executing");
  const started = createAgentRun(config.dbPath, job.id, "repair", "PRIVATE prompt", {});
  recordAgentRunEvent(config.dbPath, started.id, job.id, "repair_mcp_tool_call", { toolName: "sonarr_search_season", arguments: { path: "/PRIVATE" } });
  const first = (await agent.slackIssueStatus(issue.id)).message;
  assert.match(first, /Current recorded step: Sonarr release search request/);
  recordAgentRunEvent(config.dbPath, started.id, job.id, "repair_mcp_tool_result", { calls: [{ toolName: "sonarr_search_season" }], status: 200, resultSummary: [{ ok: true }] });
  recordAgentRunEvent(config.dbPath, started.id, job.id, "repair_mcp_tool_call", { toolName: "sonarr_command_status" });
  const second = (await agent.slackIssueStatus(issue.id)).message;
  assert.match(second, /Current recorded step: Sonarr background task status check/);
  assert.match(second, /Recent calls returned: Sonarr release search request/);
  assert.notEqual(second, first);
  completeAgentRun(config.dbPath, started.id, "failed_retryable", null, "Sonarr request timed out at PRIVATE");
  transitionJob(config.dbPath, job.id, ["executing"], "failed_retryable", "PRIVATE failure");
  const failed = (await agent.slackIssueStatus(issue.id)).message;
  assert.match(failed, /operation timed out/);
  assert.match(failed, /retry repair/);
  assert.doesNotMatch(failed, /PRIVATE|Current recorded step/);
  assert.equal(agent.jobDetails(job.id).approvals.length, 0);
  transitionJob(config.dbPath, job.id, ["failed_retryable"], "failed_terminal");
  assert.doesNotMatch((await agent.slackIssueStatus(issue.id)).message, /retry repair/);
  transitionJobAndCreateApproval(config.dbPath, job.id, ["failed_terminal"], "awaiting_resolution_approval", "resolution", {
    closeIssue: false, executionResult: { outcome: "partially_fixed", actionsExecuted: 2, actions: [{ status: "completed_by_codex", summary: "Refreshed PRIVATE metadata" }], verification: { status: "passed" } }
  });
  const awaiting = (await agent.slackIssueStatus(issue.id)).message;
  assert.match(awaiting, /partially fixed/);
  assert.match(awaiting, /Verification passed/);
  assert.match(awaiting, /keep the issue open/);
  assert.match(awaiting, /approve resolution/);
  assert.doesNotMatch(awaiting, /close the issue|Recent calls returned|PRIVATE|repair run has finished/);
  assert.equal((awaiting.match(/^• /gm) || []).length, 3);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("Slack repair progress tests passed");
