import http from "node:http";
import { randomBytes } from "node:crypto";
import { redactText } from "./redact.js";
import { normalizeSlackResearchAuthorization, slackResearchIdentityTerms } from "./slack-research-policy.js";

const OMIT = Symbol("private");
const keyOf = key => String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
const PRIVATE_KEYS = /authorization|bearer|token|apikey|password|passwd|secret|cookie|credential|privatekey|username|useragent|userdata|useractivity|friendlyname|displayname|realname|email|phone|requester|requestedby|createdby|modifiedby|reporter|viewer|userid|userguid|useruuid|account|device|machineidentifier|clientidentifier|session|host|machinename|machineid|serveraddress|ipaddress|remoteip|localip|macaddress|path|filename|directory|folder|viewoffset|lastviewed|viewedleaf|viewcount|userrating|ownername|authorname|watchhistory/;
const PRIVATE_EXACT_KEYS = new Set(["user", "users", "owner", "owners", "author", "authors", "person", "people", "host", "hosts", "server", "serverid", "servername", "address", "addresses", "ip", "ips", "path", "paths", "folder", "folders", "location", "locations", "url", "urls", "uri", "uris", "endpoint", "endpoints", "origin", "referer", "port", "ports"]);
const UNSAFE_ARGUMENT_KEYS = /authorization|bearer|token|apikey|password|passwd|secret|cookie|credential|user|viewer|requester|reporter|account|device|session|host|address|endpoint|url|uri|path|folder|directory|filename|partfile|command|shell|script|method|headers|requestbody|payload|expression|querystring|filter|where|selector|callback/;
const UNSAFE_TOOL = /(?:^|_)(?:users?|accounts?|credentials?|secrets?|passwords?|tokens?|sessions?|activity|viewers?|playback_history|watch_history|user_history|http|fetch|curl|shell|exec|graphql|sql)(?:_|$)/i;
const PRIVATE_TOOL_TEXT = /\b(?:individual|per[- ]user|specific user|user[- ]specific)\b.{0,60}\b(?:watch|view|play|history|activity|statistic)|\b(?:credentials?|api keys?|access tokens?|passwords?|raw (?:playback |viewing |watch )?history)\b/i;
const GENERIC_ENDPOINT_TEXT = /\b(?:arbitrary|generic|custom)\b.{0,70}\b(?:http|api|endpoint|request|command|query|url)\b/i;
const MAX_SCHEMA_DEPTH = 12;

function privateKey(key) {
  const normalized = keyOf(key);
  return PRIVATE_KEYS.test(normalized) || PRIVATE_EXACT_KEYS.has(normalized) || /(?:url|uri|address)$/.test(normalized);
}

function plexDirectoryCollection(key, value, parentKey) {
  // Plex calls its library/season metadata collection Directory. It is not a
  // filesystem listing; retain only the recognizable media collection shape.
  return parentKey === "MediaContainer" && key === "Directory" && Array.isArray(value)
    && value.every(record => record && typeof record === "object" && !Array.isArray(record)
      && ["movie", "show", "season", "episode", "artist", "album", "track", "photo"].includes(record.type)
      && /^\d+$/.test(String(record.ratingKey ?? record.key ?? "")));
}

function privateField(key, value, parentKey) {
  return privateKey(key) && !plexDirectoryCollection(key, value, parentKey);
}

