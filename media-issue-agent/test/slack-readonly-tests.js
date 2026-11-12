import assert from "node:assert/strict";
import { buildAnalysisCodexArgs, runCodexSlackDiagnostics, runCodexSlackPlanSummary, slackDiagnosticsPrompt } from "../src/codex.js";
import { executeSlackReadOnlyCall, projectSlackPublicResult, publicSlackInvestigationSummary, validateSlackReadOnlyCall } from "../src/slack-readonly.js";

const secret = { user: "Private Viewer", username: "private-person", device: "Private Phone", ip: "8.8.8.8", path: "/tv/private", token: "secret-token", raw: { anything: "secret" } };
let calls = [];
const callTool = async (name, args) => {
  calls.push({ name, args });
  switch (name) {
    case "media_public_watchtime_summary": return { ...secret, available: true, playCount: 12, totalWatchSeconds: 3600, complete: true, viewers: [secret] };
    case "sonarr_list_series": return { records: [{ id: 15, title: "Example Show", year: 2026, monitored: true, status: "continuing", ...secret }] };
    case "sonarr_list_episodes": return { total: 2, returned: 2, episodes: [
      { id: 42, seasonNumber: 5, episodeNumber: 6, monitored: true, hasFile: false, ...secret },
      { id: 43, seasonNumber: 5, episodeNumber: 7, monitored: true, hasFile: true, ...secret }
    ] };
    case "sonarr_queue": return { totalRecords: 300, records: [
      { seriesId: 15, episodeId: 42, seasonNumber: 5, downloadId: "abcdef", status: "completed", trackedDownloadState: "importBlocked", size: 1000, sizeLeft: 0, errorMessage: "Permission denied /tv/private token=private", ...secret },
      { seriesId: 15, episodeId: 40, seasonNumber: 4, downloadId: "not-matched", status: "downloading", ...secret },
      { seriesId: 16, episodeId: 42, seasonNumber: 5, status: "downloading", ...secret },
      { seriesId: 15, status: "downloading", ...secret }
    ] };
    case "sonarr_recent_history": return { totalRecords: 200, records: [{ seriesId: 15, eventType: "grabbed", date: "2026-11-01T00:00:00Z", ...secret }, { seriesId: 77, eventType: "downloadFailed", ...secret }] };
    case "qbittorrent_list_torrents": return { records: [{ hash: "abcdef", state: "stalledUP", progress: 1, num_seeds: 8, ...secret }, { hash: "other", state: "error", ...secret }] };
    case "nzbget_history_detail": throw new Error("private endpoint http://private.example/token=secret");
    case "plex_search": return { MediaContainer: { Hub: [{ Metadata: [{ ratingKey: "1", type: "show", title: "Example Show", year: 2026, ...secret }] }] } };
    case "plex_list_show_seasons": return { seasons: [{ ratingKey: "2", index: 5, ...secret }] };
    case "plex_list_season_children": return { children: [{ ratingKey: "3", index: 6, ...secret }] };
    case "media_probe_video_content": return { ...secret, file: { exists: true, readable: true, ...secret }, ffprobe: { code: 0, ...secret }, metadata: { format: { filename: "/tv/private" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, tags: secret }, { codec_type: "subtitle", codec_name: "subrip", tags: secret }] } };
    default: throw new Error(`Unexpected ${name}`);
  }
};
const clean = value => {
  const text = JSON.stringify(value);
  for (const forbidden of ["Private Viewer", "private-person", "Private Phone", "8.8.8.8", "/tv/private", "secret-token", "http://private", "abcdef"]) assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
};

