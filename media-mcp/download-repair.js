import { createHash, randomUUID } from "node:crypto";

const records = value => Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0;
const ids = values => [...new Set((values || []).map(Number).filter(positive))];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminalCommand = command => ["completed", "complete", "failed", "cancelled", "canceled", "aborted"].includes(String(command?.status || command?.state || "").toLowerCase());
const strip = value => typeof value === "string" ? value.replace(/https?:\/\/\S+|(?:api[_-]?key|token|password)=\S+/gi, "[redacted]").slice(0, 1000) : "";
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Hash the original bencoded info slice, not a re-encoded dictionary. Reject
// malformed/ambiguous dictionaries, excessive nesting, and oversized payloads.
export function torrentIdentity(bytes) {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > 16 * 1024 * 1024) throw new Error("Torrent metadata size is invalid");
  let offset = 0;
  let nodes = 0;
  let infoSlice;
  function parse(depth = 0, root = false) {
    if (++nodes > 100000 || depth > 40 || offset >= data.length) throw new Error("Invalid torrent metadata structure");
    const token = data[offset];
    if (token === 105) {
      const end = data.indexOf(101, ++offset);
      const text = data.subarray(offset, end).toString();
      if (end < 0 || !/^(?:0|-?[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid torrent integer");
      offset = end + 1;
      return Number(text);
    }
    if (token === 108 || token === 100) {
      offset++;
      const value = token === 108 ? [] : Object.create(null);
      while (offset < data.length && data[offset] !== 101) {
        if (token === 108) value.push(parse(depth + 1));
        else {
          const key = parse(depth + 1);
          if (!Buffer.isBuffer(key)) throw new Error("Invalid torrent dictionary key");
          const name = key.toString("utf8");
          if (Object.hasOwn(value, name)) throw new Error("Duplicate torrent dictionary key");
          const start = offset;
          value[name] = parse(depth + 1);
          if (root && name === "info") infoSlice = data.subarray(start, offset);
        }
      }
      if (data[offset++] !== 101) throw new Error("Unterminated torrent metadata");
      return value;
    }
    const colon = data.indexOf(58, offset);
    const text = data.subarray(offset, colon).toString();
    const length = Number(text);
    if (colon < 0 || !/^(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(length) || length < 0 || colon + 1 + length > data.length) throw new Error("Invalid torrent byte string");
    offset = colon + 1 + length;
    return data.subarray(colon + 1, offset);
  }
  const root = parse(0, true);
  const info = root?.info;
  if (offset !== data.length || !infoSlice || !info || Array.isArray(info) || Buffer.isBuffer(info) || !Buffer.isBuffer(info.name)) throw new Error("Torrent metadata has no valid info dictionary");
  const v1 = Buffer.isBuffer(info.pieces) ? createHash("sha1").update(infoSlice).digest("hex") : null;
  const v2 = info["meta version"] === 2 ? createHash("sha256").update(infoSlice).digest("hex") : null;
  if (!v1 && !v2) throw new Error("Torrent metadata is neither v1 nor v2");
  return { infoHashV1: v1, infoHashV2: v2, hashes: [v1, v2, v2?.slice(0, 40)].filter(Boolean), name: info.name.toString("utf8").slice(0, 500), byteLength: data.length };
}

function matchingHash(torrent, hashes) {
  return [torrent?.hash, torrent?.infohash_v1, torrent?.infohash_v2].some(value => hashes.includes(String(value || "").toLowerCase()));
}

export function exactTorrentFromAddResult(torrents, release, addResult) {
  const magnet = String(release?.magnetUrl || "").match(/[?&]xt=urn:btih:([a-f0-9]{40})(?:&|$)/i)?.[1];
  const hashes = [release?.infoHash, release?.infohash, magnet, ...(Array.isArray(addResult?.added_torrent_ids) ? addResult.added_torrent_ids : [])]
    .filter(value => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)).map(value => value.toLowerCase());
  return records(torrents).find(torrent => matchingHash(torrent, hashes)) || null;
}

export function createDownloadRepairCapabilities(deps) {
  const { arrApi, qbitRequest, requireService } = deps;
  const delay = deps.delay || pause;
  const now = deps.now || Date.now;
  const jobs = new Map();
  const redactedError = error => strip(error?.message || String(error));
  const episodeIds = release => ids([release.episodeId, ...(release.episodeIds || []), ...(release.episodes || []).map(episode => episode.id)]);
  const releaseView = release => ({ guid: release.guid, indexerId: release.indexerId, title: release.title, protocol: release.protocol, size: release.size, seeders: release.seeders, infoHash: release.infoHash });
  function budget(milliseconds = 25000, maxCalls = 25, signal) {
    const deadline = now() + milliseconds;
    const deadlineSignal = AbortSignal.timeout(milliseconds);
    const combined = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    let calls = 0;
    return { signal: combined, options() {
      if (combined.aborted || now() >= deadline || calls >= maxCalls) throw new Error("Operation budget exhausted");
      calls++;
      return { signal: combined, timeoutMs: Math.max(1, deadline - now()) };
    }, exhausted: () => combined.aborted || now() >= deadline || calls >= maxCalls };
  }
  const readArr = (scope, service, resource, options = {}) => arrApi(service, "v3", resource, { ...options, ...scope.options() });
  const budgetError = error => /budget|timeout|timed out|aborted/i.test(String(error?.message || error));

  async function seriesMissing(input, scope = budget()) {
    const [series, episodes] = await Promise.all([
      readArr(scope, "sonarr", `series/${input.seriesId}`),
      readArr(scope, "sonarr", "episode", { query: { seriesId: input.seriesId } })
    ]);
    if (Number(series?.id) !== Number(input.seriesId)) throw new Error("The exact Sonarr series was not found");
    const scoped = records(episodes).filter(episode => Number(episode.seriesId) === Number(input.seriesId) && (input.seasonNumber === undefined || Number(episode.seasonNumber) === input.seasonNumber));
    const missing = scoped.filter(episode => !episode.hasFile && !positive(episode.episodeFileId)).map(episode => ({
      episodeId: Number(episode.id), seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber,
      title: episode.title, monitored: episode.monitored === true && series.monitored !== false,
      aired: Number.isFinite(Date.parse(episode.airDateUtc)) && Date.parse(episode.airDateUtc) <= now(), airDateUtc: episode.airDateUtc || null
    }));
    const eligible = missing.filter(episode => (!input.monitoredOnly || episode.monitored) && (!input.airedOnly || episode.aired));
    const limit = Math.min(2000, input.limit || 500);
    return { seriesId: input.seriesId, title: series.title, totalEpisodes: scoped.length, missingCount: missing.length, monitoredAiredMissingCount: missing.filter(episode => episode.monitored && episode.aired).length, returned: Math.min(limit, eligible.length), complete: eligible.length <= limit, episodes: eligible.slice(0, limit) };
  }

  async function missingCandidateMatrix(input) {
    const scope = budget(25000, 22);
    let missing;
    try { missing = await seriesMissing({ ...input, monitoredOnly: true, airedOnly: true, limit: 2000 }, scope); }
    catch (error) { if (budgetError(error)) return { seriesId: input.seriesId, complete: false, incompleteReason: "budget_exhausted", episodes: [] }; throw error; }
    const wanted = input.episodeIds?.length ? ids(input.episodeIds) : missing.episodes.map(episode => episode.episodeId);
    if (wanted.some(id => !missing.episodes.some(episode => episode.episodeId === id))) throw new Error("Requested episodes must be missing, aired, monitored, and in this series scope");
    const chosen = wanted.slice(0, input.maxEpisodes || 10);
    const matrix = [];
    let incompleteReason;
    for (const episodeId of chosen) {
      let releases;
      try { releases = records(await readArr(scope, "sonarr", "release", { query: { episodeId } })); }
      catch (error) { if (budgetError(error)) { incompleteReason = "budget_exhausted"; break; } throw error; }
      const candidates = releases.slice(0, input.candidatesPerEpisode || 20).map(release => {
        const mappedIds = episodeIds(release);
        const rejections = (release.rejections || []).map(reason => strip(typeof reason === "string" ? reason : reason?.reason || reason?.message));
        if (!mappedIds.includes(episodeId)) rejections.push("Sonarr did not map this candidate to the exact episode ID");
        if (release.downloadAllowed !== true || release.rejected === true) rejections.push("Sonarr does not explicitly allow this download");
        if (!release.guid || !positive(release.indexerId)) rejections.push("The exact release identity is incomplete");
        return { ...releaseView(release), episodeIds: mappedIds, quality: release.quality, customFormatScore: release.customFormatScore, rejections, safeToGrab: rejections.length === 0 };
      });
      matrix.push({ ...missing.episodes.find(episode => episode.episodeId === episodeId), candidateCount: releases.length, candidates });
    }
    return { seriesId: input.seriesId, requestedEpisodeCount: wanted.length, searchedEpisodeCount: matrix.length, complete: missing.complete && matrix.length === wanted.length, incompleteReason, episodes: matrix, note: "safeToGrab requires explicit Sonarr download approval and exact episode mapping; this tool never grabs releases. Overall budget: 25 seconds, at most 22 API calls." };
  }

  async function exactTvSearch(input) {
    const scope = budget(25000, 23);
    let releases;
    let target;
    try {
      const series = await readArr(scope, "sonarr", `series/${input.seriesId}`);
      if (Number(series?.tvdbId) !== Number(input.tvdbId)) throw new Error("TVDB ID does not match the exact Sonarr series");
      releases = records(await arrApi("prowlarr", "v1", "search", { ...scope.options(), query: {
        type: "tvsearch", query: `{tvdbid:${input.tvdbId}}{season:${input.seasonNumber}}{episode:${input.episodeNumber}}`, categories: "5000", limit: input.limit || 50
      } }));
      const episodes = records(await readArr(scope, "sonarr", "episode", { query: { seriesId: input.seriesId } }));
      target = episodes.find(episode => Number(episode.seriesId) === input.seriesId && Number(episode.seasonNumber) === input.seasonNumber && Number(episode.episodeNumber) === input.episodeNumber);
      if (!target) throw new Error("The exact Sonarr episode was not found");
    } catch (error) {
      if (budgetError(error)) return { seriesId: input.seriesId, tvdbId: input.tvdbId, complete: false, incompleteReason: "budget_exhausted", checked: 0, candidates: [] };
      throw error;
    }
    const accepted = [];
    let rejected = 0;
    let checked = 0;
    let incompleteReason;
    for (const release of releases.slice(0, input.limit || 50)) {
      if (scope.exhausted()) { incompleteReason = "budget_exhausted"; break; }
      checked++;
      if (!(release.categories || []).some(category => Number(category.id ?? category) >= 5000 && Number(category.id ?? category) < 6000) || (release.tvdbId && Number(release.tvdbId) !== input.tvdbId)) { rejected++; continue; }
      let parsed;
      try { parsed = await readArr(scope, "sonarr", "parse", { query: { title: release.title } }); }
      catch (error) { if (budgetError(error)) { checked--; incompleteReason = "budget_exhausted"; break; } throw error; }
      const mapped = ids((parsed?.episodes || []).map(episode => episode.id));
      if (Number(parsed?.series?.id) !== input.seriesId || !mapped.includes(Number(target.id))) { rejected++; continue; }
      accepted.push({ ...releaseView(release), episodeIds: mapped, parserMatches: true, safeToGrab: false, requiresSonarrApproval: true });
    }
    return { seriesId: input.seriesId, tvdbId: input.tvdbId, episodeId: target.id, seasonNumber: input.seasonNumber, episodeNumber: input.episodeNumber, returned: accepted.length, rejected, checked, complete: checked === releases.length, incompleteReason, candidates: accepted, note: "Parser matching establishes identity, not quality-profile approval. Check Sonarr before grabbing. Overall budget: 25 seconds, at most 20 parser checks." };
  }

  async function updateMovieMonitoring(input) {
    const scope = budget(25000, 3);
    const current = await readArr(scope, "radarr", `movie/${input.movieId}`);
    if (Number(current?.id) !== input.movieId || typeof current.monitored !== "boolean") throw new Error("The exact Radarr movie and monitored state were not found");
    if (input.expectedMonitored !== undefined && current.monitored !== input.expectedMonitored) throw new Error("Radarr monitoring changed since the proposed update");
    const base = { movieId: input.movieId, currentMonitored: current.monitored, proposedMonitored: input.monitored, changed: false };
    if (input.dryRun !== false) return { ...base, dryRun: true };
    if (current.monitored !== input.monitored) await readArr(scope, "radarr", `movie/${input.movieId}`, { method: "PUT", body: { ...current, monitored: input.monitored } });
    const after = await readArr(scope, "radarr", `movie/${input.movieId}`);
    return { ...base, dryRun: false, changed: current.monitored !== input.monitored, monitored: after.monitored, verified: Number(after.id) === input.movieId && after.monitored === input.monitored };
  }

  // Serialize our profile copies so concurrent exact-movie requests cannot
  // overwrite each other's assignment or drop a previously suppressed source.
  let suppressionTail = Promise.resolve();
  function suppressMovieSource(input) {
    const operation = suppressionTail.then(() => suppressMovieSourceNow(input));
    suppressionTail = operation.catch(() => {});
    return operation;
  }

  async function suppressMovieSourceNow(input) {
    const scope = budget(25000, 20);
    const read = (resource, options) => readArr(scope, "radarr", resource, options);
    const movie = await read(`movie/${input.movieId}`);
    if (Number(movie?.id) !== input.movieId) throw new Error("The exact Radarr movie was not found");
    let file;
    if (input.movieFileId) {
      file = await read(`moviefile/${input.movieFileId}`);
      if (Number(file?.id) !== input.movieFileId || Number(file?.movieId) !== input.movieId) throw new Error("Movie file does not belong to the requested movie");
    }
    const history = records(await read("history/movie", { query: { movieId: input.movieId } }));
    const matchesFile = record => !file || (positive(record.data?.movieFileId)
      ? Number(record.data.movieFileId) === input.movieFileId
      : Boolean(file.path && record.data?.importedPath === file.path && Number.isFinite(Date.parse(file.dateAdded)) && Date.parse(file.dateAdded) === Date.parse(record.date)));
    const matches = history.filter(record => Number(record.movieId) === input.movieId && /import|downloadfolderimported/i.test(String(record.eventType))
      && (input.historyId ? Number(record.id) === input.historyId : Boolean(file)) && matchesFile(record)
      && (!input.sourceTitle || record.sourceTitle === input.sourceTitle));
    if (matches.length !== 1 || !matches[0]?.sourceTitle) throw new Error("No exact unambiguous imported source history matched; provide the original historyId and expected sourceTitle");
    const source = matches[0];
    const pattern = `(?i)^${escapeRegex(source.sourceTitle)}$`;
    const profile = await read(`qualityprofile/${movie.qualityProfileId}`);
    if (Number(profile?.id) !== Number(movie.qualityProfileId)) throw new Error("The movie quality profile was not found");
    const suppressionScore = current => {
      const maximumOtherScore = (current.formatItems || []).reduce((sum, item) => sum + Math.max(0, Number(item.score) || 0), 0);
      const minimumOtherScore = (current.formatItems || []).reduce((sum, item) => sum + Math.min(0, Number(item.score) || 0), 0);
      const score = Math.min(-10000, Number(current.minFormatScore || 0) - maximumOtherScore - 1);
      // Radarr sums matching custom-format scores as Int32, including existing
      // negative scores. Every possible subset must stay representable.
      if (!Number.isSafeInteger(score) || minimumOtherScore + score < -2147483648 || maximumOtherScore > 2147483647) throw new Error("The profile score range cannot safely guarantee source suppression");
      return { score, maximumOtherScore, maximumSuppressedScore: maximumOtherScore + score, minimumAcceptedScore: Number(current.minFormatScore || 0) };
    };
    const base = { movieId: input.movieId, historyId: source.id, sourceTitle: source.sourceTitle, originalQualityProfileId: profile.id, ...suppressionScore(profile), nativeBlocklist: false, exactReleaseSuppression: true, searchQueued: false, monitoringChanged: false, verified: false,
      scope: { affectedMovieIds: [input.movieId], copiesAssignedProfile: true, modifiesOriginalProfile: false, changesMovieProfileAssignment: true } };
    if (input.dryRun !== false) return { ...base, dryRun: true, note: "Creates a dedicated exact-title format and copies the assigned quality profile for only this movie. Existing shared profiles/formats remain unchanged. Native history-failed would trigger replacement searches." };
    const suffix = randomUUID().slice(0, 8);
    const name = `Media Issue Agent - Movie ${input.movieId} Source ${suffix}`;
    const saved = await read("customformat", { method: "POST", body: { name, includeCustomFormatWhenRenaming: false, specifications: [{ name: "Suppress exact imported source", implementation: "ReleaseTitleSpecification", negate: false, required: true, fields: [{ name: "value", value: pattern }] }] } });
    const formatId = Number(saved?.id);
    if (!positive(formatId)) throw new Error("Radarr did not return the suppression format ID; the movie profile assignment was not changed");
    const [freshMovie, freshProfile, allFormats] = await Promise.all([read(`movie/${input.movieId}`), read(`qualityprofile/${profile.id}`), read("customformat")]);
    if (Number(freshMovie.qualityProfileId) !== Number(profile.id)) throw new Error("Movie profile changed during suppression; no profile assignment was changed");
    const scores = suppressionScore(freshProfile);
    const copiedProfile = structuredClone(freshProfile);
    delete copiedProfile.id;
    copiedProfile.name = `Media Issue Agent - Movie ${input.movieId} ${suffix}`;
    copiedProfile.formatItems = records(allFormats).map(format => ({ format: format.id, name: format.name, score: Number(format.id) === formatId ? scores.score : Number(freshProfile.formatItems?.find(item => Number(item.format) === Number(format.id))?.score || 0) }));
    if (!copiedProfile.formatItems.some(item => Number(item.format) === formatId)) throw new Error("New format was not visible; no movie profile assignment was changed");
    const savedProfile = await read("qualityprofile", { method: "POST", body: copiedProfile });
    if (!positive(savedProfile?.id)) throw new Error("Radarr did not return the copied profile ID; the movie profile assignment was not changed");
    const beforeAssign = await read(`movie/${input.movieId}`);
    if (Number(beforeAssign.qualityProfileId) !== Number(profile.id)) throw new Error("Movie profile changed before assignment; the copied profile was not assigned");
    await read(`movie/${input.movieId}`, { method: "PUT", body: { ...beforeAssign, qualityProfileId: Number(savedProfile.id) } });
    const [verifiedMovie, verifiedProfile, verifiedFormat] = await Promise.all([read(`movie/${input.movieId}`), read(`qualityprofile/${savedProfile.id}`), read(`customformat/${formatId}`)]);
    const actualScore = Number(verifiedProfile.formatItems?.find(item => Number(item.format) === formatId)?.score);
    const otherScore = (verifiedProfile.formatItems || []).filter(item => Number(item.format) !== formatId).reduce((sum, item) => sum + Math.max(0, Number(item.score) || 0), 0);
    const verified = Number(verifiedMovie.qualityProfileId) === Number(savedProfile.id) && verifiedMovie.monitored === beforeAssign.monitored
      && Number.isFinite(actualScore) && actualScore + otherScore < Number(verifiedProfile.minFormatScore || 0)
      && verifiedFormat.specifications?.length === 1 && verifiedFormat.specifications[0].implementation === "ReleaseTitleSpecification"
      && verifiedFormat.specifications[0].required === true && verifiedFormat.specifications[0].negate === false
      && verifiedFormat.specifications[0].fields?.some(field => field.name === "value" && field.value === pattern);
    return { ...base, ...scores, dryRun: false, qualityProfileId: Number(savedProfile.id), formatId, verified: Boolean(verified), verification: "Exact-title score plus all positive format scores is below this movie's minimum accepted score; no release grab was attempted." };
  }

  async function exactRelease(input) {
    const requested = { ...(input.release || {}), ...Object.fromEntries(["guid", "indexerId", "title"].filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
    if (!requested.guid || !positive(requested.indexerId) || !requested.title) throw new Error("Exact Prowlarr guid, indexerId and title are required");
    const candidates = records(await arrApi("prowlarr", "v1", "search", { ...budget(15000, 1).options(), query: { query: requested.title, indexerIds: Number(requested.indexerId), limit: 100 } }));
    const match = candidates.find(candidate => String(candidate.guid) === String(requested.guid) && Number(candidate.indexerId) === Number(requested.indexerId) && candidate.title === requested.title);
    if (!match) throw new Error("Exact release is absent from a fresh Prowlarr search");
    if (!/^(torrent|1)$/i.test(String(match.protocol))) throw new Error("The exact Prowlarr result is not a torrent");
    return match;
  }

  function jobView(job) {
    return { jobId: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, release: job.release, error: job.error || null, trackedDownloadId: job.hash || null, infoHashV1: job.identity?.infoHashV1 || null, infoHashV2: job.identity?.infoHashV2 || null, added: job.status === "verified", cancellable: ["queued", "fetching"].includes(job.status), nativeUrlJob: false };
  }

  async function torrentBytes(release, signal) {
    const service = requireService("prowlarr");
    const url = new URL(release.downloadUrl || release.magnetUrl || "");
    const base = new URL(service.url);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) throw new Error("Only the configured Prowlarr download proxy can supply torrent metadata");
    const prefix = base.pathname.replace(/\/$/, "");
    if (url.pathname !== `${prefix}/${release.indexerId}/download`) throw new Error("Prowlarr URL is not the exact indexer download proxy");
    const response = await (deps.fetch || fetch)(url, { headers: { "X-Api-Key": service.apiKey }, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) throw new Error("Prowlarr returned a redirect instead of torrent bytes; no client handoff was made");
    if (!response.ok) throw new Error(`Prowlarr torrent fetch failed with HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") || 0) > 16 * 1024 * 1024) throw new Error("Torrent metadata exceeds size limit");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error("Torrent metadata exceeds size limit");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function importProwlarrTorrent(input) {
    const release = await exactRelease(input);
    if (input.dryRun !== false) return { dryRun: true, release: releaseView(release), added: false, wouldFetchAndUploadBytes: true, note: "Mutation requires dryRun:false. The exact hash will be computed from fetched metadata and verified in qBittorrent." };
    const key = `${release.indexerId}:${release.guid}`;
    for (const [id, job] of jobs) if (now() - job.createdMs > 60 * 60 * 1000 && !["queued", "fetching", "importing", "verifying"].includes(job.status)) jobs.delete(id);
    const existing = [...jobs.values()].find(job => job.key === key && ["queued", "fetching", "importing", "verifying", "verified", "unverified", "handoff_unknown"].includes(job.status));
    if (existing) return urlJobStatus({ jobId: existing.id });
    if (jobs.size >= 100) throw new Error("Torrent handoff job capacity reached");
    const controller = new AbortController();
    const scope = budget(60000, 15, controller.signal);
    const job = { id: randomUUID(), key, status: "queued", release: releaseView(release), createdMs: now(), createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), controller };
    jobs.set(job.id, job);
    const setState = status => { job.status = status; job.updatedAt = new Date(now()).toISOString(); };
    job.promise = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) return setState("cancelled");
        setState("fetching");
        const bytes = await torrentBytes(release, AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]));
        job.identity = torrentIdentity(bytes);
        const expected = String(release.infoHash || "").toLowerCase();
        if (expected && !job.identity.hashes.includes(expected)) throw new Error("Torrent bytes do not match the Prowlarr info hash");
        if (controller.signal.aborted) return setState("cancelled");
        const existingTorrent = records(await qbitRequest(`torrents/info?hashes=${job.identity.hashes.join("|")}`, scope.options())).find(torrent => matchingHash(torrent, job.identity.hashes));
        if (controller.signal.aborted) return setState("cancelled");
        if (existingTorrent) { job.hash = existingTorrent.hash; return setState("verified"); }
        if (controller.signal.aborted) return setState("cancelled");
        // From this boundary onward a timed-out response cannot prove that the
        // client did not accept the torrent, so cancellation is no longer safe.
        const uploadOptions = scope.options();
        setState("importing");
        const formData = new FormData();
        formData.append("torrents", new Blob([bytes], { type: "application/x-bittorrent" }), "release.torrent");
        formData.append("category", input.category || "sonarr");
        formData.append("tags", (input.tags || ["media-issue-agent"]).join(","));
        formData.append("paused", input.paused ? "true" : "false");
        formData.append("stopped", input.paused ? "true" : "false");
        if (input.savePath) formData.append("savepath", input.savePath);
        const added = await qbitRequest("torrents/add", { method: "POST", formData, ...uploadOptions });
        if (added?.failure_count > 0 && !added?.success_count) throw new Error("qBittorrent rejected the torrent metadata");
        if (typeof added === "string" && !/^ok\.?$/i.test(added.trim())) throw new Error("qBittorrent rejected the torrent metadata");
        setState("verifying");
        for (let attempt = 0; attempt < 10; attempt++) {
          const found = records(await qbitRequest(`torrents/info?hashes=${job.identity.hashes.join("|")}`, scope.options())).find(torrent => matchingHash(torrent, job.identity.hashes));
          if (found) { job.hash = found.hash; return setState("verified"); }
          await delay(500);
        }
        job.error = "Client accepted the handoff but the exact hash is not visible yet; do not infer success or add a different release.";
        setState("unverified");
      } catch (error) {
        job.error = controller.signal.aborted ? null : redactedError(error);
        setState(controller.signal.aborted ? "cancelled" : ["importing", "verifying"].includes(job.status) ? "handoff_unknown" : "failed");
      }
    });
    await Promise.race([job.promise, delay(input.waitMs ?? 1000)]);
    return jobView(job);
  }

  async function urlJobStatus(input) {
    const job = jobs.get(input.jobId);
    if (!job) return { jobId: input.jobId, status: "unknown", nativeUrlJob: null, cancellable: false, reason: "Only media-mcp managed handoffs have job status. qBittorrent does not expose status/cancellation for native URL-add jobs; in-memory jobs are unavailable after restart." };
    if (["unverified", "handoff_unknown", "verified"].includes(job.status) && job.identity) {
      const found = records(await qbitRequest(`torrents/info?hashes=${job.identity.hashes.join("|")}`, budget(10000, 1).options())).find(torrent => matchingHash(torrent, job.identity.hashes));
      if (found) { job.hash = found.hash; job.status = "verified"; job.error = null; job.updatedAt = new Date(now()).toISOString(); }
      else if (job.status === "verified") { job.status = "not_present"; job.hash = null; job.updatedAt = new Date(now()).toISOString(); }
    }
    return jobView(job);
  }

  function cancelUrlJob(input) {
    const job = jobs.get(input.jobId);
    if (!job) return { jobId: input.jobId, cancelled: false, reason: "Unknown managed handoff; native qBittorrent URL-add jobs cannot be cancelled through this tool." };
    if (!["queued", "fetching"].includes(job.status)) return { ...jobView(job), cancelled: false, reason: "Client handoff has started or the job is terminal; cancellation cannot safely undo it." };
    if (input.dryRun !== false) return { ...jobView(job), dryRun: true, cancelled: false };
    job.controller.abort("Exact handoff cancelled before client upload");
    job.status = "cancelled";
    job.updatedAt = new Date(now()).toISOString();
    return { ...jobView(job), dryRun: false, cancelled: true };
  }

  async function watchImport(input) {
    const service = input.service;
    const wantedEpisodes = ids(input.episodeIds || []);
    if (service === "sonarr" && (!input.downloadId || !wantedEpisodes.length)) throw new Error("Sonarr requires an exact downloadId and episodeIds");
    if (service === "radarr" && (!input.downloadId || !positive(input.movieId))) throw new Error("Radarr requires an exact downloadId and movieId");
    if (service === "bazarr" && (!input.language || (!!input.movieId === !!wantedEpisodes.length) || input.downloadId)) throw new Error("Bazarr requires a language and either movieId or episodeIds; it exposes target subtitle state, not download job IDs");
    const started = now();
    const waitMs = Math.min(25000, Math.max(0, input.waitMs ?? 5000));
    // waitMs:0 takes one bounded snapshot; all other requests share their wait
    // deadline across reads, pauses, and polling instead of per-call timeouts.
    const scope = budget(waitMs || 10000, 20);
    const read = (resource, options) => readArr(scope, service, resource, options);
    const expected = service === "sonarr" || (service === "bazarr" && !input.movieId) ? wantedEpisodes.length : 1;
    const maxPolls = Math.max(1, Math.ceil(waitMs / 1000) + 1);
    let latest = { service, complete: false, phase: "checking", expectedTargets: expected, verifiedImportedTargets: 0, checkedTargets: 0 };
    const finish = (extra = {}) => ({ ...latest, elapsedMs: now() - started, timedOut: !latest.complete && latest.phase !== "blocked", ...extra });
    const sameFile = (record, current, fileId, kind) => {
      const importedId = record.data?.[`${kind}FileId`] ?? record[`${kind}FileId`];
      if (positive(importedId)) return Number(importedId) === Number(fileId);
      const importedAt = Date.parse(record.date);
      const currentAddedAt = Date.parse(current?.dateAdded);
      return Boolean(current?.path && record.data?.importedPath && current.path === record.data.importedPath
        && Number.isFinite(importedAt) && importedAt === currentAddedAt);
    };
    try {
      for (let poll = 0; poll < maxPolls; poll++) {
        if (service === "bazarr") {
          const body = await deps.bazarrApi(input.movieId ? "movies" : "episodes", { ...scope.options(), query: input.movieId ? { "radarrid[]": [input.movieId] } : { "episodeid[]": wantedEpisodes } });
          const rows = Array.isArray(body?.data) ? body.data : records(body);
          const normalizeLanguage = deps.normalizeSubtitleLanguage || (value => String(value || "").toLowerCase());
          const flag = value => value === true || value === 1 || /^(true|1)$/i.test(String(value));
          const presentIds = new Set();
          const seenIds = new Set();
          for (const row of rows) {
            const id = Number(input.movieId ? row.radarrId ?? row.radarrid ?? row.movieId : row.sonarrEpisodeId ?? row.episodeId);
            if (!(input.movieId ? id === input.movieId : wantedEpisodes.includes(id))) continue;
            seenIds.add(id);
            if ((row.subtitles || []).some(subtitle => normalizeLanguage(subtitle.code2 || subtitle.code3 || subtitle.language || subtitle.name) === normalizeLanguage(input.language)
              && (input.forced === undefined || flag(subtitle.forced) === input.forced)
              && (input.hi === undefined || flag(subtitle.hi ?? subtitle.hearing_impaired) === input.hi))) presentIds.add(id);
          }
          latest = { service, phase: presentIds.size === expected ? "subtitles_available" : "waiting_for_subtitles", complete: presentIds.size === expected, expectedTargets: expected, checkedTargets: seenIds.size, targetsWithSubtitles: presentIds.size, language: input.language, note: "Reports current subtitle presence for these exact media targets; does not identify a Bazarr download job." };
        } else {
          const [queueBody, historyBody] = await Promise.all([
            read("queue/details"),
            read("history", { query: { downloadId: input.downloadId, page: 1, pageSize: 100, sortKey: "date", sortDirection: "descending" } })
          ]);
          const sameDownload = record => String(record.downloadId || "").toLowerCase() === String(input.downloadId).toLowerCase();
          const queue = records(queueBody).filter(sameDownload).filter(record => service !== "radarr" || Number(record.movieId ?? record.movie?.id) === input.movieId);
          const history = records(historyBody).filter(sameDownload);
          const imported = history.filter(record => /downloadfolderimported|(?:episode|movie)fileimported/i.test(String(record.eventType)));
          const blocked = queue.some(record => /blocked|failed|error|warning/i.test(`${record.status || ""} ${record.trackedDownloadStatus || ""} ${record.trackedDownloadState || ""}`));
          latest = { service, downloadId: input.downloadId, complete: false, phase: blocked ? "blocked" : queue.length ? "downloading_or_importing" : "not_tracked_or_waiting_for_import", expectedTargets: expected, verifiedImportedTargets: 0, checkedTargets: 0,
            queue: queue.map(record => ({ id: record.id, status: record.status, trackedDownloadStatus: record.trackedDownloadStatus, trackedDownloadState: record.trackedDownloadState, sizeLeft: record.sizeleft ?? record.sizeLeft, error: strip(record.errorMessage) })),
            history: history.slice(0, 20).map(record => ({ id: record.id, eventType: record.eventType, date: record.date, episodeId: record.episodeId, movieId: record.movieId })),
            historyComplete: Number(historyBody?.totalRecords || history.length) <= 100 };
          if (service === "sonarr") {
            const allEpisodes = input.seriesId ? records(await read("episode", { query: { seriesId: input.seriesId } })) : null;
            const files = new Map();
            for (const episodeId of wantedEpisodes) {
              const episode = allEpisodes ? allEpisodes.find(item => Number(item.id) === episodeId) : await read(`episode/${episodeId}`);
              if (Number(episode?.id) !== episodeId || (input.seriesId && Number(episode.seriesId) !== input.seriesId)) throw new Error("Episode identity changed outside the requested scope");
              latest.checkedTargets++;
              if (episode.hasFile !== true || !positive(episode.episodeFileId)) continue;
              const imports = imported.filter(record => Number(record.episodeId) === episodeId);
              if (!imports.length) continue;
              let currentFile = episode.episodeFile;
              if (!imports.some(record => positive(record.data?.episodeFileId ?? record.episodeFileId)) && !currentFile?.path) {
                if (!files.has(Number(episode.episodeFileId))) files.set(Number(episode.episodeFileId), await read(`episodefile/${episode.episodeFileId}`));
                currentFile = files.get(Number(episode.episodeFileId));
                if (Number(currentFile?.id) !== Number(episode.episodeFileId)) continue;
              }
              if (imports.some(record => sameFile(record, currentFile, episode.episodeFileId, "episode"))) latest.verifiedImportedTargets++;
            }
          } else {
            const movie = await read(`movie/${input.movieId}`);
            if (Number(movie?.id) !== input.movieId) throw new Error("Movie identity changed outside the requested scope");
            latest.checkedTargets = 1;
            const fileId = movie.movieFile?.id ?? movie.movieFileId;
            const imports = imported.filter(record => Number(record.movieId) === input.movieId);
            let currentFile = movie.movieFile;
            if (movie.hasFile === true && positive(fileId) && imports.length) {
              if (!imports.some(record => positive(record.data?.movieFileId ?? record.movieFileId)) && !currentFile?.path) currentFile = await read(`moviefile/${fileId}`);
              if (imports.some(record => sameFile(record, currentFile, fileId, "movie"))) latest.verifiedImportedTargets = 1;
            }
          }
          latest.complete = latest.verifiedImportedTargets === expected;
          if (latest.complete) latest.phase = "imported";
          latest.note = "Import completion requires this download's history to identify the current library file by file ID or exact imported path plus matching file-added/import timestamps; a pre-existing file alone is insufficient.";
        }
        if (latest.complete || latest.phase === "blocked" || now() - started >= waitMs || poll === maxPolls - 1) return finish();
        if (scope.exhausted()) return finish({ partial: true, incompleteReason: "budget_exhausted" });
        await delay(Math.min(1000, Math.max(1, waitMs - (now() - started))));
      }
    } catch (error) {
      if (!budgetError(error)) throw error;
      return finish({ complete: false, partial: true, incompleteReason: "budget_exhausted" });
    }
    return finish();
  }

  return { seriesMissing, missingCandidateMatrix, exactTvSearch, updateMovieMonitoring, suppressMovieSource, importProwlarrTorrent, urlJobStatus, cancelUrlJob, watchImport, jobs };
}

export function registerDownloadRepairTools(server, { z, jsonText, capabilities }) {
  const id = () => z.number().int().positive();
  const dryRun = () => z.boolean().default(true);
  const mutation = { destructiveHint: true, idempotentHint: false };
  const register = (name, description, inputSchema, operation, annotations) => server.registerTool(name, { title: name.replaceAll("_", " "), description, inputSchema, ...(annotations ? { annotations } : {}) }, async input => jsonText(await operation(input)));
  register("sonarr_series_missing_episodes", "Read one exact Sonarr series/season's missing episode IDs, aired/monitored state, and counts without global wanted pagination. No media paths or requester identities.", {
    seriesId: id(), seasonNumber: z.number().int().min(0).optional(), monitoredOnly: z.boolean().default(false), airedOnly: z.boolean().default(false), limit: z.number().int().min(1).max(2000).default(500)
  }, capabilities.seriesMissing, { readOnlyHint: true, destructiveHint: false });
  register("sonarr_missing_episode_candidate_matrix", "Search exact missing aired monitored episodes in one series, returning episode mappings, quality and rejection reasons. safeToGrab requires explicit Sonarr approval and exact mapping. Never grabs a release.", {
    seriesId: id(), seasonNumber: z.number().int().min(0).optional(), episodeIds: z.array(id()).min(1).max(100).optional(), maxEpisodes: z.number().int().min(1).max(20).default(10), candidatesPerEpisode: z.number().int().min(1).max(50).default(20)
  }, capabilities.missingCandidateMatrix);
  register("prowlarr_search_tv_episode_exact", "Search Prowlarr TV categories by TVDB ID/season/episode, then require Sonarr's parser to map each result to the exact episode. Returns no download URLs. Parser matching alone does not grant quality-profile approval.", {
    seriesId: id(), tvdbId: id(), seasonNumber: z.number().int().min(0), episodeNumber: id(), limit: z.number().int().min(1).max(100).default(50)
  }, capabilities.exactTvSearch);
  register("radarr_update_movie_monitoring", "Update one exact Radarr movie's monitored flag with dry-run, optional expected-state guard, and verification. Does not start searches.", {
    movieId: id(), monitored: z.boolean(), expectedMonitored: z.boolean().optional(), dryRun: dryRun()
  }, capabilities.updateMovieMonitoring, mutation);
  for (const name of ["radarr_blocklist_movie_file_source", "radarr_blocklist_movie_source"]) register(name, "Suppress an exact imported movie source derived from movieFileId or original historyId. Copies the assigned quality profile for only this movie and adds an exact-title penalty below the threshold even with all positive format scores. Shared profiles/formats are not modified. No search, monitoring change, or file deletion. Dry-run first.", {
    movieId: id(), movieFileId: id().optional(), historyId: id().optional(), sourceTitle: z.string().min(1).max(1000).optional(), dryRun: dryRun()
  }, capabilities.suppressMovieSource, mutation);
  register("qbittorrent_import_prowlarr_torrent", "Fetch one freshly matched Prowlarr torrent through its configured download proxy, hash the actual metadata, upload bytes to qBittorrent, and verify the exact hash. Returns a managed job ID; never guesses a torrent from its name or unrelated new hashes. Dry-run first.", {
    guid: z.string().min(1).max(2000), indexerId: id(), title: z.string().min(1).max(1000), category: z.string().min(1).max(100).default("sonarr"), tags: z.array(z.string().min(1).max(100)).max(20).default(["media-issue-agent"]), savePath: z.string().min(1).optional(), paused: z.boolean().default(false), waitMs: z.number().int().min(0).max(10000).default(1000), dryRun: dryRun()
  }, capabilities.importProwlarrTorrent, mutation);
  register("qbittorrent_url_job_status", "Read status, sanitized fetch error, and verified hash of a media-mcp managed Prowlarr handoff. Unknown/native qBittorrent URL-add jobs are explicitly unsupported, not assumed successful.", { jobId: z.string().min(1).max(100) }, capabilities.urlJobStatus);
  register("qbittorrent_cancel_url_job", "Cancel only one exact media-mcp managed handoff before client upload. Refuses cancellation once upload has begun and cannot cancel native qBittorrent URL-add jobs. Dry-run first.", { jobId: z.string().min(1).max(100), dryRun: dryRun() }, capabilities.cancelUrlJob, mutation);
  register("media_wait_for_download_import", "Bounded read-only watcher for exact Sonarr/Radarr download IDs plus episode/movie IDs. Completion requires matching import history and current library files. Bazarr mode checks requested subtitle presence on exact media IDs and does not claim job correlation.", {
    service: z.enum(["sonarr", "radarr", "bazarr"]), downloadId: z.string().min(1).max(200).optional(), seriesId: id().optional(), episodeIds: z.array(id()).min(1).max(100).optional(), movieId: id().optional(), language: z.string().min(1).max(30).optional(), forced: z.boolean().optional(), hi: z.boolean().optional(), waitMs: z.number().int().min(0).max(25000).default(5000)
  }, capabilities.watchImport);
}

export { terminalCommand };
