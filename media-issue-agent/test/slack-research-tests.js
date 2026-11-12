import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAnalysisCodexArgs, runCodex, runCodexSlackDiagnostics, slackDiagnosticsPrompt, slackIntentPrompt, SLACK_RESEARCH_LIMITS } from "../src/codex.js";
import { parseSlackIntentResult } from "../src/slack.js";
import { MediaIssueAgent } from "../src/agent.js";
import { createCodexHome } from "./helpers.js";
import { publicResearchTimeframe } from "../src/slack-readonly.js";

const tool = (name, properties = {}) => ({ name, description: "Read current media information.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties, additionalProperties: false } });
const tools = [
  tool("new_service_catalog_measurement", { title: { type: "string" } }),
  tool("media_public_watchtime_summary", {
    title: { type: "string" }, allTime: { type: "boolean" },
    periodDays: { type: "integer", minimum: 1 }, periodMonths: { type: "integer", minimum: 1 }, periodYears: { type: "integer", minimum: 1 },
    startDate: { type: "string", format: "date" }, endDate: { type: "string", format: "date" },
    cursor: { type: "string", pattern: "^watchtime_[a-f0-9]{36}$" }
  }),
  tool("media_public_recent_additions"),
  { ...tool("delete_media"), annotations: { destructiveHint: true, readOnlyHint: false } }
];
async function rpc(hooks, method, params = {}, id = 1) {
  const response = await fetch(hooks.researchGateway.url, {
    method: "POST", headers: { authorization: `Bearer ${hooks.researchGateway.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return response.json();
}
const calls = [];
const callTool = async (name, args) => {
  calls.push({ name, args });
  if (name === "media_public_watchtime_summary") return { totalWatchSeconds: 90000, periodDays: 7, playCount: 20, users: [{ name: "Secret Viewer", ip: "192.168.1.2" }] };
  if (name === "media_public_recent_additions") return { records: [{ title: "Recently Added Show", mediaType: "tv" }] };
  return { score: 91, username: "Secret Viewer", description: "Catalog measurement" };
};
const config = { codexWorkspace: "/tmp/unused" };
const settings = { model: "good-investigation-model", reasoningEffort: "high" };

// An unknown-to-the-application read-only tool is discovered and usable without
// adding a new check or response category to the worker.
const discovered = await runCodexSlackDiagnostics(config, { newestMessage: "Compare this new service's data" }, settings, {
  listTools: async () => tools, callTool,
  runModel: async (_config, prompt, hooks) => {
    assert.deepEqual(hooks.settings, settings);
    assert.match(prompt, /not a predefined checklist/);
    const catalog = (await rpc(hooks, "tools/list")).result.tools;
    assert.ok(catalog.some(item => item.name === "new_service_catalog_measurement"));
    assert.ok(!catalog.some(item => item.name === "delete_media"));
    const result = await rpc(hooks, "tools/call", { name: "new_service_catalog_measurement", arguments: { title: "Example" } });
    assert.doesNotMatch(JSON.stringify(result), /Secret Viewer/);
    return JSON.stringify({ analysis: "This service reports a score of 91. That favors this option, with the usual caveat that a score is only one measure.", completion: "complete", sources: [] });
  }
});
assert.match(discovered.analysis, /score of 91/);
assert.equal(discovered.facts.length, 1);

const weekly = await runCodexSlackDiagnostics(config, { newestMessage: "How many hours were watched last week?", request: { periodDays: 7 } }, settings, {
  listTools: async () => tools, callTool,
  runModel: async (_config, prompt, hooks) => {
    const result = await rpc(hooks, "tools/call", { name: "media_public_watchtime_summary", arguments: { periodDays: 7 } });
    const data = JSON.parse(result.result.content[0].text);
    return JSON.stringify({ analysis: `${data.totalWatchSeconds / 3600} hours were watched over the last ${data.periodDays} days (${data.playCount} plays), across all viewers.`, sources: [], completion: "complete" });
  }
});
assert.match(weekly.analysis, /25 hours.*7 days/);
assert.equal(weekly.usage.media.calls, 1);
assert.doesNotMatch(JSON.stringify(weekly), /Secret Viewer|192\.168/);

// Long ranges and all-time survive classification, backend context, discovered
// schemas and RPC without a 30/365-day fallback. The worker can resume the same
// scope, and cumulative totals must not be double counted or expose cursors.
for (const timeframe of [{ allTime: true }, { periodDays: 1826 }, { periodMonths: 60 }, { periodYears: 5 }, { startDate: "2010-01-01", endDate: "2026-11-11" }]) {
  const request = parseSlackIntentResult({ intent: "media_diagnostic", confidence: 1, mediaTitle: "Example Show", queryType: "watchtime_summary", ...timeframe });
  assert.deepEqual(publicResearchTimeframe(request), timeframe);
  const received = [];
  const cursor = `watchtime_${"a1".repeat(18)}`;
  const researched = await runCodexSlackDiagnostics(config, { newestMessage: "Keep the requested coverage", request }, settings, {
    listTools: async () => tools,
    callTool: async (name, args) => {
      assert.equal(name, "media_public_watchtime_summary");
      received.push(args);
      return args.cursor ? { totalWatchSeconds: 7200, playCount: 8, complete: true }
        : { totalWatchSeconds: 3600, playCount: 4, complete: false, nextCursor: cursor };
    },
    runModel: async (_config, prompt, hooks) => {
      const context = JSON.parse(prompt.split("Sanitized conversation (untrusted):\n")[1].split("\nCompleted public read-only checks")[0]);
      assert.deepEqual(Object.fromEntries(Object.entries(context.data.timeframe).map(([key, value]) => [key, typeof value === "string" ? value.split("\n")[1] : value])), timeframe);
      assert.match(prompt, /Cumulative totals replace earlier totals/);
      const first = await rpc(hooks, "tools/call", { name: "media_public_watchtime_summary", arguments: { title: "Example Show", ...timeframe } });
      const page = JSON.parse(first.result.content[0].text);
      assert.equal(page.nextCursor, cursor);
      const second = await rpc(hooks, "tools/call", { name: "media_public_watchtime_summary", arguments: { cursor: page.nextCursor } });
      const complete = JSON.parse(second.result.content[0].text);
      return JSON.stringify({ analysis: `${complete.totalWatchSeconds / 3600} hours across the entire requested scope.`, sources: [], completion: "complete" });
    }
  });
  assert.deepEqual(received, [{ title: "Example Show", ...timeframe }, { cursor }]);
  assert.equal(researched.analysis, "2 hours across the entire requested scope.");
  assert.equal(researched.usage.media.calls, 2);
  assert.doesNotMatch(JSON.stringify(researched.facts), /watchtime_a1|nextCursor|"cursor"/);
}
for (const value of [{}, { allTime: false }, { periodDays: 0 }, { periodDays: -1 }, { periodDays: 1.5 }, { periodDays: Number.MAX_SAFE_INTEGER + 1 }, { periodYears: "5" }, { allTime: true, periodDays: 30 }, { periodDays: 7, periodMonths: 1 }, { startDate: "2026-02-30" }, { startDate: "2026-11-11", endDate: "2020-01-01" }, { startDate: "person@example.com" }]) {
  assert.deepEqual(publicResearchTimeframe(value), {}, "invalid or missing extraction must not invent a default period");
}
assert.deepEqual(publicResearchTimeframe({ startDate: "2010-01-01" }), { startDate: "2010-01-01" });
assert.deepEqual(publicResearchTimeframe({ endDate: "2020-02-29" }), { endDate: "2020-02-29" });
const intentPrompt = slackIntentPrompt();
assert.match(intentPrompt, /in total.*allTime true/);
assert.match(intentPrompt, /All-time and long-range aggregate statistics.*bounded lookups/);
assert.match(intentPrompt, /Never default to 30 days/);
assert.match(slackDiagnosticsPrompt(), /Tool limits bound individual operations, not the user's requested scope/);
assert.match(slackDiagnosticsPrompt(), /Years\/months are approximate elapsed-duration equivalents/);
for (const field of ["hasNewIssueEvidence", "explicitIssueControl"]) {
  const base = { intent: "issue_followup", confidence: 1 };
  assert.equal(parseSlackIntentResult(base)[field], false);
  assert.equal(parseSlackIntentResult({ ...base, [field]: true })[field], true);
  assert.equal(parseSlackIntentResult({ ...base, [field]: false })[field], false);
  for (const invalid of ["true", 1, null, {}, []]) assert.throws(() => parseSlackIntentResult({ ...base, [field]: invalid }), /must be a boolean/);
}
assert.match(intentPrompt, /conversation never implies reopening or restarting work/);
assert.match(intentPrompt, /excitement, desires, future seasons.*not issue evidence/);

const recommendation = await runCodexSlackDiagnostics(config, { newestMessage: "What new show should I watch?" }, settings, {
  listTools: async () => tools, callTool,
  runModel: async (_config, _prompt, hooks) => {
    await rpc(hooks, "tools/call", { name: "media_public_recent_additions", arguments: {} });
    hooks.onEvent({ type: "item.started", item: { type: "web_search", id: "search1", action: { query: "Recently Added Show review" } } });
    hooks.onEvent({ type: "item.completed", item: { type: "web_search", id: "search1", sources: [{ url: "https://example.com/review" }] } });
    return JSON.stringify({ analysis: "Try Recently Added Show for its pacing and characters. It is in the recent library additions. Public review: https://example.com/review", sources: [{ title: "Review", url: "https://example.com/review" }, { title: "Invented source", url: "https://example.com/not-consulted" }], completion: "complete" });
  }
});
assert.match(recommendation.analysis, /pacing and characters/);
assert.match(recommendation.analysis, /\[1\]/);
assert.equal(recommendation.sources.length, 1);
assert.equal(recommendation.usage.webCalls, 1);

// Only completed successful operations provide source evidence. Requests that
// never complete or explicitly fail cannot justify a citation.
const sourceOutcomes = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => [],
  runModel: async (_config, _prompt, hooks) => {
    hooks.onEvent({ type: "item.started", item: { type: "web_fetch", id: "incomplete", action: { url: "https://example.com/never-finished" } } });
    hooks.onEvent({ type: "item.completed", item: { type: "web_fetch", id: "failed", status: "failed", action: { url: "https://example.com/failed" } } });
    hooks.onEvent({ type: "item.completed", item: { type: "web_fetch", id: "http-error", result: { statusCode: 404 }, action: { url: "https://example.com/not-found" } } });
    hooks.onEvent({ type: "item.completed", item: { type: "web_fetch", id: "still-running", status: "in_progress", action: { url: "https://example.com/in-progress" } } });
    hooks.onEvent({ type: "item.started", item: { type: "web_fetch", id: "successful", action: { url: "https://example.com/successful" } } });
    hooks.onEvent({ type: "item.completed", item: { type: "web_fetch", id: "successful", status: "completed", action: { url: "https://example.com/successful" } } });
    return JSON.stringify({
      analysis: "The supported finding is documented in [source 5]. The original claim [1] was not verified.",
      sources: ["never-finished", "failed", "not-found", "in-progress", "successful"].map(page => ({ title: page, url: `https://example.com/${page}` })),
      completion: "partial"
    });
  }
});
assert.equal(sourceOutcomes.sources.length, 1);
assert.equal(sourceOutcomes.sources[0].url, "https://example.com/successful");
assert.match(sourceOutcomes.analysis, /documented in \[1\]/);
assert.match(sourceOutcomes.analysis, /original claim \[unverified source\]/);
assert.equal(sourceOutcomes.usage.webCalls, 5, "paired events count once and completed-only events count too");
const sourceOrdering = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => [],
  runModel: async (_config, _prompt, hooks) => {
    hooks.onEvent({ type: "item.completed", item: { type: "web_search", id: "retained", sources: [{ url: "https://example.com/retained" }] } });
    return JSON.stringify({ analysis: "Verified answer [2].", sources: [{ title: "Unobserved", url: "https://example.com/unobserved" }, { title: "Retained", url: "https://example.com/retained" }], completion: "complete" });
  }
});
assert.equal(sourceOrdering.analysis, "Verified answer [1].");
assert.equal(sourceOrdering.sources[0].title, "Retained");

