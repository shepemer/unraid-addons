import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDownloadRepairCapabilities } from "./download-repair.js";

// These fixtures deliberately exercise the dependency boundary: every request
// must carry the same operation signal and a shrinking remaining-time budget.
const epoch = Date.parse("2026-11-12T00:00:00Z");
const series = { id: 7, tvdbId: 700, monitored: true, title: "Deadline fixture" };
const episodes = Array.from({ length: 30 }, (_, index) => ({
  id: index + 100, seriesId: 7, seasonNumber: 5, episodeNumber: index + 1,
  monitored: true, airDateUtc: "2020-01-01", hasFile: false, episodeFileId: 0
}));
const releases = Array.from({ length: 50 }, (_, index) => ({
  guid: `release-${index}`, indexerId: 3, title: `Deadline.fixture.S05E01.${index}`,
  protocol: "torrent", categories: [{ id: 5040 }], tvdbId: 700
}));
const exactInput = { seriesId: 7, tvdbId: 700, seasonNumber: 5, episodeNumber: 1, limit: 50 };

function fixture(handle = () => undefined, extra = {}) {
  let clock = epoch;
  const calls = [];
  const sleeps = [];
  const state = { advance: ms => { clock += ms; }, now: () => clock, calls, sleeps };
  const arrApi = async (service, version, resource, options = {}) => {
    calls.push({ service, version, resource, options, at: clock });
    const supplied = await handle({ service, version, resource, options, state });
    if (supplied !== undefined) return supplied;
    if (resource === "series/7") return series;
    if (resource === "episode") return episodes;
    if (resource === "search") return releases;
    if (resource === "parse") return { series, episodes: [{ id: 100 }] };
    if (resource === "release") return releases.map(release => ({
      ...release, episodeIds: [options.query.episodeId], downloadAllowed: true, rejections: []
    }));
    throw new Error(`Unexpected request: ${service}/${resource}`);
  };
  const api = createDownloadRepairCapabilities({
    arrApi, now: state.now, delay: async ms => { sleeps.push(ms); state.advance(ms); },
    qbitRequest: async () => { throw new Error("Unexpected client mutation"); },
    requireService: () => { throw new Error("Unexpected service credentials"); },
    ...extra
  });
  return { api, ...state };
}

function assertSharedBudget(calls, milliseconds) {
  assert.ok(calls.length > 0);
  const signal = calls[0].options.signal;
  assert.ok(signal instanceof AbortSignal);
  for (const call of calls) {
    assert.equal(call.options.signal, signal, "one operation must share cancellation across all requests");
    assert.equal(call.options.timeoutMs, milliseconds - (call.at - epoch));
    assert.ok(call.options.timeoutMs > 0);
    assert.equal(call.options.method, undefined, "diagnostic requests cannot mutate services");
  }
}

async function controlledDeadlines(run) {
  const originalTimeout = AbortSignal.timeout;
  const timers = [];
  AbortSignal.timeout = milliseconds => {
    const controller = new AbortController();
    timers.push({ milliseconds, controller });
    return controller.signal;
  };
  try { await run(timers); }
  finally { AbortSignal.timeout = originalTimeout; }
}

function rejectOnAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Large legitimate requests stop at the advertised request and candidate caps.
{
  const f = fixture();
  const result = await f.api.missingCandidateMatrix({ seriesId: 7, maxEpisodes: 20, candidatesPerEpisode: 5 });
  assert.equal(f.calls.length, 22);
  assert.equal(f.calls.filter(call => call.resource === "release").length, 20);
  assert.deepEqual(f.calls.filter(call => call.resource === "release").map(call => call.options.query.episodeId), episodes.slice(0, 20).map(episode => episode.id));
  assert.equal(result.complete, false, "unsearched requested episodes must remain explicit");
  assert.equal(result.searchedEpisodeCount, 20);
  assert.ok(result.episodes.every(episode => episode.candidateCount === 50 && episode.candidates.length === 5));
  assertSharedBudget(f.calls, 25000);
}
{
  const f = fixture();
  const result = await f.api.exactTvSearch(exactInput);
  assert.equal(f.calls.length, 23);
  assert.equal(f.calls.filter(call => call.resource === "parse").length, 20);
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "budget_exhausted");
  assert.equal(result.checked, 20);
  assert.equal(result.candidates.length, 20);
  assert.ok(result.candidates.every(candidate => candidate.parserMatches && !candidate.safeToGrab && candidate.requiresSonarrApproval));
  assertSharedBudget(f.calls, 25000);
}

