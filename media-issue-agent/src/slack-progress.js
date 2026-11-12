// Slack receives a projection of repair telemetry, never raw arguments, output,
// error prose, commands, or model messages. Every displayed label is controlled.
const SERVICES = Object.freeze({
  sonarr: "Sonarr", radarr: "Radarr", plex: "Plex", bazarr: "Bazarr",
  qbittorrent: "qBittorrent", nzbget: "NZBGet", prowlarr: "Prowlarr",
  seerr: "Seerr", threadfin: "Threadfin", tautulli: "Tautulli", tracearr: "Tracearr",
  media: "Media", download: "Download client"
});
const FAILURE_STATES = new Set(["failed_retryable", "failed_terminal", "needs_operator_decision", "blocked_needs_human"]);
const NON_REPAIR_FAILURE_EVENTS = new Set([
  "direct_close_failed", "issue_close_failed", "reopen_failed", "resolution_draft_failed",
  "resolution_comment_posted_without_closure", "investigation_evidence_collection_failed",
  "codex_investigation_failed", "codex_steered_investigation_failed"
]);
const REPAIR_FAILURE_EVENTS = new Set([
  "repair_failed_awaiting_operator_review", "interrupted_repair_run_recovered",
  "execution_failed", "repair_agent_failed", "repair_agent_needs_operator_decision"
]);
const CAPABILITY_ACTIONS = Object.freeze({
  sonarr_series_missing_episodes: "missing episode check",
  sonarr_missing_episode_candidate_matrix: "episode candidate check",
  radarr_blocklist_movie_file_source: "source suppression request",
  radarr_blocklist_movie_source: "source suppression request",
  qbittorrent_import_prowlarr_torrent: "torrent metadata handoff request",
  qbittorrent_url_job_status: "torrent handoff status check",
  qbittorrent_cancel_url_job: "torrent handoff cancellation request",
  media_wait_for_download_import: "download import status check",
  media_path_map_status: "path mapping check",
  media_list_series_files: "series file inspection",
  media_probe_decode_interval: "file decode check",
  media_verify_subtitle_sync: "subtitle timing comparison",
  media_retime_subtitle_sidecar: "subtitle timing adjustment request",
  media_remux_compatibility_copy: "compatibility copy request",
  plex_playback_attempt_diagnostics: "playback evidence check",
  plex_issue_session_correlation: "playback evidence check",
  plex_transcode_session_diagnostics: "transcode evidence check",
  plex_test_playback: "playback decision check",
  plex_set_stream_preferences: "stream preference update request",
  plex_set_default_stream_or_mkv_track_flags: "stream preference update request",
  plex_scan_status: "library scan status check"
});

function toolKey(value) {
  if (typeof value !== "string") return "";
  const name = value.replace(/^mcp__[^_]+__/, "").replace(/^media[.:]/, "");
  return /^[a-z][a-z0-9_]{0,159}$/.test(name) ? name : "";
}

