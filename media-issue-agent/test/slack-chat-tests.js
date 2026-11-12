import assert from "node:assert/strict";
import { loadConfig, normalizeSlackOwnerUserIds } from "../src/config.js";
import { buildSlackPublicSources, publicSlackSourceUrl, runSlackChatReply, safeSlackChatReply, slackChatReplyPrompt, SLACK_CHAT_FALLBACK } from "../src/slack-chat.js";

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
assert.match(prompt, /Default to about 80 words or fewer/);
assert.match(prompt, /at most three concise bullets/);
assert.match(prompt, /If the user explicitly asks for detail, expand only as much as needed/);
assert.match(prompt, /Format for Slack mrkdwn: use \*bold\*/);
assert.match(prompt, /Preserve line breaks between short paragraphs and bullet items/);
assert.doesNotMatch(prompt, /undefined/);
for (const timeframe of [{ allTime: true }, { periodDays: 1826 }, { periodMonths: 60 }, { periodYears: 5 }, { startDate: "2010-01-01", endDate: "2026-11-11" }]) {
  const scoped = slackChatReplyPrompt({ newestMessage: "What is the total?", request: timeframe }, facts);
  const payload = JSON.parse(scoped.split("Untrusted context and privacy-projected diagnostic facts:\n")[1]);
  assert.deepEqual(payload.request, timeframe);
}
assert.match(prompt, /including all time/);
assert.match(prompt, /Label years\/months as approximate duration equivalents/);
assert.match(prompt, /never present it as the requested complete total/);
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
const formattedReply = "*Download complete; import blocked.*\n\n• The file downloaded successfully.\n• Next: approve the import repair with `approve repair`.";
assert.equal(safeSlackChatReply(formattedReply), formattedReply);
assert.equal(safeSlackChatReply("  *Weekly watch time*  \r\n\r\n\r\n  •  2 hours\r\n \t• 20 plays  "), "*Weekly watch time*\n\n• 2 hours\n• 20 plays");
assert.equal(await runSlackChatReply(config, context, facts, {}, {
  run: async () => JSON.stringify({ message: formattedReply })
}), formattedReply);
for (const privateReply of [
  "The file is /mnt/user/media/test.mkv",
  "Connected at 8.8.8.8",
  "See https://private.example/show",
  "User <@UOWNER123> watched it",
  "Email person@example.com",
  "The device is plex.local",
  "Use C:\\Media\\test.mkv",
  "API key sk-fixturesecret12345",
  "*Details*\n\n• The file is /mnt/user/media/test.mkv",
  "*Details*\n• User <@UOWNER123> watched it",
  "*Details*\n• Contact person@example.com"
]) {
  assert.equal(safeSlackChatReply(privateReply), "", privateReply);
}
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => "not json" }), SLACK_CHAT_FALLBACK);
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => '{"message":{"text":"invalid shape"}}' }), SLACK_CHAT_FALLBACK);
assert.equal(await runSlackChatReply(config, context, facts, {}, { run: async () => '{"message":"IP 8.8.8.8"}' }), SLACK_CHAT_FALLBACK);

