import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { slackReadOnlyToolCatalog, validateSlackGatewayArguments } from "../media-issue-agent/src/slack-readonly-gateway.js";

async function freePort() {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

const calls = [];
const fixture = {
  id: 123, mediaType: "movie", title: "Fixture Mystery", originalTitle: "Fixture Mystery",
  overview: "A detective solves a strange disappearance.", releaseDate: "2025-08-02",
  genres: [{ id: 9648, name: "Mystery" }], genreIds: [9648], runtime: 104,
  voteAverage: 8.2, voteCount: 324, originalLanguage: "en", adult: false,
  mediaInfo: { requests: [{ requestedBy: { displayName: "PRIVATE VIEWER", email: "viewer@private.example" } }] },
  requestedBy: { username: "PRIVATE REQUESTER" },
  userData: { lastViewedAt: "PRIVATE HISTORY" }, path: "/private/library", apiKey: "PRIVATE SECRET"
};
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  calls.push({ method: req.method, path: url.pathname });
  assert.equal(req.method, "GET", "Audited sample reads must not mutate upstream state");
  res.writeHead(200, { "content-type": "application/json" });
  if (url.pathname.endsWith("/search")) {
    res.end(JSON.stringify({ page: 1, totalPages: 1, totalResults: 2, results: [fixture, { id: 4, mediaType: "person", name: "PRIVATE PERSON RESULT" }] }));
  } else if (url.pathname.endsWith("/movie/123")) {
    res.end(JSON.stringify(fixture));
  } else if (url.pathname.endsWith("/tv/456")) {
    res.end(JSON.stringify({ ...fixture, id: 456, mediaType: "tv", name: "Fixture Series", title: undefined, firstAirDate: "2024-01-01", releaseDate: undefined, numberOfSeasons: 3, numberOfEpisodes: 24 }));
  } else if (url.pathname.endsWith("/series")) {
    res.end(JSON.stringify([{ id: 1, title: "Fixture Series", monitored: true }]));
  } else if (url.pathname.endsWith("/queue")) {
    res.end(JSON.stringify({ totalRecords: 1, records: [{ id: 1, seriesId: 1, status: "downloading" }] }));
  } else if (url.pathname.endsWith("/qualityprofile")) {
    res.end(JSON.stringify([{ id: 1, name: "HD", items: [], formatItems: [] }]));
  } else if (url.pathname.endsWith("/release")) {
    res.end(JSON.stringify([{ guid: "public-candidate", indexerId: 1, title: "Fixture Series S01E01", approved: true }]));
  } else {
    res.end(JSON.stringify({}));
  }
}).listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamPort = upstream.address().port;
const port = await freePort();
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: {
    ...process.env,
    MEDIA_MCP_BEARER_TOKEN: "readonly-test-token", MEDIA_MCP_HOST: "127.0.0.1", MEDIA_MCP_PORT: String(port),
    SEERR_URL: `http://127.0.0.1:${upstreamPort}/seerr`, SEERR_API_KEY: "fixture-key",
    SONARR_URL: `http://127.0.0.1:${upstreamPort}/sonarr`, SONARR_API_KEY: "fixture-key"
  }, stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", data => { stderr += data; });