function toolActivity(value) {
  const name = toolKey(value);
  const serviceKey = name.split("_")[0];
  const service = Object.hasOwn(SERVICES, serviceKey) ? SERVICES[serviceKey] : "Media service";
  let action = "operation";
  if (Object.hasOwn(CAPABILITY_ACTIONS, name)) action = CAPABILITY_ACTIONS[name];
  else if (/_(?:verify|verification)(?:_|$)/.test(name)) action = "verification check";
  else if (/_replace(?:_|$)/.test(name)) action = "media replacement request";
  else if (/_download_.*subtitles/.test(name)) action = "subtitle download request";
  else if (/_subtitle.*(?:search|candidates)|_subtitles?_search/.test(name)) action = "subtitle candidate check";
  else if (/_extract_archives/.test(name)) action = "archive extraction request";
  else if (/_archive_.*(?:diagnosis|check)/.test(name)) action = "archive check";
  else if (/_manual_import_candidates/.test(name)) action = "import candidate check";
  else if (/_(?:manual_import|import_queue_item)/.test(name)) action = "library import request";
  else if (/_blocklist_(?:episode|history|release)/.test(name)) action = "release blocklist request";
  else if (/_(?:delete|remove)(?:_|$)/.test(name)) action = "media or queue cleanup request";
  else if (/_(?:grab_release|grab_prowlarr_release|add_prowlarr_release)/.test(name)) action = "release download request";
  else if (/_request_media/.test(name)) action = "media request submission";
  else if (/_apply/.test(name)) action = "repair plan execution request";
  else if (/_(?:update|set|save)(?:_|$)/.test(name)) action = "service update request";
  else if (/_add(?:_|$)/.test(name)) action = "service addition request";
  else if (/_search_media|_search_library|_lookup/.test(name)) action = "media catalog lookup";
  else if (/_interactive_search|_search(?:_|$)/.test(name)) action = "release search request";
  else if (/_command_status/.test(name)) action = "background task status check";
  else if (/_command_cancel/.test(name)) action = "background task cancellation request";
  else if (/_retry_postprocess/.test(name)) action = "download post-processing retry";
  else if (/_recheck_torrents/.test(name)) action = "download file recheck";
  else if (/_reannounce_torrents/.test(name)) action = "download tracker refresh request";
  else if (/_control_(?:torrents|downloads)/.test(name)) action = "download control request";
  else if (/_refresh/.test(name)) action = "metadata refresh request";
  else if (/_(?:rescan|scan|download_client_scan)/.test(name)) action = "library scan request";
  else if (/_rename/.test(name)) action = "file rename request";
  else if (/_queue_item_files|_download_files/.test(name)) action = "downloaded file inspection";
  else if (/_queue|_list_torrents/.test(name)) action = "download queue check";
  else if (/_list_episodes|_wanted_missing|_cutoff_unmet/.test(name)) action = "missing media check";
  else if (/_metadata|_list_library_items|_list_movies|_list_series|_lookup/.test(name)) action = "library metadata check";
  else if (/_probe|_file|_availability/.test(name)) action = "media file inspection";
  else if (/_diagnos/.test(name)) action = "issue diagnostic check";
  else if (/_health|_status/.test(name)) action = "service health check";
  else if (/_history|_logs/.test(name)) action = "service event review";
  else if (/_profile|_quality|_config|_settings/.test(name)) action = "service configuration check";
  return `${service} ${action}`;
}

function timestamp(value) {
  if (typeof value !== "string") return 0;
  // SQLite's default timestamps are UTC, without an explicit offset.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  return Date.parse(normalized) || 0;
}

// Persisted failure identity also drives publication after restart. A previous
// failure remains in investigation evidence across retries; it must not hide a
// newer interrupted run or turn an unrelated closure failure into a repair one.
export function slackRepairFailureAttempt(details) {
  if (!FAILURE_STATES.has(details?.job?.state)) return null;
  const latestFailureEvent = (details.auditEvents || [])
    .filter(event => NON_REPAIR_FAILURE_EVENTS.has(event.eventType) || REPAIR_FAILURE_EVENTS.has(event.eventType))
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (NON_REPAIR_FAILURE_EVENTS.has(latestFailureEvent?.eventType)) return null;
  const run = (details.agentRuns || []).filter(item => item.kind === "repair").sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (run?.status === "running") return null;
  const failure = details.investigation?.evidence?.previousRepairFailure;
  const failedRun = run && FAILURE_STATES.has(run.status);
  if (failedRun && latestFailureEvent?.eventType === "interrupted_repair_run_recovered"
    && Number(latestFailureEvent.redactedPayload?.runId) === Number(run.id)) return String(run.id);
  if (failure) {
    if (failure.agentRunId && (!run || Number(failure.agentRunId) >= Number(run.id))) return String(failure.agentRunId);
    if (!failure.agentRunId && timestamp(failure.returnedAt)
      && (!run || timestamp(failure.returnedAt) >= timestamp(run.completedAt || run.startedAt))) return failure.returnedAt;
  }
  return failedRun ? String(run.id) : null;
}

