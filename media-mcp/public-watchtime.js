import { randomBytes } from "node:crypto";

const DAY = 86400_000;
const publicTitleKey = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\s*\((?:18|19|20)\d{2}\)\s*$/, "").replace(/&/g, " and ").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
const publicYear = value => Number.isInteger(Number(value)) && Number(value) >= 1870 && Number(value) <= new Date().getUTCFullYear() + 10 ? Number(value) : null;
const tableRows = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null;

export function publicDurationSeconds(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Math.floor(Number(text));
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  // Tautulli formats totals as whole duration components. Reject any extra
  // text, negative sign or unknown unit instead of accepting a partial match.
  const component = "\\d+(?:\\.\\d+)?\\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)";
  if (!new RegExp(`^${component}(?:\\s+${component})*$`).test(text)) {
    return null;
  }
  const sizes = {
    day: 24 * 60 * 60,
    days: 24 * 60 * 60,
    hr: 60 * 60,
    hrs: 60 * 60,
    hour: 60 * 60,
    hours: 60 * 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1
  };
  let seconds = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/g)) {
    seconds += Number(match[1]) * sizes[match[2]];
  }
  return Number.isSafeInteger(Math.floor(seconds)) ? Math.floor(seconds) : null;
}

function tautulliPublicHistoryMediaType(row) {
  const type = String(row?.media_type || row?.mediaType || "").trim().toLowerCase();
  if (["episode", "season", "show"].includes(type)) {
    return "tv";
  }
  return type === "movie" ? "movie" : "";
}

function tautulliPublicHistoryMatches(row, { title, mediaType, year }) {
  const rowMediaType = tautulliPublicHistoryMediaType(row);
  if (mediaType && rowMediaType !== mediaType) {
    return false;
  }
  if (title) {
    const candidates = rowMediaType === "tv"
      ? [row?.grandparent_title, row?.grandparentTitle]
      : [row?.title, row?.full_title, row?.fullTitle];
    if (!candidates.map(publicTitleKey).filter(Boolean).includes(publicTitleKey(title))) {
      return false;
    }
  }
  const requestedYear = publicYear(year);
  const rowYear = publicYear(
    rowMediaType === "tv"
      ? row?.grandparent_year ?? row?.grandparentYear
      : row?.year
  );
  return !requestedYear || !rowYear || requestedYear === rowYear;
}

function dateValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Dates must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith("0000")) throw new Error("Invalid calendar date");
  return date;
}

function isoDate(date) {
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error("Requested lookback exceeds supported calendar dates; use allTime for all recorded history");
  return date.toISOString().slice(0, 10);
}

// Calendar scope is independent of request volume. No silently substituted
// 30-day default or year ceiling; absent scope means all retained history.
export function normalizePublicTimeRange(input = {}, at = Date.now()) {
  const today = new Date(at).toISOString().slice(0, 10);
  const units = ["periodDays", "periodMonths", "periodYears"].filter(key => input[key] !== undefined);
  const explicit = input.startDate !== undefined || input.endDate !== undefined;
  if (units.length > 1 || (units.length && explicit) || (input.allTime === true && (units.length || explicit))) throw new Error("Choose allTime, one lookback unit, or an explicit date range");
  if (input.allTime === false && !units.length && !explicit) throw new Error("Specify the requested timeframe or use allTime:true");
  let start = null;
  let end = null;
  let period = "all_time";
  const requested = {};
  if (units.length) {
    const unit = units[0];
    const amount = input[unit];
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Lookback must be a positive safe integer");
    end = today;
    const date = dateValue(today);
    if (unit === "periodDays") date.setUTCDate(date.getUTCDate() - amount + 1);
    else {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      if (unit === "periodMonths") date.setUTCMonth(date.getUTCMonth() - amount);
      else date.setUTCFullYear(date.getUTCFullYear() - amount);
      if (!Number.isFinite(date.getTime())) throw new Error("Requested lookback exceeds supported calendar dates; use allTime for all recorded history");
      const month = date.getUTCMonth();
      const lastDay = new Date(date.getTime());
      lastDay.setUTCMonth(month + 1, 0);
      date.setUTCDate(Math.min(day, lastDay.getUTCDate()));
    }
    start = isoDate(date);
    requested[unit] = amount;
    period = "lookback";
  } else if (explicit) {
    start = input.startDate === undefined ? null : isoDate(dateValue(input.startDate));
    end = input.endDate === undefined ? today : isoDate(dateValue(input.endDate));
    period = "date_range";
  }
  if (start && end && start > end) throw new Error("startDate must not be after endDate");
  return {
    period, allTime: period === "all_time", ...requested,
    periodDays: start && end ? Math.round((dateValue(end) - dateValue(start)) / DAY) + 1 : null,
    periodStart: start, periodEnd: end,
    periodStartDate: start, periodEndDate: end,
    dateBasis: "Inclusive Tautulli server-local calendar dates; relative ranges end on the current UTC date",
    coverage: "Recorded history retained by Tautulli; completed plays only"
  };
}

