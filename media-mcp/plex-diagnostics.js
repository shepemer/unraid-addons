import { inflateRawSync } from "node:zlib";
import * as z from "zod/v4";

// API references and capability limits: see plex-diagnostics-notes.md.
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
const records = body => Array.isArray(body?.MediaContainer?.Metadata) ? body.MediaContainer.Metadata : [];
const selected = value => value === true || value === 1 || value === "1";
const plexBoolean = value => [true, false, 0, 1, "0", "1"].includes(value) ? selected(value) : undefined;
const presentIds = values => values.filter(value => value !== undefined && value !== null && value !== "").map(String);
const exactId = z.union([z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/), z.number().int().positive()]);
const optionalId = exactId.optional();

export async function runPlexSectionScan(plexApi, sectionKey, path) {
  const endpoint = `library/sections/${encodeURIComponent(String(sectionKey))}/refresh`;
  const query = path ? { path } : {};
  try {
    return { accepted: true, method: "POST", result: await plexApi(endpoint, { method: "POST", query }) };
  } catch (error) {
    // Older PMS versions accept GET. Never retry authentication, validation, or
    // transport failures, which could mask a real error or duplicate a scan.
    if (!/^(?:404|405)\b/.test(String(error.message))) throw error;
    return { accepted: true, method: "GET", compatibilityFallback: true, result: await plexApi(endpoint, { method: "GET", query }) };
  }
}

export async function plexScanStatus(plexApi, { sectionKey } = {}) {
  const [libraries, activities] = await Promise.allSettled([plexApi("library/sections"), plexApi("activities")]);
  const sections = Array.isArray(libraries.value?.MediaContainer?.Directory) ? libraries.value.MediaContainer.Directory : [];
  const scope = sectionKey === undefined ? sections : sections.filter(section => String(section.key) === String(sectionKey));
  const active = (activities.value?.MediaContainer?.Activity || []).filter(activity => /scan|refresh|analy[sz]/i.test(String(activity.type || "")));
  const matches = active.filter(activity => sectionKey === undefined || String(activity.librarySectionID ?? activity.Context?.librarySectionID ?? activity.Context?.sectionID ?? "") === String(sectionKey));
  const unknownScope = sectionKey === undefined ? [] : active.filter(activity => !activity.librarySectionID && !activity.Context?.librarySectionID && !activity.Context?.sectionID);
  const refreshKnown = scope.length > 0 && scope.every(section => plexBoolean(section.refreshing) !== undefined || plexBoolean(section.scanning) !== undefined);
  const refreshing = scope.some(section => selected(section.refreshing) || selected(section.scanning));
  const running = refreshing || matches.length > 0;
  return {
    sectionKey: sectionKey === undefined ? null : String(sectionKey),
    observedAt: new Date().toISOString(),
    state: running ? "running" : refreshKnown && activities.status === "fulfilled" && !unknownScope.length ? "idle" : "unknown",
    sections: scope.map(section => clean({ sectionKey: section.key, refreshing: plexBoolean(section.refreshing), scanning: plexBoolean(section.scanning),
      scannedAt: typeof section.scannedAt === "number" && Number.isFinite(section.scannedAt) && section.scannedAt >= 0 ? section.scannedAt : undefined })),
    activities: matches.slice(0, 50).map(activity => clean({ category: /scan/i.test(String(activity.type)) ? "scan" : /refresh/i.test(String(activity.type)) ? "refresh" : "analyze",
      progress: Number.isFinite(Number(activity.progress)) ? Math.min(100, Math.max(0, Number(activity.progress))) : undefined })),
    unscopedActivityCount: unknownScope.length,
    available: libraries.status === "fulfilled" || activities.status === "fulfilled",
    completionVerified: false,
    note: "A scan request being accepted or a section becoming idle does not prove an item was imported. Verify exact metadata/children after the scan."
  };
}

function sessionIds(record) {
  return presentIds([record.sessionKey, record.Session?.id, record.TranscodeSession?.session, String(record.TranscodeSession?.key || "").split("/").at(-1)]);
}

function sessionMatches(record, input) {
  return (!input.ratingKey || presentIds([record.ratingKey, record.parentRatingKey, record.grandparentRatingKey]).includes(String(input.ratingKey)))
    && (!input.sessionId || sessionIds(record).includes(String(input.sessionId)))
    && (!input.userId || presentIds([record.User?.id]).includes(String(input.userId)))
    && (!input.clientIdentifier || presentIds([record.Player?.machineIdentifier]).includes(String(input.clientIdentifier)));
}

