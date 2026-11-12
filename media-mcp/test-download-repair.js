import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { createDownloadRepairCapabilities, exactTorrentFromAddResult, registerDownloadRepairTools, torrentIdentity } from "./download-repair.js";

const info = Buffer.concat([Buffer.from("d6:lengthi1e4:name7:fixture12:piece lengthi16384e6:pieces20:"), Buffer.alloc(20, 1), Buffer.from("e")]);
const torrent = Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("e")]);
const hash = createHash("sha1").update(info).digest("hex");
assert.equal(torrentIdentity(torrent).infoHashV1, hash);
const v2Info = Buffer.from("d9:file treede12:meta versioni2e4:name7:fixture12:piece lengthi16384ee");
const v2 = torrentIdentity(Buffer.concat([Buffer.from("d4:info"), v2Info, Buffer.from("e")]));
assert.equal(v2.infoHashV1, null);
assert.equal(v2.infoHashV2, createHash("sha256").update(v2Info).digest("hex"));
for (const bytes of [Buffer.from("<html>not torrent</html>"), Buffer.from("d4:infoi1ee"), Buffer.concat([torrent, Buffer.from("x")]), Buffer.from("d4:infoe"), Buffer.alloc(16 * 1024 * 1024 + 1)]) assert.throws(() => torrentIdentity(bytes));
assert.throws(() => torrentIdentity(Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("4:info"), info, Buffer.from("e")])));
assert.equal(exactTorrentFromAddResult([{ hash: "a".repeat(40), name: "Same title" }], { title: "Same title" }, { pending_count: 1 }), null);
assert.equal(exactTorrentFromAddResult([{ hash }], {}, { added_torrent_ids: [hash] }).hash, hash);
assert.equal(exactTorrentFromAddResult([{ hash }], { magnetUrl: `magnet:?xt=urn:btih:${hash}` }, "Ok.").hash, hash);

