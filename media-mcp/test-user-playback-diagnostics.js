import assert from "node:assert/strict";
import { createUserPlaybackDiagnostics, registerUserPlaybackDiagnostics } from "./user-playback-diagnostics.js";

const at = Date.parse("2026-11-12T12:00:00Z");
const accounts = [
  { user_id: "1001", username: "private-login", friendly_name: "Shared display", email: "private@example.test", keep_history: 1, thumb: "https://private.example.test/token" },
  { user_id: "1002", username: "another-login", friendly_name: "Shared display", email: "another@example.test" },
  { user_id: "1003", username: "impostor", friendly_name: "private@example.test", email: "impostor@example.test" }
];
const historyRows = [
  { user_id: "1001", row_id: 501, rating_key: "991", machine_id: "PRIVATE-DEVICE", started: 1000, duration: 50, platform: "Roku", transcode_decision: "transcode", friendly_name: "PRIVATE PERSON", title: "PRIVATE TITLE", ip_address: "10.1.2.3" },
  { user_id: "1001", row_id: 502, rating_key: "991", machine_id: "PRIVATE-DEVICE", started: 1100, duration: 30, platform: "Roku", transcode_decision: "transcode", error: "decoder failed /private/SECRET.mkv" },
  { user_id: "1001", row_id: 503, rating_key: "992", machine_id: "PRIVATE-DEVICE", started: 1200, duration: 300, platform: "PRIVATE PLATFORM", transcode_decision: "direct play" }
];
function fixture(overrides = {}, options = {}) {
  const calls = [];
  let clock = at;
  const deps = {
    now: () => clock,
    async tautulliApi(command, request = {}) {
      calls.push({ source: "tautulli", command, ...request });
      if (overrides.tautulli) {
        const value = await overrides.tautulli(command, request, { advance: milliseconds => { clock += milliseconds; } });
        if (value !== undefined) return value;
      }
      if (command === "get_users") return accounts;
      if (command === "get_history") {
        assert.equal(request.query.user_id, "1001");
        assert.equal(request.query.grouping, 0);
        assert.equal(request.query.include_activity, 0);
        return { recordsFiltered: historyRows.length, data: historyRows.slice(request.query.start, request.query.start + request.query.length) };
      }
      if (command === "get_activity") return { sessions: [
        { user_id: "1001", title: "PRIVATE TITLE", friendly_name: "PRIVATE PERSON", platform: "Roku", state: "buffering", buffer_count: 3, stream_bitrate: "8000", bitrate: "12000", transcode_decision: "transcode", stream_video_decision: "transcode", stream_subtitle_decision: "burn", stream_subtitle_codec: "pgs", stream_video_codec: "h264", stream_audio_codec: "aac", transcode_speed: "0.7", machine_id: "PRIVATE-DEVICE", ip_address: "10.1.2.3" },
        { user_id: "1002", state: "buffering", buffer_count: 9999, platform: "Windows", error: "unrelated error" }
      ] };
      if (command === "get_stream_data") {
        assert.ok(["501", "502", "503"].includes(request.query.row_id));
        return { row_id: request.query.row_id, user_id: "1001", title: "PRIVATE TITLE", file: "/private/file.mkv", stream_bitrate: "7000", stream_video_decision: "transcode", video_decision: "transcode", audio_decision: "copy" };
      }
      throw new Error("Unexpected Tautulli request");
    },
    async plexApi(command, request = {}) {
      calls.push({ source: "plex", command, ...request });
      if (overrides.plex) return overrides.plex(command, request);
      assert.equal(command, "status/sessions");
      return { MediaContainer: { Metadata: [
        { User: { id: "1001", title: "PRIVATE PERSON" }, title: "PRIVATE TITLE", ratingKey: "991", Session: { id: "PRIVATE-SESSION", bandwidth: 9000 }, Player: { platform: "Roku", version: "6.9.1", machineIdentifier: "PRIVATE-DEVICE", state: "buffering", local: false }, Media: [{ selected: true, bitrate: 12000, width: 1920, height: 1080, videoDecision: "transcode" }], TranscodeSession: { speed: "0.6", error: "decoder failed with apiKey=SECRET" } },
        { User: { id: "1002" }, Player: { platform: "Windows", state: "playing" }, TranscodeSession: { error: "unrelated permission denied" } }
      ] } };
    }, ...options
  };
  return { api: createUserPlaybackDiagnostics(deps), calls, deps };
}

