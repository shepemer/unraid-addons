import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import {
  archiveSlackInbound, claimSlackInbound, completeSlackInbound, createSlackIssue,
  createAgentRun, completeAgentRun, recoverInterruptedAgentRuns, recordAudit,
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
  assert.match(posts[0][3], /^\*Investigation complete\*\n\n\*Findings\*\n• Missing episodes/);
  assert.match(posts[0][3], /\n\n\*Proposed work\*\n• Inspect monitoring\n• Verify result/);
  assert.ok(posts[0][3].length < 1000, "the investigation handoff stays concise");
  assert.doesNotMatch(posts[0][3], /Current read-only checks|\.\./);
  assert.match(posts[0][3], /approve repair/);
  assert.doesNotMatch(posts[0][3], /PRIVATE|private\/path/);
  assert.equal(diagnosticContexts.length, 0, "publishing a completed investigation must not start a second research run");
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

  // The failure producer and the Slack command worker must converge on one
  // explanation, even while asynchronous outbound moderation is in flight.
  const beforeFailure = posts.length;
  const failedRun = createAgentRun(config.dbPath, job.id, "repair", "fixture", {});
  completeAgentRun(config.dbPath, failedRun.id, "failed_retryable", null, "Sonarr request timed out");
  agent.startSlackControlWork(job.id, async () => agent.recordRepairFailureForOperatorReview(
    job.id, "fixture", "Sonarr request timed out", { agentRunId: failedRun.id,
      repairResult: { status: "failed_retryable", summary: "Sonarr request timed out", actionsTaken: [], verification: { status: "failed" } } }
  ));
  await agent.slackControlRuns.get(job.id);
  await agent.publishSlackRepairFailure(job.id);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(posts.length, beforeFailure + 1, "one failure notification across producer, worker, and poll");
  assert.equal(posts.at(-1)[1], "repair_needs_review");
  assert.equal(posts.at(-1)[4].notifyOwners, true);
  assert.match(posts.at(-1)[3], /timed out|time limit/i);
  assert.match(posts.at(-1)[3], /retry repair/);
  assert.doesNotMatch(posts.at(-1)[3], /owner_control_completed|PRIVATE|private\/path/);

  // A retry can fail during preparation, before a new run row exists. It still
  // needs a new notification, not the old run's deduplication key.
  agent.recordRepairFailureForOperatorReview(job.id, "fixture", "Media service unavailable");
  await agent.publishSlackRepairFailure(job.id);
  assert.equal(posts.length, beforeFailure + 2);
  assert.match(posts.at(-1)[3], /could not be reached/i);
  await agent.publishSlackRepairFailure(job.id);
  assert.equal(posts.length, beforeFailure + 2);

  // Steering and re-investigation already acknowledge that work was queued.
  // Their automatic worker must not emit a second generic checking response.
  const startCount = () => sqliteExec(config.dbPath, "SELECT COUNT(*) AS count FROM slack_outbox WHERE kind = 'investigation_started';", { json: true })[0].count;
  const starts = startCount();
  for (const action of ["steer", "reinvestigate"]) {
    const acknowledgment = await agent.handleSlackIssueControl(issue.id, {
      action, message: action === "steer" ? "Check only the affected season" : "re-investigate",
      userId: "UOWNER", eventId: `ack-${action}`, threadId: issue.threadId
    });
    assert.match(acknowledgment.message, /queued.*investigation/);
    agent.scheduleSlackInvestigations();
    await agent.slackInvestigationPromise;
    assert.equal(startCount(), starts, "one acknowledgment before findings");
    assert.equal(getSetting(config.dbPath, `slack-investigation-announced:${job.id}`, false), false);
  }

  // A crash during read-only investigation is recoverable; approvals stay gated.
  transitionJob(config.dbPath, job.id, ["awaiting_action_approval"], "investigating");
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

  // Recovery has no producer process left to publish. Polling must announce a
  // first interrupted repair even though no previousRepairFailure was saved.
  const recoveryInbound = archiveSlackInbound(config.dbPath, event("event6", "600", "Season missing"));
  completeSlackInbound(config.dbPath, "event6");
  const recoveryIssue = createSlackIssue(config.dbPath, recoveryInbound.threadId, { mediaTitle: "Recovery fixture", description: "Season missing", confidence: 1 });
  const recoveryJob = ensureJob(config.dbPath, "slack", String(recoveryIssue.id));
  upsertInvestigation(config.dbPath, recoveryJob.id, { status: "ready", summary: "Missing episodes", evidence: {} });
  transitionJob(config.dbPath, recoveryJob.id, ["detected"], "executing");
  const firstInterrupted = createAgentRun(config.dbPath, recoveryJob.id, "repair", "fixture", {});
  sqliteExec(config.dbPath, `UPDATE agent_runs SET owner_pid = 999999 WHERE id = ${firstInterrupted.id};`);
  assert.equal(recoverInterruptedAgentRuns(config.dbPath), 1);
  const recoveryPosts = () => posts.filter(post => post[0].slackIssueId === recoveryIssue.id && post[1] === "repair_needs_review");
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(recoveryPosts().length, 1);
  assert.match(recoveryPosts()[0][3], /process was interrupted/);
  assert.equal(recoveryPosts()[0][2], `slack-repair-failure-published:${recoveryJob.id}:${firstInterrupted.id}`);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(recoveryPosts().length, 1);

  // Evidence from an already-published failure must not hide interruption of a
  // newer retry, even though that evidence survives in the investigation.
  agent.recordRepairFailureForOperatorReview(recoveryJob.id, "fixture", "Original timeout", { agentRunId: firstInterrupted.id });
  await agent.publishSlackRepairFailure(recoveryJob.id);
  assert.equal(recoveryPosts().length, 1);
  transitionJob(config.dbPath, recoveryJob.id, ["failed_retryable"], "executing");
  const secondInterrupted = createAgentRun(config.dbPath, recoveryJob.id, "repair", "fixture", {});
  sqliteExec(config.dbPath, `UPDATE agent_runs SET owner_pid = 999999 WHERE id = ${secondInterrupted.id};`);
  assert.equal(recoverInterruptedAgentRuns(config.dbPath), 1);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(recoveryPosts().length, 2);
  assert.equal(recoveryPosts()[1][2], `slack-repair-failure-published:${recoveryJob.id}:${secondInterrupted.id}`);
  assert.match(recoveryPosts()[1][3], /process was interrupted/);
  await agent.publishSlackRepairFailure(recoveryJob.id);
  assert.equal(recoveryPosts().length, 2);

  // A genuinely newer preparation failure has no run. Its returnedAt remains
  // the identity, including equal-millisecond run/failure timestamps.
  agent.recordRepairFailureForOperatorReview(recoveryJob.id, "fixture", "Media service unavailable");
  await agent.publishSlackRepairFailure(recoveryJob.id);
  assert.equal(recoveryPosts().length, 3);
  const savedFailure = agent.jobDetails(recoveryJob.id).investigation.evidence.previousRepairFailure;
  assert.equal(recoveryPosts()[2][2], `slack-repair-failure-published:${recoveryJob.id}:${savedFailure.returnedAt}`);
  assert.match(recoveryPosts()[2][3], /could not be reached/);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(recoveryPosts().length, 3);

  // Closing/reopening/result-delivery failures have their own publication.
  // Stale repair evidence must not create an additional repair-failed notice.
  recordAudit(config.dbPath, "issue_close_failed", { error: "Delivery failed" }, recoveryJob.id);
  await agent.publishSlackRepairFailure(recoveryJob.id);
  agent.scheduleSlackInvestigations();
  await agent.slackInvestigationPromise;
  assert.equal(recoveryPosts().length, 3);
  console.log("media-issue-agent Slack workflow tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