function streamSummary(stream) {
  return clean({ id: stream.id, streamType: stream.streamType, codec: stream.codec, language: stream.language, languageCode: stream.languageCode,
    channels: stream.channels, selected: stream.selected, default: stream.default, forced: stream.forced, decision: stream.decision, displayTitle: stream.displayTitle });
}

function partSummary(part) {
  return clean({ id: part.id, selected: part.selected, decision: part.decision, container: part.container,
    streams: (part.Stream || []).slice(0, 60).map(streamSummary) });
}

function sessionSummary(record) {
  const player = record.Player || {};
  const transcode = record.TranscodeSession || {};
  return clean({
    sessionKey: record.sessionKey, sessionId: record.Session?.id, ratingKey: record.ratingKey,
    title: record.title, parentIndex: record.parentIndex, index: record.index,
    userId: record.User?.id, viewOffset: record.viewOffset, lastViewedAt: record.lastViewedAt,
    player: clean({ clientIdentifier: player.machineIdentifier, product: player.product, model: player.model,
      version: player.version, platform: player.platform, platformVersion: player.platformVersion, state: player.state, local: player.local }),
    media: (record.Media || []).slice(0, 10).map(media => clean({ id: media.id, selected: media.selected,
      videoDecision: media.videoDecision, audioDecision: media.audioDecision, parts: (media.Part || []).slice(0, 20).map(partSummary) })),
    transcode: clean({ sessionId: sessionIds(record).at(-1), key: transcode.key, complete: transcode.complete,
      error: transcode.error, exitCode: transcode.exitCode, progress: transcode.progress, speed: transcode.speed,
      videoDecision: transcode.videoDecision, audioDecision: transcode.audioDecision, subtitleDecision: transcode.subtitleDecision })
  });
}

// No archive member is ever extracted to disk. Central-directory sizes and
// decompression budgets are checked before reading each supported log member.
export function plexLogArchiveEntries(buffer) {
  const maxExpanded = 48 * 1024 * 1024;
  if (buffer.length > 32 * 1024 * 1024) throw new Error("Plex log archive exceeded the 32 MiB compressed limit");
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Plex logs response was not a supported ZIP archive");
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > 500 || offset + directorySize > eocd || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw new Error("Plex log archive exceeds supported bounds");
  const result = [];
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid Plex log ZIP directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw new Error("Invalid Plex log ZIP entry bounds");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset = next;
    if (!/(?:^|\/)(?:Plex Media Server|Plex Transcoder|Plex Media Scanner)[^/]*\.log(?:\.\d+)?$/i.test(name)) continue;
    if (flags & 1 || ![0, 8].includes(method) || size > 8 * 1024 * 1024 || expanded + size > maxExpanded) throw new Error("Plex log member exceeds supported compression bounds");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid Plex log ZIP member");
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) throw new Error("Truncated Plex log ZIP member");
    const compressed = buffer.subarray(start, start + compressedSize);
    const bytes = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.min(8 * 1024 * 1024, size + 1) }) : compressed;
    if (bytes.length !== size) throw new Error("Plex log ZIP size mismatch");
    expanded += bytes.length;
    result.push({ name: name.split("/").at(-1), text: bytes.toString("utf8") });
  }
  return result;
}

async function boundedBody(response, maximum) {
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("Plex response exceeded its byte limit"); }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("Plex response exceeded its byte limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function logTimestamp(line, timezoneOffsetMinutes) {
  const iso = line.match(/^\d{4}-\d{2}-\d{2}T\S+/)?.[0];
  if (iso) return Date.parse(iso);
  const match = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return NaN;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  return month < 0 ? NaN : Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]), Number(match[6]), Number((match[7] || "").padEnd(3, "0"))) - timezoneOffsetMinutes * 60_000;
}

