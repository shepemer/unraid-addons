import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAnalysisCodexArgs, runCodex, runCodexSlackDiagnostics, slackDiagnosticsPrompt, slackIntentPrompt, SLACK_RESEARCH_LIMITS } from "../src/codex.js";
import { parseSlackIntentResult } from "../src/slack.js";

const tool = (name, properties = {}) => ({ name, description: "Read current media information.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties, additionalProperties: false } });
const tools = [
  tool("new_service_catalog_measurement", { title: { type: "string" } }),
  tool("media_public_watchtime_summary", { periodDays: { type: "integer", minimum: 1, maximum: 366 } }),
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
console.log("Slack general research and budget tests passed");