function fixture(overrides = {}) {
  const calls = [];
  const release = { guid: "release-guid", indexerId: 5, title: "Fixture.S01E01", protocol: "torrent", downloadUrl: "http://prowlarr.test/prowlarr/5/download?link=opaque", infoHash: hash, categories: [{ id: 5040 }], tvdbId: 100 };
  const episodes = [
    { id: 11, seriesId: 1, seasonNumber: 1, episodeNumber: 1, title: "Episode 1", monitored: true, airDateUtc: "2020-01-01", hasFile: false, episodeFileId: 0 },
    { id: 12, seriesId: 1, seasonNumber: 1, episodeNumber: 2, title: "Episode 2", monitored: true, airDateUtc: "2020-01-01", hasFile: false, episodeFileId: 0 },
    { id: 13, seriesId: 1, seasonNumber: 1, episodeNumber: 3, title: "Unaired", monitored: true, airDateUtc: "2999-01-01", hasFile: false },
    { id: 14, seriesId: 1, seasonNumber: 2, episodeNumber: 1, title: "Unmonitored", monitored: false, airDateUtc: "2020-01-01", hasFile: false },
    { id: 15, seriesId: 1, seasonNumber: 1, episodeNumber: 4, title: "Available", monitored: true, airDateUtc: "2020-01-01", hasFile: true, episodeFileId: 100 },
    { id: 99, seriesId: 99, seasonNumber: 1, episodeNumber: 1, monitored: true, airDateUtc: "2020-01-01", hasFile: false }
  ];
  let clock = Date.parse("2026-11-12T00:00:00Z");
  const state = {
    torrents: [], movie: { id: 2, title: "Movie", monitored: true, qualityProfileId: 3, path: "/private/movie", hasFile: true, movieFile: { id: 20 } },
    profile: { id: 3, name: "Original profile", minFormatScore: 0, formatItems: [{ format: 1, name: "Existing", score: 10 }], unrelated: "preserve" },
    format: null, copiedProfile: null, release, episodes, importedIds: [], queue: [], fetchCalls: 0, uploadCalls: 0, metadataBytes: torrent, importProgress: false, subtitlePresent: false
  };
  const arrApi = async (service, version, resource, options = {}) => {
    calls.push({ service, version, resource, ...options });
    if (resource === "queue/details") return state.queue;
    if (service === "prowlarr" && resource === "search") return overrides.searchResults || [state.release];
    if (service === "sonarr" && resource === "series/1") return { id: 1, tvdbId: 100, title: "Series", monitored: true };
    if (service === "sonarr" && resource === "episode") return state.episodes;
    if (service === "sonarr" && resource.startsWith("episode/")) return state.episodes.find(episode => episode.id === Number(resource.split("/")[1]));
    if (service === "sonarr" && resource === "release") return [
      { ...release, episodeIds: [Number(options.query.episodeId)], downloadAllowed: true, rejections: [], quality: { quality: { name: "WEB-1080p" } }, customFormatScore: 10 },
      { ...release, guid: "wrong-episode", episodeIds: [999], downloadAllowed: true, rejections: [] },
      { ...release, guid: "rejected", episodeIds: [Number(options.query.episodeId)], downloadAllowed: false, rejections: ["Quality profile rejects this release"] }
    ];
    if (service === "sonarr" && resource === "parse") return options.query.title === "Wrong.Show.S01E01" ? { series: { id: 99 }, episodes: [{ id: 99 }] } : { series: { id: 1 }, episodes: [{ id: 11 }] };
    if (service === "radarr" && resource === "movie/2") {
      if (options.method === "PUT") state.movie = options.body;
      return structuredClone(state.movie);
    }
    if (service === "radarr" && resource === "moviefile/20") return { id: 20, movieId: 2, path: "/private/movie/file.mkv", dateAdded: "2026-11-11T00:00:00Z" };
    if (service === "radarr" && resource === "moviefile/21") return { id: 21, movieId: 99, path: "/other/file" };
    if (service === "radarr" && resource === "history/movie") return overrides.movieHistory || [
      { id: 30, movieId: 2, eventType: "downloadFolderImported", sourceTitle: "Movie.Bad[Source].1080p", data: { movieFileId: 20, importedPath: "/private/movie/file.mkv" } },
      { id: 31, movieId: 99, eventType: "downloadFolderImported", sourceTitle: "Other movie" }
    ];
    if (service === "radarr" && resource === "customformat") {
      if (options.method === "POST") state.format = { ...options.body, id: 40 };
      return options.method === "POST" ? structuredClone(state.format) : [{ id: 1, name: "Existing" }, ...(state.format ? [structuredClone(state.format)] : [])];
    }
    if (service === "radarr" && resource === "customformat/40") {
      if (options.method === "PUT") state.format = options.body;
      return structuredClone(state.format);
    }
    if (service === "radarr" && resource === "qualityprofile" && options.method === "POST") {
      state.copiedProfile = { ...options.body, id: 4 };
      return structuredClone(state.copiedProfile);
    }
    if (service === "radarr" && resource === "qualityprofile/4") return structuredClone(state.copiedProfile);
    if (service === "radarr" && resource === "qualityprofile/3") {
      if (options.method === "PUT") state.profile = options.body;
      return structuredClone(state.profile);
    }
    if (resource === "history") {
      if (state.importProgress) {
        state.importedIds.push(11, 12);
        for (const episode of state.episodes.filter(episode => [11, 12].includes(episode.id))) { episode.hasFile = true; episode.episodeFileId = 100 + episode.id; }
      }
      return { totalRecords: state.importedIds.length + 1, records: [
        ...state.importedIds.map(episodeId => ({ id: episodeId + 100, downloadId: hash, episodeId, movieId: 2, eventType: "downloadFolderImported", date: overrides.importDate || "2026-11-11T00:00:00Z", data: overrides.importData || { episodeFileId: 100 + episodeId, movieFileId: 20 } })),
        { id: 999, downloadId: "unrelated-download", episodeId: 12, movieId: 2, eventType: "downloadFolderImported" }
      ] };
    }
    throw new Error(`Unexpected fixture ${service} ${resource}`);
  };
  const qbitRequest = async (resource, options = {}) => {
    calls.push({ service: "qbit", resource, ...options });
    if (resource.startsWith("torrents/info")) return state.torrents;
    if (resource === "torrents/add") {
      state.uploadCalls++;
      assert.ok(options.formData instanceof FormData);
      assert.equal(options.formData.get("urls"), null, "byte handoff must not enqueue a URL");
      const bytes = Buffer.from(await options.formData.get("torrents").arrayBuffer());
      assert.deepEqual(bytes, torrent);
      assert.equal(options.formData.get("category"), "sonarr");
      if (overrides.uploadFailure) throw new Error("qBit request timed out");
      if (!overrides.unverified) state.torrents.push({ hash, name: "Fixture" });
      return { added_torrent_ids: [hash], success_count: 1, pending_count: 0, failure_count: 0 };
    }
    throw new Error(`Unexpected qbit ${resource}`);
  };
  const api = createDownloadRepairCapabilities({
    arrApi, qbitRequest, requireService: () => ({ url: "http://prowlarr.test/prowlarr", apiKey: "PRIVATE-KEY" }),
    arrQueueDetails: async () => state.queue,
    bazarrApi: async () => ({ data: overrides.subtitleRows || [{ sonarrEpisodeId: 11, subtitles: state.subtitlePresent ? [{ code2: "en", forced: false, hi: false }] : [] }] }),
    now: () => clock,
    delay: async ms => { clock += ms; if (overrides.onDelay) overrides.onDelay(state); },
    fetch: overrides.fetch || (async (url, options) => {
      state.fetchCalls++;
      assert.equal(url.origin, "http://prowlarr.test");
      assert.equal(options.headers["X-Api-Key"], "PRIVATE-KEY");
      assert.equal(options.redirect, "manual");
      return new Response(state.metadataBytes, { status: 200, headers: { "content-type": "application/x-bittorrent" } });
    })
  });
  return { api, state, calls };
}

