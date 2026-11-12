// Application-owned read-only capability boundary for untrusted Slack requests.
// Raw operational records never enter a model prompt or a Slack message.
import { redactText } from "./redact.js";

const SERVICES = ["plex", "sonarr", "radarr", "bazarr", "seerr", "prowlarr", "qbittorrent", "nzbget", "tautulli", "tracearr", "threadfin"];
const STATUS = ["matched", "ambiguous", "not_found", "unavailable", "unknown", "pending", "processing", "partial", "partially_available", "available", "announced", "continuing", "deleted", "ended", "in_cinemas", "released", "upcoming", "not_requested"];
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const boolean = value => typeof value === "boolean" ? value : undefined;
const enumeration = choices => value => choices.includes(value) ? value : undefined;
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;

export function publicMediaTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().slice(0, 200);
  if (!title || redactText(title) !== title || /[<>@\\/\r\n]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[A-Z0-9]{12,}\b/.test(title)) return undefined;
  return title;
}

function object(schema, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(schema).map(([key, project]) => [key, project(value[key])]).filter(([, item]) => item !== undefined));
}
const fields = names => Object.fromEntries(names.split(" ").map(name => [name, numeric]));
const flags = { configured: boolean, available: boolean, online: boolean };
const counts = { ...flags, ...fields("seriesCount monitoredSeriesCount seasonCount monitoredSeasonCount airedEpisodeCount totalEpisodeCount episodeFileCount missingEpisodeCount sizeOnDiskBytes movieCount monitoredMovieCount movieFileCount missingMovieCount queuedCount problemCount") };
const titleFields = { ...counts, title: publicMediaTitle, mediaType: enumeration(["movie", "tv"]), year: numeric, monitored: boolean, lifecycle: enumeration(STATUS), status: enumeration(STATUS), seasonNumber: numeric, episodeNumber: numeric, addedAt: timestamp };
const list = (schema, max = 10) => value => Array.isArray(value) ? value.slice(0, max).map(item => object(schema, item)) : undefined;
const serviceList = value => Array.isArray(value) ? value.filter(item => SERVICES.includes(item)) : undefined;
const common = { ...flags, generatedAt: timestamp, status: enumeration(STATUS) };

const RESULT_SCHEMAS = {
  media_public_library_summary: { ...common, tv: value => object(counts, value), movies: value => object(counts, value), totalSizeOnDiskBytes: numeric },
  media_public_title_summary: { ...common, result: value => object(titleFields, value), candidates: list(titleFields, 8), searched: serviceList, unavailable: serviceList },
  media_public_request_status: { ...common, result: value => object(titleFields, value), candidates: list(titleFields, 8) },
  media_public_watchtime_summary: { ...common, ...fields("periodDays playCount totalWatchSeconds"), periodStart: timestamp, periodEnd: timestamp, scope: enumeration(["title", "library"]), mediaType: enumeration(["movie", "tv", "all"]), matched: boolean, complete: boolean },
  plex_public_bandwidth_summary: { ...common, ...fields("totalBytes lanBytes wanBytes sampleCount"), periodStart: timestamp, periodEnd: timestamp },
  media_public_health_summary: { ...common, services: value => object(Object.fromEntries(SERVICES.map(name => [name, item => object(flags, item)])), value) },
  media_public_queue_summary: { ...common, ...Object.fromEntries(["sonarr", "radarr", "qbittorrent", "nzbget"].map(name => [name, value => object(counts, value)])) },
  media_public_subtitle_summary: { ...common, ...fields("wantedMovieCount wantedEpisodeCount configuredProviderCount") },
  media_public_recent_additions: { ...common, records: list(titleFields) },
  plex_availability: { configured: boolean, online: boolean, activeStreamCount: numeric }
};

export function projectSlackPublicResult(tool, value) {
  if (!Object.hasOwn(RESULT_SCHEMAS, tool)) throw new Error("This tool has no public result projection");
  return object(RESULT_SCHEMAS[tool], value);
}

