import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import * as z from "zod/v4";
import { createPlexDiagnostics, plexLogArchiveEntries, plexScanStatus, registerPlexDiagnosticsTools, runPlexSectionScan } from "./plex-diagnostics.js";
import { scrubSlackGatewayValue } from "../media-issue-agent/src/slack-readonly-gateway.js";

function zipLog(text, name = "Plex Media Server.log") {
  const filename = Buffer.from(name);
  const source = Buffer.from(text);
  const compressed = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(source.length, 24); directory.writeUInt16LE(filename.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(directory.length + filename.length, 12); eocd.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, directory, filename, eocd]);
}
const calls = [];
const token = "private-fixture-token";
let selectedAudio = 10;
let archive = zipLog([
  "Nov 12, 2026 10:00:00.000 ERROR [playback-fixture-one] decoder failed token=secret",
  `Nov 12, 2026 10:00:01.000 DEBUG [playback-fixture-one] auth ${token}`,
  "Nov 12, 2026 10:00:02.000 ERROR [playback-fixture-one-extra] another session",
  "Nov 12, 2026 10:00:03.000 ERROR [playback-fixture-two] unrelated failure",
  "Nov 12, 2026 11:00:00.000 DEBUG [playback-fixture-one] later session line"
].join("\n"));
let decisionError = false;
const metadata = () => ({ MediaContainer: { Metadata: [{ ratingKey: "99", Media: [{ id: 6, Part: [{ id: 7, Stream: [
  { id: 10, streamType: 2, codec: "truehd", selected: selectedAudio === 10 },
  { id: 11, streamType: 2, codec: "ac3", language: "German", channels: 6, selected: selectedAudio === 11 },
  { id: 12, streamType: 3, codec: "srt", selected: false }
] }] }] }] } });
const deps = {
  getService: () => ({ url: "http://plex.test", token }),
  redactText: value => value.replace(/token=\S+/g, "token=[redacted]"),
  async plexApi(path, options = {}) {
    calls.push({ path, ...options });
    if (path === "status/sessions") return { MediaContainer: { Metadata: [
      { ratingKey: "99", parentRatingKey: "98", sessionKey: "2", Session: { id: "playback-fixture-one" }, User: { id: "4" },
        Player: { machineIdentifier: "client-fixture", product: "Plex for TV", model: "Fixture TV", version: "9.1", state: "playing" },
        Media: metadata().MediaContainer.Metadata[0].Media,
        TranscodeSession: { key: "/transcode/sessions/playback-fixture-one", audioDecision: "transcode", videoDecision: "copy", error: "decoder failed" } },
      { ratingKey: "100", sessionKey: "3", Session: { id: "playback-fixture-two" }, User: { id: "5" }, Player: { machineIdentifier: "another-client" } }
    ] } };
    if (path === "transcode/sessions") return { MediaContainer: { TranscodeSession: [
      { key: "/transcode/sessions/playback-fixture-one", error: "decoder failed", exitCode: 1 },
      { key: "/transcode/sessions/playback-fixture-two", error: "unrelated" }
    ] } };
    if (path === "library/metadata/99") return metadata();
    if (path === "library/parts/7") { selectedAudio = options.query.audioStreamID ?? selectedAudio; return { ok: true }; }
    throw new Error("Unexpected mocked Plex endpoint");
  },
  async fetch(url, options) {
    calls.push({ url: String(url), headers: options.headers });
    assert.equal(options.headers["X-Plex-Token"], token);
    assert.equal(options.redirect, "error");
    if (new URL(url).pathname === "/diagnostics/logs") return new Response(archive, { headers: { "content-type": "application/zip" } });
    assert.equal(new URL(url).pathname, "/video/:/transcode/universal/decision");
    assert.equal(new URL(url).searchParams.get("path"), "/library/metadata/99");
    assert.equal(options.headers["X-Plex-Client-Profile-Name"], "Generic");
    if (decisionError) return new Response(token, { status: 500 });
    return Response.json({ MediaContainer: { generalDecisionCode: 1001, generalDecisionText: "Conversion OK", directPlayDecisionCode: 3000,
      directPlayDecisionText: "Client requires conversion", Metadata: metadata().MediaContainer.Metadata } });
  }
};
const api = createPlexDiagnostics(deps);
await assert.rejects(api.playbackAttempts({}), /ratingKey or sessionId/);
const attempt = await api.playbackAttempts({ ratingKey: "99", userId: "4", clientIdentifier: "client-fixture" });
assert.equal(attempt.sessions.length, 1);
assert.equal(attempt.sessions[0].player.model, "Fixture TV");
assert.equal(attempt.sessions[0].player.version, "9.1");
assert.equal(attempt.sessions[0].media[0].parts[0].streams.find(stream => stream.selected).id, 10);
assert.equal((await api.playbackAttempts({ ratingKey: "99", userId: "5" })).matched, false);
assert.equal((await api.playbackAttempts({ ratingKey: "undefined" })).matched, false);
assert.equal((await api.playbackAttempts({ sessionId: "null" })).matched, false);
const transcode = await api.transcodeDiagnostics({ sessionId: "playback-fixture-one", includeLogs: true });
assert.equal(transcode.transcodes.length, 1);
assert.equal(transcode.transcodes[0].exitCode, 1);
assert.equal(transcode.logEvidence.totalMatches, 3);
assert.doesNotMatch(JSON.stringify(transcode), new RegExp(token));
assert.doesNotMatch(JSON.stringify(transcode), /token=secret|unrelated failure|one-extra/);
const scopeConflictCalls = calls.length;
await assert.rejects(api.transcodeDiagnostics({ sessionId: "playback-fixture-two", ratingKey: "99", includeLogs: true }), /conflicts with/);
assert.equal(calls.length, scopeConflictCalls + 1, "scope conflict must not fetch other-session transcode/log evidence");
const logs = await api.logs({ sessionId: "playback-fixture-one", since: "2026-11-12T10:00:00Z", until: "2026-11-12T10:00:03Z", limit: 1 });
assert.equal(logs.totalMatches, 2);
assert.equal(logs.returned, 1);
assert.equal(logs.truncated, true);
await assert.rejects(api.logs({ sessionId: "20261112" }), /precise playback/);
await assert.rejects(api.logs({ sessionId: "playback-fixture-one", since: "2026-11-13T00:00:00Z", until: "2026-11-12T00:00:00Z" }), /since/);
assert.throws(() => plexLogArchiveEntries(Buffer.from("not a zip")), /ZIP archive/);
const bomb = zipLog("small");
const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
bomb.writeUInt32LE(100 * 1024 * 1024, central + 24);
assert.throws(() => plexLogArchiveEntries(bomb), /compression bounds/);
assert.deepEqual(plexLogArchiveEntries(zipLog("secret", "private-database.sqlite")), []);
archive = zipLog("[abc.def12] correct\n[abc.def12.extra] wrong dotted session\n[abc.def12:extra] wrong colon session");
const exactDottedSession = await api.logs({ sessionId: "abc.def12" });
assert.equal(exactDottedSession.totalMatches, 1);
assert.equal(exactDottedSession.records[0].line, "[abc.def12] correct");
archive = Buffer.from("not a zip");
assert.equal((await api.transcodeDiagnostics({ sessionId: "playback-fixture-one", includeLogs: true })).logEvidence.available, false);