export function scrubSlackGatewayText(value, identities = []) {
  let text = redactText(String(value))
    .replace(/<@[A-Z0-9]+>|<![^>]+>|<#[^>]+>/gi, "[private identity]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[private contact]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[private address]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b/gi, "[private address]")
    .replace(/\b(?:[a-f0-9]{2}[:-]){5}[a-f0-9]{2}\b/gi, "[private address]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+(?:local|lan|internal|home|com|net|org|io)\b/gi, "[private host]")
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+(?:\/[^\s"'<>]*)?|[A-Za-z]:\\[^\s"'<>]+)/g, " [private path]")
    .replace(/\b[UWCT][A-Z0-9]{7,}\b/g, "[private identity]")
    .replace(/(?:^|\s)@[A-Za-z0-9._-]+/g, " [private identity]");
  for (const identity of identities) {
    if (typeof identity !== "string" || identity.length < 3 || identity.length > 500) continue;
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), "[private identity]");
  }
  return text;
}

function collectIdentityValues(value, found, depth = 0, privateBranch = false, parentKey = "") {
  if (depth > 16 || found.size > 500) return;
  if (typeof value === "string") {
    if (privateBranch && value.length >= 3 && value.length <= 500) found.add(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectIdentityValues(item, found, depth + 1, privateBranch, parentKey);
    return;
  }
  // Settings often encode secrets as {name: 'apiKey', value: '...'}.
  const labeledPrivate = privateKey(value.name || value.Name || value.key || value.Key || "");
  for (const [key, item] of Object.entries(value).slice(0, 500)) collectIdentityValues(item, found, depth + 1, privateBranch || privateField(key, item, parentKey) || (labeledPrivate && /^(?:value|val)$/i.test(key)), key);
}

export function scrubSlackGatewayValue(value, options = {}) {
  const identities = new Set(options.identities || []);
  collectIdentityValues(value, identities);
  let remaining = options.maxNodes || 6000;
  const truncate = () => options.onTruncate?.();
  const walk = (item, depth = 0, parentKey = "") => {
    if (--remaining < 0 || depth > 16) { truncate(); return "[truncated]"; }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "string") {
      const text = scrubSlackGatewayText(item, identities);
      const limit = Math.min(16000, options.maxStringChars || 4000);
      if (text.length > limit) truncate();
      return text.slice(0, limit);
    }
    if (!item || typeof item !== "object") return OMIT;
    if (Array.isArray(item)) {
      if (item.length > 250) truncate();
      return item.slice(0, 250).map(entry => walk(entry, depth + 1, parentKey)).filter(entry => entry !== OMIT);
    }
    const labeledPrivate = privateKey(item.name || item.Name || item.key || item.Key || "");
    const entries = [];
    if (Object.keys(item).length > 500) truncate();
    for (const [key, child] of Object.entries(item).slice(0, 500)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || privateField(key, child, parentKey) || (labeledPrivate && /^(?:value|val|name|key)$/i.test(key))) continue;
      const scrubbed = walk(child, depth + 1, key);
      if (scrubbed !== OMIT) entries.push([scrubSlackGatewayText(key, identities).slice(0, 160), scrubbed]);
    }
    return Object.fromEntries(entries);
  };
  const result = walk(value);
  return result === OMIT ? null : result;
}

export const scrubSlackReadOnlyValue = scrubSlackGatewayValue;

function internalMediaReferenceKey(key) {
  return /^(?:id|ids|key|keys|guid|guids|uuid|uuids|cursor|nextCursor|scopeRef|targetRef)$/i.test(key)
    || /(?:[a-z](?:Id|ID|Ids|IDs|Key|Keys|Guid|GUID|Uuid|UUID)|[_-](?:id|ids|key|keys|guid|uuid))$/.test(key);
}

export function slackPublicEvidence(value) {
  // The research worker receives selectors so it can traverse discovered
  // tools. The presentation model has no use for those internal references.
  if (Array.isArray(value)) return value.map(slackPublicEvidence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !internalMediaReferenceKey(key))
    .map(([key, child]) => [key, slackPublicEvidence(child)]));
}