const before = calls.length;
const expensive = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => tools, callTool,
  runModel: async () => JSON.stringify({ analysis: "A review of every episode would exceed this budget. Choose three shows for a focused comparison.", sources: [], completion: "too_complex" })
});
assert.equal(expensive.completion, "too_complex");
assert.equal(calls.length, before);
assert.match(expensive.analysis, /three shows/);
assert.equal(parseSlackIntentResult({ intent: "media_diagnostic", confidence: 1, researchComplexity: "excessive" }).researchComplexity, "excessive");
assert.match(slackIntentPrompt(), /recently added shows.*media_diagnostic/);
assert.match(slackIntentPrompt(), /Use media_diagnostic whenever fresh facts, research, comparisons, calculations, or deeper analysis are needed, regardless of topic/);
assert.match(slackIntentPrompt(), /legacy queryType values are optional extraction hints/);
assert.match(slackIntentPrompt(), /Leave queryType empty for other questions/);
assert.match(slackIntentPrompt(), /Requests for findings, explanations, causes, more information.*need media_diagnostic/);
const privatePrompt = slackDiagnosticsPrompt({ newestMessage: "Check this <@U123456789> person@example.com from 8.8.8.8", reporter: "Secret Viewer" });
assert.doesNotMatch(privatePrompt, /U123456789|person@example\.com|8\.8\.8\.8|Secret Viewer/);
const scopedPrompt = slackDiagnosticsPrompt({ request: { mediaTitle: "The Great Escape", year: 2018, seasons: [5] } });
assert.match(scopedPrompt, /"year":2018/);
assert.match(scopedPrompt, /"seasonNumber":5/);
assert.match(scopedPrompt, /internal media selectors.*allowed for subsequent read-only tool calls/);
assert.match(scopedPrompt, /Keep internal selectors out of the analysis/);
assert.match(scopedPrompt, /truncated result is incomplete evidence/);