export function createPlexDiagnostics({ plexApi, getService, redactText, fetch: fetchImpl = globalThis.fetch }) {
  const sanitize = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string"
    ? redactText(item).split(getService().token).join("[redacted]") : item));
  async function request(path, { query = {}, headers = {}, maximum = 1024 * 1024 } = {}) {
    const service = getService();
    const url = new URL(`${service.url}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { headers: { "X-Plex-Token": service.token,
      "X-Plex-Client-Identifier": "unraid-media-diagnostics", Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(20_000), redirect: "error" });
    const body = await boundedBody(response, response.ok ? maximum : 4096);
    if (!response.ok) throw new Error(`Plex returned HTTP ${response.status}: ${redactText(body.toString("utf8").slice(0, 500)).split(service.token).join("[redacted]")}`);
    return body;
  }
  async function logs(input) {
    if (!/^(?=.*[a-zA-Z])[a-zA-Z0-9_.:-]{8,200}$/.test(String(input.sessionId || ""))) throw new Error("A precise playback/transcode session ID of at least eight characters is required for log correlation");
    const from = input.since ? Date.parse(input.since) : -Infinity;
    const to = input.until ? Date.parse(input.until) : Infinity;
    if (from > to) throw new Error("since must not be later than until");
    const archive = await request("diagnostics/logs", { maximum: 32 * 1024 * 1024 });
    const entries = plexLogArchiveEntries(archive);
    const escaped = String(input.sessionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchesSession = new RegExp(`(?<![a-zA-Z0-9_.:-])${escaped}(?![a-zA-Z0-9_.:-])`);
    const matches = [];
    let totalMatches = 0;
    for (const entry of entries) for (const line of entry.text.split(/\r?\n/)) {
      if (!matchesSession.test(line)) continue;
      const timestamp = logTimestamp(line, input.timezoneOffsetMinutes || 0);
      if ((input.since || input.until) && (!Number.isFinite(timestamp) || timestamp < from || timestamp > to)) continue;
      totalMatches += 1;
      if (matches.length < (input.limit || 100)) matches.push(clean({ log: entry.name, timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined, line: line.slice(0, 2000) }));
    }
    return sanitize({ sessionId: input.sessionId, available: true, matched: totalMatches > 0, totalMatches, returned: matches.length,
      truncated: totalMatches > matches.length, records: matches,
      limitations: ["Only retained server logs with this exact session ID are included. No match does not establish successful playback or the absence of an error.", "Plex client-displayed errors and past client app logs are not available from the server log archive."] });
  }
  async function playbackAttempts(input, { failOnScopeConflict = false } = {}) {
    if (!input.ratingKey && !input.sessionId) throw new Error("ratingKey or sessionId is required; unscoped session enumeration is not supported here");
    const body = await plexApi("status/sessions");
    if (failOnScopeConflict && input.sessionId && records(body).some(record => sessionIds(record).includes(String(input.sessionId)) && !sessionMatches(record, input))) {
      throw new Error("The active session conflicts with the requested item, user, or client scope");
    }
    const matches = records(body).filter(record => sessionMatches(record, input));
    return sanitize({ observedAt: new Date().toISOString(), matched: matches.length > 0, total: matches.length,
      sessions: matches.slice(0, input.limit || 20).map(sessionSummary),
      limitations: ["This is a snapshot of matching active playback attempts, not proof the client played successfully.", "No active session does not rule out a recent failure. Use an exact retained session ID for server-log evidence; historical client errors may be unavailable."] });
  }
  async function transcodeDiagnostics(input) {
    const attempts = await playbackAttempts(input, { failOnScopeConflict: true });
    let transcodes;
    try {
      const response = await plexApi("transcode/sessions");
      const list = response?.MediaContainer?.TranscodeSession || [];
      transcodes = list.filter(record => presentIds([record.session, record.id, String(record.key || "").split("/").at(-1)]).includes(String(input.sessionId))).slice(0, 20)
        .map(record => clean({ key: record.key, sessionId: record.session || record.id, complete: record.complete,
          progress: record.progress, speed: record.speed, throttled: record.throttled,
          error: record.error, exitCode: record.exitCode, videoDecision: record.videoDecision,
          audioDecision: record.audioDecision, subtitleDecision: record.subtitleDecision }));
    } catch (error) { transcodes = { available: false, error: redactText(error.message) }; }
    let logEvidence;
    if (input.includeLogs) {
      try { logEvidence = await logs(input); } catch (error) { logEvidence = { available: false, error: redactText(error.message) }; }
    }
    return sanitize({ ...attempts, requestedScopeVerified: attempts.matched, transcodes, ...(logEvidence ? { logEvidence } : {}) });
  }
  async function testPlayback(input) {
    const query = { path: `/library/metadata/${input.ratingKey}`, mediaIndex: input.mediaIndex || 0, partIndex: input.partIndex || 0,
      protocol: input.protocol || "hls", directPlay: input.directPlay === false ? 0 : 1, directStream: input.directStream === false ? 0 : 1,
      videoBitrate: input.videoBitrate, audioChannelCount: input.audioChannelCount, subtitles: input.subtitles };
    const headers = { "X-Plex-Client-Profile-Name": input.clientProfile || "Generic", "X-Plex-Platform": input.platform || "Generic",
      "X-Plex-Model": input.model || "generic", "X-Plex-Platform-Version": input.platformVersion || "", "X-Plex-Client-Profile-Extra": input.profileExtra || "" };
    const base = { dryRun: input.dryRun !== false, ratingKey: String(input.ratingKey), endpoint: "video/:/transcode/universal/decision", query,
      clientProfile: headers, scope: "server_media_decision", playbackVerified: false,
      limitations: ["Evaluates Plex's direct-play/transcode decision for these explicit client settings. Does not start playback, decode media, or prove the affected physical device succeeds."] };
    if (input.dryRun !== false) return base;
    let body;
    const response = await request(base.endpoint, { query, headers });
    try { body = JSON.parse(response.toString("utf8")); } catch { throw new Error("Plex playback decision response was not JSON"); }
    const container = body?.MediaContainer || {};
    const decisions = Object.fromEntries(Object.entries(container).filter(([key, value]) => /Decision(?:Code|Text)$/.test(key) && ["string", "number"].includes(typeof value)));
    return sanitize({ ...base, decisionAvailable: Object.keys(decisions).length > 0, decisions,
      media: records(body).slice(0, 1).flatMap(record => (record.Media || []).slice(0, 10).map(media => clean({ id: media.id, videoCodec: media.videoCodec, audioCodec: media.audioCodec, parts: (media.Part || []).slice(0, 20).map(partSummary) }))) });
  }
  async function setStreams(input) {
    if (input.audioStreamId === undefined && input.subtitleStreamId === undefined) throw new Error("audioStreamId or subtitleStreamId is required");
    const endpoint = `library/metadata/${encodeURIComponent(String(input.ratingKey))}`;
    const body = await plexApi(endpoint);
    const findPart = response => records(response).flatMap(record => (record.Media || []).flatMap(media => media.Part || [])).find(part => String(part.id) === String(input.partId));
    const part = findPart(body);
    if (!part) throw new Error("The requested part does not belong to the exact ratingKey");
    for (const [id, type] of [[input.audioStreamId, 2], [input.subtitleStreamId, 3]]) {
      if (id !== undefined && !(type === 3 && id === 0) && !(part.Stream || []).some(stream => Number(stream.id) === id && Number(stream.streamType) === type)) throw new Error("The requested stream does not belong to the exact part and type");
    }
    const base = { dryRun: input.dryRun !== false, ratingKey: String(input.ratingKey), partId: input.partId,
      scope: "authenticated_plex_user", previous: partSummary(part), audioStreamId: input.audioStreamId, subtitleStreamId: input.subtitleStreamId,
      limitations: ["This changes Plex's stream preference for the configured token's user only. It does not change MKV flags or other users' preferences."] };
    if (input.dryRun !== false) return clean(base);
    await plexApi(`library/parts/${input.partId}`, { method: "PUT", query: { audioStreamID: input.audioStreamId, subtitleStreamID: input.subtitleStreamId, allParts: 0 } });
    const refreshed = findPart(await plexApi(endpoint));
    const streams = refreshed?.Stream || [];
    const inventoryComplete = Array.isArray(part.Stream) && part.Stream.length > 0 && Array.isArray(refreshed?.Stream)
      && part.Stream.every(original => streams.some(stream => String(stream.id) === String(original.id) && Number(stream.streamType) === Number(original.streamType)));
    const selectedAudio = streams.filter(stream => Number(stream.streamType) === 2 && selected(stream.selected));
    const selectedSubtitles = streams.filter(stream => Number(stream.streamType) === 3 && selected(stream.selected));
    const audioVerified = input.audioStreamId === undefined || (selectedAudio.length === 1 && Number(selectedAudio[0].id) === input.audioStreamId);
    const subtitleVerified = input.subtitleStreamId === undefined || (input.subtitleStreamId === 0
      ? selectedSubtitles.length === 0 : selectedSubtitles.length === 1 && Number(selectedSubtitles[0].id) === input.subtitleStreamId);
    return sanitize({ ...clean(base), verification: { status: inventoryComplete && audioVerified && subtitleVerified ? "passed" : "failed", inventoryComplete, current: refreshed ? partSummary(refreshed) : null } });
  }
  return { logs, playbackAttempts, transcodeDiagnostics, testPlayback, setStreams };
}

export function registerPlexDiagnosticsTools(server, dependencies) {
  const { jsonText, plexApi } = dependencies;
  const implementation = createPlexDiagnostics(dependencies);
  const scope = { ratingKey: optionalId, sessionId: optionalId, userId: optionalId,
    clientIdentifier: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(20).default(10) };
  const logScope = { sessionId: z.string().min(8).max(200), since: z.iso.datetime().optional(), until: z.iso.datetime().optional(),
    timezoneOffsetMinutes: z.number().int().min(-840).max(840).default(0), limit: z.number().int().min(1).max(200).default(100) };
  // Private playback/user/log tools deliberately have no readOnlyHint, keeping
  // them out of the public Slack gateway even though the operator action reads.
  for (const name of ["plex_playback_attempt_diagnostics", "plex_issue_session_correlation"]) server.registerTool(name, {
    title: "Scoped Plex Playback Attempt Diagnostics", description: "Operator-only exact ratingKey/session/user/client correlation, selected media and streams, client model/version, and active errors. Never evidence of successful client playback.",
    inputSchema: scope
  }, async input => jsonText(await implementation.playbackAttempts(input)));
  server.registerTool("plex_transcode_session_diagnostics", { title: "Exact Plex Transcode Session Diagnostics",
    description: "Operator-only active transcode state and optional retained server logs for one exact playback session. Past client-displayed errors may be unavailable.",
    inputSchema: { ...scope, sessionId: exactId, includeLogs: z.boolean().default(false), since: logScope.since, until: logScope.until, timezoneOffsetMinutes: logScope.timezoneOffsetMinutes }
  }, async input => jsonText(await implementation.transcodeDiagnostics(input)));
  server.registerTool("plex_transcoder_logs_for_session", { title: "Plex Server Logs For Exact Session",
    description: "Operator-only bounded server/transcoder log excerpts matching one exact session ID and optional time window. No archive files are written to disk; secrets are redacted. This is not client log retrieval.", inputSchema: logScope
  }, async input => jsonText(await implementation.logs(input)));
  server.registerTool("plex_test_playback", { title: "Plex Playback Decision Test",
    description: "Dry-run-first test of Plex's direct-play/transcode decision for an exact item and explicit client profile. Does not start playback or claim physical-client verification.", annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: { ratingKey: exactId, clientProfile: z.string().min(1).max(100).default("Generic"), platform: z.string().min(1).max(100).optional(), model: z.string().min(1).max(100).optional(), platformVersion: z.string().max(100).optional(), profileExtra: z.string().max(2000).optional(),
      mediaIndex: z.number().int().min(0).max(50).default(0), partIndex: z.number().int().min(0).max(50).default(0), protocol: z.enum(["hls", "dash", "http"]).default("hls"),
      directPlay: z.boolean().default(true), directStream: z.boolean().default(true), videoBitrate: z.number().int().min(64).max(200000).optional(), audioChannelCount: z.number().int().min(1).max(8).optional(), subtitles: z.enum(["none", "burn", "auto"]).optional(), dryRun: z.boolean().default(true) }
  }, async input => jsonText(await implementation.testPlayback(input)));
  const streamSchema = { ratingKey: exactId, partId: z.number().int().positive(), audioStreamId: z.number().int().positive().optional(), subtitleStreamId: z.number().int().min(0).optional(), dryRun: z.boolean().default(true) };
  for (const name of ["plex_set_stream_preferences", "plex_set_default_stream_or_mkv_track_flags"]) server.registerTool(name, {
    title: "Set Verified Plex User Stream Preference", description: "Dry-run-first exact-part audio/subtitle preference for the authenticated Plex user, verified afterward. Does not edit MKV flags or another user's preferences.", annotations: { destructiveHint: false, idempotentHint: false }, inputSchema: streamSchema
  }, async input => jsonText(await implementation.setStreams(input)));
  server.registerTool("plex_scan_status", { title: "Plex Section Scan Status", description: "Read section refresh flags and matching scan activities. Idle or accepted is not verified import completion.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, inputSchema: { sectionKey: optionalId }
  }, async input => jsonText(await plexScanStatus(plexApi, input)));
}
