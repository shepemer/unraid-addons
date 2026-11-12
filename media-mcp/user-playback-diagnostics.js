import * as z from "zod/v4";
import { normalizePublicTimeRange } from "./public-watchtime.js";

// These tools are private MCP capabilities. Slack must authenticate and bind
// the requested account before exposing them through its scoped gateway.
// No response from diagnostics contains account selectors or raw history.
const id = value => {
  const text = String(value ?? "");
  return /^[1-9]\d{0,19}$/.test(text) ? text : null;
};
const normalized = value => typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
const rows = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.rows) ? value.rows : null;
const number = (value, max = Number.MAX_SAFE_INTEGER) => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max ? Number(value) : null;
const bool = value => [true, 1, "1"].includes(value) ? true : [false, 0, "0"].includes(value) ? false : null;
const count = value => Number.isSafeInteger(number(value)) ? number(value) : null;
const exactOwner = (record, wanted) => id(record?.user_id ?? record?.userId ?? record?.User?.id) === wanted;

function platform(value) {
  const name = normalized(value);
  const names = {
    android: "Android", "android tv": "Android TV", androidtv: "Android TV", ios: "iOS", ipados: "iPadOS",
    tvos: "Apple TV", "apple tv": "Apple TV", roku: "Roku", windows: "Windows", linux: "Linux",
    macos: "macOS", osx: "macOS", "mac os x": "macOS", chrome: "Chrome", firefox: "Firefox",
    safari: "Safari", edge: "Edge", web: "Web", chromecast: "Chromecast", tizen: "Samsung TV",
    "samsung smart tv": "Samsung TV", webos: "LG TV", "lg smart tv": "LG TV", "fire tv": "Fire TV",
    firetv: "Fire TV", playstation: "PlayStation", "playstation 4": "PlayStation", "playstation 5": "PlayStation",
    xbox: "Xbox", "xbox one": "Xbox"
  };
  return Object.hasOwn(names, name) ? names[name] : "Other or unavailable";
}

function decision(value) {
  const text = normalized(value).replaceAll("_", " ");
  if (["direct play", "directplay"].includes(text)) return "directPlay";
  if (["copy", "direct stream", "directstream"].includes(text)) return "directStream";
  return text === "transcode" ? "transcode" : "unknown";
}

function state(value) {
  const text = normalized(value);
  return ["playing", "paused", "buffering", "stopped", "error"].includes(text) ? text : "unknown";
}

function codec(value) {
  const text = normalized(value);
  return ["h264", "hevc", "h265", "av1", "vp9", "vp8", "mpeg2video", "mpeg4", "aac", "ac3", "eac3", "truehd", "dts", "dca", "flac", "mp3", "opus", "vorbis", "srt", "ass", "ssa", "pgs", "hdmv_pgs_subtitle", "webvtt", "vtt", "dvd_subtitle", "dvb_subtitle", "text"].includes(text) ? text : null;
}

function errorCategories(record) {
  const fields = [record?.error, record?.error_message, record?.errorMessage, record?.transcode_error, record?.TranscodeSession?.error];
  const text = fields.filter(value => typeof value === "string").map(value => value.slice(0, 2000)).join(" ");
  const categories = [];
  if (/decode|decoder|corrupt|invalid (?:data|packet)/i.test(text)) categories.push("decode_error");
  if (/transcod|convert/i.test(text)) categories.push("transcode_error");
  if (/timeout|timed out|deadline/i.test(text)) categories.push("timeout");
  if (/connect|network|socket|unreachable|ECONN/i.test(text)) categories.push("connection_error");
  if (/denied|forbidden|unauthori[sz]ed|permission/i.test(text)) categories.push("access_error");
  if (/not found|missing|ENOENT/i.test(text)) categories.push("missing_media");
  if (/ENOSPC|out of memory|no space|resource/i.test(text)) categories.push("resource_error");
  if (!categories.length && (text.trim() || record?.error === true || Number(record?.TranscodeSession?.exitCode) > 0)) categories.push("reported_error");
  return categories;
}

