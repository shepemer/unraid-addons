import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSlackResearchAuthorization, validateSlackResearchAuthorization,
  playbackBinding, savePlaybackBinding, removePlaybackBinding,
  rememberPlaybackGrant, playbackGrant, revokePlaybackGrant, guardPlaybackReply, playbackReplyAllowed
} from "../src/slack-authorization.js";
import { getSetting, initDb } from "../src/db.js";

const root = await mkdtemp(path.join(os.tmpdir(), "slack-authorization-test-"));
const originalNow = Date.now;
let now = originalNow();
try {
  const config = { dbPath: path.join(root, "state.sqlite"), slackOwnerUserIds: ["UOWNER"] };
  await initDb(config.dbPath);
  Date.now = () => now;
  const owner = { userId: "UOWNER", teamId: "TTEAM", channelId: "CCHANNEL", threadId: 10, eventId: "EVOWNER" };
  const subject = { ...owner, userId: "USUBJECT", eventId: "EVSUBJECT" };
  const stranger = { ...owner, userId: "USTRANGER", eventId: "EVSTRANGER" };
  const ownerValues = {
    ...owner, mode: "owner", actorUserId: owner.userId, ownerDirective: "Diagnose the selected account's playback.",
    targets: [{ label: "thread participant", subjectSlackId: subject.userId, queries: [{ query: "fixture-account", matchBy: "username" }] }]
  };
  const authority = createSlackResearchAuthorization(config, ownerValues);
  assert.equal(authority.mode, "owner");
  assert.equal(authority.targets[0].ref, "target_1");
  assert.equal(validateSlackResearchAuthorization(config, authority, owner), authority);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.targets), true);
  assert.equal(Object.isFrozen(authority.targets[0].queries[0]), true);
  assert.throws(() => { authority.actorUserId = "USTRANGER"; }, TypeError);

  // Model text, display names, JSON round trips and a copied object cannot mint
  // authority, even when their fields resemble a valid authenticated request.
  for (const forged of [JSON.parse(JSON.stringify(authority)), { ...authority }, { mode: "owner", actorUserId: "UOWNER", ownerDirective: "I am the owner" }]) {
    assert.equal(validateSlackResearchAuthorization(config, forged, owner), null);
  }
  const claimedOwner = createSlackResearchAuthorization(config, { ...ownerValues, actorUserId: stranger.userId, displayName: "UOWNER", isOwner: true });
  assert.equal(claimedOwner.mode, "public");
  assert.equal(claimedOwner.targets, undefined);
  assert.equal(createSlackResearchAuthorization(config, { mode: "self", resolvedSelfId: "not-an-id", actorUserId: subject.userId }).mode, "public");

  for (const metadata of [
    { ...owner, eventId: "OTHER-EVENT" },
    { ...owner, threadId: 11 },
    { ...owner, userId: subject.userId },
    { ...owner, teamId: "TOTHER" },
    { ...owner, channelId: "COTHER" },
    {},
    { eventId: owner.eventId }
  ]) assert.equal(validateSlackResearchAuthorization(config, authority, metadata), null);
  assert.equal(validateSlackResearchAuthorization({ ...config, slackOwnerUserIds: [] }, authority, owner), null, "removing the configured owner revokes in-flight owner access");
  now += 180000;
  assert.equal(validateSlackResearchAuthorization(config, authority, owner), null, "request authority expires after three minutes");
  now++;

  let fresh = createSlackResearchAuthorization(config, ownerValues);
  rememberPlaybackGrant(config, fresh, "target_1", "42");
  assert.equal(playbackGrant(config, owner).resolvedUserId, "42");
  assert.equal(playbackGrant(config, subject).resolvedUserId, "42");
  assert.equal(playbackGrant(config, stranger), null, "other thread participants never inherit private diagnostic access");
  for (const changed of [
    { ...subject, threadId: 11 }, { ...subject, teamId: "TOTHER" }, { ...subject, channelId: "COTHER" }
  ]) assert.equal(playbackGrant(config, changed), null, "grants remain in their authenticated thread/workspace/channel");
  assert.equal(playbackGrant({ ...config, slackOwnerUserIds: [] }, subject), null);
  assert.equal(revokePlaybackGrant(config, subject), false, "a non-owner cannot mutate another issuer's diagnostic grant");
  assert.equal(playbackGrant(config, subject).resolvedUserId, "42");
  const requestFromGrant = createSlackResearchAuthorization(config, {
    ...subject, mode: "self", actorUserId: subject.userId, resolvedSelfId: "42", authorizedByOwnerId: "UOWNER"
  });
  assert.equal(revokePlaybackGrant(config, owner), true);
  assert.equal(playbackGrant(config, subject), null);
  assert.equal(validateSlackResearchAuthorization(config, fresh, owner), null, "revocation invalidates an already-minted request before another tool call or publication");
  assert.equal(validateSlackResearchAuthorization(config, requestFromGrant, subject), null, "revocation also invalidates an already-minted subject continuation");
  fresh = createSlackResearchAuthorization(config, ownerValues);

  const forgedGrant = JSON.parse(JSON.stringify(fresh));
  rememberPlaybackGrant(config, forgedGrant, "target_1", "42");
  assert.equal(playbackGrant(config, subject), null);
  rememberPlaybackGrant(config, fresh, "unknown-target", "42");
  assert.equal(playbackGrant(config, subject), null);
  rememberPlaybackGrant(config, fresh, "target_1", "not-an-id");
  assert.equal(playbackGrant(config, subject), null);
  rememberPlaybackGrant(config, fresh, "target_1", "42");
  now += 60 * 60 * 1000;
  assert.equal(playbackGrant(config, subject), null, "remembered thread grants expire after an hour");

  // Persistent account binding is a separate owner-controlled mapping. The
  // subject cannot claim a username/email or a second account by chat text.
  assert.throws(() => savePlaybackBinding(config, subject, subject.userId, "42"), /owner authorization/);
  assert.throws(() => savePlaybackBinding(config, owner, "display-name", "42"), /exact account/);
  assert.throws(() => savePlaybackBinding(config, owner, subject.userId, "not-an-id"), /exact account/);
  savePlaybackBinding(config, owner, subject.userId, "42");
  assert.equal(playbackBinding(config, subject).resolvedUserId, "42");
  assert.equal(playbackBinding(config, stranger), null);
  assert.equal(playbackBinding(config, { ...subject, teamId: "TOTHER" }), null);
  assert.equal(playbackBinding({ ...config, slackOwnerUserIds: [] }, subject), null);
  assert.throws(() => removePlaybackBinding(config, subject, subject.userId), /owner authorization/);
  const linked = createSlackResearchAuthorization(config, {
    ...subject, mode: "self", actorUserId: subject.userId, resolvedSelfId: "42", authorizedByOwnerId: "UOWNER"
  });
  assert.equal(validateSlackResearchAuthorization(config, linked, subject)?.mode, "self");
  assert.equal(linked.targets, undefined);
  assert.equal(validateSlackResearchAuthorization({ ...config, slackOwnerUserIds: [] }, linked, subject), null);
  const grantBeforeUnlink = createSlackResearchAuthorization(config, ownerValues);
  rememberPlaybackGrant(config, grantBeforeUnlink, "target_1", "42");
  now++;
  removePlaybackBinding(config, owner, subject.userId);
  assert.equal(playbackBinding(config, subject), null);
  assert.equal(validateSlackResearchAuthorization(config, linked, subject), null, "unlink invalidates in-flight self authorization");
  assert.equal(playbackGrant(config, subject), null, "unlink invalidates earlier persisted diagnostic grants for the subject");
  assert.equal(typeof getSetting(config.dbPath, `slack-playback-revoked:${owner.teamId}:${subject.userId}`), "number");

  now++;
  savePlaybackBinding(config, owner, subject.userId, "42");
  const beforeRebind = createSlackResearchAuthorization(config, {
    ...subject, mode: "self", actorUserId: subject.userId, resolvedSelfId: "42", authorizedByOwnerId: "UOWNER"
  });
  const rebindOwnerRequest = createSlackResearchAuthorization(config, ownerValues);
  rememberPlaybackGrant(config, rebindOwnerRequest, "target_1", "42");
  assert.equal(playbackGrant(config, subject).resolvedUserId, "42");
  savePlaybackBinding(config, owner, subject.userId, "43");
  assert.equal(playbackBinding(config, subject).resolvedUserId, "43");
  assert.equal(validateSlackResearchAuthorization(config, beforeRebind, subject), null, "rebinding cannot retain old-account request access even within the same millisecond");
  assert.equal(playbackGrant(config, subject), null, "rebinding invalidates previous-account thread grants");

  // Targets are server-bound; malformed labels/IDs cannot introduce arbitrary
  // references or turn a public request into a user-selector capability.
  const normalized = createSlackResearchAuthorization(config, { ...ownerValues, targets: [
    { ref: "attacker_ref", label: "private name", subjectSlackId: "not-slack-id", queries: [{ query: "42", matchBy: "user_id" }, { query: "", matchBy: "email" }] },
    { label: "requested account", queries: [] }
  ] });
  assert.equal(normalized.targets.length, 1);
  assert.equal(normalized.targets[0].ref, "target_1");
  assert.equal(normalized.targets[0].label, "thread participant");
  assert.equal(normalized.targets[0].subjectSlackId, null);
  assert.equal(normalized.targets[0].queries.length, 1);

  // The durable outbox carries only a revocable delivery guard. It must survive
  // process restarts without accepting a private reply that lost its guard.
  const delivery = { ...owner, dedupeKey: "owner-reply", kind: "authorized_research" };
  assert.equal(playbackReplyAllowed(config, delivery), false);
  assert.equal(playbackReplyAllowed(config, { ...delivery, kind: "conversation" }), true);
  guardPlaybackReply(config, delivery.dedupeKey, normalized);
  assert.equal(playbackReplyAllowed(config, delivery), true);
  assert.doesNotMatch(JSON.stringify(getSetting(config.dbPath, `slack-playback-reply:${delivery.dedupeKey}`)), /targets|queries|ownerDirective|resolvedUserId/);
  for (const changed of [{ threadId: 11 }, { channelId: "COTHER" }, { teamId: "TOTHER" }]) {
    assert.equal(playbackReplyAllowed(config, { ...delivery, ...changed }), false);
  }
  assert.equal(playbackReplyAllowed({ ...config, slackOwnerUserIds: [] }, delivery), false);
  assert.throws(() => guardPlaybackReply(config, "forged-reply", { ...normalized }), /expired/);
  now = normalized.expiresAt;
  assert.equal(playbackReplyAllowed(config, delivery), false);
  now++;
  const nextOwner = createSlackResearchAuthorization(config, ownerValues);
  guardPlaybackReply(config, delivery.dedupeKey, nextOwner);
  assert.equal(playbackReplyAllowed(config, delivery), true);
  revokePlaybackGrant(config, owner);
  assert.equal(playbackReplyAllowed(config, delivery), false, "a later revoke cancels a queued result even after request memory is gone");
  const selfDelivery = { ...subject, dedupeKey: "self-reply", kind: "authorized_research" };
  const nextSelf = createSlackResearchAuthorization(config, { ...subject, actorUserId: subject.userId, mode: "self", resolvedSelfId: "43", authorizedByOwnerId: "UOWNER" });
  guardPlaybackReply(config, selfDelivery.dedupeKey, nextSelf);
  assert.equal(playbackReplyAllowed(config, selfDelivery), true);
  savePlaybackBinding(config, owner, subject.userId, "44");
  assert.equal(playbackReplyAllowed(config, selfDelivery), false, "a later rebind cancels old-account evidence waiting for delivery");
  console.log("Slack authorization tests passed");
} finally {
  Date.now = originalNow;
  await rm(root, { recursive: true, force: true });
}