const resolved = fixture();
const match = await resolved.api.resolve({ query: " PRIVATE-LOGIN " });
assert.equal(match.status, "matched");
assert.deepEqual(match.candidates, [{ resolvedUserId: "1001", matchedBy: ["username"] }]);
assert.equal((await resolved.api.resolve({ query: "private" })).status, "not_found", "account lookup must not guess partial names");
assert.equal((await resolved.api.resolve({ query: "Shared display" })).status, "ambiguous");
assert.equal((await resolved.api.resolve({ query: "private@example.test" })).status, "ambiguous");
assert.deepEqual((await resolved.api.resolve({ query: "private@example.test", matchBy: "email" })).candidates, [{ resolvedUserId: "1001", matchedBy: ["email"] }]);
assert.equal((await resolved.api.resolve({ query: "1001", matchBy: "user_id" })).status, "matched");
assert.doesNotMatch(JSON.stringify(match), /private-login|Shared|private@example|https/);

const f = fixture();
const evidence = await f.api.diagnose({ resolvedUserId: "1001", allTime: true });
assert.equal(evidence.available, true);
assert.equal(evidence.complete, true);
assert.equal(evidence.history.attemptCount, 3);
assert.equal(evidence.history.shortAttemptCount, 2);
assert.equal(evidence.history.repeatedAttemptCount, 1);
assert.equal(evidence.history.streamDecisions.transcode, 2);
assert.equal(evidence.history.platforms.Roku, 2);
assert.equal(evidence.history.observedErrors.decode_error, 1);
assert.equal(evidence.current.tautulli.attemptCount, 1);
assert.equal(evidence.current.tautulli.attempts[0].bufferCount, 3);
assert.equal(evidence.current.tautulli.attempts[0].transcodeSpeed, 0.7);
assert.equal(evidence.current.tautulli.attempts[0].subtitleDecision, "burn");
assert.equal(evidence.current.tautulli.attempts[0].subtitleCodec, "pgs");
assert.equal(evidence.current.tautulli.attempts[0].videoCodec, "h264");
assert.equal(evidence.current.plex.attemptCount, 1);
assert.equal(evidence.current.plex.attempts[0].transcodeSpeed, 0.6);
assert.equal(evidence.current.plex.attempts[0].clientVersion, "6.9.1");
assert.deepEqual(evidence.current.plex.attempts[0].observedErrors, ["decode_error"]);
assert.equal(evidence.technical.checkedCount, 3);
assert.equal(evidence.technical.streamBitrateKbps.maximum, 7000);
assert.equal(evidence.technical.streamDecisions.transcode, 3);
assert.equal(f.calls.filter(call => call.command === "get_history")[0].query.after, undefined);
assert.ok(f.calls.every(call => call.signal instanceof AbortSignal && call.timeoutMs > 0 && call.timeoutMs <= 25000));
assert.ok(f.calls.every(call => call.signal === f.calls[0].signal));
assert.ok(f.calls.every(call => call.method === undefined), "these capabilities never mutate upstream state");
assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|SECRET|1001|1002|991|501|private@example|10\.1\.2\.3|apiKey|machineIdentifier|ratingKey|username|friendly_name|ip_address|\/private/);

// Explicit dates reach history unchanged; past scope does not pretend that a
// current stream occurred during that past interval.
const dated = fixture();
const dateResult = await dated.api.diagnose({ resolvedUserId: "1001", startDate: "2010-01-01", endDate: "2011-12-31" });
assert.equal(dateResult.current.included, false);
assert.equal(dated.calls.some(call => call.command === "get_activity" || call.source === "plex"), false);
assert.equal(dated.calls.find(call => call.command === "get_history").query.after, "2010-01-01");
assert.equal(dated.calls.find(call => call.command === "get_history").query.before, "2011-12-31");
const long = fixture();
assert.equal((await long.api.diagnose({ resolvedUserId: "1001", periodDays: 1826 })).range.periodDays, 1826);
await assert.rejects(() => long.api.diagnose({ resolvedUserId: "1001", allTime: true, periodDays: 3 }), /Choose/);
await assert.rejects(() => long.api.diagnose({ resolvedUserId: "private-login" }), /exact/);
await assert.rejects(() => long.api.diagnose({ resolvedUserId: "1001", offset: -1 }), /offset/);