function technicalRecord(record, source = "tautulli") {
  const media = source === "plex" ? (record.Media || []).find(item => bool(item.selected) === true) || record.Media?.[0] || {} : record;
  const transcode = record.TranscodeSession || {};
  const streams = source === "plex" ? (media.Part || []).flatMap(part => part.Stream || []) : [];
  const subtitleChoice = normalized(record.stream_subtitle_decision ?? record.subtitle_decision ?? transcode.subtitleDecision);
  const result = {
    platform: platform(source === "plex" ? record.Player?.platform : record.platform),
    state: state(source === "plex" ? record.Player?.state : record.state),
    streamDecision: decision(record.transcode_decision),
    videoDecision: decision(record.stream_video_decision ?? record.video_decision ?? media.videoDecision ?? transcode.videoDecision),
    audioDecision: decision(record.stream_audio_decision ?? record.audio_decision ?? media.audioDecision ?? transcode.audioDecision),
    subtitleDecision: ["burn", "burn-in", "burn in"].includes(subtitleChoice) ? "burn" : subtitleChoice === "none" ? "none" : decision(subtitleChoice),
    observedErrors: errorCategories(record)
  };
  for (const [key, value] of Object.entries({
    videoCodec: codec(record.stream_video_codec ?? record.video_codec ?? transcode.videoCodec ?? media.videoCodec),
    audioCodec: codec(record.stream_audio_codec ?? record.audio_codec ?? transcode.audioCodec ?? streams.find(stream => Number(stream.streamType) === 2 && bool(stream.selected) === true)?.codec ?? media.audioCodec),
    subtitleCodec: codec(record.stream_subtitle_codec ?? record.subtitle_codec ?? streams.find(stream => Number(stream.streamType) === 3 && bool(stream.selected) === true)?.codec)
  })) if (value) result[key] = value;
  if (result.streamDecision === "unknown") {
    const components = [result.videoDecision, result.audioDecision];
    result.streamDecision = components.includes("transcode") ? "transcode" : components.includes("directStream") ? "directStream" : components.includes("directPlay") ? "directPlay" : "unknown";
  }
  const numeric = {
    sourceBitrateKbps: number(source === "plex" ? media.bitrate : record.bitrate, 10_000_000),
    streamBitrateKbps: number(record.stream_bitrate ?? record.Session?.bandwidth, 10_000_000),
    bandwidthKbps: number(record.bandwidth ?? record.Session?.bandwidth, 10_000_000),
    transcodeSpeed: number(record.transcode_speed ?? transcode.speed, 1000),
    bufferCount: count(number(record.buffer_count ?? record.bufferCount, 1_000_000)),
    videoWidth: number(record.stream_video_width ?? media.width, 32768),
    videoHeight: number(record.stream_video_height ?? media.height, 32768)
  };
  for (const [key, value] of Object.entries(numeric)) if (value !== null) result[key] = value;
  const local = bool(record.local ?? record.Player?.local);
  const relay = bool(record.relayed ?? record.Player?.relayed);
  result.connection = relay === true ? "relay" : local === true || record.location === "lan" ? "local" : local === false || record.location === "wan" ? "remote" : "unknown";
  const version = String(record.Player?.version ?? record.product_version ?? "");
  if (/^\d{1,5}(?:\.\d{1,8}){0,4}$/.test(version)) result.clientVersion = version;
  return result;
}