const endpoint = `http://127.0.0.1:${port}/mcp`;
let sessionId;
let requestId = 0;
async function rpc(method, params = {}, notification = false) {
  const response = await fetch(endpoint, {
    method: "POST", headers: {
      authorization: "Bearer readonly-test-token", "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++requestId }), method, params })
  });
  const text = await response.text();
  assert.ok(response.ok, `${response.status}: ${text}\n${stderr}`);
  sessionId ||= response.headers.get("mcp-session-id");
  if (!text || notification) return null;
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data:")).slice(5).trim() : text);
}
async function call(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.error && !result.result?.isError, JSON.stringify(result));
  return JSON.parse(result.result.content[0].text);
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fetch(endpoint); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(ready, stderr);
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "readonly-discovery-test", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  const registry = (await rpc("tools/list")).result.tools;
  const tools = new Map(registry.map(tool => [tool.name, tool]));
  const reads = registry.filter(tool => tool.annotations?.readOnlyHint === true);
  assert.ok(reads.length >= 65, `Expected broad discoverable reads, found ${reads.length}`);
  for (const name of [
    "plex_search", "plex_get_metadata", "plex_list_libraries", "plex_list_library_items", "plex_availability",
    "sonarr_list_series", "sonarr_list_episodes", "sonarr_queue", "sonarr_manual_import_candidates", "sonarr_quality_profiles",
    "sonarr_custom_formats", "sonarr_quality_definitions", "sonarr_interactive_search_episode", "sonarr_interactive_search_season",
    "radarr_list_movies", "radarr_lookup_movie", "radarr_queue", "radarr_quality_profiles", "radarr_interactive_search_movie",
    "qbittorrent_list_torrents", "nzbget_status", "nzbget_list_queue", "bazarr_wanted_episodes", "bazarr_status",
    "media_queue_repair_plan", "seerr_public_search_media", "seerr_public_media_details"
  ]) assert.equal(tools.get(name)?.annotations?.readOnlyHint, true, name);

  // Exercise the real discovered schemas/descriptions through the Slack
  // gateway, not only simplified synthetic annotations.
  const gatewayCatalog = slackReadOnlyToolCatalog(registry);
  const gatewayTools = new Map(gatewayCatalog.map(tool => [tool.name, tool]));
  assert.ok(gatewayCatalog.length >= 60, `Expected broad live-catalog gateway access, found ${gatewayCatalog.length}`);
  for (const name of [
    "media_public_library_summary", "media_public_title_summary", "media_public_watchtime_summary",
    "media_public_health_summary", "media_public_queue_summary", "media_public_subtitle_summary",
    "media_public_recent_additions", "media_public_request_status", "plex_public_bandwidth_summary",
    "plex_availability", "plex_search", "plex_get_metadata", "plex_list_libraries", "plex_list_library_items",
    "plex_list_show_seasons", "plex_list_season_children", "plex_scan_status", "sonarr_list_series", "sonarr_list_episodes",
    "sonarr_queue", "sonarr_quality_profiles", "sonarr_interactive_search_season", "radarr_lookup_movie",
    "radarr_interactive_search_movie", "qbittorrent_list_torrents", "seerr_public_search_media", "seerr_public_media_details"
  ]) assert.ok(gatewayTools.has(name), `${name} must survive actual tool-schema and description filtering`);
  for (const name of ["plex_list_show_seasons", "plex_list_season_children"]) {
    assert.equal(validateSlackGatewayArguments(gatewayTools.get(name).inputSchema, { ratingKey: "12345", limit: 20 }), true, name);
    assert.equal(validateSlackGatewayArguments(gatewayTools.get(name).inputSchema, { ratingKey: 12345, limit: 20 }), true, name);
    assert.equal(validateSlackGatewayArguments(gatewayTools.get(name).inputSchema, { ratingKey: "/library/metadata/12345" }), false, name);
    assert.equal(validateSlackGatewayArguments(gatewayTools.get(name).inputSchema, { ratingKey: "12345", userId: "UPRIVATE" }), false, name);
  }
  assert.equal(validateSlackGatewayArguments(gatewayTools.get("seerr_public_search_media").inputSchema, { query: "mystery movies", page: 1 }), true);
  assert.equal(validateSlackGatewayArguments(gatewayTools.get("seerr_public_media_details").inputSchema, { mediaType: "movie", tmdbId: 123 }), true);
  assert.equal(validateSlackGatewayArguments(gatewayTools.get("media_public_watchtime_summary").inputSchema, { periodDays: 30, title: "Fixture Mystery", mediaType: "movie" }), true);
  assert.equal(validateSlackGatewayArguments(gatewayTools.get("media_public_watchtime_summary").inputSchema, { periodDays: 30, userId: "UPRIVATE" }), false);
  for (const name of ["plex_active_sessions", "tautulli_history", "tracearr_history", "tracearr_users", "seerr_request_details", "seerr_list_issues", "media_file_delete", "sonarr_search_episode", "seerr_request_media",
    "plex_playback_attempt_diagnostics", "plex_issue_session_correlation", "plex_transcode_session_diagnostics", "plex_transcoder_logs_for_session",
    "media_resolve_playback_user", "media_user_playback_diagnostics",
    "plex_test_playback", "plex_set_stream_preferences", "plex_set_default_stream_or_mkv_track_flags"]) {
    assert.equal(gatewayTools.has(name), false, name);
  }

  // Mutation semantics cannot become available merely because dryRun defaults true.
  for (const tool of registry) {
    const properties = tool.inputSchema?.properties || {};
    if (tool.annotations?.destructiveHint === true || Object.hasOwn(properties, "dryRun") || Object.hasOwn(properties, "confirmUnsafe")) {
      assert.notEqual(tool.annotations?.readOnlyHint, true, `${tool.name} has mutation-capable arguments`);
    }
  }
  for (const name of [
    "media_archive_environment_check", "media_apply_queue_repair_plan", "media_file_delete", "sonarr_search_missing",
    "sonarr_search_episode", "sonarr_refresh_series", "radarr_search_movie", "radarr_grab_release", "plex_refresh_metadata",
    "plex_analyze_metadata", "plex_scan_library_path", "sonarr_subtitle_replacement_candidates_async", "nzbget_control_downloads",
    "nzbget_extract_archives", "nzbget_retry_postprocess", "qbittorrent_recheck_torrents", "threadfin_backup_config",
    "plex_active_sessions", "plex_status", "plex_recent_user_reports", "plex_issue_details", "tautulli_activity", "tautulli_history",
    "tracearr_users", "tracearr_history", "tracearr_activity", "seerr_request_details", "seerr_list_requests", "seerr_issue_details",
    "seerr_search_media", "sonarr_recent_logs", "radarr_recent_logs", "nzbget_history_detail", "threadfin_get_config"
  ]) assert.notEqual(tools.get(name)?.annotations?.readOnlyHint, true, name);

  const search = await call("seerr_public_search_media", { query: "mystery" });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].title, "Fixture Mystery");
  const movie = await call("seerr_public_media_details", { mediaType: "movie", tmdbId: 123 });
  assert.equal(movie.runtimeMinutes, 104);
  assert.equal(movie.voteAverage, 8.2);
  assert.deepEqual(movie.genres, [{ id: 9648, name: "Mystery" }]);
  assert.equal(movie.overview, fixture.overview);
  const series = await call("seerr_public_media_details", { mediaType: "tv", tmdbId: 456 });
  assert.equal(series.seasonCount, 3);
  assert.equal(series.episodeCount, 24);
  assert.equal(series.year, 2024);
  assert.doesNotMatch(JSON.stringify({ search, movie, series }), /PRIVATE|private|requestedBy|mediaInfo|userData|apiKey|lastViewedAt/);
  await call("sonarr_list_series", { term: "Fixture" });
  await call("sonarr_quality_profiles");
  await call("sonarr_queue");
  await call("sonarr_interactive_search_episode", { episodeId: 1 });
  assert.ok(calls.length >= 7);
  assert.ok(calls.every(request => request.method === "GET"));
  console.log(`Read-only discovery tests passed: ${reads.length} of ${registry.length} tools are read-only; ${gatewayCatalog.length} survive gateway filtering.`);
} finally {
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  await stopped;
  await new Promise(resolve => upstream.close(resolve));
}