const missingFixture = fixture();
const missing = await missingFixture.api.seriesMissing({ seriesId: 1, seasonNumber: 1 });
assert.equal(missing.missingCount, 3);
assert.equal(missing.monitoredAiredMissingCount, 2);
assert.equal(missing.episodes.some(episode => episode.episodeId === 99), false);
assert.doesNotMatch(JSON.stringify(missing), /private|path/);
const matrix = await missingFixture.api.missingCandidateMatrix({ seriesId: 1, maxEpisodes: 1 });
assert.equal(matrix.complete, false);
assert.equal(matrix.episodes[0].candidates[0].safeToGrab, true);
assert.equal(matrix.episodes[0].candidates[1].safeToGrab, false);
assert.equal(matrix.episodes[0].candidates[2].safeToGrab, false);
await assert.rejects(() => missingFixture.api.missingCandidateMatrix({ seriesId: 1, episodeIds: [99] }), /scope/);
const searchFixture = fixture();
const exact = await searchFixture.api.exactTvSearch({ seriesId: 1, tvdbId: 100, seasonNumber: 1, episodeNumber: 1 });
assert.equal(exact.candidates.length, 1);
assert.equal(exact.candidates[0].parserMatches, true);
assert.equal(exact.candidates[0].safeToGrab, false, "Prowlarr identity does not bypass Sonarr quality approval");
assert.doesNotMatch(JSON.stringify(exact), /downloadUrl|PRIVATE/);
const searchCall = searchFixture.calls.find(call => call.service === "prowlarr");
assert.equal(searchCall.query.type, "tvsearch");
assert.equal(searchCall.query.query, "{tvdbid:100}{season:1}{episode:1}");
assert.equal(searchCall.query.categories, "5000");
await assert.rejects(() => searchFixture.api.exactTvSearch({ seriesId: 1, tvdbId: 101, seasonNumber: 1, episodeNumber: 1 }), /does not match/);
const rejectedSearch = fixture({ searchResults: [
  { title: "Movie", categories: [{ id: 2000 }] }, { title: "Wrong.Show.S01E01", categories: [{ id: 5040 }] }, { title: "Wrong TVDB", categories: [{ id: 5040 }], tvdbId: 999 }
] });
assert.equal((await rejectedSearch.api.exactTvSearch({ seriesId: 1, tvdbId: 100, seasonNumber: 1, episodeNumber: 1 })).candidates.length, 0);

