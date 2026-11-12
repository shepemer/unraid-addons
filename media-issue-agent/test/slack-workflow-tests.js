import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import {
  archiveSlackInbound, claimSlackInbound, completeSlackInbound, createSlackIssue,
  createAgentRun, recoverInterruptedAgentRuns,
  ensureJob, getSetting, insertSnapshot, jobForId, listSlackIssueRecords,
  pendingApprovalForJobAnyKind, recoverSlackInvestigations, slackIssueForId,
  transitionJob, transitionJobAndCreateApproval, transitionJobAndResolveApproval,
  upsertInvestigation
} from "../src/db.js";
import { normalizeIssue } from "../src/issues.js";
import { createCodexHome } from "./helpers.js";
import { sqliteExec } from "../src/sqlite.js";

const root = await mkdtemp(path.join(os.tmpdir(), "slack-workflow-test-"));
try {
  const posts = [];
  const diagnosticContexts = [];
  const config = {
    dbPath: path.join(root, "state.sqlite"), logPath: path.join(root, "agent.log"),
    codexHome: await createCodexHome(root), codexModel: "fixture-model",
    slackEnabled: true, slackOwnerUserIds: ["UOWNER"], suppressInitLog: true,
    issueSnapshotRetention: 20, recoverStaleRunSeconds: 120
  };
  const agent = new MediaIssueAgent(config, { callTool() { throw new Error("Unexpected upstream call"); } }, {
    slackService: { async enqueueThreadReply(...args) { posts.push(args); } },
    slackPlanSummaryRunner: async () => ({ findings: ["Missing episodes"], actions: ["Inspect monitoring", "Verify result"], approvalScope: "Approval authorizes media-side repairs for this issue, followed by verification." }),
    slackDiagnosticRunner: async (_config, context) => {
      diagnosticContexts.push(context);
      return { completion: "complete", facts: [{ tool: "media_public_title_diagnostics", result: { missingEpisodes: 5 } }] };
    },
    slackReplyRunner: async () => "The requested season has five missing episodes and no matching download. Check monitoring before searching for a replacement."
  });
  await agent.init();
  const event = (id, thread, text, user = "UREPORTER") => ({
    eventId: id, eventType: "message", messageKey: id, teamId: "TTEAM", channelId: "CISSUES",
    rootTs: thread, messageTs: `${Number(thread) + Number(id.replace(/\D/g, "") || 0) / 100}`, userId: user, text
  });
  const first = archiveSlackInbound(config.dbPath, event("event1", "100", "Season 5 is not downloading"));
  completeSlackInbound(config.dbPath, "event1");
  const issue = createSlackIssue(config.dbPath, first.threadId, { mediaTitle: "The Great Escape", description: "Season 5 is not downloading", confidence: 1 });
  const job = ensureJob(config.dbPath, "slack", String(issue.id));
  insertSnapshot(config.dbPath, "fixture", listSlackIssueRecords(config.dbPath).map(normalizeIssue));

  // A pre-existing, uninvestigated issue is picked up without a new Slack event.
  let investigations = 0;
  agent.investigate = async () => {
    investigations += 1;
    transitionJob(config.dbPath, job.id, ["detected", "queued_for_investigation"], "investigating");
    upsertInvestigation(config.dbPath, job.id, { status: "ready", summary: "PRIVATE user watched item from /private/path", evidence: {} });
    transitionJobAndCreateApproval(config.dbPath, job.id, ["investigating"], "awaiting_action_approval", "action", { plan: { classification: "server_action" } });
  };
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(investigations, 1);
  assert.equal(jobForId(config.dbPath, job.id).state, "awaiting_action_approval");
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0].rootTs, "100");
  assert.equal(posts[0][4].notifyOwners, true);
  assert.match(posts[0][3], /five missing episodes/);
  assert.match(posts[0][3], /approve repair/);
  assert.doesNotMatch(posts[0][3], /PRIVATE|private\/path/);
  assert.equal(diagnosticContexts[0].issue.mediaTitle, "The Great Escape");
  assert.match(diagnosticContexts[0].issue.description, /Season 5/);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(posts.length, 1, "polls must not repeat owner notifications");

  const version = slackIssueForId(config.dbPath, issue.id).evidenceVersion;
  assert.match((await agent.slackIssueStatus(issue.id)).message, /awaiting owner approval/);
  assert.equal(slackIssueForId(config.dbPath, issue.id).evidenceVersion, version);
  const control = { action: "approve_repair", userId: "UOWNER", eventId: "approval1", threadId: issue.threadId };
  assert.match((await agent.handleSlackIssueControl(issue.id, { ...control, userId: "UIMPOSTOR" })).message, /Only a configured/);
  assert.match((await agent.handleSlackIssueControl(issue.id, { ...control, threadId: 999 })).message, /own thread/);

  // Run repair in the background so the same thread can accept status/steering.
  let approvals = 0;
  let releaseRepair;
  const repairGate = new Promise(resolve => { releaseRepair = resolve; });
  agent.approve = async (_id, _actor, options) => {
    approvals += 1;
    const pending = pendingApprovalForJobAnyKind(config.dbPath, job.id);
    assert.equal(options.expectedApprovalId, pending.id);
    transitionJobAndResolveApproval(config.dbPath, job.id, pending.id, ["awaiting_action_approval"], "approved_for_execution", "approved", "fixture");
    await repairGate;
    transitionJobAndCreateApproval(config.dbPath, job.id, ["approved_for_execution"], "awaiting_resolution_approval", "resolution", {});
  };
  await agent.handleSlackIssueControl(issue.id, control);
  await Promise.resolve();
  assert.equal(approvals, 1);
  assert.match((await agent.slackIssueStatus(issue.id)).message, /approved.*queued/);
  await agent.handleSlackIssueControl(issue.id, control);
  assert.equal(approvals, 1);

  const steering = archiveSlackInbound(config.dbPath, event("event2", "100", "steer: only season 5", "UOWNER"));
  agent.scheduleSlackPoll = () => {};
  const steeringResponse = await agent.handleSlackIssueControl(issue.id, {
    action: "steer", message: "Only season 5", userId: "UOWNER", eventId: "event2", threadId: issue.threadId, messageId: steering.messageId
  });
  assert.match(steeringResponse.message, /saved your steering/);
  assert.equal(getSetting(config.dbPath, `slack-owner-guidance:${job.id}`)[0].message, "Only season 5");
  assert.equal(slackIssueForId(config.dbPath, issue.id).evidenceVersion, version + 1);
  releaseRepair();
  await agent.slackControlRuns.get(job.id);
  await agent.handleSlackIssueControl(issue.id, control);
  assert.equal(approvals, 1, "redelivery must not approve final resolution");
  assert.equal(pendingApprovalForJobAnyKind(config.dbPath, job.id).kind, "resolution");
  await agent.publishSlackResolution(job.id);
  assert.equal(posts.length, 2);
  assert.equal(posts[1][4].notifyOwners, true);
  assert.match(posts[1][3], /approve resolution/);
  assert.match(posts[1][3], /close the issue/);
  await agent.publishSlackResolution(job.id);
  assert.equal(posts.length, 2, "final review notifications are also deduplicated");

  // A crash during read-only investigation is recoverable; approvals stay gated.
  transitionJob(config.dbPath, job.id, ["awaiting_resolution_approval"], "investigating");
  recoverSlackInvestigations(config.dbPath);
  assert.equal(jobForId(config.dbPath, job.id).state, "queued_for_investigation");

  // Same-thread events are serialized, but another thread can keep chatting.
  completeSlackInbound(config.dbPath, "event2");
  archiveSlackInbound(config.dbPath, event("event3", "100", "check it"));
  archiveSlackInbound(config.dbPath, event("event4", "100", "any update?"));
  archiveSlackInbound(config.dbPath, event("event5", "200", "another title"));
  const claimed = claimSlackInbound(config.dbPath);
  assert.equal(claimed.eventId, "event3");
  assert.equal(claimSlackInbound(config.dbPath).eventId, "event5");
  assert.equal(claimSlackInbound(config.dbPath), null);
  completeSlackInbound(config.dbPath, "event3");
  assert.equal(claimSlackInbound(config.dbPath).eventId, "event4");

  const interrupted = ensureJob(config.dbPath, "slack", "9999");
  transitionJob(config.dbPath, interrupted.id, ["detected"], "executing");
  const run = createAgentRun(config.dbPath, interrupted.id, "repair", "fixture", {});
  sqliteExec(config.dbPath, `UPDATE agent_runs SET owner_pid = 999999 WHERE id = ${run.id};`);
  assert.equal(recoverInterruptedAgentRuns(config.dbPath), 1, "fresh dead-process runs must recover immediately");
  assert.equal(jobForId(config.dbPath, interrupted.id).state, "failed_retryable");
  console.log("media-issue-agent Slack workflow tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
