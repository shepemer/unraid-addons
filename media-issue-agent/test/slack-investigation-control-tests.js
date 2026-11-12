import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import {
  applySlackIssueEvidenceMessage, archiveSlackInbound, completeSlackInbound,
  createSlackIssue, enqueueSlackOutbox, ensureJob, getSetting, insertSnapshot,
  investigationForJob, jobForId, listSlackIssueRecords, pendingApprovalForJobAnyKind,
  setSetting, setSlackIssueStatus, slackIssueForId, slackQueueStatus,
  transitionJob, transitionJobAndCreateApproval, upsertInvestigation
} from "../src/db.js";
import { normalizeIssue } from "../src/issues.js";
import { SlackService } from "../src/slack.js";
import { createCodexHome } from "./helpers.js";

const root = await mkdtemp(path.join(os.tmpdir(), "slack-investigation-control-"));
let sequence = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return;
    await pause(2);
  }
  throw new Error("Timed out waiting for test activity");
}
async function fixture(options = {}) {
  const id = ++sequence;
  const config = {
    dbPath: path.join(root, `state-${id}.sqlite`), logPath: path.join(root, `agent-${id}.log`),
    codexHome: await createCodexHome(path.join(root, `fixture-${id}`)), codexModel: "fixture",
    codexWorkspace: path.join(root, `workspace-${id}`), codexTerminationGraceMs: 100,
    slackEnabled: true, slackOwnerUserIds: ["UOWNER"], suppressInitLog: true,
    issueSnapshotRetention: 20, recoverStaleRunSeconds: 120, ...options.config
  };
  const posts = [];
  const polls = [];
  let modelCalls = 0;
  const agent = new MediaIssueAgent(config, options.client || { async callTool() { return { missingEpisodes: 2 }; } }, {
    slackService: { async enqueueThreadReply(...args) { if (!args[4]?.shouldEnqueue || args[4].shouldEnqueue()) posts.push(args); } },
    slackPlanSummaryRunner: options.summaryRunner || (async () => ({ findings: ["Two episodes are missing."], actions: ["Inspect the affected downloads."] })),
    ...(options.realCodex ? {} : { investigationRunner: async (...args) => {
      modelCalls++;
      return options.runner ? options.runner(...args) : "Two episodes are missing; inspect their downloads before any repair.";
    } })
  });
  await agent.init();
  agent.scheduleSlackPoll = (...args) => polls.push(args);
  const inbound = archiveSlackInbound(config.dbPath, {
    eventId: `root-${id}`, eventType: "message", messageKey: `root-${id}`, teamId: "TTEAM", channelId: "CISSUES",
    rootTs: "100", messageTs: "100", userId: "UREPORTER", text: "Season five has missing episodes"
  });
  completeSlackInbound(config.dbPath, `root-${id}`);
  const issue = createSlackIssue(config.dbPath, inbound.threadId, { mediaTitle: "Fixture", description: "Season five has missing episodes", confidence: 1 });
  const job = ensureJob(config.dbPath, "slack", String(issue.id));
  const snapshot = insertSnapshot(config.dbPath, "fixture", listSlackIssueRecords(config.dbPath).map(normalizeIssue));
  let controlId = 0;
  const control = (action, extra = {}) => agent.handleSlackIssueControl(issue.id, {
    action, message: action === "reinvestigate" ? "re-investigate" : action, userId: "UOWNER",
    eventId: `control-${id}-${++controlId}`, threadId: issue.threadId, ...extra
  });
  return { agent, config, issue, job, snapshot, posts, polls, control, modelCalls: () => modelCalls };
}