function safeSchema(schema, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH || !schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  if (schema.$ref || schema.patternProperties || schema.dependentSchemas || schema.if || schema.not || schema.contains || schema.propertyNames || schema.unevaluatedProperties) return null;
  const output = {};
  const validTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (schema.type !== undefined) {
    if (Array.isArray(schema.type)) {
      if (!schema.type.length || schema.type.some(type => !validTypes.includes(type))) return null;
      output.type = schema.type;
    } else if (validTypes.includes(schema.type)) output.type = schema.type;
    else return null;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length || schema[key].length > 10) return null;
      const variants = schema[key].map(child => safeSchema(child, depth + 1));
      if (variants.some(child => !child)) return null;
      output[key] = variants;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 100 || schema.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))) return null;
    if (schema.enum.some(item => typeof item === "string" && scrubSlackGatewayText(item) !== item)) return null;
    output.enum = schema.enum;
  }
  if (schema.const !== undefined) {
    if (schema.const !== null && !["string", "number", "boolean"].includes(typeof schema.const)) return null;
    output.const = schema.const;
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "multipleOf"]) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== "number" || !Number.isFinite(schema[key])) return null;
      output[key] = schema[key];
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 256) return null;
    try { new RegExp(schema.pattern); } catch { return null; }
    output.pattern = schema.pattern;
  }
  if (schema.format && ["uri", "uri-reference", "hostname", "ipv4", "ipv6", "email"].includes(schema.format)) return null;
  if (schema.format === "date-time" || schema.format === "date") output.format = schema.format;
  if (schema.uniqueItems !== undefined) output.uniqueItems = schema.uniqueItems === true;
  if (schema.items !== undefined) {
    output.items = safeSchema(schema.items, depth + 1);
    if (!output.items) return null;
  }
  if (schema.type === "array" && !output.items) return null;
  if (schema.properties !== undefined || schema.type === "object") {
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) return null;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(key => typeof key !== "string")) return null;
    output.type ??= "object";
    output.properties = {};
    output.additionalProperties = false;
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (["__proto__", "prototype", "constructor"].includes(key) || UNSAFE_ARGUMENT_KEYS.test(keyOf(key))) {
        if (required.includes(key)) return null;
        continue;
      }
      const projected = safeSchema(child, depth + 1);
      if (!projected) {
        if (required.includes(key)) return null;
        continue;
      }
      output.properties[key] = projected;
    }
    if (required.some(key => !Object.hasOwn(output.properties, key))) return null;
    if (required.length) output.required = required;
  }
  if (typeof schema.description === "string") output.description = scrubSlackGatewayText(schema.description).slice(0, 250);
  if (!output.type && !output.anyOf && !output.oneOf && !output.allOf && !output.enum && !Object.hasOwn(output, "const")) return null;
  return output;
}

export function slackReadOnlyToolCatalog(tools) {
  const catalog = (Array.isArray(tools) ? tools : []).slice(0, 1000).flatMap(tool => {
    const name = String(tool?.name || "");
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) || tool?.annotations?.readOnlyHint !== true || tool?.annotations?.destructiveHint === true) return [];
    const text = `${name} ${tool.description || ""}`;
    const aggregate = /(?:public|aggregate)/i.test(name) && /(?:watch|view|play|bandwidth|availability|summary)/i.test(name);
    if (UNSAFE_TOOL.test(name) || /(?:tautulli|tracearr|plex).*(?:history|session|activity|user|account)/i.test(name)) return [];
    if (!aggregate && PRIVATE_TOOL_TEXT.test(text)) return [];
    if (GENERIC_ENDPOINT_TEXT.test(text)) return [];
    const inputSchema = safeSchema(tool.inputSchema || { type: "object", properties: {} });
    if (!inputSchema || JSON.stringify(inputSchema).length > 12000) return [];
    return [{ name, description: scrubSlackGatewayText(tool.description || tool.title || name).slice(0, 400), inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, ...(tool.annotations.idempotentHint === true ? { idempotentHint: true } : {}) } }];
  }).filter((tool, index, list) => list.findIndex(other => other.name === tool.name) === index);
  let catalogBytes = 0;
  return catalog.filter(tool => {
    const bytes = Buffer.byteLength(JSON.stringify(tool));
    if (catalogBytes + bytes > 256 * 1024) return false;
    catalogBytes += bytes;
    return true;
  });
}

const PLAYBACK_RESOLVER = "media_resolve_playback_user";
const PLAYBACK_DIAGNOSTICS = "media_user_playback_diagnostics";