// A slow response consumes the shared deadline; later requests never begin.
for (const operation of ["missingCandidateMatrix", "exactTvSearch"]) {
  let checked = 0;
  const targetResource = operation === "missingCandidateMatrix" ? "release" : "parse";
  const f = fixture(({ resource, state }) => {
    if (resource === targetResource) { checked++; state.advance(25000); }
  });
  const result = await f.api[operation](operation === "exactTvSearch" ? exactInput : { seriesId: 7, maxEpisodes: 20 });
  assert.equal(checked, 1);
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "budget_exhausted");
  assert.equal(operation === "exactTvSearch" ? result.candidates.length : result.episodes.length, 1, "completed evidence survives deadline exhaustion");
  assertSharedBudget(f.calls, 25000);
}

// An in-flight operation is actually aborted, not merely prevented from making
// its next request, and observations completed before the abort remain usable.
for (const operation of ["missingCandidateMatrix", "exactTvSearch"]) {
  await controlledDeadlines(async timers => {
    let checks = 0;
    const targetResource = operation === "missingCandidateMatrix" ? "release" : "parse";
    const f = fixture(({ resource, options, state }) => {
      if (resource !== targetResource) return undefined;
      if (++checks === 1) { state.advance(3500); return undefined; }
      queueMicrotask(() => timers[0].controller.abort(new DOMException("Operation timed out", "TimeoutError")));
      return rejectOnAbort(options.signal);
    });
    const result = await f.api[operation](operation === "exactTvSearch" ? exactInput : { seriesId: 7, maxEpisodes: 20 });
    assert.deepEqual(timers.map(timer => timer.milliseconds), [25000]);
    assert.equal(checks, 2);
    assert.equal(result.complete, false);
    assert.equal(result.incompleteReason, "budget_exhausted");
    assert.equal(operation === "exactTvSearch" ? result.candidates.length : result.episodes.length, 1);
    assert.equal(f.calls.at(-1).options.signal.aborted, true);
    assertSharedBudget(f.calls, 25000);
  });
}

// An incomplete first snapshot is bounded even when the caller supplies many
// exact targets; already verified imports are not discarded on the 20-call cap.
{
  const f = fixture(({ resource }) => {
    if (resource === "queue/details") return [];
    if (resource === "history") return { records: [{
      id: 1, downloadId: "exact-download", episodeId: 100,
      eventType: "downloadFolderImported", data: { episodeFileId: 500 }
    }] };
    if (resource.startsWith("episode/")) {
      const id = Number(resource.split("/")[1]);
      return { id, hasFile: id === 100, episodeFileId: id === 100 ? 500 : 0 };
    }
  });
  const result = await f.api.watchImport({ service: "sonarr", downloadId: "exact-download", episodeIds: episodes.map(episode => episode.id), waitMs: 0 });
  assert.equal(f.calls.length, 20);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.incompleteReason, "budget_exhausted");
  assert.equal(result.checkedTargets, 18);
  assert.equal(result.verifiedImportedTargets, 1);
  assert.deepEqual(f.sleeps, []);
  assertSharedBudget(f.calls, 10000);
}

await controlledDeadlines(async timers => {
  const f = fixture(({ resource, options, state }) => {
    if (resource === "queue/details") return [];
    if (resource === "history") return { records: [{
      id: 1, downloadId: "exact-download", episodeId: 100,
      eventType: "downloadFolderImported", data: { episodeFileId: 500 }
    }] };
    if (resource === "episode/100") {
      state.advance(1000);
      return { id: 100, hasFile: true, episodeFileId: 500 };
    }
    if (resource === "episode/101") {
      queueMicrotask(() => timers[0].controller.abort(new DOMException("Operation timed out", "TimeoutError")));
      return rejectOnAbort(options.signal);
    }
  });
  const result = await f.api.watchImport({ service: "sonarr", downloadId: "exact-download", episodeIds: [100, 101, 102], waitMs: 5000 });
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.incompleteReason, "budget_exhausted");
  assert.equal(result.checkedTargets, 1);
  assert.equal(result.verifiedImportedTargets, 1);
  assert.deepEqual(f.calls.map(call => call.resource), ["queue/details", "history", "episode/100", "episode/101"]);
  assert.equal(f.calls.at(-1).options.signal.aborted, true);
  assert.deepEqual(f.sleeps, []);
  assertSharedBudget(f.calls, 5000);
});

