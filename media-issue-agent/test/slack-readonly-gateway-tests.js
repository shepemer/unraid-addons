import assert from "node:assert/strict";
import { startSlackReadOnlyGateway, slackReadOnlyToolCatalog, scrubSlackReadOnlyValue, validateSlackGatewayArguments } from "../src/slack-readonly-gateway.js";

const read = (name, properties = {}, required = []) => ({ name, description: `Read ${name} diagnostics`, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties, required, additionalProperties: false } });
const definitions = [
  read("new_service_library_inspection", { mediaId: { type: "integer", minimum: 1 }, detail: { enum: ["brief", "full"] }, options: { type: "object", properties: { limit: { type: "integer", maximum: 10 } } } }, ["mediaId"]),
  read("catalog_search", { query: { type: "string", minLength: 1 }, year: { anyOf: [{ type: "integer", minimum: 1870 }, { type: "null" }] } }, ["query"]),
  read("sonarr_recent_history", { limit: { type: "integer", maximum: 100 } }),
  read("plex_get_metadata", { ratingKey: { type: "string", pattern: "^[0-9]+$" } }, ["ratingKey"]),
  read("plex_list_libraries"),
  read("plex_search", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 250 } }, ["query"]),
  read("plex_list_show_seasons", { ratingKey: { anyOf: [{ type: "string" }, { type: "number" }] }, limit: { type: "integer", minimum: 1, maximum: 250 } }, ["ratingKey"]),
  read("plex_list_season_children", { ratingKey: { anyOf: [{ type: "string" }, { type: "number" }] }, limit: { type: "integer", minimum: 1, maximum: 250 } }, ["ratingKey"]),
  read("media_public_watchtime_summary", { periodDays: { type: "integer", minimum: 1, maximum: 366 }, userId: { type: "integer" } }),
  read("media_probe_video_content", { ratingKey: { type: "string" }, path: { type: "string" }, comparePath: { type: "string" }, includeFrameHashes: { type: "boolean" } }),
  read("private_files", { path: { type: "string" } }, ["path"]),
  read("plex_active_sessions"), read("tautulli_history"), read("public_user_summary"), read("service_credentials"),
  { ...read("admin_mutation"), annotations: { readOnlyHint: true, destructiveHint: true } },
  { ...read("unannotated_safe_sounding"), annotations: {} },
  { ...read("generic_endpoint"), description: "Execute arbitrary API requests" },
  read("unsupported_schema", { input: { $ref: "#/unsafe" } }, ["input"])
];
const catalog = slackReadOnlyToolCatalog(definitions);
assert.ok(catalog.some(tool => tool.name === "new_service_library_inspection"), "new read-only capability must work without code changes");
for (const denied of ["private_files", "plex_active_sessions", "tautulli_history", "public_user_summary", "service_credentials", "admin_mutation", "unannotated_safe_sounding", "generic_endpoint", "unsupported_schema"]) assert.equal(catalog.some(tool => tool.name === denied), false, denied);
const probe = catalog.find(tool => tool.name === "media_probe_video_content");
assert.deepEqual(Object.keys(probe.inputSchema.properties), ["ratingKey", "includeFrameHashes"]);
assert.equal(catalog.find(tool => tool.name === "media_public_watchtime_summary").inputSchema.properties.userId, undefined);
const schema = catalog.find(tool => tool.name === "new_service_library_inspection").inputSchema;
assert.equal(validateSlackGatewayArguments(schema, { mediaId: 1, detail: "full", options: { limit: 2 } }), true);
for (const value of [{ mediaId: 0 }, { mediaId: "1" }, { mediaId: 1, detail: "private" }, { mediaId: 1, options: { limit: 100 } }, { mediaId: 1, userId: 1 }, { mediaId: 1, options: { token: "hidden" } }]) assert.equal(validateSlackGatewayArguments(schema, value), false);
const searchSchema = catalog.find(tool => tool.name === "catalog_search").inputSchema;
assert.equal(validateSlackGatewayArguments(searchSchema, { query: "Example Movie", year: null }), true);
for (const query of ["http://private.example", "/mnt/private/media", "user_id=8", "8.8.8.8"]) assert.equal(validateSlackGatewayArguments(searchSchema, { query }), false);