const titleArguments = { title: "public media title (required)", mediaType: "movie or tv (optional)", year: "release year (optional)" };
export const SLACK_READ_ONLY_TOOLS = Object.freeze([
  { name: "media_public_title_diagnostics", description: "Inspect one exact title across library inventory, specific seasons/episodes, matching download queues and linked download-client state. Use this for why a title is stuck, missing, or not downloading; never substitute whole-server queue totals.", arguments: { ...titleArguments, seasonNumber: "TV season, optional", episodeNumber: "TV episode, optional" } },
  { name: "media_public_title_playback", description: "Inspect Plex metadata and a read-only file probe for one exact movie or specific TV episode: existence, readable media, codecs, resolution and subtitle count. TV requires season and episode.", arguments: { ...titleArguments, seasonNumber: "TV season, required for TV", episodeNumber: "TV episode, required for TV" } },
  { name: "media_public_title_summary", description: "Library availability, monitoring, episode counts and storage for one exact title.", arguments: titleArguments },
  { name: "media_public_request_status", description: "Seerr request status for one exact title.", arguments: titleArguments },
  { name: "media_public_watchtime_summary", description: "Aggregate viewing duration/play counts, optionally for one exact title; no user filters.", arguments: { ...titleArguments, title: "public media title (optional)", periodDays: "1 to 366; default 30" } },
  { name: "media_public_library_summary", description: "Aggregate library counts/storage.", arguments: {} },
  { name: "media_public_health_summary", description: "Service availability.", arguments: { service: `optional: ${SERVICES.join(", ")}` } },
  { name: "media_public_queue_summary", description: "Whole-server aggregate queues; cannot diagnose a particular title.", arguments: {} },
  { name: "media_public_subtitle_summary", description: "Aggregate subtitle coverage.", arguments: {} },
  { name: "media_public_recent_additions", description: "Recently added public media titles.", arguments: { mediaType: "movie or tv (optional)", limit: "1 to 10; default 5" } },
  { name: "plex_public_bandwidth_summary", description: "Aggregate current-month bandwidth.", arguments: {} },
  { name: "plex_availability", description: "Plex availability and aggregate active stream count.", arguments: {} }
]);

export function validateSlackReadOnlyCall(name, input = {}) {
  const spec = SLACK_READ_ONLY_TOOLS.find(tool => tool.name === name);
  if (!spec || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Read-only tool is not allowed");
  if (Object.keys(input).some(key => !Object.hasOwn(spec.arguments, key))) throw new Error("Unsupported read-only tool argument");
  const args = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "title") {
      const title = publicMediaTitle(value);
      if (!title || title !== value.trim() || value.length > 200) throw new Error("A public media title is required");
      args.title = title;
    } else if (key === "mediaType") {
      if (!["movie", "tv"].includes(value)) throw new Error("Invalid media type");
      args.mediaType = value;
    } else if (key === "service") {
      if (!SERVICES.includes(value)) throw new Error("Invalid media service");
      args.service = value;
    } else {
      const bounds = { year: [1870, 2100], seasonNumber: [0, 100], episodeNumber: [1, 10000], periodDays: [1, 366], limit: [1, 10] }[key];
      if (!Number.isInteger(value) || !bounds || value < bounds[0] || value > bounds[1]) throw new Error("Invalid read-only lookup range");
      args[key] = value;
    }
  }
  if (["media_public_title_diagnostics", "media_public_title_playback", "media_public_title_summary", "media_public_request_status"].includes(name) && !args.title) throw new Error("A public media title is required");
  if (args.episodeNumber !== undefined && args.seasonNumber === undefined) throw new Error("A season is required for an episode lookup");
  if (name === "media_public_watchtime_summary") args.periodDays ??= 30;
  if (name === "media_public_recent_additions") args.limit ??= 5;
  return args;
}

const rows = value => Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];
const titleKey = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
const id = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const safeDate = value => timestamp(value);

function queueState(record) {
  const state = `${record.status || ""} ${record.trackedDownloadState || ""} ${record.trackedDownloadStatus || ""} ${record.state || ""}`.toLowerCase();
  if (/importblocked|importfailed|importpending/.test(state)) return "import_blocked";
  if (/error|failed|warning/.test(state)) return "failed";
  if (/stalledup|pausedup|stoppedup|queuedup|uploading|forcedup/.test(state)) return "download_complete";
  if (/stalled/.test(state)) return "stalled";
  if (/paused|stopped/.test(state)) return "paused";
  if (/completed|imported|uploading|stalledup/.test(state)) return "download_complete";
  if (/download/.test(state)) return "downloading";
  if (/queued/.test(state)) return "queued";
  return "unknown";
}