// Polling shares its remaining time with requests and never sleeps past it.
{
  const requests = [];
  let f;
  f = fixture(undefined, { bazarrApi: async (resource, options) => {
    requests.push({ resource, options, at: f.now() });
    f.advance(300);
    return { data: [{ sonarrEpisodeId: 100, subtitles: [{ code2: "en" }] }] };
  } });
  const result = await f.api.watchImport({ service: "bazarr", episodeIds: [100, 101], language: "en", waitMs: 1000 });
  assert.equal(requests.length, 1, "a new poll cannot start at the expired deadline");
  assert.deepEqual(f.sleeps, [700]);
  assert.equal(result.elapsedMs, 1000);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.incompleteReason, "budget_exhausted");
  assert.equal(result.targetsWithSubtitles, 1);
  assertSharedBudget(requests, 1000);
}

// Cancel while qBittorrent's initial read is unresolved. Even an upstream
// adapter which returns late instead of rejecting cannot cross into upload.
{
  const info = Buffer.concat([Buffer.from("d6:lengthi1e4:name7:fixture12:piece lengthi16384e6:pieces20:"), Buffer.alloc(20, 1), Buffer.from("e")]);
  const torrent = Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("e")]);
  const hash = createHash("sha1").update(info).digest("hex");
  const release = { ...releases[0], infoHash: hash, downloadUrl: "http://prowlarr.test/prowlarr/3/download?link=opaque" };
  let beginRead;
  let finishRead;
  let qbitSignal;
  let uploads = 0;
  const readStarted = new Promise(resolve => { beginRead = resolve; });
  const readResponse = new Promise(resolve => { finishRead = resolve; });
  const f = fixture(({ resource }) => resource === "search" ? [release] : undefined, {
    requireService: () => ({ url: "http://prowlarr.test/prowlarr", apiKey: "test-secret" }),
    fetch: async () => new Response(torrent),
    qbitRequest: async (resource, options) => {
      if (resource === "torrents/add") { uploads++; return "Ok."; }
      assert.match(resource, /^torrents\/info\?hashes=/);
      qbitSignal = options.signal;
      beginRead();
      return readResponse;
    }
  });
  const job = await f.api.importProwlarrTorrent({ guid: release.guid, indexerId: release.indexerId, title: release.title, dryRun: false, waitMs: 0 });
  await readStarted;
  const cancellation = f.api.cancelUrlJob({ jobId: job.jobId, dryRun: false });
  assert.equal(cancellation.cancelled, true);
  assert.equal(qbitSignal.aborted, true);
  finishRead([]);
  await f.api.jobs.get(job.jobId).promise;
  assert.equal(uploads, 0);
  assert.equal((await f.api.urlJobStatus({ jobId: job.jobId })).status, "cancelled");
}

// The 60-second managed handoff budget also stops a late, non-cooperative
// dependency from initiating an upload or a later verification request.
for (const expiresDuring of ["lookup", "upload"]) {
  const info = Buffer.concat([Buffer.from("d6:lengthi1e4:name7:fixture12:piece lengthi16384e6:pieces20:"), Buffer.alloc(20, 1), Buffer.from("e")]);
  const torrent = Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("e")]);
  const hash = createHash("sha1").update(info).digest("hex");
  const release = { ...releases[0], infoHash: hash, downloadUrl: "http://prowlarr.test/prowlarr/3/download?link=opaque" };
  const clientCalls = [];
  let f;
  f = fixture(({ resource }) => resource === "search" ? [release] : undefined, {
    requireService: () => ({ url: "http://prowlarr.test/prowlarr", apiKey: "test-secret" }),
    fetch: async () => new Response(torrent),
    qbitRequest: async (resource, options) => {
      clientCalls.push({ resource, options, at: f.now() });
      if (resource.startsWith("torrents/info")) {
        if (expiresDuring === "lookup") f.advance(60000);
        return [];
      }
      assert.equal(resource, "torrents/add");
      f.advance(60000);
      return "Ok.";
    }
  });
  const started = await f.api.importProwlarrTorrent({ guid: release.guid, indexerId: release.indexerId, title: release.title, dryRun: false, waitMs: 0 });
  const job = f.api.jobs.get(started.jobId);
  await job.promise;
  assert.equal(clientCalls.length, expiresDuring === "lookup" ? 1 : 2);
  assert.equal(clientCalls.filter(call => call.resource === "torrents/add").length, expiresDuring === "lookup" ? 0 : 1);
  assert.notEqual(job.status, "verified");
  assert.match(job.error, /budget|timeout/i);
  if (expiresDuring === "upload") assert.equal(job.status, "handoff_unknown", "a timed-out upload cannot safely be retried or declared absent");
  assert.ok(clientCalls.every(call => call.options.signal === clientCalls[0].options.signal));
  assert.ok(clientCalls.every(call => call.options.timeoutMs > 0 && call.options.timeoutMs <= 60000));
}

console.log("Download repair deadline and cancellation tests passed");
