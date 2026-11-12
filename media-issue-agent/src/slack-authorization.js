import { getSetting, setSetting, deleteSetting, recordAudit } from "./db.js";

const issued = new WeakSet();
const REQUEST_TTL = 180_000;
const GRANT_TTL = 60 * 60_000;
const accountId = value => /^\d{1,20}$/.test(String(value || ""));
export const slackOwnerIds = config => (Array.isArray(config.slackOwnerUserIds) ? config.slackOwnerUserIds : String(config.slackOwnerUserIds || "").split(","))
  .map(value => String(value).trim()).filter(value => /^[UW][A-Z0-9]{2,}$/.test(value));

// These objects are minted from authenticated Slack events by application code.
// Serialized context, classifier output and claimed display names cannot mint one.
export function createSlackResearchAuthorization(config, values = {}) {
  const mode = values.mode === "owner" && slackOwnerIds(config).includes(values.actorUserId) ? "owner"
    : values.mode === "self" && accountId(values.resolvedSelfId) ? "self" : "public";
  const targets = mode === "owner" ? (values.targets || []).slice(0, 4).map((target, index) => Object.freeze({
    ref: `target_${index + 1}`,
    label: target.label === "requested account" ? "requested account" : "thread participant",
    subjectSlackId: /^[UW][A-Z0-9]{2,}$/.test(target.subjectSlackId || "") ? target.subjectSlackId : null,
    queries: Object.freeze((target.queries || []).filter(item => typeof item?.query === "string" && item.query.trim() && item.query.length <= 200)
      .slice(0, 4).map(item => Object.freeze({ query: item.query.trim(), ...(["email", "username", "friendly_name", "user_id"].includes(item.matchBy) ? { matchBy: item.matchBy } : {}) })))
  })).filter(target => target.queries.length) : [];
  const result = Object.freeze({
    mode, actorUserId: String(values.actorUserId || ""), teamId: String(values.teamId || ""),
    channelId: String(values.channelId || ""), threadId: Number(values.threadId), eventId: String(values.eventId || ""),
    expiresAt: Date.now() + REQUEST_TTL,
    policyEpoch: getSetting(config.dbPath, `${grantKey(values)}:epoch`, 0),
    subjectEpoch: getSetting(config.dbPath, subjectEpochKey(values.teamId, values.actorUserId), 0),
    ...(mode === "owner" ? { ownerDirective: String(values.ownerDirective || "").slice(0, 4000), targets: Object.freeze(targets) } : {}),
    ...(mode === "self" ? { resolvedSelfId: String(values.resolvedSelfId), authorizedByOwnerId: values.authorizedByOwnerId || null } : {})
  });
  issued.add(result);
  return result;
}

export function validateSlackResearchAuthorization(config, value, metadata = {}) {
  if (!value || !issued.has(value) || value.expiresAt <= Date.now()) return null;
  if (value.mode === "owner" && !slackOwnerIds(config).includes(value.actorUserId)) return null;
  if (value.mode === "self" && value.authorizedByOwnerId && !slackOwnerIds(config).includes(value.authorizedByOwnerId)) return null;
  if (getSetting(config.dbPath, `${grantKey(value)}:epoch`, 0) !== value.policyEpoch) return null;
  if (getSetting(config.dbPath, subjectEpochKey(value.teamId, value.actorUserId), 0) !== value.subjectEpoch) return null;
  if (String(metadata.eventId || "") !== value.eventId || Number(metadata.threadId) !== value.threadId) return null;
  if (metadata.userId !== undefined && metadata.userId !== value.actorUserId) return null;
  if (metadata.teamId !== undefined && metadata.teamId !== value.teamId) return null;
  if (metadata.channelId !== undefined && metadata.channelId !== value.channelId) return null;
  return value;
}

const bindingKey = (teamId, userId) => `slack-playback-binding:${teamId}:${userId}`;
const grantKey = item => `slack-playback-grant:${item.teamId}:${item.channelId}:${item.threadId}`;
const subjectEpochKey = (teamId, userId) => `slack-playback-subject-epoch:${teamId}:${userId}`;
function invalidateSubject(config, teamId, userId) {
  const key = subjectEpochKey(teamId, userId);
  setSetting(config.dbPath, key, Number(getSetting(config.dbPath, key, 0)) + 1);
}

export function playbackBinding(config, item) {
  const binding = getSetting(config.dbPath, bindingKey(item.teamId, item.userId), null);
  return binding && accountId(binding.resolvedUserId) && slackOwnerIds(config).includes(binding.ownerId) ? binding : null;
}