// Never trust the upstream filter as proof of account ownership. Unscoped and
// foreign rows cannot influence metrics or become stream-detail requests.
const crossAccount = fixture({ tautulli: command => command === "get_history" ? { recordsFiltered: 2, data: [
  { user_id: "1002", row_id: 999, duration: 1, transcode_decision: "transcode" },
  { row_id: 998, duration: 1, transcode_decision: "transcode" }
] } : undefined });
const excluded = await crossAccount.api.diagnose({ resolvedUserId: "1001" });
assert.equal(excluded.history.attemptCount, 0);
assert.equal(excluded.history.complete, false);
assert.equal(excluded.history.scopeConflictCount, 2);
assert.equal(excluded.history.incompleteReason, "scope_mismatch");
assert.equal(crossAccount.calls.some(call => call.command === "get_stream_data"), false);
assert.doesNotMatch(JSON.stringify(excluded), /999|998|1002/);

const changedDetail = fixture({ tautulli: command => command === "get_stream_data" ? { user_id: "1002", stream_bitrate: 999999 } : undefined });
const detailResult = await changedDetail.api.diagnose({ resolvedUserId: "1001" });
assert.equal(detailResult.technical.checkedCount, 0);
assert.equal(detailResult.technical.complete, false);
assert.equal(detailResult.technical.streamBitrateKbps, undefined);

// Production get_stream_data omits row/account identifiers and buffering
// counters. Ownership was established on the exact history row before this
// read; absent retained telemetry stays absent rather than becoming zero.
const liveDetailShape = fixture({ tautulli: command => command === "get_stream_data" ? {
  bitrate: 12000, stream_bitrate: 8000, stream_video_decision: "direct play", video_decision: "direct play",
  stream_audio_decision: "direct play", audio_decision: "direct play", stream_subtitle_decision: "copy",
  stream_video_codec: "h264", stream_audio_codec: "aac", stream_subtitle_codec: "srt"
} : undefined });
const productionShape = await liveDetailShape.api.diagnose({ resolvedUserId: "1001" });
assert.equal(productionShape.technical.checkedCount, 3);
assert.equal(productionShape.technical.complete, true);
assert.equal(productionShape.technical.streamDecisions.directPlay, 3);
assert.equal(productionShape.technical.streamBitrateKbps.maximum, 8000);
assert.equal(productionShape.technical.bufferMetricCount, 0);
assert.equal(productionShape.technical.transcodeSpeed, undefined);
assert.match(productionShape.limitations.join(" "), /errors may not have been retained/);

// Pages and deadlines bound work without silently narrowing the requested
// dates. nextOffset resumes the same exact-account scope, with batch metrics.
const paged = fixture({}, { pageSize: 1, maxPages: 1, maxDetails: 0 });
const firstPage = await paged.api.diagnose({ resolvedUserId: "1001", allTime: true });
assert.equal(firstPage.history.complete, false);
assert.equal(firstPage.history.attemptCount, 1);
assert.equal(firstPage.history.nextOffset, 1);
const nextPage = await paged.api.diagnose({ resolvedUserId: "1001", allTime: true, offset: firstPage.history.nextOffset });
assert.equal(nextPage.history.offset, 1);
assert.equal(nextPage.history.attemptCount, 1);
assert.equal(nextPage.history.nextOffset, 2);
const slow = fixture({ tautulli: (command, options, clock) => { if (command === "get_history") clock.advance(25000); } }, { pageSize: 1 });
const limited = await slow.api.diagnose({ resolvedUserId: "1001", periodYears: 5 });
assert.equal(limited.history.attemptCount, 1);
assert.equal(limited.history.incompleteReason, "work_budget_exhausted");
assert.equal(slow.calls.filter(call => call.command === "get_history").length, 1);
assert.equal(slow.calls.some(call => call.command === "get_stream_data"), false);
assert.equal(limited.range.periodYears, 5);