const movieFixture = fixture();
await movieFixture.api.updateMovieMonitoring({ movieId: 2, monitored: false });
assert.equal(movieFixture.state.movie.monitored, true, "monitoring defaults to dry run");
const monitoring = await movieFixture.api.updateMovieMonitoring({ movieId: 2, monitored: false, expectedMonitored: true, dryRun: false });
assert.equal(monitoring.verified, true);
assert.equal(movieFixture.state.movie.path, "/private/movie", "unrelated movie fields are preserved");
assert.doesNotMatch(JSON.stringify(monitoring), /private|path/);
await assert.rejects(() => movieFixture.api.updateMovieMonitoring({ movieId: 2, monitored: true, expectedMonitored: true, dryRun: false }), /changed since/);
const drySource = await movieFixture.api.suppressMovieSource({ movieId: 2, movieFileId: 20 });
assert.equal(drySource.dryRun, true);
assert.equal(movieFixture.state.format, null);
const source = await movieFixture.api.suppressMovieSource({ movieId: 2, historyId: 30, sourceTitle: "Movie.Bad[Source].1080p", dryRun: false });
assert.equal(source.verified, true);
assert.equal(source.nativeBlocklist, false);
assert.equal(source.searchQueued, false);
assert.equal(movieFixture.state.movie.monitored, false);
assert.equal(movieFixture.state.profile.unrelated, "preserve");
assert.equal(movieFixture.state.profile.formatItems[0].format, 1);
assert.equal(movieFixture.state.profile.formatItems.length, 1, "shared original profile is not modified");
assert.equal(movieFixture.state.movie.qualityProfileId, 4, "only the target movie is assigned a dedicated copy");
assert.equal(movieFixture.state.copiedProfile.formatItems[0].score, 10);
assert.deepEqual(drySource.scope.affectedMovieIds, [2]);
assert.equal(drySource.scope.modifiesOriginalProfile, false);
assert.equal(movieFixture.calls.some(call => call.resource === "qualityprofile/3" && call.method === "PUT"), false);
assert.match(movieFixture.state.format.specifications[0].fields[0].value, /\\\[Source\\\]/);
assert.equal(movieFixture.calls.some(call => /history\/failed|^command$/.test(call.resource)), false);
await assert.rejects(() => movieFixture.api.suppressMovieSource({ movieId: 2, movieFileId: 21, dryRun: false }), /does not belong/);
await assert.rejects(() => movieFixture.api.suppressMovieSource({ movieId: 2, historyId: 31, dryRun: false }), /No exact/);
const strongScores = fixture();
strongScores.state.profile.formatItems[0].score = 500000;
const suppressedStrong = await strongScores.api.suppressMovieSource({ movieId: 2, movieFileId: 20, dryRun: false });
assert.equal(suppressedStrong.verified, true);
assert.ok(suppressedStrong.maximumSuppressedScore < suppressedStrong.minimumAcceptedScore, "all possible positive scores cannot outweigh the exact-source penalty");
assert.equal(strongScores.state.profile.formatItems[0].score, 500000, "other movies retain their existing score");
const underflowScores = fixture();
underflowScores.state.profile.formatItems[0].score = -2147483640;
await assert.rejects(() => underflowScores.api.suppressMovieSource({ movieId: 2, movieFileId: 20, dryRun: false }), /score range/);
assert.equal(underflowScores.calls.some(call => call.method === "POST" || call.method === "PUT"), false, "unsafe score combinations are rejected before any mutation");
const staleSource = fixture({ movieHistory: [{ id: 30, movieId: 2, eventType: "downloadFolderImported", sourceTitle: "Old source", data: { movieFileId: 999, importedPath: "/private/movie/file.mkv" } }] });
await assert.rejects(() => staleSource.api.suppressMovieSource({ movieId: 2, movieFileId: 20, historyId: 30 }), /No exact/, "same path cannot override a mismatched imported file ID");
const ambiguousSource = fixture({ movieHistory: [1, 2].map(id => ({ id, movieId: 2, eventType: "downloadFolderImported", sourceTitle: `Source ${id}`, data: { movieFileId: 20 } })) });
await assert.rejects(() => ambiguousSource.api.suppressMovieSource({ movieId: 2, movieFileId: 20 }), /unambiguous/);

