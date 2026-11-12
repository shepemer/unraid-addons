import assert from "node:assert/strict";
import { publicSlackResolution } from "../src/slack-resolution.js";

const pending = (executionResult, closeIssue = true) => ({
  id: 9, kind: "resolution", status: "pending",
  payload: { closeIssue, message: "PRIVATE final comment by Sally on /private/path", executionResult }
});
const fixed = {
  outcome: "fixed", summary: "PRIVATE user watched a title on plex.local",
  actionsExecuted: 3,
  actions: [
    { status: "completed_by_codex", index: 1, summary: "Deleted /mnt/user/media/private.mkv reported by Sally." },
    { status: "completed_by_codex", index: 2, summary: "Imported replacement from https://private.example/download using api_key=secret" },
    { status: "completed_by_codex", index: 3, summary: "Verified playback for <@UPRIVATE> on 10.0.0.1" }
  ],
  verification: { status: "passed", details: "PRIVATE watch history for Sally" },
  draftComment: "Sally watched a private movie.", closeRecommended: true,
  agentRunId: 12345, modelConfig: { credentials: "SECRET" }
};
const message = publicSlackResolution({ approvals: [pending(fixed)] });
assert.match(message, /reports the issue fixed/);
assert.match(message, /3 completed steps were recorded/);
assert.match(message, /media or queue cleanup, library import, inspection and verification/);
assert.match(message, /Verification passed/);
assert.match(message, /close the issue/);
assert.doesNotMatch(message, /PRIVATE|Sally|private|api_key|secret|10\.0\.0\.1|UPRIVATE|12345|SECRET/);

const clientSide = publicSlackResolution({ approvals: [pending({
  outcome: "client_side", actionsExecuted: 0, actions: [], verification: { status: "not_applicable" }
})] });
assert.match(clientSide, /no server-side repair was needed/);
assert.match(clientSide, /0 completed steps/);
assert.match(clientSide, /not applicable/);

const partial = publicSlackResolution({ approvals: [pending({ ...fixed, outcome: "partially_fixed" }, false)] });
assert.match(partial, /partially fixed/);
assert.match(partial, /keep the issue open/);
assert.doesNotMatch(partial, /close the issue/);

const untrusted = publicSlackResolution({ approvals: [pending({
  outcome: "__proto__", actionsExecuted: "Sally", verification: { status: "PRIVATE" },
  actions: [
    { status: "completed_by_codex", summary: "Did not delete any files." },
    { status: "completed_by_codex", summary: "Deleted no files." },
    { status: "completed_by_codex", summary: "Would refresh metadata." },
    { status: "pending", summary: "Deleted files." },
    { status: "completed_by_codex", summary: { private: "data" } }
  ]
})] });
assert.match(untrusted, /outcome is not available/);
assert.match(untrusted, /Verification status is unavailable/);
assert.doesNotMatch(untrusted, /Recorded step categories|Sally|PRIVATE|__proto__|cleanup/);

assert.equal(publicSlackResolution(), "There is no repair result awaiting final review.");
assert.equal(publicSlackResolution({ approvals: [pending(fixed), { ...pending(fixed), id: 10, status: "superseded" }] }), message);
assert.equal(publicSlackResolution({ approvals: [{ ...pending(fixed), status: "approved" }] }), "There is no repair result awaiting final review.");
for (const actionsExecuted of [-1, Number.NaN, Infinity, 1.5, 10001]) {
  assert.doesNotMatch(publicSlackResolution({ approvals: [pending({ ...fixed, actionsExecuted })] }), /completed steps were recorded/);
}
const newest = publicSlackResolution({ approvals: [pending(fixed), { ...pending({ ...fixed, outcome: "not_reproducible" }), id: 10 }] });
assert.match(newest, /could not be reproduced/);
assert.doesNotMatch(newest, /reports the issue fixed/);
console.log("Slack resolution privacy tests passed");