const privateRecord = {
  id: 8, title: "Example Movie", monitored: true,
  user: { name: "Private Viewer", id: 99 }, requestedBy: { displayName: "Secret Person" },
  path: "/mnt/private/media", hostname: "private-host", ip: "8.8.8.8", accessToken: "supersecret",
  viewCount: 8, viewOffset: 123, viewedLeafCount: 8, lastViewedAt: 777, userRating: 4,
  description: "Private Viewer found an import error at 8.8.8.8 in /srv/media/example.mkv; owner@example.net",
  nested: { rows: [{ name: "apiKey", value: "private-api-key" }, { name: "quality", value: "1080p" }], deviceID: "private-device" }
};
const scrubbed = scrubSlackReadOnlyValue(privateRecord);
assert.equal(scrubbed.title, "Example Movie");
assert.equal(scrubbed.id, 8);
assert.equal(scrubbed.user, undefined);
for (const key of ["viewCount", "viewOffset", "viewedLeafCount", "lastViewedAt", "userRating"]) assert.equal(scrubbed[key], undefined, key);
for (const secret of ["Private Viewer", "Secret Person", "/mnt/private", "private-host", "8.8.8.8", "supersecret", "owner@example.net", "private-api-key", "private-device"]) assert.equal(JSON.stringify(scrubbed).includes(secret), false, secret);

const plexLibraries = { MediaContainer: { Directory: [{ key: "2", type: "show", title: "TV Shows", Location: [{ path: "/mnt/private/tv" }], agent: "tv.plex.agents.series" }], machineIdentifier: "PRIVATE-SERVER" } };
const publicLibraries = scrubSlackReadOnlyValue(plexLibraries);
assert.equal(publicLibraries.MediaContainer.Directory[0].key, "2", "Plex's structural Directory collection preserves section selectors");
assert.equal(publicLibraries.MediaContainer.Directory[0].title, "TV Shows");
assert.doesNotMatch(JSON.stringify(publicLibraries), /PRIVATE|private\/tv|Location|machineIdentifier/);
for (const unsafe of [{ Directory: [{ key: "2", type: "show", title: "Private folder" }] }, { MediaContainer: { Directory: [{ key: "2", type: "directory", name: "Private folder", path: "/private/path" }] } }]) {
  assert.doesNotMatch(JSON.stringify(scrubSlackReadOnlyValue(unsafe)), /Private folder|Directory|private\/path/);
}