export function createPublicWatchtimeSummary({ api, configured = () => true, now = Date.now, timeoutMs = 25000, maxCalls = 20, pageSize = 1000 }) {
  const cursors = new Map();
  const ttlMs = 15 * 60_000;
  const scopeKeys = ["allTime", "periodDays", "periodMonths", "periodYears", "startDate", "endDate", "title", "mediaType", "year"];
  const canonicalScope = (input, at) => {
    const title = String(input.title || "").trim();
    if (input.year !== undefined && !title) throw new Error("year disambiguates an exact title; supply title or a date range");
    return { title, mediaType: input.mediaType || null, year: publicYear(input.year), range: normalizePublicTimeRange(input, at) };
  };
  const sameScope = (left, right) => left.title === right.title && left.mediaType === right.mediaType && left.year === right.year
    && left.range.periodStartDate === right.range.periodStartDate && left.range.periodEndDate === right.range.periodEndDate;
  const save = state => {
    for (const [key, entry] of cursors) if (entry.expires <= now()) cursors.delete(key);
    while (cursors.size >= 100) cursors.delete(cursors.keys().next().value);
    const cursor = `watchtime_${randomBytes(18).toString("hex")}`;
    cursors.set(cursor, { expires: now() + ttlMs, state: structuredClone(state) });
    return cursor;
  };
  return async (input = {}) => {
    if (!configured()) return { configured: false, available: false };
    const started = now();
    let state;
    if (input.cursor) {
      const entry = cursors.get(input.cursor);
      if (!entry || entry.expires <= started) throw new Error("Watch-time cursor expired or unavailable; restart the same requested scope");
      state = structuredClone(entry.state);
      if (scopeKeys.some(key => input[key] !== undefined) && !sameScope(state.scope, canonicalScope(input, state.started))) throw new Error("Watch-time cursor does not match the requested scope");
    } else {
      state = { scope: canonicalScope(input, started), started, offset: 0, expectedRows: null, playCount: 0, totalWatchSeconds: 0, invalidDuration: false };
    }
    const { scope } = state;
    const deadline = started + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    let requests = 0;
    let complete = false;
    let reason = null;
    const query = {
      // https://github.com/Tautulli/Tautulli/wiki/Tautulli-API-Reference#get_history
      // Tautulli documents both after and before as inclusive calendar dates.
      grouping: 0, include_activity: 0, order_column: "date", order_dir: "asc",
      ...(scope.range.periodStartDate ? { after: scope.range.periodStartDate } : {}),
      ...(scope.range.periodEndDate ? { before: scope.range.periodEndDate } : {}),
      ...(scope.title ? { search: scope.title } : {}),
      ...(scope.mediaType ? { media_type: scope.mediaType === "tv" ? "episode" : "movie" } : {})
    };
    const exhausted = () => requests >= maxCalls || signal.aborted || now() >= deadline;
    const read = async (offset, length) => {
      if (exhausted()) throw new Error("Aggregate work budget exhausted");
      requests++;
      return api("get_history", { query: { ...query, start: offset, length }, signal, timeoutMs: Math.max(1, deadline - now()) });
    };
    const count = value => value !== null && value !== undefined && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    try {
      // total_duration has the date/media filters but not the global search
      // text. It is exact and efficient for library totals, never title totals.
      if (!scope.title && !input.cursor) {
        const summary = await read(0, 1);
        const plays = count(summary?.recordsFiltered);
        const seconds = publicDurationSeconds(summary?.total_duration);
        if (plays !== null && seconds !== null) {
          state.playCount = plays;
          state.totalWatchSeconds = seconds;
          complete = true;
        }
      }
      while (!complete && !exhausted()) {
        const requested = state.expectedRows === null ? pageSize : Math.min(pageSize, Math.max(0, state.expectedRows - state.offset));
        if (!requested) { complete = true; break; }
        const page = await read(state.offset, requested);
        const rows = tableRows(page);
        if (!rows) { reason = "invalid_history_response"; break; }
        const total = count(page?.recordsFiltered);
        if (state.expectedRows !== null && total !== null && total !== state.expectedRows) { reason = "history_changed"; break; }
        if (state.expectedRows === null) state.expectedRows = total;
        if (rows.length > requested) { reason = "invalid_pagination"; break; }
        for (const row of rows) {
          if (!tautulliPublicHistoryMatches(row, scope)) continue;
          state.playCount++;
          const duration = publicDurationSeconds(row?.duration);
          if (duration === null) state.invalidDuration = true;
          else if (Number.isSafeInteger(state.totalWatchSeconds + duration)) state.totalWatchSeconds += duration;
          else state.invalidDuration = true;
        }
        state.offset += rows.length;
        if (state.expectedRows !== null ? state.offset >= state.expectedRows : rows.length < requested) { complete = true; break; }
        if (!rows.length) { reason = "incomplete_upstream_page"; break; }
      }
      if (!complete && !reason) reason = "work_budget_exhausted";
    } catch {
      reason = exhausted() ? "work_budget_exhausted" : "upstream_unavailable";
    }
    if (state.invalidDuration) { complete = false; reason = "unavailable_durations"; }
    const canResume = ["work_budget_exhausted", "upstream_unavailable"].includes(reason);
    const nextCursor = canResume ? save(state) : null;
    return {
      configured: true, available: complete || state.offset > 0, generatedAt: new Date(now()).toISOString(),
      ...scope.range, scope: scope.title ? "title" : "library", mediaType: scope.mediaType || "all",
      ...(scope.title ? { matched: state.playCount > 0 ? true : complete ? false : null } : {}),
      playCount: state.playCount, totalWatchSeconds: state.totalWatchSeconds,
      complete, partial: !complete, ...(reason ? { incompleteReason: reason } : {}),
      scannedRows: state.offset, ...(state.expectedRows === null ? {} : { expectedMatchingRows: state.expectedRows }),
      ...(nextCursor ? { nextCursor, continuation: "Resume with cursor. Totals are cumulative; replace previous totals, never add them." } : {}),
      requestCount: requests
    };
  };
}