const unavailableEvents = [];
const publicOnly = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => { throw new Error("PRIVATE upstream URL and credentials"); },
  onEvent: event => unavailableEvents.push(event),
  runModel: async () => JSON.stringify({ analysis: "The media lookup is unavailable.", sources: [], completion: "partial" })
});
assert.equal(publicOnly.completion, "partial");
assert.equal(unavailableEvents.find(event => event.type === "slack_readonly_catalog").status, "unavailable");
assert.doesNotMatch(JSON.stringify(unavailableEvents), /PRIVATE|credentials/);

const started = Date.now();
const timedOut = await runCodexSlackDiagnostics(config, {}, settings, { timeoutMs: 25, listTools: async () => [], runModel: async () => new Promise(() => {}) });
assert.equal(timedOut.completion, "budget_exceeded");
assert.ok(Date.now() - started < 1000, "a stuck worker cannot ignore the request deadline");

const webLimited = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => [],
  runModel: async (_config, _prompt, hooks) => {
    for (let i = 0; i <= SLACK_RESEARCH_LIMITS.maxWebCalls; i++) hooks.onEvent({ type: "item.started", item: { type: "web_search", id: `web${i}` } });
    return JSON.stringify({ analysis: "Should stop", sources: [], completion: "complete" });
  }
});
assert.equal(webLimited.completion, "budget_exceeded");
const completedOnlyWebLimit = await runCodexSlackDiagnostics(config, {}, settings, {
  listTools: async () => [],
  runModel: async (_config, _prompt, hooks) => {
    for (let index = 0; index <= SLACK_RESEARCH_LIMITS.maxWebCalls; index++) hooks.onEvent({ type: "item.completed", item: { type: "web_search", id: `completed-${index}`, status: "completed" } });
    return JSON.stringify({ analysis: "Must stop", sources: [], completion: "complete" });
  }
});
assert.equal(completedOnlyWebLimit.completion, "budget_exceeded");
assert.equal(completedOnlyWebLimit.usage.webCalls, SLACK_RESEARCH_LIMITS.maxWebCalls + 1);