const traversalEvents = [];
const traversed = [];
const plexGateway = await startSlackReadOnlyGateway({}, {
  listTools: async () => definitions,
  onEvent: event => traversalEvents.push(event),
  callTool: async (name, args) => {
    traversed.push({ name, args });
    if (name === "plex_list_libraries") return plexLibraries;
    if (name === "plex_search") return { MediaContainer: { size: 2, Hub: ["movie", "show"].map(type => ({ type, size: 40, Metadata: Array.from({ length: 40 }, (_, index) => ({
      ratingKey: `${type === "show" ? "100" : "900"}${index}`, type,
      title: index ? `Another ${type} ${index}` : "The Great Escape", year: type === "show" ? 2018 : 1963,
      originallyAvailableAt: type === "show" ? "2018-07-01" : "1963-06-20",
      addedAt: 1770000000, leafCount: 72, summary: "Public catalog synopsis. ".repeat(50),
      viewCount: 18, lastViewedAt: 1770000010, user: { name: "PRIVATE VIEWER" },
      Media: [{ id: 812, Part: [{ id: 913, file: "/mnt/private/video.mkv" }] }]
    })) })) } };
    if (name === "plex_list_show_seasons") {
      assert.equal(args.ratingKey, "1000");
      return { ratingKey: "1000", total: 5, returned: 5, seasons: [1, 2, 3, 4, 5].map(index => ({ ratingKey: `200${index}`, index, title: `Season ${index}`, childCount: 12, addedAt: 1770000020, originallyAvailableAt: "2025-01-01" })) };
    }
    assert.equal(name, "plex_list_season_children");
    assert.equal(args.ratingKey, "2005");
    return { ratingKey: "2005", total: 2, returned: 2, children: [1, 2].map(index => ({ ratingKey: `300${index}`, parentRatingKey: "2005", index, parentIndex: 5, title: `Episode ${index}`, addedAt: 1770000030, updatedAt: 1770000040, originallyAvailableAt: "2025-06-01", viewedLeafCount: 3, parts: [{ id: 912, file: "/mnt/private/episode.mkv" }] })) };
  }
});
try {
  const call = async (name, args) => {
    const response = await fetch(plexGateway.url, { method: "POST", headers: { authorization: `Bearer ${plexGateway.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: traversed.length + 1, method: "tools/call", params: { name, arguments: args } }) }).then(response => response.json());
    const content = response.result.content[0].text;
    assert.ok(Buffer.byteLength(content) <= 8 * 1024);
    assert.doesNotMatch(content, /PRIVATE VIEWER|private\/|viewCount|lastViewedAt|viewedLeafCount/);
    return JSON.parse(content);
  };
  assert.equal((await call("plex_list_libraries", {})).MediaContainer.Directory[0].key, "2");
  const search = await call("plex_search", { query: "The Great Escape", limit: 40 });
  assert.equal(search.truncated, true, "Oversized nested Plex results explicitly mark incomplete evidence");
  assert.equal(search.MediaContainer.Hub.length, 2, "A large first hub cannot consume all remaining hubs' evidence");
  const show = search.MediaContainer.Hub.find(hub => hub.type === "show").Metadata.find(item => item.title === "The Great Escape" && item.year === 2018);
  assert.equal(show.ratingKey, "1000");
  assert.equal(show.originallyAvailableAt, "2018-07-01");
  const seasons = await call("plex_list_show_seasons", { ratingKey: show.ratingKey });
  const season = seasons.seasons.find(item => item.index === 5);
  const children = await call("plex_list_season_children", { ratingKey: season.ratingKey });
  assert.equal(children.children.length, 2);
  assert.equal(children.children[0].parentIndex, 5);
  assert.equal(children.children[0].addedAt, 1770000030);
  const presentation = plexGateway.getEvidence();
  assert.doesNotMatch(JSON.stringify(presentation), /ratingKey|parentRatingKey|"key"|"id"|1000|2005|3001/);
  assert.equal(presentation[3].result.children[0].addedAt, 1770000030, "Presentation retains public date evidence without internal selectors");
  assert.equal(presentation[3].result.children[0].originallyAvailableAt, "2025-06-01");
  assert.ok(traversalEvents.some(event => event.toolName === "plex_search" && event.status === "truncated"));
  assert.doesNotMatch(JSON.stringify(traversalEvents), /PRIVATE|ratingKey|Great Escape|query|arguments|result|\/mnt/);
} finally { await plexGateway.close(); }

let upstream = [];
const gateway = await startSlackReadOnlyGateway({}, {
  listTools: async ({ signal }) => { assert.equal(signal.aborted, false); return definitions; },
  callTool: async (name, args, { signal }) => { upstream.push({ name, args }); assert.equal(signal.aborted, false); return privateRecord; },
  maxCalls: 2, perResultBytes: 1200, maxOutputBytes: 2400
});
const rpc = async payload => {
  const response = await fetch(gateway.url, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
};
try {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools.length, catalog.length);
  assert.ok((await rpc({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "private" } })).body.error);
  assert.ok((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "admin_mutation", arguments: {} } })).body.error);
  assert.ok((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "new_service_library_inspection", arguments: { mediaId: 8, token: "secret" } } })).body.error);
  // A notification must never execute a tool (even with an allowed name).
  assert.equal((await rpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "new_service_library_inspection", arguments: { mediaId: 8 } } })).status, 202);
  assert.equal(upstream.length, 0);
  const first = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "new_service_library_inspection", arguments: { mediaId: 8 } } });
  assert.ok(first.body.result.content[0].text.includes("Example Movie"));
  assert.equal(first.body.result.content[0].text.includes("Private Viewer"), false);
  const batch = await rpc([
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "catalog_search", arguments: { query: "Example Movie" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "catalog_search", arguments: { query: "Example Movie" } } }
  ]);
  assert.equal(batch.body.length, 2);
  assert.ok(batch.body[0].result);
  assert.ok(batch.body[1].error);
  assert.equal(upstream.length, 2);
  assert.equal(gateway.getEvidence().length, 2);
  assert.equal(gateway.getUsage().exhausted, true);
  assert.ok(gateway.getUsage().outputBytes <= 2400);
  assert.equal(JSON.stringify(gateway.getEvidence()).includes("Private Viewer"), false);
  const invalidAuth = await fetch(gateway.url, { method: "POST", headers: { authorization: "Bearer upstream-real-token" }, body: "{}" });
  assert.equal(invalidAuth.status, 401);
  assert.equal(upstream.length, 2);
} finally { await gateway.close(); }

const concurrent = await startSlackReadOnlyGateway({}, { listTools: async () => definitions, callTool: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { count: 1 }; }, maxCalls: 1 });
try {
  const request = id => fetch(concurrent.url, { method: "POST", headers: { authorization: `Bearer ${concurrent.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "catalog_search", arguments: { query: "Example" } } }) }).then(response => response.json());
  const responses = await Promise.all([request(1), request(2)]);
  assert.equal(responses.filter(response => response.result).length, 1);
  assert.equal(concurrent.getUsage().calls, 1);
} finally { await concurrent.close(); }

