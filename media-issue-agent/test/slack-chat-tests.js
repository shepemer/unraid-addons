import assert from "node:assert/strict";
import { loadConfig, normalizeSlackOwnerUserIds } from "../src/config.js";
import { runSlackChatReply, safeSlackChatReply, slackChatReplyPrompt, SLACK_CHAT_FALLBACK } from "../src/slack-chat.js";

assert.deepEqual(normalizeSlackOwnerUserIds(" UOWNER123, WOWNER456, UOWNER123 "), ["UOWNER123", "WOWNER456"]);
assert.deepEqual(normalizeSlackOwnerUserIds(""), []);
for (const value of ["Alice", "U123\nW456", "<@U12345678>", "u12345678"]) {
  assert.throws(() => normalizeSlackOwnerUserIds(value), /Slack member IDs/);
}
const config = await loadConfig({
  ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture",
  ISSUE_AGENT_SLACK_OWNER_USER_IDS: "UOWNER123"
}, { requireCodexAuth: false });
assert.deepEqual(config.slackOwnerUserIds, ["UOWNER123"]);

const facts = {
  completion: "complete",
  facts: [{ tool: "media_public_watchtime_summary", arguments: { periodDays: 30 }, result: { playCount: 20, durationSeconds: 7200 } }]
};
const context = { newestMessage: "How much watch time?", recentMessages: [{ direction: "inbound", text: "This month please" }] };
const prompt = slackChatReplyPrompt(context, facts);
assert.match(prompt, /20/);
assert.match(prompt, /7200/);
assert.match(prompt, /Never identify who watched what/);
assert.doesNotMatch(prompt, /undefined/);
const scopedContext = {
  newestMessage: "is it downloaded?",
  issue: { mediaTitle: "The Great Escape", description: "Season 5 episode 6 is missing. <@UOWNER123> reported it.", reporterUsername: "private-person" },
  request: { mediaTitle: "The Great Escape", mediaType: "tv", seasons: [5], episodeNumber: 6, queryType: "title_summary", userId: "private-person" },
  workflow: { state: "awaiting_action_approval", classification: "server_action", nextStep: "owner_approve_repair", actor: "private-person" }
};
const scopedPrompt = slackChatReplyPrompt(scopedContext, facts);
const scopedPayload = JSON.parse(scopedPrompt.split("Untrusted context and privacy-projected diagnostic facts:\n")[1]);
assert.equal(scopedPayload.issue.mediaTitle, "The Great Escape");
assert.match(scopedPayload.issue.description, /Season 5 episode 6/);
assert.deepEqual(scopedPayload.request, { mediaTitle: "The Great Escape", mediaType: "tv", episodeNumber: 6, seasons: [5], queryType: "title_summary" });
assert.deepEqual(scopedPayload.workflow, { state: "awaiting_action_approval", classification: "server_action", nextStep: "owner_approve_repair" });
assert.doesNotMatch(scopedPrompt, /private-person|UOWNER123/);
assert.match(scopedPrompt, /Never attribute symptoms, requests, or viewing activity to a person/);
const publicationPrompt = slackChatReplyPrompt({
  newestMessage: "Summarize the verified findings for this issue and useful next diagnostic or repair steps. The investigation is complete; repair has not been approved.",
  recentMessages: [{ direction: "inbound", text: scopedContext.issue.description }],
  issue: scopedContext.issue,
  request: { mediaTitle: "The Great Escape" },
  workflow: scopedContext.workflow
}, { completion: "unavailable", facts: [] });
assert.match(publicationPrompt, /The Great Escape/);
assert.match(publicationPrompt, /Season 5 episode 6/);
assert.match(publicationPrompt, /awaiting_action_approval/);
assert.match(publicationPrompt, /owner_approve_repair/);
let calls = 0;
const message = await runSlackChatReply(config, context, facts, { model: "existing-chat-model", reasoningEffort: "ultra" }, {
  run: async (_config, actualPrompt, options) => {
    calls += 1;
    assert.equal(actualPrompt, prompt);
    assert.equal(options.settings.model, "existing-chat-model");
    assert.equal(options.settings.reasoningEffort, "low");
    assert.equal(options.settings.serviceTier, "fast");
    assert.equal(options.toolFree, true);
    assert.equal(options.ignoreRules, true);
    assert.equal(options.ignoreUserConfig, true);
    assert.equal(options.isolatedWorkspace, true);
    return JSON.stringify({ message: "There were 20 plays and 2 hours of total watch time." });
  }
});
assert.equal(calls, 1);
assert.equal(message, "There were 20 plays and 2 hours of total watch time.");
for (const privateReply of [
  "The file is /mnt/user/media/test.mkv",
  "Connected at 8.8.8.8",
  "See https://private.example/show",
  "User <@UOWNER123> watched it",
  "Email person@example.com",
  "The device is plex.local",
  "Use C:\\Media\\test.mkv",
  "API key sk-fixturesecret12345"
]) {
  assert.equal(safeSlackChatReply(privateReply), "", privateReply);
}
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => "not json" }), SLACK_CHAT_FALLBACK);
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => '{"message":{"text":"invalid shape"}}' }), SLACK_CHAT_FALLBACK);
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => '{"message":"IP 8.8.8.8"}' }), SLACK_CHAT_FALLBACK);
console.log("Slack chat synthesis and owner configuration tests passed");