function scopedPlaybackCatalog(discovered, authorization) {
  if (authorization.mode === "public") return [];
  const available = name => (Array.isArray(discovered) ? discovered : []).find(tool => tool?.name === name && tool.annotations?.destructiveHint !== true);
  const diagnostic = available(PLAYBACK_DIAGNOSTICS);
  if (!diagnostic) return [];
  const properties = { ...(diagnostic.inputSchema?.properties || {}) };
  delete properties.resolvedUserId;
  const schema = safeSchema({ type: "object", properties, additionalProperties: false,
    required: (diagnostic.inputSchema?.required || []).filter(key => key !== "resolvedUserId") });
  if (!schema) return [];
  const resolverAvailable = authorization.mode === "owner" && authorization.targets.length && available(PLAYBACK_RESOLVER);
  if (authorization.mode === "owner" && !resolverAvailable) return [];
  if (authorization.mode === "owner") {
    schema.properties.scopeRef = { type: "string", pattern: "^playback_[a-f0-9]{32}$" };
    schema.required = [...(schema.required || []), "scopeRef"];
  }
  return [
    ...(resolverAvailable ? [{ name: PLAYBACK_RESOLVER,
      description: "Resolve an application-authorized playback target by its targetRef. Returns an opaque scopeRef only for one exact, unambiguous match. Identity names and IDs are never returned.",
      inputSchema: { type: "object", properties: { targetRef: { type: "string", enum: authorization.targets.map(target => target.ref) } }, required: ["targetRef"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false } }] : []),
    { name: PLAYBACK_DIAGNOSTICS,
      description: "Read technical playback diagnostics for the authorized account, without watched titles or identifying details. Use the resolved scopeRef in owner mode; self mode is already bound. Preserve the requested time range; current source counts can overlap and must not be summed.",
      inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false } }
  ];
}

function scopedPlaybackEvidence(value, identities) {
  const privateField = key => internalMediaReferenceKey(key) || /(?:titles?|ratingkey|name)$|^(?:file|metadata)$/i.test(keyOf(key));
  const sensitive = new Set(identities);
  let truncated = false;
  const collect = (item, hidden = false, depth = 0) => {
    if (depth > 16) return;
    if (typeof item === "string" && hidden && item.length >= 3 && item.length <= 500) sensitive.add(item);
    else if (Array.isArray(item)) item.slice(0, 250).forEach(child => collect(child, hidden, depth + 1));
    else if (item && typeof item === "object") Object.entries(item).slice(0, 500).forEach(([key, child]) => collect(child, hidden || privateField(key), depth + 1));
  };
  collect(value);
  const remove = (item, depth = 0) => {
    if (depth > 16) { truncated = true; return null; }
    if (Array.isArray(item)) { if (item.length > 250) truncated = true; return item.slice(0, 250).map(child => remove(child, depth + 1)); }
    if (!item || typeof item !== "object") return item;
    if (Object.keys(item).length > 500) truncated = true;
    return Object.fromEntries(Object.entries(item).slice(0, 500).filter(([key]) => !privateField(key)).map(([key, child]) => [key, remove(child, depth + 1)]));
  };
  const result = scrubSlackGatewayValue(remove(value), { identities: [...sensitive], onTruncate: () => { truncated = true; } });
  return truncated && result && typeof result === "object" && !Array.isArray(result) ? { ...result, truncated: true } : result;
}

function validType(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateSlackGatewayArguments(schema, value, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => validType(value, type))) return false;
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) return false;
  if (schema.anyOf && !schema.anyOf.some(child => validateSlackGatewayArguments(child, value, depth + 1))) return false;
  if (schema.oneOf && schema.oneOf.filter(child => validateSlackGatewayArguments(child, value, depth + 1)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(child => validateSlackGatewayArguments(child, value, depth + 1))) return false;
  if (typeof value === "string") {
    if (value.length > 4000 || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 4000)) return false;
    if (scrubSlackGatewayText(value) !== value || /(?:user|viewer|account|device|session)(?:_?id)?\s*[:=]/i.test(value)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format && !Number.isFinite(Date.parse(value))) return false;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) || (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)) return false;
    if (schema.multipleOf !== undefined && (schema.multipleOf <= 0 || Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9)) return false;
  }
  if (Array.isArray(value)) {
    if (value.length > Math.min(250, schema.maxItems ?? 250) || value.length < (schema.minItems || 0)) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && !value.every(item => validateSlackGatewayArguments(schema.items, item, depth + 1))) return false;
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > Math.min(100, schema.maxProperties ?? 100) || keys.length < (schema.minProperties || 0)) return false;
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (keys.some(key => ["__proto__", "prototype", "constructor"].includes(key) || UNSAFE_ARGUMENT_KEYS.test(keyOf(key)))) return false;
    if (schema.properties) {
      if (keys.some(key => !Object.hasOwn(schema.properties, key))) return false;
      if (keys.some(key => !validateSlackGatewayArguments(schema.properties[key], value[key], depth + 1))) return false;
    }
  }
  return true;
}

