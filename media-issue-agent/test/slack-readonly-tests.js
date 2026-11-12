import assert from "node:assert/strict";
import { buildAnalysisCodexArgs, runCodexSlackPlanSummary, slackDiagnosticsPrompt } from "../src/codex.js";
const config = { codexWorkspace: "/tmp/unused" };
const secret = { user: "Private Viewer", username: "private-person", path: "/tv/private" };
function clean(value) { assert.doesNotMatch(JSON.stringify(value), /Private Viewer|private-person|\/tv\/private/); }
const pendingDetails = {
  investigation: { summary: "The expected file is missing. Private Viewer reported it. Reacquire the episode and verify playback." },
  approvals: [{ kind: "action", status: "pending", payload: { plan: { classification: "server_action", executionMode: "approved_repair_agent", actionSummary: { expectedSteps: ["Search for a replacement and verify the affected episode."] } } } }]
};
const safePlan = await runCodexSlackPlanSummary(config, pendingDetails, {}, {
  runModel: async (_config, prompt, hooks) => {
    assert.equal(hooks.toolFree, true);
    assert.ok(prompt.includes("Search for a replacement"));
    return JSON.stringify({ findings: ["missing_file"], actions: ["search_replace", "verify"] });
  }
});
assert.deepEqual(safePlan.findings, ["The expected media file is missing."]);
assert.equal(safePlan.actions.length, 2);
assert.ok(safePlan.approvalScope.includes("choose and carry out appropriate media-side repairs"));
assert.ok(safePlan.approvalScope.includes("closing the issue require separate approval"));
clean(safePlan);
for (const badOutput of [
  { findings: ["Private Viewer watched Example Show"], actions: ["verify"] },
  { findings: ["missing_file"], actions: ["delete /tv/private"] },
  { findings: ["missing_file"], actions: ["verify"], raw: secret },
  { findings: [1], actions: ["verify"] },
  { findings: ["__proto__"], actions: ["constructor"] },
  { findings: [], actions: [] }
]) {
  const blocked = await runCodexSlackPlanSummary(config, pendingDetails, {}, { runModel: async () => JSON.stringify(badOutput) });
  assert.deepEqual(blocked.findings, ["The investigation has not established a specific cause."]);
  clean(blocked);
}
const clientDetails = structuredClone(pendingDetails);
clientDetails.approvals[0].payload.plan.executionMode = "none";
clientDetails.approvals[0].payload.plan.classification = "client_side";
const clientPlan = await runCodexSlackPlanSummary(config, clientDetails, {}, { runModel: async () => JSON.stringify({ findings: ["client_side"], actions: ["client_guidance"] }) });
assert.ok(clientPlan.approvalScope.includes("without media changes"));
console.log("Slack read-only diagnostic tests passed");