function problemCategories(record) {
  // Freeform upstream messages can contain private paths, hosts and credentials.
  // Interpret them locally into a closed vocabulary; never expose the originals.
  const text = `${record.errorMessage || ""} ${JSON.stringify(record.statusMessages || [])}`.toLowerCase();
  const patterns = {
    disk_space: /(?:not enough|insufficient|no) (?:free |disk )?space|disk full/,
    permission_denied: /permission denied|access denied/,
    file_missing: /file.{0,30}(?:not found|missing)|no files.{0,30}(?:found|eligible)/,
    quality_rejected: /quality|custom format|cutoff/,
    unmapped_episode: /unable to (?:parse|match)|episode.{0,30}(?:unknown|unmatched)/,
    archive_processing: /unpack|extract|archive|repairing/,
    import_pending: /waiting to import|import pending|manual import/
  };
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function publicQueueRecord(record) {
  const size = numeric(record.size);
  const left = numeric(record.sizeLeft ?? record.sizeleft);
  return {
    state: queueState(record),
    ...(size > 0 && left !== undefined ? { percentDownloaded: Math.round(Math.max(0, Math.min(100, (size - left) / size * 100))) } : {}),
    ...(Number.isInteger(record.seasonNumber) ? { seasonNumber: record.seasonNumber } : {}),
    problemCategories: problemCategories(record)
  };
}

export async function collectSlackTitleDiagnostics(args, callTool) {
  const services = args.mediaType === "movie" ? ["radarr"] : args.mediaType === "tv" ? ["sonarr"] : ["sonarr", "radarr"];
  const candidates = [];
  const unavailable = [];
  for (const service of services) {
    try {
      const result = await callTool(service === "sonarr" ? "sonarr_list_series" : "radarr_list_movies", { term: args.title, limit: 250 });
      for (const item of rows(result)) {
        if (titleKey(item.title) === titleKey(args.title) && (!args.year || Number(item.year) === args.year) && id(item.id)) candidates.push({ service, item });
      }
    } catch { unavailable.push(service); }
  }
  if (candidates.length !== 1) return {
    status: candidates.length > 1 ? "ambiguous" : unavailable.length === services.length ? "unavailable" : "not_found",
    candidates: candidates.slice(0, 8).map(({ service, item }) => ({ title: publicMediaTitle(item.title), mediaType: service === "sonarr" ? "tv" : "movie", year: numeric(item.year) })),
    unavailable
  };
  const { service, item } = candidates[0];
  const result = {
    status: "matched", title: publicMediaTitle(item.title), year: numeric(item.year), mediaType: service === "sonarr" ? "tv" : "movie",
    monitored: item.monitored === true, lifecycle: enumeration(STATUS)(String(item.status || "").toLowerCase()) || "unknown", unavailable,
    inventory: service === "radarr" ? { hasFile: item.hasFile === true || Boolean(item.movieFile) } : {}
  };
  let episodeIds = null;
  if (service === "sonarr") {
    try {
      const inventory = await callTool("sonarr_list_episodes", { seriesId: id(item.id), ...(args.seasonNumber !== undefined ? { seasonNumber: args.seasonNumber } : {}), includeEpisodeFiles: false, includeHistory: false, limit: 250 });
      const episodes = (Array.isArray(inventory.episodes) ? inventory.episodes : []).filter(episode => (args.seasonNumber === undefined || Number(episode.seasonNumber) === args.seasonNumber) && (args.episodeNumber === undefined || Number(episode.episodeNumber) === args.episodeNumber));
      episodeIds = new Set(episodes.map(episode => id(episode.id)).filter(Boolean));
      result.inventory = {
        complete: Number(inventory.total || 0) <= Number(inventory.returned ?? inventory.episodes?.length ?? 0),
        episodeCount: episodes.length, availableEpisodeCount: episodes.filter(episode => episode.hasFile === true).length,
        monitoredEpisodeCount: episodes.filter(episode => episode.monitored === true).length,
        episodes: episodes.slice(0, 50).map(episode => ({ seasonNumber: numeric(episode.seasonNumber), episodeNumber: numeric(episode.episodeNumber), hasFile: episode.hasFile === true, monitored: episode.monitored === true, airDate: safeDate(episode.airDateUtc) }))
      };
    } catch { result.unavailable.push("episode_inventory"); }
  }
  try {
    const queue = await callTool(`${service}_queue`, { limit: 250 });
    const records = rows(queue);
    const matches = records.filter(record => {
      if (Number(record[service === "sonarr" ? "seriesId" : "movieId"]) !== id(item.id)) return false;
      if (args.seasonNumber !== undefined) {
        if (record.seasonNumber !== undefined && Number(record.seasonNumber) !== args.seasonNumber) return false;
        if (record.seasonNumber === undefined) {
          const ids = [record.episodeId, ...(record.episodeIds || [])].map(id).filter(Boolean);
          if (!episodeIds || !ids.some(episodeId => episodeIds.has(episodeId))) return false;
        }
      }
      if (args.episodeNumber !== undefined) {
        const ids = [record.episodeId, ...(record.episodeIds || [])].map(id).filter(Boolean);
        return episodeIds && ids.some(episodeId => episodeIds.has(episodeId));
      }
      return true;
    });
    result.downloads = { complete: Number(queue?.totalRecords ?? queue?.total ?? records.length) <= records.length, matchedCount: matches.length, records: matches.slice(0, 25).map(publicQueueRecord) };
    const downloadIds = new Set(matches.map(record => String(record.downloadId || "").toLowerCase()).filter(Boolean));
    try {
      const history = await callTool(`${service}_recent_history`, { limit: 100 });
      const historyRows = rows(history).filter(record => Number(record[service === "sonarr" ? "seriesId" : "movieId"]) === id(item.id));
      // Recent-history tools are title scoped here; they cannot establish exact
      // episode scope, so label this explicitly instead of overclaiming.
      result.recentHistory = {
        scope: "title", complete: Number(history?.totalRecords ?? historyRows.length) <= rows(history).length,
        events: historyRows.slice(0, 20).map(record => ({
          event: enumeration(["grabbed", "downloadFolderImported", "downloadFailed", "downloadIgnored", "episodeFileDeleted", "episodeFileRenamed", "movieFileDeleted", "movieFileRenamed"])(record.eventType) || "other",
          date: safeDate(record.date)
        }))
      };
    } catch { result.unavailable.push("recent_history"); }
    if (downloadIds.size) {
      try {
        const torrents = await callTool("qbittorrent_list_torrents", { limit: 250 });
        const linked = rows(torrents).filter(record => downloadIds.has(String(record.hash || "").toLowerCase()));
        result.downloads.linkedClientRecords = linked.slice(0, 25).map(record => ({ state: queueState(record), percentDownloaded: Math.round(Math.max(0, Math.min(100, (numeric(record.progress) || 0) * 100))), seedCount: numeric(record.num_seeds) }));
      } catch { /* Library-manager results remain useful when the client is absent. */ }
      const linkedNzb = [];
      for (const downloadId of [...downloadIds].slice(0, 3)) {
        try {
          const detail = await callTool("nzbget_history_detail", { downloadId, includeLog: false });
          const state = String(detail.record?.Status || "").toUpperCase();
          linkedNzb.push({
            state: /FAILURE|BAD/.test(state) ? "failed" : /SUCCESS/.test(state) ? "download_complete" : "unknown",
            unpack: enumeration(["SUCCESS", "FAILURE", "NONE", "SKIPPED"])(detail.record?.UnpackStatus),
            repair: enumeration(["SUCCESS", "FAILURE", "NONE", "SKIPPED"])(detail.record?.ParStatus)
          });
        } catch { /* A torrent generally has no matching NZBGet history entry. */ }
      }
      if (linkedNzb.length) result.downloads.linkedNzbRecords = linkedNzb;
    }
  } catch { result.unavailable.push("download_queue"); }
  return result;
}

const CODECS = ["h264", "hevc", "h265", "av1", "vp9", "mpeg2video", "mpeg4", "vc1", "aac", "ac3", "eac3", "dts", "truehd", "flac", "opus", "mp3", "pcm_s16le", "subrip", "ass", "ssa", "webvtt", "hdmv_pgs_subtitle", "dvd_subtitle", "mov_text"];

export async function collectSlackTitlePlayback(args, callTool) {
  const search = await callTool("plex_search", { query: args.title, limit: 100 });
  const container = search?.MediaContainer || search || {};
  const entries = [...(Array.isArray(container.Metadata) ? container.Metadata : []), ...(Array.isArray(container.Hub) ? container.Hub.flatMap(hub => hub.Metadata || []) : [])];
  const matches = entries.filter(item => ["movie", "show"].includes(item.type) && (!args.mediaType || item.type === (args.mediaType === "tv" ? "show" : "movie")) && titleKey(item.title) === titleKey(args.title) && (!args.year || Number(item.year) === args.year));
  const unique = [...new Map(matches.map(item => [String(item.ratingKey), item])).values()];
  if (unique.length !== 1) return { status: unique.length > 1 ? "ambiguous" : "not_found" };
  const item = unique[0];
  if (!/^\d+$/.test(String(item.ratingKey))) return { status: "unavailable" };
  let ratingKey = String(item.ratingKey);
  if (item.type === "show") {
    if (args.seasonNumber === undefined || args.episodeNumber === undefined) return { status: "needs_episode_scope" };
    const seasons = await callTool("plex_list_show_seasons", { ratingKey, limit: 100 });
    const matchingSeasons = (seasons.seasons || []).filter(season => Number(season.index) === args.seasonNumber);
    if (matchingSeasons.length !== 1 || !/^\d+$/.test(String(matchingSeasons[0].ratingKey))) return { status: "not_found" };
    const episodes = await callTool("plex_list_season_children", { ratingKey: String(matchingSeasons[0].ratingKey), limit: 250 });
    const matchingEpisodes = (episodes.children || []).filter(episode => Number(episode.index) === args.episodeNumber);
    if (matchingEpisodes.length !== 1 || !/^\d+$/.test(String(matchingEpisodes[0].ratingKey))) return { status: "not_found" };
    ratingKey = String(matchingEpisodes[0].ratingKey);
  }
  const probe = await callTool("media_probe_video_content", { ratingKey, includeFrameHashes: false });
  const streams = Array.isArray(probe.metadata?.streams) ? probe.metadata.streams : [];
  return {
    status: "matched", title: publicMediaTitle(item.title), mediaType: item.type === "show" ? "tv" : "movie",
    ...(args.seasonNumber !== undefined ? { seasonNumber: args.seasonNumber } : {}),
    ...(args.episodeNumber !== undefined ? { episodeNumber: args.episodeNumber } : {}),
    fileExists: boolean(probe.file?.exists), readable: boolean(probe.file?.readable), probeSucceeded: probe.ffprobe?.code === 0,
    streams: streams.slice(0, 30).map(stream => ({ type: enumeration(["video", "audio", "subtitle"])(stream.codec_type), codec: enumeration(CODECS)(stream.codec_name), width: numeric(stream.width), height: numeric(stream.height), channels: numeric(stream.channels) })),
    subtitleTrackCount: streams.filter(stream => stream.codec_type === "subtitle").length,
    blockers: (Array.isArray(probe.blockers) ? probe.blockers : []).slice(0, 10).map(blocker => enumeration(["ffprobe_missing", "path_not_found", "no_readable_candidate", "outside_allowed_roots", "not_found", "not_a_file"])(blocker.type) || "probe_unavailable")
  };
}

export async function executeSlackReadOnlyCall(name, input, callTool) {
  const args = validateSlackReadOnlyCall(name, input);
  if (typeof callTool !== "function") throw new Error("Read-only media client is unavailable");
  try {
    const result = name === "media_public_title_diagnostics"
      ? await collectSlackTitleDiagnostics(args, callTool)
      : name === "media_public_title_playback"
        ? await collectSlackTitlePlayback(args, callTool)
        : projectSlackPublicResult(name, await callTool(name, args));
    return { tool: name, arguments: args, result };
  } catch {
    // Never forward an upstream error: it may include an API URL or credential.
    return { tool: name, arguments: args, result: { available: false, status: "unavailable" } };
  }
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