const rpcError = (id, message, code = -32600) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

function fitPublicValue(value, maximumBytes) {
  if (jsonBytes(value) <= maximumBytes) return value;
  if (maximumBytes < 2) return OMIT;
  if (typeof value === "string") {
    let text = "";
    // Iterate code points to keep both JSON escaping and UTF-8 byte limits.
    for (const character of value) {
      if (jsonBytes(`${text}${character}…`) > maximumBytes) break;
      text += character;
    }
    return text && jsonBytes(`${text}…`) <= maximumBytes ? `${text}…` : OMIT;
  }
  if (Array.isArray(value)) {
    const records = [];
    for (const [index, item] of value.entries()) {
      const remaining = maximumBytes - jsonBytes(records) - (records.length ? 1 : 0);
      if (remaining < 2) break;
      // Share the budget among several rows/hubs instead of allowing one large
      // synopsis or stream list to crowd every other search match out.
      const rowBudget = Math.min(remaining, Math.max(128, Math.floor(remaining / Math.min(8, value.length - index))));
      const projected = fitPublicValue(item, rowBudget);
      if (projected !== OMIT && jsonBytes([...records, projected]) <= maximumBytes) records.push(projected);
    }
    return records;
  }
  if (value && typeof value === "object") {
    const result = {};
    const rank = item => item && typeof item === "object" ? 1 : typeof item === "string" && item.length > 200 ? 2 : 0;
    const entries = Object.entries(value).sort((left, right) => rank(left[1]) - rank(right[1]));
    for (const [index, [key, item]] of entries.entries()) {
      const overhead = jsonBytes({ [key]: null }) - 4 - 2 + (Object.keys(result).length ? 1 : 0);
      const remaining = maximumBytes - jsonBytes(result) - overhead;
      if (remaining < 1) continue;
      const containers = item && typeof item === "object"
        ? entries.slice(index).filter(([, child]) => child && typeof child === "object").length : 1;
      const fieldBudget = Math.min(remaining, Math.max(128, Math.floor(remaining / Math.min(containers, 4))));
      const projected = fitPublicValue(item, fieldBudget);
      if (projected !== OMIT && jsonBytes({ ...result, [key]: projected }) <= maximumBytes) result[key] = projected;
    }
    return result;
  }
  return OMIT;
}

function boundedPublicResult(value, maximumBytes, options = {}) {
  let truncated = false;
  const scrubbed = scrubSlackGatewayValue(value, { ...options, onTruncate: () => { truncated = true; } });
  const text = JSON.stringify(scrubbed);
  if (!truncated && Buffer.byteLength(text) <= maximumBytes) return { value: scrubbed, text };
  // Preserve nested collection shape (e.g. Plex MediaContainer.Hub.Metadata),
  // useful scalar IDs/dates/counts, and an explicit incomplete-evidence marker.
  let result = { truncated: true };
  if (Array.isArray(scrubbed)) {
    const projected = fitPublicValue(scrubbed, maximumBytes - jsonBytes({ records: [], truncated: true }) + 2);
    if (projected !== OMIT) result.records = projected;
  } else if (scrubbed && typeof scrubbed === "object") {
    const { truncated: _existing, ...fields } = scrubbed;
    const projected = fitPublicValue(fields, maximumBytes - jsonBytes({ truncated: true }) + 1);
    if (projected !== OMIT) result = { ...projected, truncated: true };
  }
  return { value: result, text: JSON.stringify(result) };
}