function summarizeTechnical(records) {
  const result = { checkedCount: records.length, streamDecisions: { directPlay: 0, directStream: 0, transcode: 0, unknown: 0 }, platforms: {}, observedErrors: {}, bufferingCount: 0, bufferMetricCount: 0, totalBufferCount: 0 };
  const rates = [];
  const speeds = [];
  for (const record of records) {
    result.streamDecisions[record.streamDecision]++;
    result.platforms[record.platform] = (result.platforms[record.platform] || 0) + 1;
    for (const category of record.observedErrors) result.observedErrors[category] = (result.observedErrors[category] || 0) + 1;
    if (record.state === "buffering") result.bufferingCount++;
    if (record.bufferCount !== undefined) { result.bufferMetricCount++; result.totalBufferCount += record.bufferCount; }
    if (record.streamBitrateKbps !== undefined) rates.push(record.streamBitrateKbps);
    if (record.transcodeSpeed !== undefined) speeds.push(record.transcodeSpeed);
  }
  if (rates.length) result.streamBitrateKbps = { observedCount: rates.length, minimum: Math.min(...rates), maximum: Math.max(...rates) };
  if (speeds.length) result.transcodeSpeed = { observedCount: speeds.length, belowRealtimeCount: speeds.filter(value => value < 1).length, minimum: Math.min(...speeds), maximum: Math.max(...speeds) };
  return result;
}