const args = buildAnalysisCodexArgs(config, settings, { toolFree: true, researchGateway: { url: "http://127.0.0.1:123/mcp" }, tokenBudget: 24000 }).args;
assert.ok(args.includes('web_search="live"'));
assert.ok(args.includes("features.shell_tool=false"));
assert.ok(args.includes("features.rollout_budget.limit_tokens=24000"));
assert.ok(args.includes('mcp_servers.media_readonly.bearer_token_env_var="SLACK_READ_ONLY_GATEWAY_TOKEN"'));

// Verify the real subprocess boundary cancels, not merely an awaiting Promise.
const root = await mkdtemp(path.join(os.tmpdir(), "slack-research-budget-"));
try {
  const marker = path.join(root, "should-not-exist");
  const bin = path.join(root, "slow-codex.mjs");
  await writeFile(bin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'still running'), 500);\nsetInterval(() => {}, 1000);\n`);
  await chmod(bin, 0o755);
  await assert.rejects(runCodex({ codexBin: bin, codexHome: root, codexWorkspace: root, codexTimeoutMs: 1000, codexTerminationGraceMs: 50 }, "fixture", { toolFree: true, timeoutMs: 50 }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 550));
  await assert.rejects(access(marker));

  const sourceBin = path.join(root, "source-codex.mjs");
  const sourceUrl = "https://example.com/verified-review";
  await writeFile(sourceBin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'web_search',id:'source-search',sources:[{url:${JSON.stringify(sourceUrl)}}]}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({analysis:'A researched recommendation. '+${JSON.stringify(sourceUrl)},sources:[{title:'Verified review',url:${JSON.stringify(sourceUrl)}}],completion:'complete'})}}));\n`);
  await chmod(sourceBin, 0o755);
  const telemetry = [];
  const sourced = await runCodexSlackDiagnostics({ codexBin: sourceBin, codexHome: root, codexWorkspace: root, codexTimeoutMs: 1000 }, {}, settings, { listTools: async () => [], onEvent: event => telemetry.push(event) });
  assert.equal(sourced.sources[0].url, sourceUrl, "real streamed citations survive diagnostic log redaction");
  assert.match(sourced.analysis, /\[1\]/);
  assert.doesNotMatch(JSON.stringify(telemetry), /https:\/\//, "ordinary telemetry remains redacted");
  assert.equal(sourced.usage.webCalls, 1, "real completed-only stream consumes a web operation");
  const failedSourceBin = path.join(root, "mixed-source-codex.mjs");
  const mixedSources = [
    { title: "Not completed", url: "https://example.com/requested-only" },
    { title: "Failed", url: "https://example.com/fetch-failed" },
    { title: "Completed", url: "https://example.com/completed" }
  ];
  const streamedEvents = [
    { type: "item.started", item: { type: "web_fetch", id: "only-started", action: { url: mixedSources[0].url } } },
    { type: "item.completed", item: { type: "web_fetch", id: "failed", status: "failed", sources: [mixedSources[1]] } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ analysis: "The completed source supports this [3].", sources: mixedSources, completion: "partial" }) } },
    // Leave the final successful source event unterminated to exercise the
    // subprocess close handler as well as the newline streaming handler.
    { type: "item.completed", item: { type: "web_fetch", id: "completed", status: "completed", sources: [mixedSources[2]] } }
  ];
  await writeFile(failedSourceBin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(streamedEvents.map(event => JSON.stringify(event)).join("\n"))});\n`);
  await chmod(failedSourceBin, 0o755);
  const mixed = await runCodexSlackDiagnostics({ codexBin: failedSourceBin, codexHome: root, codexWorkspace: root, codexTimeoutMs: 1000 }, {}, settings, { listTools: async () => [] });
  assert.deepEqual(mixed.sources, [mixedSources[2]], "raw source hook excludes failed and incomplete operations");
  assert.equal(mixed.analysis, "The completed source supports this [1].");
  assert.equal(mixed.usage.webCalls, 3);

} finally { await rm(root, { recursive: true, force: true }); }

const telemetryRoot = await mkdtemp(path.join(os.tmpdir(), "slack-research-telemetry-"));
try {
  const records = [];
  const telemetryConfig = { dbPath: path.join(telemetryRoot, "state.sqlite"), logPath: path.join(telemetryRoot, "agent.log"), codexHome: await createCodexHome(telemetryRoot), suppressInitLog: true };
  const agent = new MediaIssueAgent(telemetryConfig, {}, {
    slackDiagnosticRunner: async (_config, _context, _settings, hooks) => {
      hooks.onEvent({ type: "slack_readonly_catalog", status: "ok", toolCount: 82, durationMs: 11 });
      hooks.onEvent({ type: "slack_readonly_tool_completed", toolName: "media_public_recent_additions", status: "unavailable", callCount: 1, outputBytes: 54, durationMs: 122,
        arguments: { ratingKey: "PRIVATE" }, result: { token: "PRIVATE" }, error: "PRIVATE upstream URL" });
      return { completion: "partial", analysis: "Recent additions could not be checked.", facts: [] };
    },
    slackReplyRunner: async () => "Recent additions could not be checked."
  });
  await agent.init();
  agent.diagnostic = (level, event, details) => records.push({ level, event, details });
  await agent.slackReadOnlyChat({ newestMessage: "Recently added shows?" });
  const record = records.find(record => record.event === "slack_readonly_tool_completed");
  assert.equal(record.level, "warn");
  assert.deepEqual(record.details, { toolName: "media_public_recent_additions", status: "unavailable", callCount: 1, durationMs: 122, outputBytes: 54 });
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|ratingKey|token|arguments|result|upstream/);

  const aggregateCalls = [];
  const aggregateAgent = new MediaIssueAgent(telemetryConfig, {
    listTools: async () => tools,
    callTool: async (name, args) => {
      aggregateCalls.push({ name, args });
      return { available: true, complete: true, period: args.periodDays ? "lookback" : "all_time", ...args, scope: args.title ? "title" : "library", matched: true, playCount: 24000, totalWatchSeconds: 86400 };
    }
  }, {
    slackDiagnosticRunner: (actualConfig, context, settings, hooks) => runCodexSlackDiagnostics(actualConfig, context, settings, {
      ...hooks,
      runModel: async (_config, prompt, options) => {
        assert.match(prompt, /researchComplexity is only a preliminary chat-classifier hint/);
        assert.match(prompt, /excessive/);
        const result = await rpc(options, "tools/call", { name: "media_public_watchtime_summary", arguments: { allTime: true } });
        assert.equal(JSON.parse(result.result.content[0].text).complete, true);
        return JSON.stringify({ analysis: "24 hours across all recorded history.", sources: [], completion: "complete" });
      }
    }),
    slackReplyRunner: async (_config, _context, evidence) => evidence.analysis
  });
  const aggregateAnswer = await aggregateAgent.slackReadOnlyChat({ newestMessage: "How many years/months/days have been watched in total?", request: { queryType: "watchtime_summary", allTime: true, researchComplexity: "excessive" } });
  assert.match(aggregateAnswer.message, /24 hours across all recorded history/);
  assert.deepEqual(aggregateCalls, [{ name: "media_public_watchtime_summary", args: { allTime: true } }], "a low-model cost hint cannot reject an inexpensive all-library aggregate");
  for (const timeframe of [{ allTime: true }, { periodDays: 1826 }, { periodYears: 5 }, {}]) {
    const answer = await aggregateAgent.slackMediaInfo({ queryType: "watchtime_summary", mediaTitle: "Example Show", ...timeframe });
    assert.deepEqual(aggregateCalls.at(-1).args, { title: "Example Show", ...timeframe });
    assert.doesNotMatch(answer.message, /last (?:30|365) days/);
    assert.match(answer.message, timeframe.periodDays ? /last 1,826 days/ : /all recorded history/);
  }
} finally { await rm(telemetryRoot, { recursive: true, force: true }); }
console.log("Slack general research and budget tests passed");
