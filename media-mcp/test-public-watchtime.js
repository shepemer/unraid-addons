import assert from "node:assert/strict";
import { createPublicWatchtimeSummary, normalizePublicTimeRange } from "./public-watchtime.js";

const at = Date.parse("2024-03-31T12:00:00Z");
assert.equal(normalizePublicTimeRange({}, at).allTime, true);
assert.equal(normalizePublicTimeRange({ allTime: true }, at).periodStartDate, null);
assert.equal(normalizePublicTimeRange({ periodDays: 1826 }, at).periodDays, 1826);
assert.equal(normalizePublicTimeRange({ periodMonths: 1 }, at).periodStartDate, "2024-02-29");
assert.equal(normalizePublicTimeRange({ periodYears: 5 }, at).periodStartDate, "2019-03-31");
assert.equal(normalizePublicTimeRange({ periodYears: 1 }, Date.parse("2024-02-29")).periodStartDate, "2023-02-28");
assert.equal(normalizePublicTimeRange({ periodYears: 100 }, at).periodStartDate, "1924-03-31");
assert.equal(normalizePublicTimeRange({ startDate: "1900-01-01", endDate: "2024-02-29" }, at).periodEndDate, "2024-02-29");
assert.equal(normalizePublicTimeRange({ endDate: "2000-01-01" }, at).periodStartDate, null);
for (const input of [
  { allTime: false }, { allTime: true, periodDays: 30 }, { periodMonths: 5, periodYears: 2 },
  { periodDays: 30, startDate: "2020-01-01" }, { startDate: "2023-02-29" },
  { startDate: "2025-01-01", endDate: "2024-01-01" }, { startDate: "2024-01-01T12:00:00Z" },
  { periodDays: 0 }, { periodDays: 1.5 }, { periodDays: Number.MAX_SAFE_INTEGER + 1 },
  { periodYears: Number.MAX_SAFE_INTEGER }, { periodMonths: Number.MAX_SAFE_INTEGER },
  { startDate: "0000-01-01" }
]) assert.throws(() => normalizePublicTimeRange(input, at), JSON.stringify(input));

const calls = [];
const library = createPublicWatchtimeSummary({ now: () => at, api: async (command, options) => {
  calls.push({ command, ...options });
  return { recordsFiltered: 44396, total_duration: "898 days 17 hrs 17 mins", filter_duration: "2 mins", data: [{ user_id: 92, friendly_name: "PRIVATE VIEWER" }] };
} });
for (const input of [{}, { allTime: true }, { periodDays: 1826 }, { periodYears: 5 }, { startDate: "2010-01-01", endDate: "2020-12-31" }]) {
  const result = await library(input);
  assert.equal(result.totalWatchSeconds, 898 * 86400 + 17 * 3600 + 17 * 60);
  assert.equal(result.playCount, 44396);
  assert.equal(result.complete, true);
  assert.equal(result.requestCount, 1);
  assert.equal(calls.at(-1).query.length, 1);
  assert.equal(calls.at(-1).query.after ?? null, result.periodStartDate);
  assert.equal(calls.at(-1).query.before ?? null, result.periodEndDate);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|friendly_name|user_id/);
}

// All title rows stay inside this process. A global-search hit in a viewer's
// name is never counted, and upstream library totals are not title totals.
const titleRows = [
  { media_type: "episode", grandparent_title: "Exact Show", grandparent_year: 2018, duration: 100, friendly_name: "PRIVATE ONE", user_id: 1 },
  { media_type: "episode", grandparent_title: "Different Show", duration: 9999, friendly_name: "Exact Show", user_id: 2 },
  { media_type: "episode", grandparent_title: "Exact Show", grandparent_year: 2018, duration: 200, player: "PRIVATE DEVICE", ip_address: "10.0.0.10" },
  { media_type: "episode", grandparent_title: "Exact Show", grandparent_year: 2025, duration: 9999 },
  { media_type: "movie", title: "Exact Show", duration: 9999 },
  { media_type: "episode", grandparent_title: "Exact Show", grandparent_year: 2018, duration: 300, user: "PRIVATE THREE" }
];
const titleCalls = [];
const scoped = createPublicWatchtimeSummary({ now: () => at, maxCalls: 2, pageSize: 2, api: async (command, options) => {
  titleCalls.push(options);
  return { recordsFiltered: titleRows.length, total_duration: "1000 days", data: titleRows.slice(options.query.start, options.query.start + options.query.length) };
} });
const first = await scoped({ title: "Exact Show", mediaType: "tv", year: 2018, allTime: true });
assert.equal(first.complete, false);
assert.equal(first.playCount, 2);
assert.equal(first.totalWatchSeconds, 300);
assert.equal(first.scannedRows, 4);
assert.equal(first.incompleteReason, "work_budget_exhausted");
assert.match(first.nextCursor, /^watchtime_[a-f0-9]{36}$/);
await assert.rejects(() => scoped({ title: "Other Show", cursor: first.nextCursor }), /scope/);
await assert.rejects(() => scoped({ cursor: "watchtime_invalid" }), /expired|unavailable/);
const finished = await scoped({ cursor: first.nextCursor });
assert.equal(finished.complete, true);
assert.equal(finished.playCount, 3);
assert.equal(finished.totalWatchSeconds, 600);
assert.equal(finished.nextCursor, undefined);
assert.equal(titleCalls.at(-1).query.start, 4);
assert.ok(titleCalls.every(call => call.query.after === undefined && call.query.before === undefined));
assert.deepEqual(await scoped({ cursor: first.nextCursor }), finished, "retrying a cursor resumes its immutable checkpoint, never the already accumulated result");
assert.doesNotMatch(JSON.stringify([first, finished]), /PRIVATE|friendly_name|user_id|ip_address|10\.0/);