export function createUserPlaybackDiagnostics({ tautulliApi, plexApi, configured = { tautulli: true, plex: true }, now = Date.now, timeoutMs = 25000, maxCalls = 20, pageSize = 250, maxPages = 8, maxDetails = 6 }) {
  function budget(externalSignal) {
    const deadline = now() + timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    let calls = 0;
    const exhausted = () => calls >= maxCalls || signal.aborted || now() >= deadline;
    return { exhausted, get calls() { return calls; }, read: async (source, command, query = {}) => {
      if (exhausted()) throw new Error("Diagnostic work budget exhausted");
      calls++;
      const options = { query, signal, timeoutMs: Math.max(1, deadline - now()) };
      return source === "tautulli" ? tautulliApi(command, options) : plexApi(command, options);
    } };
  }
  async function resolve(input, options = {}) {
    const query = normalized(input.query);
    if (!query || query.length > 200) throw new Error("Supply one exact account lookup");
    if (!configured.tautulli) return { available: false, status: "unavailable", complete: false, candidates: [] };
    const scope = budget(options.signal);
    try {
      const directory = rows(await scope.read("tautulli", "get_users"));
      if (!directory || directory.length > 10000) return { available: false, status: "unavailable", complete: false, candidates: [] };
      const fields = input.matchBy ? [input.matchBy] : ["username", "email", "friendly_name", "user_id"];
      const found = new Map();
      for (const account of directory) {
        const accountId = id(account.user_id);
        if (!accountId) continue;
        const matchedBy = fields.filter(key => ["username", "email", "friendly_name", "user_id"].includes(key) && normalized(String(account[key] ?? "")) === query);
        if (matchedBy.length) found.set(accountId, { resolvedUserId: accountId, matchedBy: [...new Set([...(found.get(accountId)?.matchedBy || []), ...matchedBy])] });
      }
      return { available: true, status: found.size === 1 ? "matched" : found.size > 1 ? "ambiguous" : "not_found", complete: true, matchCount: found.size, candidates: [...found.values()].slice(0, 10) };
    } catch { return { available: false, status: "unavailable", complete: false, candidates: [] }; }
  }

  async function diagnose(input, options = {}) {
    const target = id(input.resolvedUserId);
    if (!target) throw new Error("An exact resolved account is required");
    const range = normalizePublicTimeRange(input, now());
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer");
    const scope = budget(options.signal);
    const unavailable = [];
    const observed = [];
    const details = [];
    const candidates = [];
    const attempts = [];
    const today = new Date(now()).toISOString().slice(0, 10);
    const includeCurrent = (!range.periodStartDate || range.periodStartDate <= today) && (!range.periodEndDate || range.periodEndDate >= today);
    const current = { included: includeCurrent, tautulli: { available: false, attemptCount: 0, attempts: [] }, plex: { available: false, attemptCount: 0, attempts: [] } };
    const history = { available: false, complete: false, offset, scannedRows: 0, attemptCount: 0, shortAttemptCount: 0, repeatedAttemptCount: 0, scopeConflictCount: 0, expectedCount: null, nextOffset: null };
    let historyEnabled = configured.tautulli;
    if (configured.tautulli) {
      try {
        const directory = rows(await scope.read("tautulli", "get_users"));
        if (!directory) throw new Error("Unavailable account directory");
        const account = directory.find(record => id(record.user_id) === target);
        if (!account) return { available: false, complete: false, status: "not_found", range };
        history.retention = bool(account.keep_history) === true ? "enabled" : bool(account.keep_history) === false ? "disabled" : "unknown";
      } catch {
        if (!configured.plex) return { available: false, complete: false, status: "unavailable", range };
        unavailable.push("account_directory");
        historyEnabled = false;
        history.incompleteReason = "account_directory_unavailable";
      }
    }
    if (includeCurrent && configured.tautulli) {
      try {
        const activity = await scope.read("tautulli", "get_activity");
        if (!Array.isArray(activity?.sessions)) throw new Error("Unavailable current activity");
        const matching = activity.sessions.filter(record => exactOwner(record, target));
        current.tautulli = { available: true, attemptCount: matching.length, complete: matching.length <= 20, attempts: matching.slice(0, 20).map(record => technicalRecord(record)) };
      } catch { unavailable.push("current_tautulli"); }
    }
    if (includeCurrent && configured.plex) {
      try {
        const body = await scope.read("plex", "status/sessions");
        if (!body?.MediaContainer || (body.MediaContainer.Metadata !== undefined && !Array.isArray(body.MediaContainer.Metadata))
          || (body.MediaContainer.Metadata === undefined && Number(body.MediaContainer.size) !== 0)) throw new Error("Unavailable current playback");
        const matching = (body.MediaContainer.Metadata || []).filter(record => exactOwner(record, target));
        current.plex = { available: true, attemptCount: matching.length, complete: matching.length <= 20, attempts: matching.slice(0, 20).map(record => technicalRecord(record, "plex")) };
      } catch { unavailable.push("current_plex"); }
    }
    if (historyEnabled) {
      try {
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
          const page = await scope.read("tautulli", "get_history", {
            user_id: target, grouping: 0, include_activity: 0, order_column: "date", order_dir: "desc",
            start: offset + history.scannedRows, length: pageSize,
            ...(range.periodStartDate ? { after: range.periodStartDate } : {}), ...(range.periodEndDate ? { before: range.periodEndDate } : {})
          });
          const records = rows(page);
          if (!records || records.length > pageSize) throw new Error("Unavailable bounded history");
          history.available = true;
          const expected = count(page.recordsFiltered);
          if (history.expectedCount !== null && expected !== null && expected !== history.expectedCount) { history.incompleteReason = "history_changed"; break; }
          history.expectedCount ??= expected;
          for (const record of records) {
            if (!exactOwner(record, target)) { history.scopeConflictCount++; continue; }
            history.attemptCount++;
            const duration = number(record.duration ?? record.play_duration);
            if (duration !== null && duration < 120) history.shortAttemptCount++;
            observed.push(technicalRecord(record));
            const content = id(record.rating_key);
            const client = typeof record.machine_id === "string" && record.machine_id.length <= 200 ? record.machine_id : null;
            const started = number(record.started ?? record.date);
            if (content && client && started !== null) attempts.push({ content, client, started });
            const rowId = id(record.row_id ?? record.id);
            if (rowId && candidates.length < maxDetails && !candidates.includes(rowId)) candidates.push(rowId);
          }
          history.scannedRows += records.length;
          if (history.expectedCount !== null ? offset + history.scannedRows >= history.expectedCount : records.length < pageSize) { history.complete = true; break; }
          if (!records.length) { history.incompleteReason = "incomplete_upstream_page"; break; }
        }
      } catch { history.incompleteReason = scope.exhausted() ? "work_budget_exhausted" : "upstream_unavailable"; }
      if (history.scopeConflictCount) { history.complete = false; history.incompleteReason = "scope_mismatch"; }
      if (!history.complete) {
        history.incompleteReason ||= "work_budget_exhausted";
        if (!["history_changed", "scope_mismatch", "incomplete_upstream_page"].includes(history.incompleteReason)) history.nextOffset = offset + history.scannedRows;
      }
      for (const rowId of [...new Set(candidates)]) {
        if (scope.exhausted()) break;
        try {
          const record = await scope.read("tautulli", "get_stream_data", { row_id: rowId });
          if (!record || typeof record !== "object" || Array.isArray(record)) continue;
          if (record.user_id !== undefined && !exactOwner(record, target)) continue;
          if ((record.row_id ?? record.id) !== undefined && id(record.row_id ?? record.id) !== rowId) continue;
          details.push(technicalRecord(record));
        } catch { unavailable.push("historical_stream_details"); }
      }
    }
    const lastStarts = new Map();
    for (const attempt of attempts.sort((left, right) => left.started - right.started)) {
      const key = JSON.stringify([attempt.content, attempt.client]);
      const previous = lastStarts.get(key);
      if (previous !== undefined && attempt.started > previous && attempt.started - previous <= 600) history.repeatedAttemptCount++;
      lastStarts.set(key, attempt.started);
    }
    Object.assign(history, summarizeTechnical(observed));
    const technical = { ...summarizeTechnical(details), sampled: true, complete: details.length === candidates.length, eligibleRecentCount: candidates.length };
    const available = history.available || current.tautulli.available || current.plex.available;
    return {
      available,
      complete: available && (!configured.tautulli || history.complete) && (!includeCurrent || (!configured.tautulli || current.tautulli.complete === true) && (!configured.plex || current.plex.complete === true)) && technical.complete,
      status: available ? "ok" : "unavailable", generatedAt: new Date(now()).toISOString(), range, history, current, technical,
      requestCount: scope.calls, unavailable: [...new Set(unavailable)],
      limitations: [
        "Only the exact authorized account is checked; identifiers and watched titles are omitted.",
        "Current Plex and Tautulli snapshots may describe the same playback; do not add their counts.",
        "History metrics describe the observed attempts in this page range. Use nextOffset for later pages; counts are not cumulative.",
        "Repeated attempts mean the same media and client restarted within ten minutes; short attempts and repeats do not establish a failure.",
        "Historical bitrate and codec decisions are sampled from recent retained stream details. Buffering and client-displayed errors may not have been retained.",
        ...(history.retention === "disabled" ? ["History collection is disabled for this account; retained records may not cover recent attempts."] : []),
        "No errors observed is not proof that playback succeeded; this tool does not start playback or change media."
      ]
    };
  }
  return { resolve, diagnose };
}