export function savePlaybackBinding(config, item, subjectSlackId, resolvedUserId) {
  if (!slackOwnerIds(config).includes(item.userId) || !/^[UW][A-Z0-9]{2,}$/.test(subjectSlackId) || !accountId(resolvedUserId)) throw new Error("Configured owner authorization and an exact account are required");
  setSetting(config.dbPath, bindingKey(item.teamId, subjectSlackId), { resolvedUserId: String(resolvedUserId), ownerId: item.userId, createdAt: Date.now() });
  invalidateSubject(config, item.teamId, subjectSlackId);
  recordAudit(config.dbPath, "slack_playback_binding_updated", { threadId: item.threadId, action: "linked" });
}

export function removePlaybackBinding(config, item, subjectSlackId) {
  if (!slackOwnerIds(config).includes(item.userId)) throw new Error("Configured owner authorization is required");
  deleteSetting(config.dbPath, bindingKey(item.teamId, subjectSlackId));
  setSetting(config.dbPath, `slack-playback-revoked:${item.teamId}:${subjectSlackId}`, Date.now());
  invalidateSubject(config, item.teamId, subjectSlackId);
  recordAudit(config.dbPath, "slack_playback_binding_updated", { threadId: item.threadId, action: "unlinked" });
}

export function rememberPlaybackGrant(config, authority, targetRef, resolvedUserId) {
  if (!validateSlackResearchAuthorization(config, authority, authority) || authority.mode !== "owner" || !accountId(resolvedUserId)) return;
  const target = authority.targets.find(value => value.ref === targetRef);
  if (!target) return;
  setSetting(config.dbPath, grantKey(authority), {
    ownerId: authority.actorUserId, subjectSlackId: target.subjectSlackId,
    resolvedUserId: String(resolvedUserId), createdAt: Date.now(), expiresAt: Date.now() + GRANT_TTL,
    subjectEpoch: getSetting(config.dbPath, subjectEpochKey(authority.teamId, target.subjectSlackId), 0),
    teamId: authority.teamId, channelId: authority.channelId, threadId: authority.threadId
  });
  recordAudit(config.dbPath, "slack_playback_diagnostics_authorized", { threadId: authority.threadId, scope: "one_account", expiresInSeconds: GRANT_TTL / 1000 });
}

export function playbackGrant(config, item) {
  const grant = getSetting(config.dbPath, grantKey(item), null);
  if (!grant || grant.expiresAt <= Date.now() || !accountId(grant.resolvedUserId)
    || !slackOwnerIds(config).includes(grant.ownerId)
    || (item.userId !== grant.ownerId && item.userId !== grant.subjectSlackId)
    || grant.teamId !== item.teamId || grant.channelId !== item.channelId || Number(grant.threadId) !== Number(item.threadId)) return null;
  if (grant.subjectEpoch !== getSetting(config.dbPath, subjectEpochKey(item.teamId, grant.subjectSlackId), 0)) return null;
  const revokedAt = getSetting(config.dbPath, `slack-playback-revoked:${item.teamId}:${grant.subjectSlackId}`, 0);
  return revokedAt >= grant.createdAt ? null : grant;
}

export function revokePlaybackGrant(config, item) {
  if (!slackOwnerIds(config).includes(item.userId)) return false;
  deleteSetting(config.dbPath, grantKey(item));
  setSetting(config.dbPath, `${grantKey(item)}:epoch`, Number(getSetting(config.dbPath, `${grantKey(item)}:epoch`, 0)) + 1);
  recordAudit(config.dbPath, "slack_playback_diagnostics_revoked", { threadId: item.threadId });
  return true;
}

export function guardPlaybackReply(config, dedupeKey, authority) {
  if (!authority || authority.mode === "public") return;
  if (!validateSlackResearchAuthorization(config, authority, authority)) throw new Error("Diagnostic authorization expired");
  // Store only the delivery guard, never account queries or owner prose.
  const { mode, actorUserId, authorizedByOwnerId, teamId, channelId, threadId, expiresAt, policyEpoch, subjectEpoch } = authority;
  setSetting(config.dbPath, `slack-playback-reply:${dedupeKey}`, { mode, actorUserId, authorizedByOwnerId, teamId, channelId, threadId, expiresAt, policyEpoch, subjectEpoch });
}

export function playbackReplyAllowed(config, item) {
  const guard = getSetting(config.dbPath, `slack-playback-reply:${item.dedupeKey}`, null);
  if (!guard) return item.kind !== "authorized_research";
  if (guard.expiresAt <= Date.now() || guard.threadId !== Number(item.threadId) || guard.channelId !== item.channelId || guard.teamId !== item.teamId) return false;
  if (guard.mode === "owner" && !slackOwnerIds(config).includes(guard.actorUserId)) return false;
  if (guard.authorizedByOwnerId && !slackOwnerIds(config).includes(guard.authorizedByOwnerId)) return false;
  if (getSetting(config.dbPath, `${grantKey(guard)}:epoch`, 0) !== guard.policyEpoch) return false;
  return guard.mode !== "self" || getSetting(config.dbPath, subjectEpochKey(guard.teamId, guard.actorUserId), 0) === guard.subjectEpoch;
}