const beforeDry = calls.length;
assert.equal((await api.testPlayback({ ratingKey: "99" })).dryRun, true);
assert.equal(calls.length, beforeDry, "playback dry run must not make a decision request");
const decision = await api.testPlayback({ ratingKey: "99", dryRun: false });
assert.equal(decision.decisions.generalDecisionCode, 1001);
assert.equal(decision.playbackVerified, false);
assert.equal(decision.scope, "server_media_decision");
assert.ok(!calls.some(call => /\/start|playMedia/.test(call.url || call.path)), "decision harness must not start playback");
decisionError = true;
await assert.rejects(api.testPlayback({ ratingKey: "99", dryRun: false }), error => /HTTP 500/.test(error.message) && !error.message.includes(token));

const preference = await api.setStreams({ ratingKey: "99", partId: 7, audioStreamId: 11 });
assert.equal(preference.dryRun, true);
assert.equal(preference.scope, "authenticated_plex_user");
assert.equal(calls.filter(call => call.method === "PUT").length, 0);
await assert.rejects(api.setStreams({ ratingKey: "99", partId: 8, audioStreamId: 11, dryRun: false }), /does not belong/);
await assert.rejects(api.setStreams({ ratingKey: "99", partId: 7, audioStreamId: 12, dryRun: false }), /stream does not belong/);
const changed = await api.setStreams({ ratingKey: "99", partId: 7, audioStreamId: 11, subtitleStreamId: 0, dryRun: false });
assert.equal(changed.verification.status, "passed");
assert.equal(calls.find(call => call.method === "PUT").query.allParts, 0);
for (const invalidInventory of [undefined, [], [{ id: 10, streamType: 2, selected: true }, { id: 11, streamType: 2, selected: true }, { id: 12, streamType: 3, selected: false }]]) {
  let reads = 0;
  const missingEvidence = createPlexDiagnostics({ ...deps, async plexApi(path, options) {
    if (path !== "library/metadata/99") return deps.plexApi(path, options);
    const result = metadata();
    if (++reads > 1) result.MediaContainer.Metadata[0].Media[0].Part[0].Stream = invalidInventory;
    return result;
  } });
  const unverified = await missingEvidence.setStreams({ ratingKey: "99", partId: 7, audioStreamId: 11, subtitleStreamId: 0, dryRun: false });
  assert.equal(unverified.verification.status, "failed", "missing or ambiguous stream selection is not verification");
}