export function registerUserPlaybackDiagnostics(server, dependencies) {
  const implementation = createUserPlaybackDiagnostics(dependencies);
  const accountId = z.string().regex(/^[1-9]\d{0,19}$/);
  // Deliberately no readOnlyHint: these reads require account-scoped authority,
  // unlike public aggregates advertised by the unprivileged Slack gateway.
  server.registerTool("media_resolve_playback_user", {
    title: "Resolve Exact Playback Account",
    annotations: { destructiveHint: false },
    description: "Private read-only exact account lookup for an authorized diagnosis. No fuzzy matches or directory listing. Returns internal selectors only; caller must authenticate the requester and keep selectors out of public chat.",
    inputSchema: { query: z.string().min(1).max(200), matchBy: z.enum(["username", "email", "friendly_name", "user_id"]).optional() }
  }, async (input, extra) => dependencies.jsonText(await implementation.resolve(input, { signal: extra?.signal })));
  server.registerTool("media_user_playback_diagnostics", {
    title: "Exact Account Playback Technical Diagnostics",
    annotations: { destructiveHint: false },
    description: "Private read-only diagnostics for one exact authorized account. Returns technical evidence and honest coverage without account identities, watched titles, paths, addresses, or raw history. Does not authorize its caller, start playback, or modify media.",
    inputSchema: { resolvedUserId: accountId, allTime: z.boolean().optional(), periodDays: z.number().int().positive().optional(), periodMonths: z.number().int().positive().optional(), periodYears: z.number().int().positive().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), offset: z.number().int().min(0).default(0) }
  }, async (input, extra) => dependencies.jsonText(await implementation.diagnose(input, { signal: extra?.signal })));
}