function age(time, now) {
  if (!time) return "at an unknown time";
  const minutes = Math.floor(Math.max(0, now - time) / 60000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

// Only error-bearing fields are used to choose a public reason. Arbitrary
// successful tool content (including viewing history) cannot become a finding.
function errorEvidence(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 3000);
  if (Array.isArray(value)) return value.slice(0, 8).map(item => errorEvidence(item, depth + 1)).join(" ").slice(0, 6000);
  if (typeof value !== "object") return "";
  return ["error", "message", "code", "details"].map(key => errorEvidence(value[key], depth + 1)).filter(Boolean).join(" ").slice(0, 6000);
}

function failureReason(value, status) {
  const text = errorEvidence(value).split(/[.\n;]/).filter(part => !/\b(?:not (?:a |an |caused|due|stalled|blocked|missing|full|timed|unavailable|failed)|isn't|wasn't|isn’t|wasn’t|no evidence|ruled out)\b/i.test(part)).join(". ");
  if (/\b(?:resolution|comment|draft)\b/i.test(text) && /reject|invalid|validat|delegat|failed|must|empty|privacy|moderation/i.test(text)) return "the resolution draft did not pass its checks";
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|authentication|permission denied|EACCES/i.test(text)) return "the media service denied access";
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return "the media service rate-limited the request";
  if (status === 408 || status === 504 || /timed?\s*out|timeout|deadline|time budget/i.test(text)) return "the operation timed out";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|network error|connection (?:failed|refused|reset)|service unavailable/i.test(text) || status >= 500) return "the media service could not be reached reliably";
  if (/ENOSPC|no space left|disk (?:is )?full/i.test(text)) return "storage is full";
  if (/ENOENT|file (?:is |was )?(?:missing|not found)|missing (?:media )?file/i.test(text)) return "an expected media file could not be found";
  if (/(?:no|could not find|couldn't find) (?:suitable |matching |usable |available )?(?:releases?|replacement|candidates?)/i.test(text)) return "no suitable replacement release was found";
  if (/(?:download|torrent)[^.\n]{0,70}(?:stalled|blocked)|(?:stalled|blocked) (?:download|torrent)/i.test(text)) return "the download is stalled or blocked";
  if (/(?:import|unpack|extract)[^.\n]{0,60}(?:failed|failure|error)|(?:failed|unable) to (?:import|unpack|extract)/i.test(text)) return "the downloaded media could not be imported or unpacked";
  if (/(?:tool|capability)[^.\n]{0,60}(?:unavailable|missing|not available|not found|not exposed|unsupported)/i.test(text)) return "a required repair capability is unavailable";
  if (/(?:verification|playback check)[^.\n]{0,50}(?:failed|did not pass)|could not verify/i.test(text)) return "repair verification did not pass";
  if (/aborted|cancelled|canceled/i.test(text)) return "the repair was stopped before completion";
  if (/restart|interrupted/i.test(text)) return "the repair process was interrupted";
  return "";
}

function failedResult(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.slice(0, 12).some(item => failedResult(item, depth + 1));
  return Boolean(value.error || value.isError === true || value.ok === false || value.success === false || ["failed", "error"].includes(value.status))
    || ["result", "results"].some(key => failedResult(value[key], depth + 1));
}

function resultError(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.slice(0, 12).map(item => resultError(item, depth + 1)).join(" ");
  if (failedResult(value)) return errorEvidence(value.error || value);
  return ["result", "results"].map(key => resultError(value[key], depth + 1)).join(" ");
}

function projectEvents(events) {
  const operations = [];
  const useProxy = events.some(event => ["repair_mcp_tool_call", "repair_mcp_tool_result"].includes(event.eventType));
  let latestFailure = null;
  let lastStepAt = 0;
  for (const event of events) {
    const payload = event.payload || {};
    const type = event.eventType;
    const at = timestamp(event.createdAt);
    const start = (key, label, id = null) => {
      if (id && operations.some(item => item.id === id)) return;
      operations.push({ key, label, id, startedAt: at, at, state: "running" });
      lastStepAt = Math.max(lastStepAt, at);
    };
    const finish = (key, label, failed, reason, id = null) => {
      const operation = operations.find(item => item.state === "running" && (id ? item.id === id : item.key === key)) || { key, label, startedAt: 0 };
      if (!operations.includes(operation)) operations.push(operation);
      Object.assign(operation, { at, state: failed ? "failed" : "returned", reason });
      if (failed) latestFailure = operation;
      lastStepAt = Math.max(lastStepAt, at);
    };
    if (type === "repair_mcp_tool_call") {
      start(toolKey(payload.toolName), toolActivity(payload.toolName));
    } else if (type === "repair_mcp_tool_result") {
      const calls = (Array.isArray(payload.calls) ? payload.calls : []).slice(0, 12);
      const results = payload.resultSummary ?? payload.result;
      calls.forEach((call, index) => {
        const result = Array.isArray(results) && results.length === calls.length ? results[index] : results;
        const failed = Number(payload.status) >= 400 || failedResult(result);
        finish(toolKey(call.toolName), toolActivity(call.toolName), failed, failureReason(resultError(result), Number(payload.status)));
      });
    } else if (type === "repair_mcp_proxy_blocked") {
      finish(toolKey(payload.toolName), toolActivity(payload.toolName), true, "that issue-lifecycle action requires separate final approval");
    } else if (type === "repair_mcp_proxy_error") {
      // Legacy proxy errors have no call ID. Do not assign one to an unrelated
      // concurrent call, or claim that outstanding calls completed.
      latestFailure = { label: "Media service connection", reason: failureReason(payload.error), at };
      lastStepAt = Math.max(lastStepAt, at);
    } else if (/^item\.(?:started|updated|completed)$/.test(type)) {
      const item = payload.item || {};
      if (item.type === "mcp_tool_call" && useProxy) {
        // The proxy has the authoritative call timeline, but older stored
        // proxy summaries lost MCP isError. Native failure events can correct
        // the corresponding returned call without counting it twice.
        if (type === "item.completed" && (["failed", "error", "cancelled"].includes(item.status) || item.error || failedResult(item.resultSummary ?? item.result))) {
          const key = toolKey(item.tool || item.name);
          const matching = [...operations].reverse().filter(entry => entry.key === key);
          // The native completion follows the proxy result. Prefer that result
          // over another concurrent in-flight call of the same tool.
          const operation = matching.find(entry => entry.state !== "running") || matching[0] || { key, label: toolActivity(item.tool || item.name) };
          Object.assign(operation, { at, state: "failed", reason: failureReason(item.error || resultError(item.resultSummary ?? item.result)) });
          if (!operations.includes(operation)) operations.push(operation);
          latestFailure = operation;
          lastStepAt = Math.max(lastStepAt, at);
        }
        continue;
      }
      let label;
      if (item.type === "mcp_tool_call" && !useProxy) label = toolActivity(item.tool || item.name);
      else if (item.type === "command_execution") label = "Local repair workspace step";
      else if (item.type === "reasoning") label = "Repair evidence review";
      else continue;
      const key = item.type === "mcp_tool_call" ? toolKey(item.tool || item.name) : item.type;
      const failed = ["failed", "error", "cancelled"].includes(item.status) || Boolean(item.error) || (item.type === "command_execution" && Number.isInteger(item.exit_code) && item.exit_code !== 0) || failedResult(item.resultSummary ?? item.result);
      if (type === "item.completed" && !["in_progress", "running"].includes(item.status)) finish(key, label, failed, failureReason(item.error || resultError(item.resultSummary ?? item.result)), item.id);
      else if (type === "item.started") start(key, label, item.id);
    }
  }
  return { operations, latestFailure, lastStepAt };
}

export function publicSlackRepairProgress(details, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleAfterMs = Math.max(30_000, Number(options.staleAfterMs) || 120_000);
  const job = details?.job || {};
  const runs = (details?.agentRuns || []).filter(run => run.kind === "repair").sort((a, b) => Number(b.id) - Number(a.id));
  let run = runs[0];
  const previousFailure = details?.investigation?.evidence?.previousRepairFailure;
  if (previousFailure && !previousFailure.agentRunId && slackRepairFailureAttempt(details) === previousFailure.returnedAt) run = null;
  if (options.activeRun) {
    run = options.activeRun.runId ? runs.find(item => Number(item.id) === Number(options.activeRun.runId)) : null;
    if (!run) return "The approved repair is preparing a new attempt. No activity has been recorded for this attempt yet.";
  }
  // A new execution may be preparing before its run row exists. Never present
  // the preceding retry's actions as activity of this new attempt.
  if (job.state === "executing" && run?.status !== "running" && !options.activeRun) return "The approved repair is starting. No activity has been recorded for this attempt yet.";
  if (!run) {
    if (!FAILURE_STATES.has(job.state)) return "";
    const reason = failureReason(job.lastError || previousFailure?.message || previousFailure?.repairResult?.summary);
    return `The repair stopped before detailed activity was recorded.\n• Why: ${reason || "a specific cause is not available in the recorded activity"}.`;
  }
  const events = (details.agentRunEvents || []).filter(event => Number(event.runId) === Number(run.id)).sort((a, b) => Number(a.id) - Number(b.id));
  const { operations, latestFailure, lastStepAt } = projectEvents(events);
  const terminal = run.status !== "running";
  const failed = FAILURE_STATES.has(run.status);
  const workflowFailed = FAILURE_STATES.has(job.state);
  const laterFailure = terminal && !failed && workflowFailed;
  const heartbeatAt = timestamp(run.heartbeatAt || run.startedAt);
  const stale = !terminal && (!heartbeatAt || now - heartbeatAt > staleAfterMs);
  const lines = [laterFailure ? "The repair run finished, but a later workflow step stopped." : run.status === "needs_operator_decision" ? "The repair paused for an owner decision." : failed ? "The last repair attempt stopped." : terminal ? "The repair run has finished." : stale ? "The repair is marked as running, but its activity is stale." : "The approved repair is running."];
  const running = operations.filter(item => item.state === "running").slice(-2);
  if (!terminal && running.length) {
    const current = running.map(item => `${item.label} (started ${age(item.startedAt, now)})`).join("; ");
    lines.push(`• ${stale || !lastStepAt || now - lastStepAt > staleAfterMs ? "Last recorded step" : "Current recorded step"}: ${current}.`);
  } else if (!terminal) {
    lines.push(operations.length ? "• No next step has been recorded yet." : "• No detailed repair steps have been recorded yet.");
  }
  const finished = [...new Set(operations.filter(item => item.state === "returned").slice(-6).reverse().map(item => item.label))].slice(0, 3);
  if (finished.length) lines.push(`• Recent calls returned: ${finished.join("; ")}.`);
  if (latestFailure) lines.push(`• Latest error: ${latestFailure.label}${latestFailure.reason ? ` — ${latestFailure.reason}` : " returned an error; its cause is not available in the recorded activity"}.`);
  if (failed || laterFailure) {
    const result = run.finalResult || {};
    const reason = failureReason(laterFailure ? previousFailure?.message || job.lastError : run.error || result.summary || job.lastError)
      || (!laterFailure && result.verification?.status === "failed" ? "repair verification did not pass" : "");
    if (reason && reason !== latestFailure?.reason) lines.push(`• Why it stopped: ${reason}.`);
    else if (!reason && !latestFailure) lines.push("• A specific failure cause is not available in the recorded activity.");
  }
  const verification = run.finalResult?.verification?.status;
  if (terminal && ["passed", "failed", "not_applicable"].includes(verification)) lines.push(`• Verification: ${verification === "not_applicable" ? "not applicable" : verification}.`);
  else if (finished.length) lines.push("• Returned calls do not yet confirm a verified repair.");
  if (!terminal && (!lastStepAt || now - lastStepAt > staleAfterMs)) {
    lines.push(`• ${lastStepAt ? `Last recorded step was ${age(lastStepAt, now)}` : "No step timing is available"}; ${stale ? "current activity cannot be confirmed" : "the process is still reporting a heartbeat"}.`);
  }
  return lines.join("\n");
}