async function requestBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("Read-only diagnostic cancelled"));
  let handler;
  const cancelled = new Promise((_resolve, reject) => {
    handler = () => reject(new Error("Read-only diagnostic cancelled"));
    signal.addEventListener("abort", handler, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener("abort", handler));
}

export async function startSlackReadOnlyGateway(config = {}, hooks = {}) {
  const authorization = normalizeSlackResearchAuthorization(hooks.authorization);
  const authorityValid = () => {
    try { return !hooks.isAuthorized || hooks.isAuthorized() === true; } catch { return false; }
  };
  const identities = slackResearchIdentityTerms(authorization);
  const playbackScopes = new Map();
  const startedAt = Date.now();
  const emit = event => { try { hooks.onEvent?.(event); } catch { /* Logging cannot relax the boundary. */ } };
  const deadlineMs = Number(hooks.deadlineMs || Date.now() + 120000);
  const maxCalls = Math.max(1, Math.min(100, Number(hooks.maxCalls || 12)));
  const maxOutputBytes = Math.max(256, Math.min(1024 * 1024, Number(hooks.maxOutputBytes || 48 * 1024)));
  const perResultBytes = Math.max(128, Math.min(maxOutputBytes, Number(hooks.perResultBytes || 8 * 1024)));
  const controller = new AbortController();
  const signal = hooks.abortSignal ? AbortSignal.any([controller.signal, hooks.abortSignal]) : controller.signal;
  let expired = false;
  const deadlineTimer = setTimeout(() => { expired = true; controller.abort("Read-only diagnostic deadline reached"); }, Math.max(1, deadlineMs - Date.now()));
  const checkActive = () => !signal.aborted && !expired && Date.now() < deadlineMs;
  let discovered;
  try {
    if (!checkActive()) throw new Error("Read-only diagnostic deadline reached");
    discovered = await withAbort(Promise.resolve().then(() => hooks.listTools({ signal })), signal);
    if (!checkActive()) throw new Error("Read-only diagnostic deadline reached");
  } catch (error) {
    clearTimeout(deadlineTimer);
    controller.abort();
    emit({ type: "slack_readonly_catalog", status: "unavailable", toolCount: 0, durationMs: Date.now() - startedAt });
    throw new Error("Read-only media capability discovery is unavailable");
  }
  const catalog = [...slackReadOnlyToolCatalog(discovered), ...(authorityValid() ? scopedPlaybackCatalog(discovered, authorization) : [])];
  emit({ type: "slack_readonly_catalog", status: "ok", toolCount: catalog.length, durationMs: Date.now() - startedAt });
  const tools = new Map(catalog.map(tool => [tool.name, tool]));
  const token = `slack-readonly-${randomBytes(24).toString("hex")}`;
  const evidence = [];
  const usage = { calls: 0, outputBytes: 0, rejectedCalls: 0, exhausted: false, toolCount: catalog.length };
  let serial = Promise.resolve();
  const handle = async request => {
    if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || (request.id !== undefined && typeof request.id !== "string" && typeof request.id !== "number")) return rpcError(request?.id, "Invalid request");
    const notification = !Object.hasOwn(request, "id");
    if (notification) return null; // Notifications never invoke a capability.
    if (!checkActive()) { usage.exhausted = true; return rpcError(request.id, "Read-only diagnostic deadline reached", -32001); }
    if (request.method === "initialize") return rpcResult(request.id, { protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(request.params?.protocolVersion) ? request.params.protocolVersion : "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "slack-readonly-media", version: "1.0.0" } });
    if (request.method === "ping") return rpcResult(request.id, {});
    if (request.method === "tools/list") return rpcResult(request.id, { tools: authorityValid() ? catalog : catalog.filter(tool => ![PLAYBACK_RESOLVER, PLAYBACK_DIAGNOSTICS].includes(tool.name)) });
    if (request.method !== "tools/call") return rpcError(request.id, "Only discovered read-only tools are available", -32601);
    const tool = tools.get(request.params?.name);
    const args = request.params?.arguments ?? {};
    const scopedPlayback = [PLAYBACK_RESOLVER, PLAYBACK_DIAGNOSTICS].includes(tool?.name);
    if (scopedPlayback && !authorityValid()) {
      usage.rejectedCalls += 1;
      emit({ type: "slack_readonly_tool_rejected", toolName: tool.name, status: "authorization_error", callCount: usage.calls, durationMs: 0 });
      return rpcError(request.id, "Playback diagnostic authorization is no longer current", -32602);
    }
    if (!tool || !validateSlackGatewayArguments(tool.inputSchema, args) || Buffer.byteLength(JSON.stringify(args)) > 16 * 1024 || Object.keys(request.params || {}).some(key => !["name", "arguments", "_meta"].includes(key))) {
      usage.rejectedCalls += 1;
      emit({ type: "slack_readonly_tool_rejected", ...(tool ? { toolName: tool.name } : {}), status: tool ? "invalid_arguments" : "not_allowed", callCount: usage.calls, durationMs: 0 });
      return rpcError(request.id, "Read-only capability or arguments are not allowed", -32602);
    }
    if (usage.calls >= maxCalls || usage.outputBytes >= maxOutputBytes - 128) {
      usage.exhausted = true;
      emit({ type: "slack_readonly_tool_rejected", toolName: tool.name, status: "budget_exceeded", callCount: usage.calls, durationMs: 0 });
      return rpcError(request.id, "Read-only diagnostic budget reached", -32001);
    }
    const callStartedAt = Date.now();
    const completed = (status, outputBytes = 0) => emit({ type: "slack_readonly_tool_completed", toolName: tool.name, status, callCount: usage.calls, durationMs: Date.now() - callStartedAt, outputBytes });
    const upstream = async (name, upstreamArgs) => {
      const checkAuthority = () => {
        if ([PLAYBACK_RESOLVER, PLAYBACK_DIAGNOSTICS].includes(name) && !authorityValid()) {
          const error = new Error("Playback diagnostic authorization is no longer current");
          error.code = "SLACK_RESEARCH_AUTHORIZATION";
          throw error;
        }
      };
      checkAuthority();
      if (!checkActive() || usage.calls >= maxCalls) {
        usage.exhausted = true;
        const error = new Error("Read-only diagnostic budget reached");
        error.code = "SLACK_RESEARCH_BUDGET";
        throw error;
      }
      usage.calls += 1;
      emit({ type: "slack_readonly_tool_started", toolName: name, status: "started", callCount: usage.calls });
      const result = await withAbort(Promise.resolve().then(() => { checkAuthority(); return hooks.callTool(name, upstreamArgs, { signal }); }), signal);
      checkAuthority();
      return result;
    };
    let publicResult;
    let status = "ok";
    try {
      let raw;
      if (tool.name === PLAYBACK_RESOLVER) {
        const target = authorization.targets.find(target => target.ref === args.targetRef);
        const matches = new Set();
        let resolution = "not_found";
        for (const query of target.queries) {
          const candidate = await upstream(PLAYBACK_RESOLVER, query);
          if (candidate?.status === "ambiguous" || Number(candidate?.matchCount) > 1 || (candidate?.candidates || []).length > 1) { resolution = "ambiguous"; break; }
          if (!candidate || candidate.complete !== true || !["matched", "not_found"].includes(candidate.status)) { resolution = "unavailable"; break; }
          if (candidate.status === "matched") {
            const id = candidate.candidates?.[0]?.resolvedUserId;
            if (candidate.candidates?.length !== 1 || typeof id !== "string" || !/^[0-9]{1,20}$/.test(id)) { resolution = "unavailable"; break; }
            matches.add(id);
            if (matches.size > 1) { resolution = "ambiguous"; break; }
            resolution = "matched";
          }
        }
        if (resolution === "matched" && matches.size === 1) {
          const scopeRef = `playback_${randomBytes(16).toString("hex")}`;
          playbackScopes.set(scopeRef, { targetRef: target.ref, resolvedUserId: [...matches][0] });
          raw = { available: true, status: "matched", complete: true, scopeRef };
        } else raw = { available: resolution !== "unavailable", status: resolution, complete: resolution !== "unavailable" };
      } else if (tool.name === PLAYBACK_DIAGNOSTICS) {
        const target = authorization.mode === "self" ? { resolvedUserId: authorization.resolvedSelfId } : playbackScopes.get(args.scopeRef);
        if (!target) {
          usage.rejectedCalls += 1;
          completed("invalid_arguments");
          return rpcError(request.id, "Resolve the authorized target before requesting diagnostics", -32602);
        }
        const { scopeRef: _scopeRef, ...scope } = args;
        raw = await upstream(PLAYBACK_DIAGNOSTICS, { ...scope, resolvedUserId: target.resolvedUserId });
        if (raw?.available === true) {
          try { await hooks.onDiagnosticTarget?.({ ...target }); } catch { /* Binding persistence never expands authorization. */ }
        }
        raw = scopedPlaybackEvidence(raw, identities);
      } else raw = await upstream(tool.name, args);
      if (!checkActive()) { usage.exhausted = true; completed("cancelled"); return rpcError(request.id, "Read-only diagnostic deadline reached", -32001); }
      if (raw?.available === false || raw?.configured === false) status = "unavailable";
      else if (raw?.error || raw?.isError === true || raw?.ok === false) status = "upstream_error";
      publicResult = boundedPublicResult(raw, Math.min(perResultBytes, maxOutputBytes - usage.outputBytes), { identities });
      if (status === "ok" && publicResult.value?.truncated === true) status = "truncated";
    } catch (error) {
      if (error?.code === "SLACK_RESEARCH_BUDGET") { completed("budget_exceeded"); return rpcError(request.id, "Read-only diagnostic budget reached", -32001); }
      if (error?.code === "SLACK_RESEARCH_AUTHORIZATION") { completed("authorization_error"); return rpcError(request.id, "Playback diagnostic authorization is no longer current", -32602); }
      if (!checkActive()) { usage.exhausted = true; completed("cancelled"); return rpcError(request.id, "Read-only diagnostic deadline reached", -32001); }
      const message = String(error?.message || "");
      status = /timeout|timed out|deadline/i.test(message) ? "timeout"
        : /\b(?:401|403)\b|unauthorized|forbidden/i.test(message) ? "authorization_error"
          : /ECONN|ENOTFOUND|fetch failed|network/i.test(message) ? "connection_error" : "upstream_error";
      publicResult = { value: { available: false, error: "Read-only lookup unavailable" }, text: '{"available":false,"error":"Read-only lookup unavailable"}' };
    }
    if (scopedPlayback && !authorityValid()) { completed("authorization_error"); return rpcError(request.id, "Playback diagnostic authorization is no longer current", -32602); }
    usage.outputBytes += Buffer.byteLength(publicResult.text);
    evidence.push({ tool: tool.name, arguments: scrubSlackGatewayValue(args, { identities }), result: publicResult.value });
    completed(status, Buffer.byteLength(publicResult.text));
    return rpcResult(request.id, { content: [{ type: "text", text: publicResult.text }] });
  };
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    try {
      const body = await requestBody(req);
      if (Array.isArray(body) && (!body.length || body.length > 20)) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify(rpcError(null, "Invalid batch"))); return; }
      // Serial execution closes races across concurrent HTTP requests and batches.
      const result = serial.then(async () => {
        if (!Array.isArray(body)) return handle(body);
        const results = [];
        for (const request of body) { const response = await handle(request); if (response) results.push(response); }
        return results.length ? results : null;
      });
      serial = result.catch(() => {});
      const payload = await result;
      if (payload === null) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, "Invalid gateway request", -32700)));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch (error) { clearTimeout(deadlineTimer); controller.abort(); throw error; }
  deadlineTimer.unref?.();
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, token, tools: structuredClone(catalog),
    getEvidence: () => structuredClone(slackPublicEvidence(authorityValid() ? evidence : evidence.filter(entry => ![PLAYBACK_RESOLVER, PLAYBACK_DIAGNOSTICS].includes(entry.tool)))),
    getUsage: () => ({ ...usage, expired: expired || Date.now() >= deadlineMs }),
    async close() {
      clearTimeout(deadlineTimer);
      controller.abort("Read-only gateway closed");
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections?.();
      await closing;
    }
  };
}
