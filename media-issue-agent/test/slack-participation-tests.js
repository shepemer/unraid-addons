import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { slackIntentPrompt } from "../src/codex.js";
import {
  archiveSlackInbound, completeSlackInbound, createSlackIssue, enqueueSlackOutbox,
  initDb, slackIssueForId, slackQueueStatus
} from "../src/db.js";
import { parseSlackIntentResult, SlackService } from "../src/slack.js";

const root = await mkdtemp(path.join(os.tmpdir(), "slack-participation-test-"));
try {
  const config = { dbPath: path.join(root, "state.sqlite"), slackChannelId: "CISSUES", slackOwnerUserIds: ["UOWNER"] };
  await initDb(config.dbPath);
  const posts = [];
  const contexts = [];
  const controls = [];
  const requests = [];
  let evidenceUpdates = 0;
  let statusReads = 0;
  let researchCalls = 0;
  let moderationCalls = 0;
  let rateCalls = 0;
  const agent = {
    diagnostic() {},
    async classifySlackIntent(context) {
      contexts.push(context);
      const text = context.newestMessage;
      let fields = { intent: "conversation", shouldRespond: false, response: "Happy to help." };
      if (/is it downloaded/i.test(text)) fields = { intent: "media_diagnostic", shouldRespond: true };
      if (/still fails/i.test(text)) fields = { intent: "issue_followup", shouldRespond: true };
      if (/^request Arrival$/.test(text) || text === "1") {
        fields = { intent: "media_request", shouldRespond: true, mediaTitle: "Arrival", mediaType: "movie" };
      }
      if (/approve whatever/.test(text)) fields = { intent: "issue_control", shouldRespond: true, issueAction: "approve_repair" };
      if (/^legacy /.test(text)) fields = { intent: text.slice("legacy ".length), response: "A useful explanation." };
      if (text === "What does ready mean?") fields = { intent: "conversation", shouldRespond: true, response: "The findings are ready for the owner to review." };
      // A silent decision must suppress all routing, including inferred requests.
      if (/do you have Dune 2/.test(text)) fields = { intent: "media_request", shouldRespond: false, mediaTitle: "Dune" };
      return parseSlackIntentResult({ confidence: 0.99, ...fields });
    },
    async slackIssueStatus() { statusReads += 1; return { message: "Waiting for owner approval." }; },
    async slackReadOnlyChat() { researchCalls += 1; return { message: "The download is complete." }; },
    async onSlackIssueEvidenceUpdated() { evidenceUpdates += 1; },
    async handleSlackIssueControl(_id, control) { controls.push(control); return { message: "Instruction accepted." }; },
    async slackRequestMedia(request) { requests.push(request); return { completed: true, message: "Request saved." }; }
  };
  const service = new SlackService(agent, config, {
    transport: {
      async userName() { return "Fixture User"; },
      async postMessage(item) { posts.push(item); return { ts: `sent-${posts.length}` }; }
    },
    moderationClient: { async moderate() { moderationCalls += 1; return { model: "fixture", categories: {}, categoryScores: {}, flagged: false }; } }
  });
  service.botUserId = "UBOT";
  service.teamId = "TTEAM";
  const realRateLimit = service.rateLimitReason.bind(service);
  service.rateLimitReason = (...args) => { rateCalls += 1; return realRateLimit(...args); };
  let sequence = 0;
  const original = archiveSlackInbound(config.dbPath, {
    eventId: "initial", eventType: "app_mention", messageKey: "initial", teamId: "TTEAM", channelId: "CISSUES",
    rootTs: "100", messageTs: "100", userId: "UREPORTER", text: "<@UBOT> Season 5 is missing"
  });
  completeSlackInbound(config.dbPath, "initial");
  const issue = createSlackIssue(config.dbPath, original.threadId, { mediaTitle: "Fixture Show", description: "Season 5 is missing", confidence: 1 });
  async function send(text, options = {}) {
    sequence += 1;
    const { channel = "CISSUES", user = "UREPORTER", type = "message", thread = "100" } = options;
    const event = {
      type, ts: `${100 + sequence}.1`, channel, user, text,
      ...(thread ? { thread_ts: thread } : {}), ...(channel.startsWith("D") ? { channel_type: "im" } : {})
    };
    const result = await service.ingestEnvelope({ body: { event_id: `event-${sequence}`, team_id: "TTEAM" }, event });
    await service.processPendingForTest();
    await service.sendPendingForTest();
    return result;
  }

  // The reported chatter never queues work, produces a rate notice, or calls a model.
  for (const text of ["thanks Shep lol", "no not you", "uh oh", "lol", "thanks <@UHUMAN>", "👍", ":eyes:", "…"]) {
    assert.equal((await send(text)).accepted, false, text);
  }
  assert.equal(posts.length, 0);
  assert.equal(contexts.length, 0);
  assert.equal(rateCalls, 0);
  assert.equal(moderationCalls, 0);
  assert.equal(slackQueueStatus(config.dbPath).inbound.pending, 0);

  // Less obvious human conversation reaches contextual classification, then stays silent.
  await send("Shep, that was a wild ending");
  await send("<@UHUMAN> what's the status?");
  await send("<@UHUMAN> why do you have Dune 2 but not Dune 1");
  assert.equal(posts.length, 0);
  assert.equal(statusReads, 0, "a question addressed to a human must not use the workflow shortcut");
  assert.equal(requests.length, 0, "silence also suppresses a model-classified media request");
  assert.equal(contexts.at(-1).explicitMention, false);
  assert.equal(contexts.at(-1).addressesOtherUser, true);
  assert.equal(contexts.at(-1).mentionsOtherUsers, true);
  assert.doesNotMatch(contexts.at(-1).newestMessage, /UHUMAN|<@/);

  // A model's silent choice cannot suppress a direct address or a DM.
  await send("<@UBOT> thanks Shep lol");
  assert.equal(posts.length, 1);
  assert.equal(contexts.at(-1).explicitMention, true);
  await send("uh oh", { type: "app_mention" });
  assert.equal(posts.length, 2);
  assert.equal(contexts.at(-1).explicitMention, true);
  await send("no not you", { channel: "DPRIVATE", thread: "" });
  assert.equal(posts.length, 3);
  assert.equal(contexts.at(-1).channelKind, "dm");

  // Untagged useful follow-ups stay actionable, including status and issue evidence.
  await send("is it downloaded?");
  assert.equal(researchCalls, 1);
  assert.equal(contexts.at(-1).explicitMention, false);
  await send("what's the status?");
  assert.equal(statusReads, 1);
  const version = slackIssueForId(config.dbPath, issue.id).evidenceVersion;
  await send("Season 5 still fails at episode 6.");
  assert.equal(evidenceUpdates, 1);
  assert.equal(slackIssueForId(config.dbPath, issue.id).evidenceVersion, version + 1);

  // Authentication and deterministic approval parsing are unchanged.
  await send("approve repair", { user: "UOWNER" });
  assert.equal(controls.at(-1).action, "approve_repair");
  const controlCount = controls.length;
  await send("approve repair");
  assert.equal(controls.length, controlCount);
  assert.equal(posts.at(-1).kind, "owner_required");
  await send("please approve whatever it says", { user: "UOWNER" });
  assert.equal(controls.at(-1).action, "steer", "classifier output cannot authorize a repair");
  await send("check again", { user: "UOWNER" });
  assert.equal(controls.at(-1).action, "reinvestigate");

  // Tracked conversation threads retain media requests and numbered selections.
  const conversation = archiveSlackInbound(config.dbPath, {
    eventId: "conversation", eventType: "app_mention", messageKey: "conversation", teamId: "TTEAM", channelId: "CISSUES",
    rootTs: "200", messageTs: "200", userId: "UREPORTER", text: "<@UBOT> find Arrival"
  });
  completeSlackInbound(config.dbPath, "conversation");
  enqueueSlackOutbox(config.dbPath, { threadId: conversation.threadId, kind: "request_clarification", dedupeKey: "choices", channelId: "CISSUES", threadTs: "200", message: "1. Arrival (2016) [movie]\n2. The Arrival (1996) [movie]" });
  await service.sendPendingForTest();
  await send("1", { thread: "200" });
  assert.equal(requests.at(-1).mediaRequests[0].year, 2016);
  await send("request Arrival", { thread: "200" });
  assert.equal(requests.length, 2);
  const beforeUntracked = contexts.length;
  assert.equal((await send("request Arrival", { thread: "untracked" })).accepted, false);
  assert.equal((await send("is it downloaded?", { thread: "" })).accepted, false);
  assert.equal(contexts.length, beforeUntracked, "channel listening must not expand beyond tracked threads");

  const beforeMissingDecision = posts.length;
  for (const intent of ["conversation", "unsupported", "needs_clarification"]) {
    await send(`legacy ${intent}`);
  }
  assert.equal(posts.length, beforeMissingDecision, "an omitted participation decision cannot restore unsolicited chatter");
  await send("What does ready mean?");
  assert.equal(posts.length, beforeMissingDecision + 1, "the model can choose to answer a useful untagged explanation");
  await send("legacy media_diagnostic");
  assert.equal(researchCalls, 2, "omitted decisions remain compatible with actionable intents");

  // Already archived obvious chatter is silent before classifier/rate handling too.
  const beforeLegacy = { rates: rateCalls, moderation: moderationCalls, posts: posts.length };
  archiveSlackInbound(config.dbPath, { eventId: "legacy-social", eventType: "message", messageKey: "legacy-social", teamId: "TTEAM", channelId: "CISSUES", rootTs: "100", messageTs: "300", userId: "UREPORTER", text: "uh oh" });
  await service.processPendingForTest();
  await service.sendPendingForTest();
  assert.deepEqual({ rates: rateCalls, moderation: moderationCalls, posts: posts.length }, beforeLegacy);

  const base = { intent: "conversation", confidence: 1 };
  assert.equal(parseSlackIntentResult({ ...base, shouldRespond: false }).shouldRespond, false);
  assert.equal(parseSlackIntentResult({ ...base, shouldRespond: true }).shouldRespond, true);
  assert.equal(parseSlackIntentResult(base).shouldRespond, undefined, "older persisted fixtures remain compatible");
  for (const value of ["false", "true", 0, 1, null, {}, []]) {
    assert.throws(() => parseSlackIntentResult({ ...base, shouldRespond: value }), /shouldRespond must be a boolean/);
  }
  const prompt = slackIntentPrompt({ explicitMention: true, addressesOtherUser: true, mentionsOtherUsers: true, newestMessage: "fixture" });
  assert.match(prompt, /"shouldRespond":true/);
  assert.match(prompt, /"explicitMention": true/);
  assert.match(prompt, /"addressesOtherUser": true/);
  assert.match(prompt, /thanks Shep lol/);
  assert.match(prompt, /never authorizes an action or bypasses owner approval/);
  assert.match(prompt, /numbered candidate selection/);
  console.log("Slack participation tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