// Work volume limits do not change the requested dates, and a deadline stops
// subsequent calls while preserving an honest partial count and resume point.
let clock = at;
const slowCalls = [];
const slow = createPublicWatchtimeSummary({ now: () => clock, timeoutMs: 100, pageSize: 2, api: async (command, options) => {
  slowCalls.push(options);
  clock += 100;
  return { recordsFiltered: 6, data: titleRows.slice(0, 2) };
} });
const partial = await slow({ title: "Exact Show", mediaType: "tv", startDate: "2000-01-01", endDate: "2024-03-31" });
assert.equal(slowCalls.length, 1);
assert.equal(slowCalls[0].timeoutMs, 100);
assert.ok(slowCalls[0].signal instanceof AbortSignal);
assert.equal(partial.complete, false);
assert.equal(partial.periodStartDate, "2000-01-01");
assert.equal(partial.periodEndDate, "2024-03-31");
assert.equal(partial.totalWatchSeconds, 100);
assert.ok(partial.nextCursor);

// Upstream interruption, inconsistent pagination, and missing durations never
// become apparently complete zero/under-counted lifetime totals.
let attempts = 0;
const interrupted = createPublicWatchtimeSummary({ now: () => at, pageSize: 2, api: async () => {
  if (attempts++) throw new Error("PRIVATE endpoint unavailable");
  return { recordsFiltered: 6, data: titleRows.slice(0, 2) };
} });
const stopped = await interrupted({ allTime: true, title: "Exact Show", mediaType: "tv" });
assert.equal(stopped.available, true);
assert.equal(stopped.complete, false);
assert.equal(stopped.incompleteReason, "upstream_unavailable");
assert.equal(stopped.playCount, 1);
assert.doesNotMatch(JSON.stringify(stopped), /PRIVATE/);

for (const [body, reason] of [
  [{ recordsFiltered: 10, data: [] }, "incomplete_upstream_page"],
  [{ ok: true }, "invalid_history_response"],
  [{ recordsFiltered: 1, data: [{ media_type: "movie", title: "Title", duration: null }] }, "unavailable_durations"]
]) {
  const run = createPublicWatchtimeSummary({ now: () => at, api: async () => body });
  const result = await run({ title: "Title" });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, reason);
}
let historyCount = 6;
const changing = createPublicWatchtimeSummary({ now: () => at, pageSize: 2, maxCalls: 1, api: async (command, options) => ({ recordsFiltered: historyCount, data: titleRows.slice(options.query.start, options.query.start + options.query.length) }) });
const checkpoint = await changing({ title: "Exact Show" });
historyCount = 5;
const changed = await changing({ cursor: checkpoint.nextCursor });
assert.equal(changed.complete, false);
assert.equal(changed.incompleteReason, "history_changed");
assert.equal(changed.nextCursor, undefined);
assert.equal(changed.totalWatchSeconds, checkpoint.totalWatchSeconds);

// Actual cancellation reaches the currently pending adapter request. No
// subsequent page starts, and the public error cannot contain private prose.
const originalTimeout = AbortSignal.timeout;
const controller = new AbortController();
let abortCalls = 0;
AbortSignal.timeout = () => controller.signal;
try {
  const cancelled = createPublicWatchtimeSummary({ now: () => at, api: async (command, options) => {
    abortCalls++;
    assert.equal(options.signal, controller.signal);
    queueMicrotask(() => controller.abort(new DOMException("PRIVATE upstream timed out", "TimeoutError")));
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } });
  const result = await cancelled({ title: "Exact Show", allTime: true });
  assert.equal(abortCalls, 1);
  assert.equal(result.complete, false);
  assert.equal(result.available, false);
  assert.equal(result.matched, null, "an interrupted search cannot establish title absence");
  assert.equal(result.incompleteReason, "work_budget_exhausted");
  assert.ok(result.nextCursor);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
} finally { AbortSignal.timeout = originalTimeout; }

const normalized = createPublicWatchtimeSummary({ now: () => at, api: async () => ({ recordsFiltered: 1, data: [{ media_type: "movie", title: "Cafe and Tea", year: 2020, duration: 42 }] }) });
assert.equal((await normalized({ title: "Café & Tea (2020)", mediaType: "movie", year: 2020 })).totalWatchSeconds, 42);
console.log("Public watch-time range, completeness, privacy and budget tests passed");
