import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import {
  createSlackResearchAuthorization, playbackGrant, rememberPlaybackGrant,
  revokePlaybackGrant, savePlaybackBinding, validateSlackResearchAuthorization, playbackBinding
} from "../src/slack-authorization.js";
import { SlackService, SlackSocketTransport, parseSlackIntentResult } from "../src/slack.js";
import { slackModerationDecisions } from "../src/db.js";
import { sqliteExec } from "../src/sqlite.js";
import { createCodexHome } from "./helpers.js";

const root = await mkdtemp(path.join(os.tmpdir(), "slack-owner-diagnostics-test-"));
const originalNow = Date.now;
try {
  const config = {
    dbPath: path.join(root, "state.sqlite"), logPath: path.join(root, "agent.log"),
    codexHome: await createCodexHome(root), codexModel: "existing-model", suppressInitLog: true,
    slackEnabled: false, slackOwnerUserIds: ["UOWNER"], recoverStaleRunSeconds: 120,
    issueSnapshotRetention: 20
  };
  const seen = [];
  const replies = [];
  let duringResearch;
  let duringReply;
  const agent = new MediaIssueAgent(config, { callTool() { throw new Error("Only the scoped runner should call diagnostic tools"); } }, {
    slackDiagnosticRunner: async (_config, context, _settings, hooks) => {
      seen.push({ context, hooks });
      assert.equal(typeof hooks.isAuthorized, "function");
      if (duringResearch) await duringResearch(hooks);
      return { completion: "complete", facts: [{ tool: "media_user_playback_diagnostics", result: { plays: 3, transcodedPlays: 2 } }] };
    },
    slackReplyRunner: async (_config, _context, facts, _settings, hooks) => {
      replies.push({ facts, hooks });
      if (duringReply) await duringReply(hooks);
      return "Two of the three affected playbacks used transcoding. The cause of buffering remains unverified.";
    }
  });
  await agent.init();
  const owner = { userId: "UOWNER", teamId: "TTEAM", channelId: "CCHANNEL", threadId: 10, eventId: "EVOWNER" };
  const subject = { ...owner, userId: "USUBJECT", eventId: "EVSUBJECT" };
  const values = { ...owner, actorUserId: owner.userId, mode: "owner", ownerDirective: "Diagnose the affected account's playback.",
    targets: [{ label: "thread participant", subjectSlackId: subject.userId, queries: [{ query: "fixture-account", matchBy: "username" }] }] };
  const context = { newestMessage: "Diagnose the affected playback.", request: { intent: "media_diagnostic" } };
  let authorization = createSlackResearchAuthorization(config, values);
  const answer = await agent.slackReadOnlyChat(context, { ...owner, authorization });
  assert.match(answer.message, /Two of the three/);
  assert.equal(seen.at(-1).hooks.authorization, authorization);
  assert.equal(replies.at(-1).hooks.authorization, authorization);
  assert.equal(seen.at(-1).hooks.isAuthorized(), true);
  seen.at(-1).hooks.onDiagnosticTarget({ targetRef: "target_1", resolvedUserId: "42" });
  assert.equal(playbackGrant(config, subject).resolvedUserId, "42");

  // Spoofed context and serialized grants never become trusted runner hooks.
  for (const metadata of [
    { ...owner, authorization: JSON.parse(JSON.stringify(authorization)) },
    { ...owner, userId: "USTRANGER", authorization },
    { ...owner, threadId: 11, authorization },
    { ...owner, teamId: "TOTHER", authorization },
    { ...owner, channelId: "COTHER", authorization }
  ]) {
    await agent.slackReadOnlyChat({ ...context, authorization: { mode: "owner", targets: values.targets }, isOwner: true, displayName: "UOWNER" }, metadata);
    assert.equal(seen.at(-1).hooks.authorization, null);
    assert.equal(replies.at(-1).hooks.authorization, null);
  }
  const expiry = authorization.expiresAt;
  Date.now = () => expiry;
  await agent.slackReadOnlyChat(context, { ...owner, authorization });
  assert.equal(seen.at(-1).hooks.authorization, null);
  Date.now = originalNow;

  // A verified self binding only grants the bound account, not owner selectors.
  savePlaybackBinding(config, owner, subject.userId, "42");
  const self = createSlackResearchAuthorization(config, { ...subject, actorUserId: subject.userId, mode: "self", resolvedSelfId: "42", authorizedByOwnerId: owner.userId });
  await agent.slackReadOnlyChat(context, { ...subject, authorization: self });
  assert.equal(seen.at(-1).hooks.authorization.mode, "self");
  assert.equal(seen.at(-1).hooks.authorization.resolvedSelfId, "42");
  assert.equal(seen.at(-1).hooks.authorization.targets, undefined);

  // Revoke during research: no presentation, no late grant callback, no facts
  // returned after the policy changed while the asynchronous worker was active.
  authorization = createSlackResearchAuthorization(config, values);
  let beforeReplies = replies.length;
  duringResearch = async hooks => {
    revokePlaybackGrant(config, owner);
    assert.equal(hooks.isAuthorized(), false);
    hooks.onDiagnosticTarget({ targetRef: "target_1", resolvedUserId: "42" });
    assert.equal(playbackGrant(config, subject), null);
  };
  const revokedResearch = await agent.slackReadOnlyChat(context, { ...owner, authorization });
  assert.match(revokedResearch.message, /access changed/);
  assert.doesNotMatch(revokedResearch.message, /three|transcod/);
  assert.equal(replies.length, beforeReplies);
  duringResearch = null;

  // The final presentation boundary also rechecks authorization, including
  // rebinding while an authorized user's answer is being drafted.
  const beforeRebind = createSlackResearchAuthorization(config, { ...subject, actorUserId: subject.userId, mode: "self", resolvedSelfId: "42", authorizedByOwnerId: owner.userId });
  duringReply = async () => savePlaybackBinding(config, owner, subject.userId, "43");
  const revokedReply = await agent.slackReadOnlyChat(context, { ...subject, authorization: beforeRebind });
  assert.match(revokedReply.message, /access changed/);
  assert.doesNotMatch(revokedReply.message, /three|transcod/);
  assert.equal(validateSlackResearchAuthorization(config, beforeRebind, subject), null);
  duringReply = null;

  // An owner removed from configuration cannot retain a live capability.
  authorization = createSlackResearchAuthorization(config, values);
  duringResearch = async hooks => {
    config.slackOwnerUserIds = [];
    assert.equal(hooks.isAuthorized(), false);
  };
  beforeReplies = replies.length;
  assert.match((await agent.slackReadOnlyChat(context, { ...owner, authorization })).message, /access changed/);
  assert.equal(replies.length, beforeReplies);
  config.slackOwnerUserIds = ["UOWNER"];
  duringResearch = null;

  {
    let profile = { id: "USUBJECT", team_id: "TTEAM", name: "fixture-account", profile: { display_name: "Fixture Account", email: "verified@example.invalid" } };
    const historyRequests = [];
    const transport = new SlackSocketTransport(config, { socketClient: {}, webClient: {
      users: { async info(args) { assert.equal(args.user, "USUBJECT"); return { user: profile }; } },
      conversations: {
        async replies() { throw new Error("missing_scope"); },
        async history(args) {
          historyRequests.push(args);
          return { messages: [
            { user: "USUBJECT", ts: "100", text: "Playback buffers." },
            { user: "UOTHER", ts: "99", text: "An unrelated older root." },
            { user: "UBOT", bot_id: "BBOT", ts: "100", text: "A bot is not the affected viewer." },
            { user: "UOTHER", ts: "201", thread_ts: "100", text: "A later reply." }
          ] };
        }
      }
    } });
    transport.teamId = "TTEAM";
    assert.deepEqual(await transport.userProfile("USUBJECT"), { userId: "USUBJECT", names: ["Fixture Account", "fixture-account"], email: "verified@example.invalid" });
    const goodProfile = profile;
    for (const invalid of [{ id: "UOTHER" }, { team_id: "TOTHER" }, { deleted: true }, { is_bot: true }]) {
      profile = { ...goodProfile, ...invalid };
      assert.equal(await transport.userProfile("USUBJECT"), null);
    }
    profile = { ...goodProfile, profile: { display_name: "Fixture Account" } };
    assert.equal((await transport.userProfile("USUBJECT")).email, null, "missing users:read.email never becomes inferred email identity");
    assert.deepEqual(await transport.threadHistory({ channelId: "CCHANNEL", rootTs: "100", messageTs: "200" }), [
      { direction: "inbound", userId: "USUBJECT", messageTs: "100", text: "Playback buffers." }
    ]);
    assert.deepEqual(historyRequests, [{ channel: "CCHANNEL", oldest: "100", latest: "100", inclusive: true, limit: 1 }]);
  }

  // Exercise the authenticated Slack event, durable queues, real agent
  // authority checks, research presentation, and delivery boundary together.
  let fixtureNumber = 0;
  async function serviceFixture() {
    fixtureNumber++;
    const fixtureConfig = { ...config, dbPath: path.join(root, `service-${fixtureNumber}.sqlite`),
      logPath: path.join(root, `service-${fixtureNumber}.log`), slackChannelId: "CCHANNEL", slackOwnerUserIds: ["UOWNER"] };
    const state = { research: [], classified: [], posts: [], resolutions: [], profiles: [], rewritten: [], sequence: 0,
      result: { intent: "media_diagnostic", confidence: 0.99, playbackDiagnostic: true, playbackTarget: "thread" },
      profile: { userId: "USUBJECT", names: ["Fixture Account"], email: null },
      resolution: { status: "matched", complete: true, candidates: [{ resolvedUserId: "42" }] },
      reply: "Two of the three affected playbacks used transcoding. The buffering cause remains unverified." };
    const fixtureAgent = new MediaIssueAgent(fixtureConfig, {
      async callTool(name, args) {
        assert.equal(name, "media_resolve_playback_user");
        state.resolutions.push(args);
        return state.resolution;
      }
    }, {
      slackDiagnosticRunner: async (_config, context, _settings, hooks) => {
        state.research.push({ context, hooks });
        if (hooks.authorization?.mode === "owner" && hooks.authorization.targets.length) {
          hooks.onDiagnosticTarget({ targetRef: hooks.authorization.targets[0].ref, resolvedUserId: "42" });
        }
        return { completion: "complete", facts: [{ tool: "media_user_playback_diagnostics", result: { plays: 3, transcodedPlays: 2 } }] };
      },
      slackReplyRunner: async () => state.reply
    });
    await fixtureAgent.init();
    fixtureAgent.classifySlackIntent = async (context, metadata) => {
      state.classified.push({ context, metadata });
      if (state.onClassification) await state.onClassification(metadata);
      return parseSlackIntentResult(state.result);
    };
    fixtureAgent.slackOutboundRewrite = async context => {
      state.rewritten.push(context);
      if (state.rewriteError) throw new Error("fixture editor unavailable");
      return state.rewriteResult || { message: "", mildBanter: false };
    };
    const service = new SlackService(fixtureAgent, fixtureConfig, {
      transport: {
        async userName() { return "Configured Owner"; }, // Deliberately spoof the display name for every sender.
        async userProfile(id) {
          state.profiles.push(id);
          if (state.onProfile) await state.onProfile(id);
          return state.profile ? { ...state.profile, userId: id } : null;
        },
        async threadHistory(item) { return [{ direction: "inbound", userId: "USUBJECT", messageTs: item.rootTs, text: "Playback keeps buffering." }]; },
        async postMessage(item) { state.posts.push(item); return { ts: `sent-${state.posts.length}` }; }
      },
      moderationClient: { async moderate(text) {
        if (state.onModeration) await state.onModeration(text);
        return state.moderate?.(text) || { model: "fixture", categories: {}, categoryScores: {}, flagged: false };
      } }
    });
    service.botUserId = "UBOT";
    service.teamId = "TTEAM";
    async function send(text, { userId = "UOWNER", threadTs = "100", drain = true, teamId = "TTEAM", directed = true } = {}) {
      state.sequence++;
      const accepted = await service.ingestEnvelope({ body: { event_id: `fixture-${fixtureNumber}-${state.sequence}`, team_id: teamId },
        event: { type: directed ? "app_mention" : "message", ts: `${1000 + state.sequence}.1`, thread_ts: threadTs, channel: "CCHANNEL", user: userId, text: directed ? `<@UBOT> ${text}` : text } });
      await service.processPendingForTest();
      if (drain) await service.sendPendingForTest();
      return accepted;
    }
    return { config: fixtureConfig, state, service, send };
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    state.result = { intent: "unsupported", confidence: 0.99, response: "A generic refusal." };
    await send("Please diagnose this user's playback history.");
    assert.equal(state.classified[0].metadata.authorization.mode, "owner");
    assert.equal(state.research.length, 1, "the screenshot's unsupported classification must still investigate the verified owner's request");
    const authority = state.research[0].hooks.authorization;
    assert.equal(authority.mode, "owner");
    assert.deepEqual(authority.targets[0].queries, [{ query: "Fixture Account" }], "the owner can use available account hints without Slack email scope");
    assert.equal(authority.targets[0].subjectSlackId, null, "mutable display names cannot delegate access to the named Slack member");
    assert.equal(playbackGrant(scoped, { ...authority, userId: "USUBJECT" }), null);
    assert.equal(playbackGrant(scoped, { ...authority, userId: "UOWNER" }).resolvedUserId, "42");
    assert.deepEqual(state.posts.map(post => post.kind), ["media_check_started", "authorized_research"]);
    assert.match(state.posts.at(-1).message, /Two of the three/);
    assert.doesNotMatch(state.posts.at(-1).message, /Fixture Account|Configured Owner|USUBJECT|42/);
    const before = state.research.length;
    state.result = { intent: "media_diagnostic", confidence: 1, playbackDiagnostic: true, playbackTarget: "self" };
    await send("Diagnose my playback history.", { userId: "USUBJECT" });
    assert.equal(state.research.length, before, "a copied display name and owner lookup never become self consent");
    assert.equal(state.posts.at(-1).kind, "playback_identity_needed");
    assert.equal((await send("Diagnose playback.", { teamId: "TOTHER" })).accepted, false, "events from another Slack workspace are rejected before authority minting");
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    state.result = { intent: "media_diagnostic", confidence: 1, playbackDiagnostic: true, playbackTarget: "named", playbackUserQuery: "other-account" };
    await send("Compare <@USUBJECT> with account other-account playback history.");
    const authority = state.research[0].hooks.authorization;
    assert.deepEqual(authority.targets[0].queries, [{ query: "other-account" }]);
    assert.equal(authority.targets[0].subjectSlackId, null);
    assert.equal(playbackGrant(scoped, { ...authority, userId: "USUBJECT" }), null, "mentioning one member beside another account cannot grant the member that account");
    state.result.playbackUserQuery = "other";
    await send("Diagnose other-account playback history.");
    assert.notEqual(state.research.at(-1).hooks.authorization.targets[0]?.queries[0]?.query, "other", "partial account tokens invented by the classifier cannot select a named account");
    state.result.playbackUserQuery = "!!!";
    await send("Diagnose this user's playback history.");
    assert.notEqual(state.research.at(-1).hooks.authorization.targets[0]?.queries[0]?.query, "!!!", "an empty normalized target cannot match every request");
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    state.profile.email = "fixture@example.invalid";
    await send("Please diagnose this user's playback history.");
    const authority = state.research[0].hooks.authorization;
    assert.equal(authority.targets[0].subjectSlackId, "USUBJECT");
    assert.deepEqual(authority.targets[0].queries, [{ query: "fixture@example.invalid", matchBy: "email" }], "verified email must not fall back to an ambiguous display-name grant");
    assert.equal(playbackGrant(scoped, { ...authority, userId: "USUBJECT" }).resolvedUserId, "42");
    state.profile = null;
    await send("What explains the buffering?", { userId: "USUBJECT" });
    assert.equal(state.research.at(-1).hooks.authorization.mode, "self");
    assert.equal(state.research.at(-1).hooks.authorization.resolvedSelfId, "42");
    const count = state.research.length;
    await send("Diagnose that account's playback.", { userId: "USTRANGER" });
    await send("What explains the buffering?", { userId: "USUBJECT", threadTs: "200" });
    assert.equal(state.research.length, count, "neither another participant nor another thread inherits the diagnostic grant");
    state.result.playbackTarget = "named";
    state.result.playbackUserQuery = "another-account";
    await send("Check another-account playback.", { userId: "USUBJECT" });
    assert.equal(state.research.length, count, "a self grant cannot be widened to another named account");
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    await send("link playback <@USUBJECT> to fixture-account");
    const subjectItem = { teamId: "TTEAM", userId: "USUBJECT" };
    assert.equal(playbackBinding(scoped, subjectItem).resolvedUserId, "42");
    assert.deepEqual(state.resolutions[0], { query: "fixture-account", matchBy: "username" });
    state.profile = null;
    state.result.playbackTarget = "self";
    await send("Check my playback history.", { userId: "USUBJECT" });
    assert.equal(state.research.at(-1).hooks.authorization.resolvedSelfId, "42");
    await send("link playback <@USUBJECT> to someone-else", { userId: "USUBJECT" });
    assert.equal(playbackBinding(scoped, subjectItem).resolvedUserId, "42");
    assert.equal(state.resolutions.length, 1, "a spoofed display name cannot invoke owner linking");
    await send("unlink playback <@USUBJECT>");
    assert.equal(playbackBinding(scoped, subjectItem), null);
    const count = state.research.length;
    await send("Check my playback history.", { userId: "USUBJECT" });
    assert.equal(state.research.length, count);
  }

  {
    const { state, send } = await serviceFixture();
    state.profile.email = "verified@example.invalid";
    state.result.playbackTarget = "self";
    await send("Check my playback history.", { userId: "USUBJECT" });
    assert.equal(state.research[0].hooks.authorization.mode, "self");
    assert.deepEqual(state.resolutions[0], { query: "verified@example.invalid", matchBy: "email" });
    state.resolution = { status: "ambiguous", complete: true, candidates: [{ resolvedUserId: "42" }, { resolvedUserId: "43" }] };
    await send("Check my playback history.", { userId: "UOTHER" });
    assert.equal(state.research.length, 1, "ambiguous email matching cannot mint self authority");
    state.profile.email = null;
    await send("My email is verified@example.invalid; check my history.", { userId: "UOTHER" });
    assert.equal(state.research.length, 1, "a typed email is not verified identity evidence");
  }

  {
    const { state, config: scoped, service, send } = await serviceFixture();
    await send("Diagnose this user's playback history.", { drain: false });
    const authority = state.research[0].hooks.authorization;
    revokePlaybackGrant(scoped, { ...authority, userId: "UOWNER" });
    await service.sendPendingForTest();
    assert.deepEqual(state.posts.map(post => post.kind), ["media_check_started"], "revoke while the final answer waits in the durable queue suppresses delivery");
    assert.equal(sqliteExec(scoped.dbPath, "SELECT status FROM slack_outbox WHERE kind='authorized_research'", { json: true })[0].status, "cancelled");
    const stored = sqliteExec(scoped.dbPath, "SELECT value_json FROM settings WHERE key LIKE 'slack-playback-reply:%'", { json: true });
    assert.doesNotMatch(JSON.stringify(stored), /Fixture Account|Diagnose|targets|resolvedUserId/, "durable delivery guards contain no account queries or owner prose");
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    state.onClassification = async metadata => revokePlaybackGrant(scoped, { ...metadata, userId: "UOWNER" });
    await send("Diagnose this user's playback history.");
    assert.equal(state.research.length, 0, "a request revoked during classification cannot remint a fresh post-revoke capability from the same old event");
    assert.equal(state.posts.filter(post => post.kind === "authorized_research").length, 0);
  }

  for (const lookupNumber of [1, 2]) {
    const { state, config: scoped, send } = await serviceFixture();
    state.onProfile = async () => {
      if (state.profiles.length !== lookupNumber) return;
      const thread = sqliteExec(scoped.dbPath, "SELECT id FROM slack_threads WHERE root_ts='100'", { json: true })[0];
      revokePlaybackGrant(scoped, { userId: "UOWNER", teamId: "TTEAM", channelId: "CCHANNEL", threadId: thread.id });
    };
    await send("Diagnose this user's playback history.");
    assert.equal(state.research.length, 0, `revoke during profile lookup ${lookupNumber} invalidates the original event boundary`);
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    await send("link playback <@USUBJECT> to fixture-account");
    state.result.playbackTarget = "self";
    state.onClassification = async metadata => savePlaybackBinding(scoped, { ...metadata, userId: "UOWNER" }, "USUBJECT", "43");
    await send("Check my playback history.", { userId: "USUBJECT" });
    assert.equal(state.research.length, 0, "rebinding during classification invalidates the original event even before private authority is minted");
  }

  {
    const { state, send } = await serviceFixture();
    state.result = { intent: "unsupported", confidence: 1, shouldRespond: false, response: "No investigation was requested." };
    for (const text of ["Please don't investigate this user's history.", "Do not check the account history.", "What happens if you check user history?", "Hypothetically, investigate the account history?"]) {
      await send(text);
    }
    await send("We should investigate user history someday.", { directed: false });
    assert.equal(state.research.length, 0, "negation, hypotheticals and incidental owner discussion cannot trigger the affirmative-request fallback");
  }

  {
    const { state, config: scoped, send } = await serviceFixture();
    state.onModeration = async text => {
      if (text !== state.reply) return;
      const authority = state.research.at(-1).hooks.authorization;
      revokePlaybackGrant(scoped, { ...authority, userId: "UOWNER" });
    };
    await send("Diagnose this user's playback history.");
    assert.deepEqual(state.posts.map(post => post.kind), ["media_check_started"], "revocation during moderation is checked before queueing the final answer");
  }

  {
    const { state, config: scoped, service, send } = await serviceFixture();
    await send("link playback <@USUBJECT> to fixture-account");
    state.result.playbackTarget = "self";
    await send("Check my playback history.", { userId: "USUBJECT", drain: false });
    const authority = state.research[0].hooks.authorization;
    savePlaybackBinding(scoped, { ...authority, userId: "UOWNER" }, "USUBJECT", "43");
    await service.sendPendingForTest();
    assert.equal(state.posts.filter(post => post.kind === "authorized_research").length, 0, "rebinding while delivery is queued prevents posting evidence from the old account");
  }

  // Harassment-only retries are one bounded editorial pass, followed by fresh
  // moderation. They never bypass stronger categories or local secret checks.
  {
    const { state, config: scoped, service, send } = await serviceFixture();
    await send("Diagnose this user's playback history.");
    const authority = state.research[0].hooks.authorization;
    const item = { ...authority, userId: "UOWNER", rootTs: "100", text: "Explain the playback check.", userName: "Configured Owner" };
    const flagged = categories => ({ model: "fixture", flagged: true, categories, categoryScores: Object.fromEntries(Object.keys(categories).map(key => [key, 0.95])) });
    const initial = "The sarcastic draft has three affected playbacks.";
    const neutral = "Three affected playbacks used transcoding. The buffering cause remains unverified.";
    const mild = "The stream is taking its sweet time. Three affected playbacks used transcoding.";
    state.moderate = text => text === initial || text === mild ? flagged({ harassment: true }) : null;
    state.rewriteResult = { message: mild, mildBanter: true };
    const mildReply = await service.enqueueThreadReply(item, "conversation", "mild-rewrite", initial, { authorization: authority });
    assert.equal(mildReply.message, mild);
    assert.equal(state.rewritten.length, 1);
    assert.ok(state.rewritten[0].identities.includes("Fixture Account"));
    assert.equal(slackModerationDecisions(scoped.dbPath, 10).find(row => row.referenceKey === "mild-rewrite:rewrite").verdict, "allow");

    state.rewriteResult = { message: neutral, mildBanter: false };
    assert.equal((await service.enqueueThreadReply(item, "conversation", "neutral-rewrite", initial)).message, neutral);
    state.rewriteResult = { message: mild, mildBanter: false };
    assert.match((await service.enqueueThreadReply(item, "conversation", "unapproved-mild", initial)).message, /could not safely send/);
    assert.equal(state.rewritten.length, 3, "an unsuccessful rewrite cannot loop");

    for (const categories of [{ harassment: true, hate: true }, { "harassment/threatening": true }, { harassment: true, sexual: true }]) {
      state.moderate = () => flagged(categories);
      const count = state.rewritten.length;
      assert.match((await service.enqueueThreadReply(item, "conversation", `stronger-${count}-${Object.keys(categories).join()}`, initial)).message, /could not safely send/);
      assert.equal(state.rewritten.length, count, "a broader category never reaches the mild-banter rewrite exception");
    }
    state.moderate = text => text === initial ? flagged({ harassment: true }) : flagged({ harassment: true, hate: true });
    state.rewriteResult = { message: mild, mildBanter: true };
    assert.match((await service.enqueueThreadReply(item, "conversation", "rewrite-new-category", initial)).message, /could not safely send/);
    const beforeSecret = state.rewritten.length;
    assert.match((await service.enqueueThreadReply(item, "conversation", "secret-no-rewrite", "api_key=sk-private-draft-fixture")).message, /could not safely send/);
    assert.equal(state.rewritten.length, beforeSecret);
    state.rewriteResult = { message: "api_key=sk-private-rewrite-fixture", mildBanter: true };
    assert.match((await service.enqueueThreadReply(item, "conversation", "rewrite-secret", initial)).message, /could not safely send/);
    state.rewriteError = true;
    assert.match((await service.enqueueThreadReply(item, "conversation", "rewrite-error", initial)).message, /could not safely send/);
  }
  console.log("Slack owner diagnostics integration tests passed");
} finally {
  Date.now = originalNow;
  await rm(root, { recursive: true, force: true });
}