const stopped = fixture({ tautulli: command => { if (command === "get_users") throw new Error("SECRET user database at http://private"); } });
assert.deepEqual(await stopped.api.resolve({ query: "private-login" }), { available: false, status: "unavailable", complete: false, candidates: [] });
const plexFallback = await stopped.api.diagnose({ resolvedUserId: "1001" });
assert.equal(plexFallback.available, true);
assert.equal(plexFallback.complete, false);
assert.equal(plexFallback.current.plex.attemptCount, 1);
assert.equal(plexFallback.history.available, false);
assert.equal(plexFallback.history.incompleteReason, "account_directory_unavailable");
assert.equal((await fixture().api.diagnose({ resolvedUserId: "9999" })).status, "not_found");
const unconfigured = fixture({}, { configured: { tautulli: false, plex: false } });
assert.equal((await unconfigured.api.resolve({ query: "private-login" })).status, "unavailable");
assert.equal((await unconfigured.api.diagnose({ resolvedUserId: "1001" })).available, false);
assert.equal((await unconfigured.api.diagnose({ resolvedUserId: "1001" })).complete, false);

const capped = fixture({}, { maxCalls: 5, pageSize: 1 });
const capResult = await capped.api.diagnose({ resolvedUserId: "1001" });
assert.equal(capped.calls.length, 5);
assert.equal(capResult.requestCount, 5);
assert.equal(capResult.history.complete, false);
assert.equal(capResult.history.nextOffset, 2);
assert.equal(capped.calls.some(call => call.command === "get_stream_data"), false);

const originalTimeout = AbortSignal.timeout;
const controller = new AbortController();
AbortSignal.timeout = () => controller.signal;
try {
  const aborted = fixture({ tautulli: (command, request) => {
    if (command !== "get_history") return undefined;
    queueMicrotask(() => controller.abort(new DOMException("PRIVATE history timeout", "TimeoutError")));
    return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  } });
  const abortResult = await aborted.api.diagnose({ resolvedUserId: "1001" });
  assert.equal(abortResult.history.incompleteReason, "work_budget_exhausted");
  assert.equal(aborted.calls.filter(call => call.command === "get_history").length, 1);
  assert.equal(aborted.calls.some(call => call.command === "get_stream_data"), false);
  assert.doesNotMatch(JSON.stringify(abortResult), /PRIVATE/);
} finally { AbortSignal.timeout = originalTimeout; }

const noRawStrings = fixture({
  tautulli: command => command === "get_activity" ? { sessions: [{ user_id: "1001", platform: "PRIVATE PERSON", state: "PRIVATE STATE", transcode_decision: "PRIVATE TITLE", buffer_count: true, stream_bitrate: false, local: "PRIVATE ADDRESS", product_version: "PRIVATE VERSION", error: "PRIVATE ERROR" }] } : undefined,
  plex: async () => ({ MediaContainer: { size: 0 } })
});
const projected = await noRawStrings.api.diagnose({ resolvedUserId: "1001" });
assert.equal(projected.current.tautulli.attempts[0].platform, "Other or unavailable");
assert.equal(projected.current.tautulli.attempts[0].state, "unknown");
assert.equal(projected.current.tautulli.attempts[0].streamBitrateKbps, undefined);
assert.equal(projected.current.tautulli.attempts[0].bufferCount, undefined);
assert.deepEqual(projected.current.tautulli.attempts[0].observedErrors, ["reported_error"]);
assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);

const manyCurrent = fixture({ tautulli: command => command === "get_activity" ? { sessions: Array.from({ length: 21 }, () => ({ user_id: "1001", platform: "Roku", state: "buffering" })) } : undefined });
const partialCurrent = await manyCurrent.api.diagnose({ resolvedUserId: "1001" });
assert.equal(partialCurrent.current.tautulli.attemptCount, 21);
assert.equal(partialCurrent.current.tautulli.attempts.length, 20);
assert.equal(partialCurrent.current.tautulli.complete, false);
assert.equal(partialCurrent.complete, false);

const registered = new Map();
registerUserPlaybackDiagnostics({ registerTool: (name, config, callback) => registered.set(name, { ...config, callback }) }, { ...f.deps, jsonText: value => value });
assert.equal(registered.size, 2);
for (const tool of registered.values()) assert.notEqual(tool.annotations?.readOnlyHint, true, "private diagnostics must not enter the ordinary public tool catalog");
assert.ok(registered.get("media_user_playback_diagnostics").inputSchema.resolvedUserId.safeParse("1001").success);
assert.equal(registered.get("media_user_playback_diagnostics").inputSchema.resolvedUserId.safeParse("1001,1002").success, false);
assert.equal((await registered.get("media_resolve_playback_user").callback({ query: "private-login" }, {})).status, "matched");
console.log("Exact account playback diagnostic scope, privacy and budget tests passed");