for (const name of ["radarr_search_movie", "sonarr_refresh_series", "media_file_delete", "plex_active_sessions", "tautulli_history", "tools/list", "resources/read"]) {
  assert.throws(() => validateSlackReadOnlyCall(name, {}));
}
for (const args of [{ userId: 1 }, { username: "Private Viewer" }, { user: "Private Viewer" }, { periodDays: 367 }, { periodDays: "30" }, { title: "http://private.example" }, { title: "safe", credentials: "x" }]) {
  assert.throws(() => validateSlackReadOnlyCall("media_public_watchtime_summary", args));
}
assert.throws(() => validateSlackReadOnlyCall("media_public_title_diagnostics", { title: "Example Show", episodeNumber: 6 }));
const watch = await executeSlackReadOnlyCall("media_public_watchtime_summary", { periodDays: 30 }, callTool);
assert.equal(watch.result.playCount, 12);
assert.equal(watch.result.totalWatchSeconds, 3600);
clean(watch);
assert.deepEqual(projectSlackPublicResult("media_public_watchtime_summary", { available: "secret", playCount: "private-person", totalWatchSeconds: -1, records: [secret] }), {});

calls = [];
const diagnostic = await executeSlackReadOnlyCall("media_public_title_diagnostics", { title: "Example Show", mediaType: "tv", seasonNumber: 5, episodeNumber: 6 }, callTool);
assert.equal(diagnostic.result.inventory.episodeCount, 1);
assert.equal(diagnostic.result.inventory.availableEpisodeCount, 0);
assert.equal(diagnostic.result.downloads.matchedCount, 1);
assert.equal(diagnostic.result.downloads.complete, false);
assert.equal(diagnostic.result.downloads.records[0].state, "import_blocked");
assert.equal(diagnostic.result.downloads.records[0].percentDownloaded, 100);
assert.deepEqual(diagnostic.result.downloads.records[0].problemCategories, ["permission_denied"]);
assert.equal(diagnostic.result.downloads.linkedClientRecords[0].state, "download_complete");
assert.equal(diagnostic.result.recentHistory.events.length, 1);
assert.equal(diagnostic.result.recentHistory.complete, false);
assert.equal(calls.find(call => call.name === "sonarr_list_episodes").args.seriesId, 15);
clean(diagnostic);

const playback = await executeSlackReadOnlyCall("media_public_title_playback", { title: "Example Show", mediaType: "tv", seasonNumber: 5, episodeNumber: 6 }, callTool);
assert.equal(playback.result.probeSucceeded, true);
assert.equal(playback.result.streams[0].codec, "h264");
assert.equal(playback.result.subtitleTrackCount, 1);
assert.deepEqual(calls.find(call => call.name === "media_probe_video_content").args, { ratingKey: "3", includeFrameHashes: false });
clean(playback);
const missingScope = await executeSlackReadOnlyCall("media_public_title_playback", { title: "Example Show", mediaType: "tv" }, callTool);
assert.equal(missingScope.result.status, "needs_episode_scope");

const results = [
  { calls: [{ name: "media_public_watchtime_summary", arguments: { periodDays: 30 } }], done: false },
  { calls: [{ name: "media_public_title_diagnostics", arguments: { title: "Example Show", mediaType: "tv", seasonNumber: 5 } }], done: false },
  { calls: [], done: true }
];
let turns = 0;
const config = { codexWorkspace: "/tmp/unused" };
const report = await runCodexSlackDiagnostics(config, { newestMessage: "Why is season 5 stuck?", mediaTitle: "Example Show" }, {}, {
  callTool,
  runModel: async (_config, prompt, hooks) => {
    assert.equal(hooks.toolFree, true);
    assert.equal(hooks.ignoreUserConfig, true);
    if (turns > 0) clean(prompt);
    return JSON.stringify(results[turns++]);
  }
});
assert.equal(turns, 3);
assert.equal(report.completion, "complete");
assert.equal(report.facts.length, 2);
clean(report);
let mutated = false;
const denied = await runCodexSlackDiagnostics(config, {}, {}, { callTool: () => { mutated = true; }, runModel: async () => JSON.stringify({ calls: [{ name: "radarr_search_movie", arguments: { movieId: 2 } }], done: false }) });
assert.equal(denied.completion, "unavailable");
assert.equal(mutated, false);
const leakedError = await executeSlackReadOnlyCall("plex_availability", {}, async () => { throw new Error("Bearer secret-token 8.8.8.8"); });
assert.equal(leakedError.result.status, "unavailable");
clean(leakedError);
const looping = await runCodexSlackDiagnostics(config, {}, {}, { callTool, runModel: async () => JSON.stringify(results[0]) });
assert.equal(looping.facts.length, 1);
assert.equal(looping.completion, "limit_reached");

