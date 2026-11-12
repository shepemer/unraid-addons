import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function parseSse(text) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const data = text.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim();
  return JSON.parse(data);
}

async function run() {
  const currentMonth = new Date();
  const currentMonthSeconds = Math.floor(Date.UTC(
    currentMonth.getUTCFullYear(),
    currentMonth.getUTCMonth(),
    3
  ) / 1000);
  const previousMonthSeconds = Math.floor(Date.UTC(
    currentMonth.getUTCFullYear(),
    currentMonth.getUTCMonth() - 1,
    3
  ) / 1000);
  const calls = [];
  const periodStartDate = days => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86400_000).toISOString().slice(0, 10);
  };
  let historyOverride = null;
  const fallbackHistoryRows = [
    { media_type: "movie", title: "Private Watch Record", duration: 207, friendly_name: "Private User", user_id: 7001, player: "private-device" },
    { media_type: "episode", grandparent_title: "Private Series", duration: 3600, friendly_name: "Another Private User", user_id: 7002 },
    { media_type: "movie", title: "Private Watch Record", duration: 125, friendly_name: "Private User", user_id: 7001 }
  ];
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams)
    });

    if (url.pathname.startsWith("/sonarr")) {
      assert.equal(req.headers["x-api-key"], "sonarr-key");
    }
    if (url.pathname.startsWith("/radarr")) {
      assert.equal(req.headers["x-api-key"], "radarr-key");
    }
    if (url.pathname.startsWith("/plex")) {
      assert.equal(req.headers["x-plex-token"], "plex-token");
    }
    if (url.pathname.startsWith("/bazarr") || url.pathname.startsWith("/seerr")) {
      assert.ok(req.headers["x-api-key"]);
    }
    if (url.pathname.startsWith("/tautulli")) {
      assert.equal(url.searchParams.get("apikey"), "tautulli-key");
    }

    if (url.pathname === "/sonarr/api/v3/series") {
      return sendJson(res, 200, [{
        id: 101,
        title: "Fixture Series",
        year: 2024,
        monitored: true,
        status: "continuing",
        path: "/private/tv/Fixture Series",
        seasons: [
          { seasonNumber: 0, monitored: false },
          { seasonNumber: 1, monitored: true },
          { seasonNumber: 2, monitored: true }
        ],
        statistics: {
          seasonCount: 2,
          episodeCount: 20,
          totalEpisodeCount: 24,
          episodeFileCount: 18,
          sizeOnDisk: 2_000_000_000
        }
      }, {
        id: 102,
        title: "Second Fixture",
        year: 2021,
        monitored: false,
        status: "ended",
        path: "/private/tv/Second Fixture",
        statistics: {
          seasonCount: 1,
          episodeCount: 8,
          totalEpisodeCount: 8,
          episodeFileCount: 8,
          sizeOnDisk: 1_000_000_000
        }
      }]);
    }
    if (url.pathname === "/radarr/api/v3/movie") {
      return sendJson(res, 200, [{
        id: 201,
        title: "Fixture Movie",
        year: 2025,
        monitored: true,
        status: "released",
        hasFile: true,
        path: "/private/movies/Fixture Movie",
        movieFile: { id: 501, size: 4_000_000_000 }
      }, {
        id: 202,
        title: "Missing Fixture",
        year: 2026,
        monitored: true,
        status: "released",
        hasFile: false,
        path: "/private/movies/Missing Fixture"
      }]);
    }
    if (url.pathname === "/sonarr/api/v3/queue/details") {
      return sendJson(res, 200, [
        { id: 301, title: "Private.Download.Name", outputPath: "/private/downloads/a", status: "downloading" },
        { id: 302, title: "Another.Private.Download", outputPath: "/private/downloads/b", status: "warning" }
      ]);
    }
    if (url.pathname === "/radarr/api/v3/queue/details") {
      return sendJson(res, 200, [
        { id: 401, title: "Private.Movie.Download", outputPath: "/private/downloads/c", status: "downloading" }
      ]);
    }
    if (url.pathname === "/sonarr/api/v3/system/status"
      || url.pathname === "/radarr/api/v3/system/status"
      || url.pathname === "/bazarr/api/system/status"
      || url.pathname === "/seerr/api/v1/status") {
      return sendJson(res, 200, { version: "private-version", url: "http://private.internal" });
    }
    if (url.pathname === "/plex/") {
      return sendJson(res, 200, { MediaContainer: { machineIdentifier: "private-machine-id" } });
    }
    if (url.pathname === "/plex/statistics/bandwidth") {
      assert.equal(url.searchParams.get("timespan"), "1");
      return sendJson(res, 200, {
        MediaContainer: {
          StatisticsBandwidth: [
            { at: currentMonthSeconds, bytes: 1_000_000, lan: 1, accountID: 777, deviceID: 888 },
            { at: currentMonthSeconds + 3600, bytes: 2_000_000, lan: 0, accountID: 999, deviceID: 1000 },
            { at: previousMonthSeconds, bytes: 9_000_000, lan: 0, accountID: 555, deviceID: 666 }
          ]
        }
      });
    }
    if (url.pathname === "/plex/library/recentlyAdded") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "private-rating-key",
            type: "movie",
            title: "Recent Fixture",
            year: 2026,
            addedAt: currentMonthSeconds,
            user: { title: "Private User" },
            Media: [{ Part: [{ file: "/private/movies/Recent Fixture.mkv" }] }]
          }, {
            ratingKey: "private-episode-key",
            type: "episode",
            grandparentTitle: "Recent Series",
            parentIndex: 2,
            index: 4,
            title: "Recent Episode",
            addedAt: currentMonthSeconds - 60
          }]
        }
      });
    }
    if (url.pathname === "/bazarr/api/movies/wanted") {
      return sendJson(res, 200, { total: 7, data: [{ path: "/private/movie.srt" }] });
    }
    if (url.pathname === "/bazarr/api/episodes/wanted") {
      return sendJson(res, 200, { total: 11, data: [{ path: "/private/episode.srt" }] });
    }
    if (url.pathname === "/bazarr/api/providers") {
      return sendJson(res, 200, { data: [{ name: "private-provider-a" }, { name: "private-provider-b" }] });
    }
    if (url.pathname === "/seerr/api/v1/search") {
      return sendJson(res, 200, {
        results: [{
          id: 901,
          mediaType: "movie",
          title: "Fixture Request",
          releaseDate: "2025-02-02",
          mediaInfo: {
            id: 902,
            status: 3,
            requests: [{ requestedBy: { email: "private@example.test" } }]
          }
        }]
      });
    }
    if (url.pathname === "/tautulli/api/v2" && url.searchParams.get("cmd") === "get_history") {
      assert.equal(url.searchParams.get("grouping"), "0");
      assert.equal(url.searchParams.get("include_activity"), "0");
      assert.match(url.searchParams.get("after"), /^\d{4}-\d{2}-\d{2}$/);
      if (url.searchParams.get("search") === "Fixture Series") {
        assert.equal(url.searchParams.get("media_type"), "episode");
        return sendJson(res, 200, {
          response: {
            result: "success",
            data: {
              recordsTotal: 50,
              recordsFiltered: 3,
              total_duration: "201 days 4 hrs 30 mins",
              filter_duration: "207 secs",
              data: [{
                media_type: "episode",
                grandparent_title: "Fixture Series",
                grandparent_year: 2024,
                duration: 1800,
                friendly_name: "Private User",
                user_id: 7001,
                player: "private-device"
              }, {
                media_type: "episode",
                grandparent_title: "Fixture Series",
                grandparent_year: 2024,
                duration: 900,
                friendly_name: "Another Private User",
                user_id: 7002
              }, {
                media_type: "episode",
                grandparent_title: "Other Series",
                duration: 99_999,
                friendly_name: "Fixture Series"
              }]
            }
          }
        });
      }
      if (url.searchParams.get("search") === "Fixture Movie") {
        assert.equal(url.searchParams.get("media_type"), "movie");
        return sendJson(res, 200, {
          response: {
            result: "success",
            data: {
              recordsTotal: 23480,
              recordsFiltered: 1,
              // The upstream total ignores the global search text. The exact
              // movie calculation must still use matching rows, not this sum.
              total_duration: "70 days 2 hrs",
              filter_duration: "5125 secs",
              data: [{ media_type: "movie", title: "Fixture Movie", year: 2025, duration: 5125, friendly_name: "Private User", user_id: 7001 }]
            }
          }
        });
      }
      const start = Number(url.searchParams.get("start"));
      const length = Number(url.searchParams.get("length"));
      const weekly = url.searchParams.get("after") === periodStartDate(7);
      const moviesOnly = url.searchParams.get("media_type") === "movie";
      const overrideRows = historyOverride?.rowCount
        ? Array.from({ length: Math.min(length, Math.max(0, historyOverride.rowCount - start)) }, () => ({ duration: 1, media_type: "movie", friendly_name: "Private User" }))
        : (historyOverride?.rows || fallbackHistoryRows).slice(start, start + length);
      return sendJson(res, 200, {
        response: {
          result: "success",
          data: {
            recordsTotal: 23480,
            recordsFiltered: historyOverride?.rowCount || (historyOverride ? fallbackHistoryRows.length : weekly ? 42 : moviesOnly ? 5000 : 23480),
            // With length=1 the page is just 207 seconds, even when thousands
            // of filtered plays cover many days of watch time.
            filter_duration: "3 mins 27 secs",
            ...(historyOverride ? historyOverride.summary : { total_duration: weekly ? "14 hrs 30 mins" : moviesOnly ? "70 days 2 hrs" : "201 days 4 hrs 30 mins" }),
            data: historyOverride ? overrideRows : [{
              media_type: "movie",
              title: "Private Watch Record",
              duration: 207,
              friendly_name: "Private User"
            }]
          }
        }
      });
    }

    return sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const mockPort = mock.address().port;
  const mediaPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      MEDIA_MCP_BEARER_TOKEN: "test-token",
      MEDIA_MCP_HOST: "127.0.0.1",
      MEDIA_MCP_PORT: String(mediaPort),
      PLEX_URL: `http://127.0.0.1:${mockPort}/plex`,
      PLEX_TOKEN: "plex-token",
      SONARR_URL: `http://127.0.0.1:${mockPort}/sonarr`,
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: `http://127.0.0.1:${mockPort}/radarr`,
      RADARR_API_KEY: "radarr-key",
      BAZARR_URL: `http://127.0.0.1:${mockPort}/bazarr`,
      BAZARR_API_KEY: "bazarr-key",
      SEERR_URL: `http://127.0.0.1:${mockPort}/seerr`,
      SEERR_API_KEY: "seerr-key",
      TAUTULLI_URL: `http://127.0.0.1:${mockPort}/tautulli`,
      TAUTULLI_API_KEY: "tautulli-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const baseUrl = `http://127.0.0.1:${mediaPort}/mcp`;
  let sessionId;
  let id = 1;

  async function rpc(method, params = {}, hasId = true) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(hasId ? { id: id++ } : {}), method, params })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${response.status}: ${text}\nstdout=${stdout}\nstderr=${stderr}`);
    }
    sessionId ||= response.headers.get("mcp-session-id") || undefined;
    return hasId && text ? parseSse(text) : null;
  }

  async function tool(name, args = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    assert.ok(!response.result.isError, response.result.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  }

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(baseUrl, {
          headers: { authorization: "Bearer test-token", accept: "application/json, text/event-stream" }
        });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "public-media-info-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const listed = await rpc("tools/list");
    const tools = new Map(listed.result.tools.map(toolInfo => [toolInfo.name, toolInfo]));
    const expectedTools = [
      "media_public_library_summary",
      "media_public_title_summary",
      "media_public_watchtime_summary",
      "media_public_health_summary",
      "media_public_queue_summary",
      "media_public_subtitle_summary",
      "media_public_recent_additions",
      "media_public_request_status",
      "plex_public_bandwidth_summary"
    ];
    for (const name of expectedTools) {
      assert.equal(tools.get(name)?.annotations?.readOnlyHint, true, `${name} must be read-only`);
    }

    const library = await tool("media_public_library_summary");
    assert.equal(library.tv.seriesCount, 2);
    assert.equal(library.tv.missingEpisodeCount, 2);
    assert.equal(library.movies.movieCount, 2);
    assert.equal(library.movies.missingMovieCount, 1);
    assert.equal(library.totalSizeOnDiskBytes, 7_000_000_000);

    const series = await tool("media_public_title_summary", {
      title: "Fixture Series",
      mediaType: "tv",
      year: 2024
    });
    assert.equal(series.status, "matched");
    assert.equal(series.result.title, "Fixture Series");
    assert.equal(series.result.missingEpisodeCount, 2);
    assert.equal(Object.hasOwn(series.result, "id"), false);

    const aggregateWatchtime = await tool("media_public_watchtime_summary", { periodDays: 365 });
    assert.equal(aggregateWatchtime.scope, "library");
    assert.equal(aggregateWatchtime.playCount, 23480);
    assert.equal(aggregateWatchtime.totalWatchSeconds, 201 * 86400 + 4 * 3600 + 30 * 60);
    assert.notEqual(aggregateWatchtime.totalWatchSeconds, 207);
    assert.equal(aggregateWatchtime.periodDays, 365);
    assert.equal(aggregateWatchtime.complete, true);
    const aggregateCall = calls.at(-1);
    assert.equal(aggregateCall.query.length, "1");
    assert.equal(aggregateCall.query.after, periodStartDate(365));

    const weeklyWatchtime = await tool("media_public_watchtime_summary", { periodDays: 7 });
    assert.equal(weeklyWatchtime.playCount, 42);
    assert.equal(weeklyWatchtime.totalWatchSeconds, 14 * 3600 + 30 * 60);
    assert.equal(calls.at(-1).query.after, periodStartDate(7));
    assert.equal(weeklyWatchtime.periodStart.slice(0, 10), calls.at(-1).query.after);

    const movieWatchtime = await tool("media_public_watchtime_summary", { periodDays: 365, mediaType: "movie" });
    assert.equal(movieWatchtime.playCount, 5000);
    assert.equal(movieWatchtime.totalWatchSeconds, 70 * 86400 + 2 * 3600);
    assert.ok(movieWatchtime.totalWatchSeconds < aggregateWatchtime.totalWatchSeconds);
    assert.equal(calls.at(-1).query.media_type, "movie");
    assert.equal(calls.at(-1).query.after, periodStartDate(365));

    const movieTitleWatchtime = await tool("media_public_watchtime_summary", { periodDays: 365, mediaType: "movie", title: "Fixture Movie", year: 2025 });
    assert.equal(movieTitleWatchtime.playCount, 1);
    assert.equal(movieTitleWatchtime.totalWatchSeconds, 5125);
    assert.ok(movieTitleWatchtime.totalWatchSeconds < aggregateWatchtime.totalWatchSeconds);

    const titleWatchtime = await tool("media_public_watchtime_summary", {
      periodDays: 30,
      title: "Fixture Series",
      mediaType: "tv",
      year: 2024
    });
    assert.equal(titleWatchtime.scope, "title");
    assert.equal(titleWatchtime.matched, true);
    assert.equal(titleWatchtime.playCount, 2);
    assert.equal(titleWatchtime.totalWatchSeconds, 2700);
    assert.equal(titleWatchtime.complete, true);

    const fallbackResults = [];
    for (const total of [undefined, null, "", "not available", "4 hrs unavailable", "-4 hrs", "1 hr 2 milliseconds", "3 minutesgarbage", false, [], "0x100", Infinity]) {
      historyOverride = { summary: total === undefined ? {} : { total_duration: total } };
      const previousCalls = calls.length;
      const fallback = await tool("media_public_watchtime_summary", { periodDays: 365 });
      assert.equal(fallback.playCount, 3, `Invalid total ${String(total)} must use history rows`);
      assert.equal(fallback.totalWatchSeconds, 3932);
      assert.equal(fallback.complete, true);
      assert.deepEqual(calls.slice(previousCalls).map(call => call.query.length), ["1", "1000"]);
      assert.ok(calls.slice(previousCalls).every(call => call.query.after === periodStartDate(365)));
      fallbackResults.push(fallback);
    }
    for (const total of [0, "0", 16200, "16200", "4 hrs 30 mins", "4 hours 30 minutes", "1 day 2 hrs 3 mins 4 secs"]) {
      historyOverride = { summary: { total_duration: total } };
      const previousCalls = calls.length;
      const parsed = await tool("media_public_watchtime_summary", { periodDays: 365 });
      assert.equal(parsed.totalWatchSeconds, total === 0 || total === "0" ? 0 : total === "1 day 2 hrs 3 mins 4 secs" ? 93784 : 16200);
      assert.equal(calls.length, previousCalls + 1, "Valid total should not fetch raw history pages");
    }
    historyOverride = { summary: {}, rowCount: 1001 };
    const paginationStart = calls.length;
    const paginatedWatchtime = await tool("media_public_watchtime_summary", { periodDays: 365 });
    assert.equal(paginatedWatchtime.playCount, 1001);
    assert.equal(paginatedWatchtime.totalWatchSeconds, 1001);
    assert.equal(paginatedWatchtime.complete, true);
    assert.deepEqual(calls.slice(paginationStart).map(call => call.query.start), ["0", "0", "1000"]);
    historyOverride = { summary: {}, rowCount: 50001 };
    const boundedStart = calls.length;
    const boundedWatchtime = await tool("media_public_watchtime_summary", { periodDays: 365 });
    assert.equal(boundedWatchtime.playCount, 50000);
    assert.equal(boundedWatchtime.totalWatchSeconds, 50000);
    assert.equal(boundedWatchtime.complete, false);
    assert.equal(calls.length - boundedStart, 51);
    assert.equal(calls.at(-1).query.start, "49000");
    historyOverride = null;

    const bandwidth = await tool("plex_public_bandwidth_summary");
    assert.equal(bandwidth.totalBytes, 3_000_000);
    assert.equal(bandwidth.lanBytes, 1_000_000);
    assert.equal(bandwidth.wanBytes, 2_000_000);
    assert.equal(bandwidth.sampleCount, 2);

    const health = await tool("media_public_health_summary", { service: "bazarr" });
    assert.deepEqual(health.services, { bazarr: { configured: true, online: true } });

    const queues = await tool("media_public_queue_summary");
    assert.deepEqual(queues.sonarr, {
      configured: true,
      available: true,
      queuedCount: 2,
      problemCount: 1
    });
    assert.equal(queues.radarr.problemCount, 0);

    const subtitles = await tool("media_public_subtitle_summary");
    assert.equal(subtitles.wantedMovieCount, 7);
    assert.equal(subtitles.wantedEpisodeCount, 11);
    assert.equal(subtitles.configuredProviderCount, 2);

    const recent = await tool("media_public_recent_additions", { limit: 5 });
    assert.equal(recent.records.length, 2);
    assert.equal(recent.records[0].title, "Recent Fixture");
    assert.equal(Object.hasOwn(recent.records[0], "ratingKey"), false);

    const request = await tool("media_public_request_status", {
      title: "Fixture Request",
      mediaType: "movie",
      year: 2025
    });
    assert.equal(request.status, "matched");
    assert.equal(request.result.status, "processing");

    const allResults = JSON.stringify({
      library,
      series,
      aggregateWatchtime,
      weeklyWatchtime,
      movieWatchtime,
      movieTitleWatchtime,
      titleWatchtime,
      fallbackResults,
      paginatedWatchtime,
      boundedWatchtime,
      bandwidth,
      health,
      queues,
      subtitles,
      recent,
      request
    });
    assert.doesNotMatch(allResults, /\/private|accountID|deviceID|ratingKey|requestedBy|private@|Private User|private-machine|private-version/i);
    assert.doesNotMatch(allResults, /Private\.Download|Private\.Movie\.Download/);
    assert.doesNotMatch(allResults, /friendly_name|user_id|private-device|Private Watch Record/i);
    assert.ok(calls.some(call =>
      call.path === "/plex/statistics/bandwidth" && call.query.timespan === "1"
    ));
    assert.ok(calls
      .filter(call => call.path === "/tautulli/api/v2")
      .every(call => !Object.hasOwn(call.query, "user") && !Object.hasOwn(call.query, "user_id")));
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
  }
}

run().then(() => {
  console.log("public media info tool tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