const scanCalls = [];
assert.equal((await runPlexSectionScan(async (path, options) => { scanCalls.push({ path, ...options }); if (options.method === "POST") throw new Error("404 Not Found"); return {}; }, "2", "/tv/Exact Show")).method, "GET");
assert.deepEqual(scanCalls.map(call => call.method), ["POST", "GET"]);
assert.deepEqual(scanCalls[1].query, { path: "/tv/Exact Show" });
let unauthorizedCalls = 0;
await assert.rejects(runPlexSectionScan(async () => { unauthorizedCalls += 1; throw new Error("401 Unauthorized"); }, "2"), /401/);
assert.equal(unauthorizedCalls, 1);
const scanApi = async endpoint => endpoint === "library/sections"
  ? { MediaContainer: { Directory: [{ key: "2", refreshing: false, scannedAt: 1794466837 }] } }
  : { MediaContainer: { Activity: [{ uuid: "private-scan-id", type: "library.scan.Private Person", title: "Private Person /private/media", Context: { librarySectionID: 2 }, progress: 50 }] } };
const running = await plexScanStatus(scanApi, { sectionKey: "2" });
assert.equal(running.state, "running");
assert.deepEqual(running.activities, [{ category: "scan", progress: 50 }]);
assert.doesNotMatch(JSON.stringify(scrubSlackGatewayValue(running)), /Private Person|private-scan-id|private\/media/);
const idle = await plexScanStatus(async endpoint => endpoint === "activities" ? { MediaContainer: { Activity: [] } } : scanApi(endpoint), { sectionKey: "2" });
assert.equal(idle.state, "idle");
assert.equal(idle.completionVerified, false);
assert.equal((await plexScanStatus(async () => { throw new Error("Unavailable"); }, { sectionKey: "2" })).state, "unknown");

const registry = new Map();
registerPlexDiagnosticsTools({ registerTool(name, spec, handler) { registry.set(name, { spec, handler }); } }, { ...deps, jsonText: value => value });
for (const name of ["plex_playback_attempt_diagnostics", "plex_issue_session_correlation", "plex_transcode_session_diagnostics", "plex_transcoder_logs_for_session", "plex_test_playback", "plex_set_stream_preferences", "plex_set_default_stream_or_mkv_track_flags"]) {
  assert.ok(registry.has(name));
  assert.notEqual(registry.get(name).spec.annotations?.readOnlyHint, true, "private diagnostics and writes stay out of public chat");
}
const tool = registry.get("plex_test_playback");
const defaultInput = z.object(tool.spec.inputSchema).parse({ ratingKey: "99" });
assert.equal((await tool.handler(defaultInput)).dryRun, true);
assert.throws(() => z.object(tool.spec.inputSchema).parse({ ratingKey: "../../other" }));
assert.throws(() => z.object(tool.spec.inputSchema).parse({ ratingKey: ".." }));
console.log("Plex diagnostics tests passed");