try {
  // A queued investigation is stopped durably, including after a process restart.
  const queued = await fixture();
  for (const kind of ["investigation_started", "investigation_ready", "investigation_failed", "repair_result_ready"]) {
    enqueueSlackOutbox(queued.config.dbPath, { slackIssueId: queued.issue.id, threadId: queued.issue.threadId,
      channelId: "CISSUES", threadTs: "100", kind, dedupeKey: kind, message: kind });
  }
  assert.match((await queued.control("stop_investigation", { userId: "UOTHER" })).message, /Only a configured/);
  assert.equal(queued.agent.isSlackInvestigationPaused(queued.job.id), false);
  const stopEvent = { eventId: "durable-stop" };
  const stopped = await queued.control("stop_investigation", stopEvent);
  assert.match(stopped.message, /Investigation stopped/);
  assert.equal(jobForId(queued.config.dbPath, queued.job.id).state, "blocked_needs_human");
  assert.equal(investigationForJob(queued.config.dbPath, queued.job.id).status, "paused");
  assert.equal(slackQueueStatus(queued.config.dbPath).outbound.pending, 1, "only investigation notifications are cancelled");
  assert.deepEqual(await queued.control("stop_investigation", stopEvent), stopped, "redelivery is idempotent");
  queued.agent.scheduleSlackInvestigations();
  await queued.agent.slackInvestigationPromise;
  assert.equal(queued.modelCalls(), 0);
  const restarted = new MediaIssueAgent(queued.config, { callTool() { throw new Error("Paused issue must not call MCP"); } }, { slackService: { async enqueueThreadReply() {} } });
  await restarted.init();
  restarted.scheduleSlackInvestigations();
  await restarted.slackInvestigationPromise;
  assert.equal(restarted.isSlackInvestigationPaused(queued.job.id), true);
  assert.match((await restarted.slackIssueStatus(queued.issue.id)).message, /Investigation is paused/);
  assert.match((await queued.control("steer", { message: "Check only season five" })).message, /remains paused/);
  assert.equal(queued.polls.length, 0, "steering alone does not resume an explicitly paused investigation");
  await queued.control("reinvestigate");
  queued.agent.scheduleSlackInvestigations();
  await queued.agent.slackInvestigationPromise;
  assert.equal(queued.modelCalls(), 1);
  assert.equal(jobForId(queued.config.dbPath, queued.job.id).state, "awaiting_action_approval");

  // Stop propagates to the actual MCP request, never becomes a failure notice,
  // and cannot progress to Codex or create an approval after the request aborts.
  let diagnosticSignal;
  const collecting = await fixture({ client: { async callTool(_name, _args, options) {
    diagnosticSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } } });
  const collection = collecting.agent.investigate(collecting.snapshot.id, 1, { force: true });
  await until(() => diagnosticSignal);
  assert.match((await collecting.control("stop_investigation")).message, /Investigation stopped/);
  assert.equal(diagnosticSignal.aborted, true);
  assert.equal((await collection).status, "paused");
  assert.equal(collecting.modelCalls(), 0);
  assert.equal(pendingApprovalForJobAnyKind(collecting.config.dbPath, collecting.job.id), null);
  assert.equal(collecting.posts.length, 0);
  assert.equal(slackQueueStatus(collecting.config.dbPath).outbound.pending, 0);

  // An uncooperative old worker may return after cancellation. An immediate
  // owner restart waits for it, then starts a new generation without old results.
  let releaseOld;
  let oldSignal;
  let runs = 0;
  const racing = await fixture({ runner: async (_config, _prompt, hooks) => {
    if (++runs > 1) return "Fresh investigation of the requested season.";
    oldSignal = hooks.abortSignal;
    return new Promise(resolve => { releaseOld = resolve; });
  } });
  const oldWork = racing.agent.investigate(racing.snapshot.id, 1, { force: true });
  await until(() => releaseOld);
  const stopping = racing.control("stop_investigation");
  await until(() => oldSignal.aborted);
  const resume = await racing.control("reinvestigate");
  assert.match(resume.message, /after the previous investigation finishes stopping/);
  assert.equal(racing.agent.isSlackInvestigationPaused(racing.job.id), true, "resume does not clear the old worker's pause prematurely");
  releaseOld("STALE RESULT MUST NEVER CREATE APPROVAL");
  assert.equal((await oldWork).status, "paused");
  await stopping;
  assert.equal(racing.posts.length, 0);
  assert.equal(pendingApprovalForJobAnyKind(racing.config.dbPath, racing.job.id), null);
  assert.equal(jobForId(racing.config.dbPath, racing.job.id).state, "detected");
  racing.agent.scheduleSlackInvestigations();
  await racing.agent.slackInvestigationPromise;
  assert.equal(runs, 2);
  assert.doesNotMatch(investigationForJob(racing.config.dbPath, racing.job.id).summary, /STALE/);
  assert.equal(racing.posts.length, 1);

  // Approval creation can precede public-summary generation. Stopping there
  // must supersede that generation, and resume must not republish the old plan.
  let releaseSummary;
  let summaryCalls = 0;
  const publishing = await fixture({ summaryRunner: async () => {
    if (++summaryCalls > 1) return { findings: ["Fresh findings"], actions: ["Fresh plan"] };
    return new Promise(resolve => { releaseSummary = resolve; });
  } });
  const publishingWork = publishing.agent.investigate(publishing.snapshot.id, 1, { force: true });
  await until(() => releaseSummary);
  assert.equal(jobForId(publishing.config.dbPath, publishing.job.id).state, "awaiting_action_approval");
  const publishingStop = publishing.control("stop_investigation");
  await until(() => publishing.agent.isSlackInvestigationPaused(publishing.job.id));
  await publishing.control("reinvestigate", { message: "reinvestigate, focus on season five" });
  releaseSummary({ findings: ["OLD SUMMARY"], actions: ["OLD PLAN"] });
  assert.equal((await publishingWork).status, "paused");
  await publishingStop;
  assert.equal(pendingApprovalForJobAnyKind(publishing.config.dbPath, publishing.job.id), null);
  assert.equal(jobForId(publishing.config.dbPath, publishing.job.id).state, "detected");
  assert.equal(publishing.posts.length, 0);
  assert.match(getSetting(publishing.config.dbPath, `slack-owner-guidance:${publishing.job.id}`)[0].message, /focus on season five/);
  publishing.agent.scheduleSlackInvestigations();
  await publishing.agent.slackInvestigationPromise;
  assert.equal(publishing.modelCalls(), 2);
  assert.equal(publishing.posts.length, 1);
  assert.doesNotMatch(publishing.posts[0][3], /OLD/);

  // Outbound moderation is asynchronous too. A stopped generation must be
  // checked again after moderation before it becomes a durable outgoing notice.
  let releaseModeration;
  const moderating = await fixture();
  const service = new SlackService(moderating.agent, moderating.config, {
    transport: {}, moderationClient: { async moderate() {
      return new Promise(resolve => { releaseModeration = resolve; });
    } }
  });
  const notice = service.enqueueThreadReply({ slackIssueId: moderating.issue.id, threadId: moderating.issue.threadId, channelId: "CISSUES", rootTs: "100" },
    "investigation_ready", "moderation-race", "The investigation is complete.",
    { shouldEnqueue: () => !moderating.agent.isSlackInvestigationPaused(moderating.job.id) });
  await until(() => releaseModeration);
  await moderating.control("stop_investigation");
  releaseModeration({ model: "fixture", categories: {}, categoryScores: {}, flagged: false });
  assert.equal(await notice, null);
  assert.equal(slackQueueStatus(moderating.config.dbPath).outbound.pending, 0);

  // If the process dies after accepting resume, that explicit request survives.
  const resumeRecovery = await fixture();
  await resumeRecovery.control("stop_investigation");
  setSetting(resumeRecovery.config.dbPath, `slack-investigation-resume:${resumeRecovery.job.id}`, { eventId: "persisted-owner-resume" });
  resumeRecovery.agent.scheduleSlackInvestigations();
  await resumeRecovery.agent.slackInvestigationPromise;
  assert.equal(resumeRecovery.modelCalls(), 1);
  assert.equal(resumeRecovery.agent.isSlackInvestigationPaused(resumeRecovery.job.id), false);

  // Even genuine new evidence is passive: it neither reopens a closed issue nor
  // invalidates/queues a completed plan. An explicit approval still checks it.
  const passive = await fixture();
  upsertInvestigation(passive.config.dbPath, passive.job.id, { status: "ready", summary: "Original plan", evidence: { slackEvidenceVersion: 1 } });
  transitionJobAndCreateApproval(passive.config.dbPath, passive.job.id, ["detected"], "awaiting_action_approval", "action", {});
  const approval = pendingApprovalForJobAnyKind(passive.config.dbPath, passive.job.id);
  const followup = archiveSlackInbound(passive.config.dbPath, { eventId: "new-evidence", eventType: "message", messageKey: "new-evidence", teamId: "TTEAM", channelId: "CISSUES", rootTs: "100", messageTs: "101", userId: "UREPORTER", text: "It also fails on another player." });
  const applied = applySlackIssueEvidenceMessage(passive.config.dbPath, passive.issue.id, followup.messageId);
  await passive.agent.onSlackIssueEvidenceUpdated(applied.issue, { evidenceApplied: true });
  assert.equal(pendingApprovalForJobAnyKind(passive.config.dbPath, passive.job.id).id, approval.id);
  assert.equal(passive.polls.length, 0);

  const closing = await fixture();
  upsertInvestigation(closing.config.dbPath, closing.job.id, { status: "ready", summary: "Verified repair", evidence: { slackEvidenceVersion: 1 } });
  const resolution = transitionJobAndCreateApproval(closing.config.dbPath, closing.job.id, ["detected"], "awaiting_resolution_approval", "resolution", {
    source: "slack", issueId: String(closing.issue.id), message: "Repair verified.", closeIssue: true, slackEvidenceVersion: 1
  }).approval;
  const originalExecute = closing.agent.executeIssueAction.bind(closing.agent);
  let injected = false;
  closing.agent.executeIssueAction = async (...args) => {
    const result = await originalExecute(...args);
    if (!injected) {
      injected = true;
      const inbound = archiveSlackInbound(closing.config.dbPath, { eventId: "closure-evidence", eventType: "message", messageKey: "closure-evidence", teamId: "TTEAM", channelId: "CISSUES", rootTs: "100", messageTs: "102", userId: "UREPORTER", text: "Another player also failed." });
      const update = applySlackIssueEvidenceMessage(closing.config.dbPath, closing.issue.id, inbound.messageId);
      await closing.agent.onSlackIssueEvidenceUpdated(update.issue);
    }
    return result;
  };
  const closed = await closing.agent.closeApprovedIssue(closing.job.id, resolution, "slack:UOWNER");
  assert.equal(closed.status, "closed");
  assert.equal(closed.newEvidenceAwaitingOwner, true);
  assert.equal(slackIssueForId(closing.config.dbPath, closing.issue.id).status, "closed");
  assert.equal(jobForId(closing.config.dbPath, closing.job.id).state, "closed");
  assert.equal(closing.modelCalls(), 0);
  assert.equal(closing.polls.length, 0, "evidence during approved closure never queues a new investigation");
  transitionJob(passive.config.dbPath, passive.job.id, ["awaiting_action_approval"], "closed");
  setSlackIssueStatus(passive.config.dbPath, passive.issue.id, "closed");
  await passive.agent.onSlackIssueEvidenceUpdated(slackIssueForId(passive.config.dbPath, passive.issue.id));
  assert.equal(slackIssueForId(passive.config.dbPath, passive.issue.id).status, "closed");
  assert.equal(jobForId(passive.config.dbPath, passive.job.id).state, "closed");
  assert.equal(passive.polls.length, 0);

  // Stopping investigation cannot silently abort or rewind an approved repair.
  const repair = await fixture();
  transitionJob(repair.config.dbPath, repair.job.id, ["detected"], "executing");
  const repairController = new AbortController();
  repair.agent.activeRepairRuns.set(repair.job.id, { controller: repairController });
  assert.match((await repair.control("stop_investigation")).message, /repair workflow is still active/);
  assert.equal(repairController.signal.aborted, false);
  assert.equal(jobForId(repair.config.dbPath, repair.job.id).state, "executing");

  // Exercise the production Codex process termination path, not just a mock.
  const pidPath = path.join(root, "investigation.pid");
  const codexBin = path.join(root, "hanging-codex.mjs");
  await writeFile(codexBin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
  await chmod(codexBin, 0o755);
  const child = await fixture({ realCodex: true, config: { codexBin, codexTimeoutMs: 60000 } });
  const childWork = child.agent.investigate(child.snapshot.id, 1, { force: true });
  await until(async () => { try { return Boolean(await readFile(pidPath, "utf8")); } catch { return false; } });
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.match((await child.control("stop_investigation")).message, /Investigation stopped/);
  assert.equal((await childWork).status, "paused");
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(pendingApprovalForJobAnyKind(child.config.dbPath, child.job.id), null);
  assert.equal(child.posts.length, 0);
  console.log("Slack investigation control tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