const researchSources = [
  { title: "Arrival reviews", url: "https://www.rottentomatoes.com/m/arrival_2016" },
  { title: "Arrival details", url: "https://www.imdb.com/title/tt2543164/" }
];
assert.deepEqual(buildSlackPublicSources([...researchSources, researchSources[0]]), researchSources);
for (const url of [
  "http://localhost/private", "http://plex.local:32400/library", "https://192.168.1.20/", "https://8.8.8.8/",
  "http://[::1]/", "http://[2606:4700:4700::1111]/", "http://2130706433/", "http://0x7f000001/",
  "http://plex/", "http://plex.internal/", "http://private.home.arpa/", "http://127.0.0.1.nip.io/",
  "https://user:password@www.imdb.com/", "ftp://www.imdb.com/title/tt2543164/", "https://www.imdb.com:444/",
  "https://www.imdb.com/?token=private", "https://www.imdb.com/?api_key=private", "https://www.imdb.com/?session_id=private",
  "https://www.imdb.com/?q=person%40example.com", "https://www.imdb.com/?redirect=http%3A%2F%2F192.168.1.20%2F",
  "https://www.imdb.com/auth/private", "https://www.imdb.com/sk-fixturesecret12345", "https://www.imdb.com/path|fake",
  "https://www.imdb.com/\nInjected"
]) assert.equal(publicSlackSourceUrl(url), "", url);
assert.equal(publicSlackSourceUrl("https://www.imdb.com/title/tt2543164/#reviews"), "https://www.imdb.com/title/tt2543164/");
assert.equal(buildSlackPublicSources(Array.from({ length: 20 }, (_, i) => ({ title: `Source ${i}`, url: `https://www.imdb.com/title/tt${i}/` }))).length, 8);
assert.equal(safeSlackChatReply("Arrival is a thoughtful choice [1].", researchSources), "Arrival is a thoughtful choice <https://www.rottentomatoes.com/m/arrival_2016|Arrival reviews>.");
assert.equal(safeSlackChatReply("Arrival is acclaimed [Reviews](https://www.rottentomatoes.com/m/arrival_2016).", researchSources), "Arrival is acclaimed <https://www.rottentomatoes.com/m/arrival_2016|Arrival reviews>.");
assert.equal(safeSlackChatReply("See https://www.imdb.com/title/tt2543164/.", researchSources), "See <https://www.imdb.com/title/tt2543164/|Arrival details>.");
assert.equal(safeSlackChatReply("Use [3] for proof.", researchSources), "");
assert.equal(safeSlackChatReply("See https://unverified-site.com/movie", researchSources), "");
assert.equal(safeSlackChatReply("See https://www.imdb.com/title/tt2543164/?token=secret", researchSources), "");
assert.equal(safeSlackChatReply("See https://www.imdb.com/title/tt2543164/", []), "");
assert.equal(safeSlackChatReply("*Try Arrival.*\n\n• Thoughtful science fiction [1].\n• Recently added to the library.", researchSources), "*Try Arrival.*\n\n• Thoughtful science fiction <https://www.rottentomatoes.com/m/arrival_2016|Arrival reviews>.\n• Recently added to the library.");
assert.equal(safeSlackChatReply("*Recommendation*\n\n• See https://unverified-site.com/movie", researchSources), "");
const longFormattedReply = safeSlackChatReply(`*Recommendation*\n\n• Arrival is worth watching [1].\n\n${"Additional verified context. ".repeat(100)}`, researchSources);
assert.ok(longFormattedReply.length <= 2000);
assert.match(longFormattedReply, /^\*Recommendation\*\n\n•/);
assert.match(longFormattedReply, /<https:\/\/www\.rottentomatoes\.com\/m\/arrival_2016\|Arrival reviews>/);
assert.match(longFormattedReply, /…$/);
assert.doesNotMatch(longFormattedReply, /\[source/);
const overflowingCitation = safeSlackChatReply(`${"Verified context. ".repeat(110)}[1]`, [
  { title: "Long public source", url: `https://www.imdb.com/${"article".repeat(120)}` }
]);
assert.ok(overflowingCitation.length <= 2000);
assert.match(overflowingCitation, /…$/);
assert.doesNotMatch(overflowingCitation, /\[source|<|https?:\/\//);

const researched = {
  completion: "budget_exceeded",
  facts: [{ tool: "media_public_recent_additions", args: { mediaType: "movie" }, result: { records: [{ title: "Arrival", year: 2016 }] } }],
  analysis: "Arrival was recently added and is a strong recommendation for thoughtful science fiction. Reviews praise its patient storytelling [Reviews](https://www.rottentomatoes.com/m/arrival_2016). I did not inspect anybody's viewing history. A second comparison remains unverified.",
  sources: [...researchSources, { title: "Not public", url: "http://plex.local/" }]
};
const researchedPrompt = slackChatReplyPrompt({ newestMessage: "What should we watch from the recent additions?" }, researched);
const researchedPayload = JSON.parse(researchedPrompt.split("Untrusted context and privacy-projected diagnostic facts:\n")[1]);
assert.match(researchedPayload.analysis, /strong recommendation for thoughtful science fiction/);
assert.match(researchedPayload.analysis, /\[source 1\]/);
assert.deepEqual(researchedPayload.facts[0].arguments, { mediaType: "movie" });
assert.equal(researchedPayload.completion, "budget_exceeded");
assert.equal(researchedPayload.sources.length, 2);
const remappedPrompt = slackChatReplyPrompt({}, {
  analysis: "The public reviews are positive [2]. A private claim lacks a usable citation [1].",
  sources: [{ title: "Private", url: "http://plex.local/" }, researchSources[0]],
  completion: "partial"
});
const remappedPayload = JSON.parse(remappedPrompt.split("Untrusted context and privacy-projected diagnostic facts:\n")[1]);
assert.match(remappedPayload.analysis, /positive \[source 1\]/);
assert.match(remappedPayload.analysis, /claim lacks a usable citation \[unverified source\]/);
assert.equal(remappedPayload.sources[0].url, researchSources[0].url);
assert.doesNotMatch(researchedPrompt, /plex\.local/);
assert.match(researchedPrompt, /Preserve the backend analysis's useful conclusions, calculations, recommendations/);
assert.match(researchedPrompt, /Do not promise an automatic retry/);
assert.match(researchedPrompt, /seconds divided by 3600/);
const recommendation = await runSlackChatReply(config, { newestMessage: "Recommend a recent addition" }, researched, { model: "existing-chat-model" }, {
  timeoutMs: 30000,
  tokenBudget: 6000,
  run: async (_config, actualPrompt, options) => {
    assert.match(actualPrompt, /patient storytelling/);
    assert.equal(options.settings.reasoningEffort, "low");
    assert.equal(options.timeoutMs, 30000);
    assert.equal(options.tokenBudget, 6000);
    return JSON.stringify({ message: "Arrival is in the recent additions and suits thoughtful sci-fi; reviews praise its patient storytelling [1]. I could not verify the second comparison." });
  }
});
assert.match(recommendation, /Arrival is in the recent additions/);
assert.match(recommendation, /<https:\/\/www\.rottentomatoes\.com\/m\/arrival_2016\|Arrival reviews>/);
assert.match(recommendation, /could not verify/);
console.log("Slack chat synthesis and owner configuration tests passed");