const input = { guid: "release-guid", indexerId: 5, title: "Fixture.S01E01", category: "sonarr", waitMs: 0 };
const handoff = fixture();
assert.equal((await handoff.api.importProwlarrTorrent(input)).dryRun, true);
assert.equal(handoff.state.fetchCalls, 0);
assert.equal(handoff.state.uploadCalls, 0);
const started = await handoff.api.importProwlarrTorrent({ ...input, dryRun: false });
await handoff.api.jobs.get(started.jobId).promise;
const verified = await handoff.api.urlJobStatus({ jobId: started.jobId });
assert.equal(verified.status, "verified");
assert.equal(verified.trackedDownloadId, hash);
assert.equal(verified.added, true);
assert.equal(handoff.state.uploadCalls, 1);
assert.doesNotMatch(JSON.stringify(verified), /PRIVATE-KEY|downloadUrl|opaque/);
assert.equal((await handoff.api.importProwlarrTorrent({ ...input, dryRun: false })).jobId, started.jobId);
assert.equal(handoff.state.uploadCalls, 1, "repeated managed handoff is idempotent");
assert.equal(handoff.api.cancelUrlJob({ jobId: started.jobId, dryRun: false }).cancelled, false);
assert.equal((await handoff.api.urlJobStatus({ jobId: "native-url-job" })).status, "unknown");
assert.equal(handoff.api.cancelUrlJob({ jobId: "native-url-job", dryRun: false }).cancelled, false);

const mismatch = fixture();
mismatch.state.release.infoHash = "0".repeat(40);
const mismatchJob = await mismatch.api.importProwlarrTorrent({ ...input, dryRun: false });
await mismatch.api.jobs.get(mismatchJob.jobId).promise;
assert.equal((await mismatch.api.urlJobStatus({ jobId: mismatchJob.jobId })).status, "failed");
assert.equal(mismatch.state.uploadCalls, 0);
const invalid = fixture();
invalid.state.metadataBytes = Buffer.from("private HTML error");
const invalidJob = await invalid.api.importProwlarrTorrent({ ...input, dryRun: false });
await invalid.api.jobs.get(invalidJob.jobId).promise;
assert.equal(invalid.state.uploadCalls, 0);
assert.equal((await invalid.api.urlJobStatus({ jobId: invalidJob.jobId })).status, "failed");
const foreign = fixture();
foreign.state.release.downloadUrl = "http://untrusted.test/5/download";
const foreignJob = await foreign.api.importProwlarrTorrent({ ...input, dryRun: false });
await foreign.api.jobs.get(foreignJob.jobId).promise;
assert.equal(foreign.state.fetchCalls, 0, "do not send Prowlarr credentials to a foreign origin");
assert.equal(foreign.state.uploadCalls, 0);
const redirect = fixture({ fetch: async () => new Response(null, { status: 302, headers: { location: "http://foreign.test/file" } }) });
const redirectJob = await redirect.api.importProwlarrTorrent({ ...input, dryRun: false });
await redirect.api.jobs.get(redirectJob.jobId).promise;
assert.equal(redirect.state.uploadCalls, 0);
assert.match((await redirect.api.urlJobStatus({ jobId: redirectJob.jobId })).error, /redirect/);

const cancelled = fixture({ fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })) });
const cancelJob = await cancelled.api.importProwlarrTorrent({ ...input, dryRun: false });
assert.equal(cancelled.api.cancelUrlJob({ jobId: cancelJob.jobId }).dryRun, true);
assert.equal(cancelled.api.cancelUrlJob({ jobId: cancelJob.jobId, dryRun: false }).cancelled, true);
await cancelled.api.jobs.get(cancelJob.jobId).promise;
assert.equal((await cancelled.api.urlJobStatus({ jobId: cancelJob.jobId })).status, "cancelled");
assert.equal(cancelled.state.uploadCalls, 0);
const uncertain = fixture({ uploadFailure: true });
const uncertainJob = await uncertain.api.importProwlarrTorrent({ ...input, dryRun: false });
await uncertain.api.jobs.get(uncertainJob.jobId).promise;
assert.equal((await uncertain.api.urlJobStatus({ jobId: uncertainJob.jobId })).status, "handoff_unknown");
assert.equal(uncertain.api.cancelUrlJob({ jobId: uncertainJob.jobId, dryRun: false }).cancelled, false);
uncertain.state.torrents.push({ hash });
assert.equal((await uncertain.api.urlJobStatus({ jobId: uncertainJob.jobId })).status, "verified", "timeout does not prove the client failed to add the torrent");