const huge = await startSlackReadOnlyGateway({}, { listTools: async () => definitions, callTool: async () => ({ records: Array.from({ length: 250 }, (_, id) => ({ id, title: "Example".repeat(50) })) }), perResultBytes: 600, maxOutputBytes: 1200 });
try {
  const response = await fetch(huge.url, { method: "POST", headers: { authorization: `Bearer ${huge.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog_search", arguments: { query: "Example" } } }) }).then(response => response.json());
  assert.ok(Buffer.byteLength(response.result.content[0].text) <= 600);
  assert.equal(JSON.parse(response.result.content[0].text).truncated, true);
} finally { await huge.close(); }

const aborter = new AbortController();
const aborted = await startSlackReadOnlyGateway({}, { listTools: async () => definitions, callTool: async () => new Promise(() => {}), abortSignal: aborter.signal });
try {
  const response = fetch(aborted.url, { method: "POST", headers: { authorization: `Bearer ${aborted.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog_search", arguments: { query: "Example" } } }) }).then(response => response.json());
  setTimeout(() => aborter.abort(), 20);
  assert.ok((await response).error);
  assert.equal(aborted.getEvidence().length, 0);
} finally { await aborted.close(); }

await assert.rejects(startSlackReadOnlyGateway({}, { listTools: async () => new Promise(() => {}), deadlineMs: Date.now() + 20 }), /discovery is unavailable/);

const failures = [];
const unavailable = await startSlackReadOnlyGateway({}, {
  listTools: async () => definitions, onEvent: event => failures.push(event),
  callTool: async (_name, args) => {
    if (args.query === "unavailable") return { available: false, records: [] };
    throw new Error("401 Unauthorized PRIVATE endpoint https://private.example/token?secret=bad");
  }
});
try {
  for (const query of ["unavailable", "failure"]) {
    const result = await fetch(unavailable.url, { method: "POST", headers: { authorization: `Bearer ${unavailable.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: query, method: "tools/call", params: { name: "catalog_search", arguments: { query } } }) }).then(response => response.json());
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\.example|secret=bad/);
  }
  assert.deepEqual(failures.filter(event => event.type === "slack_readonly_tool_completed").map(event => event.status), ["unavailable", "authorization_error"]);
  assert.ok(failures.filter(event => event.type === "slack_readonly_tool_completed").every(event => event.durationMs >= 0 && event.callCount > 0));
  assert.doesNotMatch(JSON.stringify(failures), /PRIVATE|private\.example|secret=bad|arguments/);
} finally { await unavailable.close(); }
console.log("Slack dynamic read-only gateway tests passed");