const args = buildAnalysisCodexArgs(config, {}, { toolFree: true }).args;
for (const blocked of ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "browser_use", "computer_use", "view_image"]) assert.ok(args.includes(`features.${blocked}=false`));
assert.ok(args.includes('web_search="disabled"'));
assert.ok(args.includes("read-only"));
assert.equal(slackDiagnosticsPrompt({ newestMessage: "hello", reporter: secret }).includes("Private Viewer"), false);
const summary = publicSlackInvestigationSummary({ job: { state: "awaiting_action_approval", ...secret }, investigation: { summary: "Private Viewer watched Example Show", ...secret }, approvals: [{ kind: "action", status: "pending", payload: { plan: { classification: "server_action" } } }] });
assert.equal(summary.nextStep, "owner_approve_repair");
clean(summary);
assert.equal(projectSlackPublicResult("media_public_request_status", { status: "matched", result: { title: "Example Show", status: "partially_available" } }).result.status, "partially_available");
const scopedPrompt = slackDiagnosticsPrompt({ issue: { mediaTitle: "Canonical Show", description: "Season 5 episode 6 is missing" }, request: { mediaType: "tv", seasons: [5] }, workflow: { state: "awaiting_action_approval", nextStep: "owner_approve_repair", privateNote: "Private Viewer" } });
assert.ok(scopedPrompt.includes("Canonical Show"));
assert.ok(scopedPrompt.includes('"seasonNumber":5'));
assert.ok(scopedPrompt.includes("Season 5 episode 6 is missing"));
assert.equal(scopedPrompt.includes("Private Viewer"), false);

const pendingDetails = {
  investigation: { summary: "The expected file is missing. Private Viewer reported it. Reacquire the episode and verify playback." },
  approvals: [{ kind: "action", status: "pending", payload: { plan: { classification: "server_action", executionMode: "approved_repair_agent", actionSummary: { expectedSteps: ["Search for a replacement and verify the affected episode."] } } } }]
};
const safePlan = await runCodexSlackPlanSummary(config, pendingDetails, {}, {
  runModel: async (_config, prompt, hooks) => {
    assert.equal(hooks.toolFree, true);
    assert.ok(prompt.includes("Search for a replacement"));
    return JSON.stringify({ findings: ["missing_file"], actions: ["search_replace", "verify"] });
  }
});
assert.deepEqual(safePlan.findings, ["The expected media file is missing."]);
assert.equal(safePlan.actions.length, 2);
assert.ok(safePlan.approvalScope.includes("choose and carry out appropriate media-side repairs"));
assert.ok(safePlan.approvalScope.includes("closing the issue require separate approval"));
clean(safePlan);
for (const badOutput of [
  { findings: ["Private Viewer watched Example Show"], actions: ["verify"] },
  { findings: ["missing_file"], actions: ["delete /tv/private"] },
  { findings: ["missing_file"], actions: ["verify"], raw: secret },
  { findings: [1], actions: ["verify"] },
  { findings: ["__proto__"], actions: ["constructor"] },
  { findings: [], actions: [] }
]) {
  const blocked = await runCodexSlackPlanSummary(config, pendingDetails, {}, { runModel: async () => JSON.stringify(badOutput) });
  assert.deepEqual(blocked.findings, ["The investigation has not established a specific cause."]);
  clean(blocked);
}
const clientDetails = structuredClone(pendingDetails);
clientDetails.approvals[0].payload.plan.executionMode = "none";
clientDetails.approvals[0].payload.plan.classification = "client_side";
const clientPlan = await runCodexSlackPlanSummary(config, clientDetails, {}, { runModel: async () => JSON.stringify({ findings: ["client_side"], actions: ["client_guidance"] }) });
assert.ok(clientPlan.approvalScope.includes("without media changes"));
console.log("Slack read-only diagnostic tests passed");