const watcher = fixture({ onDelay: state => { state.importProgress = true; } });
const imported = await watcher.api.watchImport({ service: "sonarr", downloadId: hash, episodeIds: [11, 12], seriesId: 1, waitMs: 2000 });
assert.equal(imported.complete, true);
assert.equal(imported.verifiedImportedTargets, 2);
assert.equal(imported.history.some(record => record.id === 999), false);
const partial = fixture();
partial.state.importedIds = [11];
partial.state.episodes[0].hasFile = true;
partial.state.episodes[0].episodeFileId = 111;
const waiting = await partial.api.watchImport({ service: "sonarr", downloadId: hash, episodeIds: [11, 12], waitMs: 0 });
assert.equal(waiting.complete, false);
assert.equal(waiting.verifiedImportedTargets, 1);
assert.equal(waiting.timedOut, true);
partial.state.queue = [{ id: 1, downloadId: hash, trackedDownloadState: "importBlocked", errorMessage: "Import failed" }];
assert.equal((await partial.api.watchImport({ service: "sonarr", downloadId: hash, episodeIds: [11], waitMs: 0 })).complete, true, "matching import evidence and current file are authoritative even if a stale queue record remains");
assert.equal((await partial.api.watchImport({ service: "sonarr", downloadId: hash, episodeIds: [12], waitMs: 0 })).phase, "blocked");
await assert.rejects(() => partial.api.watchImport({ service: "sonarr", downloadId: hash }), /episodeIds/);
const staleImport = fixture();
staleImport.state.importedIds = [11];
staleImport.state.episodes[0].hasFile = true;
staleImport.state.episodes[0].episodeFileId = 999;
assert.equal((await staleImport.api.watchImport({ service: "sonarr", downloadId: hash, episodeIds: [11], waitMs: 0 })).complete, false, "an old import for this download cannot verify a different replacement file");
const staleMovie = fixture({ importData: { movieFileId: 999 } });
staleMovie.state.importedIds = [11];
assert.equal((await staleMovie.api.watchImport({ service: "radarr", downloadId: hash, movieId: 2, waitMs: 0 })).complete, false);
const pathMovie = fixture({ importData: { importedPath: "/private/movie/file.mkv" } });
pathMovie.state.importedIds = [11];
assert.equal((await pathMovie.api.watchImport({ service: "radarr", downloadId: hash, movieId: 2, waitMs: 0 })).complete, true, "matching current file path and exact import timestamp can establish identity when history omits file IDs");

const reusedPath = fixture({ importData: { importedPath: "/private/movie/file.mkv" }, importDate: "2020-01-01T00:00:00Z" });
reusedPath.state.importedIds = [11];
assert.equal((await reusedPath.api.watchImport({ service: "radarr", downloadId: hash, movieId: 2, waitMs: 0 })).complete, false, "a reused file path with a later current file date cannot verify an old download import");
const subtitles = fixture({ onDelay: state => { state.subtitlePresent = true; } });
assert.equal((await subtitles.api.watchImport({ service: "bazarr", episodeIds: [11], language: "en", waitMs: 2000 })).phase, "subtitles_available");
await assert.rejects(() => subtitles.api.watchImport({ service: "bazarr", downloadId: "not-supported", movieId: 2, language: "en" }), /not download job/);
const duplicateSubtitles = fixture({ subtitleRows: [1, 2].map(() => ({ sonarrEpisodeId: 11, subtitles: [{ code2: "en", forced: "False", hi: "False" }] })) });
const duplicateState = await duplicateSubtitles.api.watchImport({ service: "bazarr", episodeIds: [11, 12], language: "en", forced: false, hi: false, waitMs: 0 });
assert.equal(duplicateState.complete, false, "duplicate episode rows cannot satisfy a different missing target");
assert.equal(duplicateState.targetsWithSubtitles, 1);
assert.equal((await duplicateSubtitles.api.watchImport({ service: "bazarr", episodeIds: [11], language: "en", forced: true, waitMs: 0 })).targetsWithSubtitles, 0, "string False is not forced subtitle evidence");


const registered = new Map();
registerDownloadRepairTools({ registerTool: (name, definition, handler) => registered.set(name, { definition, handler }) }, { z, jsonText: value => value, capabilities: handoff.api });
assert.equal(registered.size, 10);
assert.equal(registered.get("sonarr_series_missing_episodes").definition.annotations.readOnlyHint, true);
for (const name of ["qbittorrent_import_prowlarr_torrent", "qbittorrent_cancel_url_job", "radarr_update_movie_monitoring", "radarr_blocklist_movie_file_source", "radarr_blocklist_movie_source"]) {
  assert.notEqual(registered.get(name).definition.annotations?.readOnlyHint, true);
  assert.equal(registered.get(name).definition.inputSchema.dryRun.parse(undefined), true);
}
console.log("Download repair capability tests passed");
