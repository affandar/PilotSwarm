/**
 * Wall-clock cron schedule helper.
 *
 * Pure helpers for parsing/validating `cron_at` schedules and computing
 * the next deterministic fire time for a given anchor (`afterUtcMs`).
 *
 * The orchestration MUST call `computeCronAtNextFire` through a recorded
 * activity so that replay reuses the original next-fire result even if
 * tzdata or the helper implementation changes later.
 *
 * This module intentionally avoids any I/O and any non-deterministic state
 * (clock reads, randomness) so it is safe to call from activity code.
 *
 * Recurrence inference:
 *   - minute                                 → hourly
 *   - minute + hour                          → daily
 *   - minute + hour + dayOfWeek (0-6, Sun=0) → weekly
 *   - minute + hour + dayOfMonth (1-31)      → monthly
 *
 * Timezone handling uses `Intl.DateTimeFormat` with the `ianaName` timezone
 * to determine the local wall-clock parts for a candidate UTC instant. This
 * works for any IANA zone supported by the running Node.js runtime.
 *
 * @module
 */

/**
 * Serialized `cron_at` schedule. Mirrors the proposed orchestration state shape.
 *
 * Optional fields (`hour`, `dayOfWeek`, `dayOfMonth`, `maxFires`,
 * `lastOccurrenceKey`, `nextFireAtMs`, `nextOccurrenceKey`) are absent unless set.
 */
export interface CronAtSchedule {
    minute: number;
    hour?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    tz: string;
    reason: string;
    maxFires?: number;
    firesCompleted: number;
    lastOccurrenceKey?: string;
    nextFireAtMs?: number;
    nextOccurrenceKey?: string;
}

/** User-supplied input fields accepted by the `cron_at` tool. */
export interface CronAtInput {
    minute?: number | string;
    hour?: number | string;
    day_of_week?: number | string;
    day_of_month?: number | string;
    tz?: string;
    max_fires?: number | string;
    reason?: string;
}

/** Successful next-fire computation, returned by `computeCronAtNextFire`. */
export interface CronAtNextFire {
    nextFireAtMs: number;
    occurrenceKey: string;
    localTime: string;
    skippedOccurrences: number;
}

/** Validation/normalization result returned by `normalizeCronAtInput`. */
export type CronAtNormalizeResult =
    | { ok: true; schedule: Omit<CronAtSchedule, "firesCompleted"> & { firesCompleted: 0 } }
    | { ok: false; error: string };

const VALID_RECURRENCES = ["hourly", "daily", "weekly", "monthly"] as const;
export type CronAtRecurrence = (typeof VALID_RECURRENCES)[number];

/** Classify a normalized schedule into its inferred recurrence kind. */
export function classifyRecurrence(s: Pick<CronAtSchedule, "hour" | "dayOfWeek" | "dayOfMonth">): CronAtRecurrence {
    if (s.hour === undefined) return "hourly";
    if (s.dayOfWeek !== undefined) return "weekly";
    if (s.dayOfMonth !== undefined) return "monthly";
    return "daily";
}

/** True if `tz` is a valid IANA timezone according to the host runtime. */
export function isValidTimezone(tz: string): boolean {
    if (!tz || typeof tz !== "string") return false;
    try {
        // Throws RangeError if the tz is not recognized.
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function isInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v);
}

function coerceInt(v: unknown): number | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v === "number") return Number.isInteger(v) ? v : NaN;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
    return NaN;
}

/**
 * Validate and normalize raw `cron_at` tool input.
 *
 * On success, returns `{ ok: true, schedule }` with `firesCompleted = 0`.
 * On failure, returns `{ ok: false, error }` with a human-readable explanation
 * suitable for surfacing back to the LLM.
 */
export function normalizeCronAtInput(input: CronAtInput): CronAtNormalizeResult {
    const minute = coerceInt(input.minute);
    if (minute === undefined) return { ok: false, error: "cron_at requires 'minute'." };
    if (minute === undefined || !isInt(minute)) return { ok: false, error: "cron_at 'minute' must be an integer." };
    if (minute < 0 || minute > 59) return { ok: false, error: "cron_at 'minute' must be 0-59." };

    const hourRaw = coerceInt(input.hour);
    let hour: number | undefined;
    if (input.hour !== undefined && input.hour !== null && input.hour !== "") {
        if (!isInt(hourRaw)) return { ok: false, error: "cron_at 'hour' must be an integer." };
        if (hourRaw! < 0 || hourRaw! > 23) return { ok: false, error: "cron_at 'hour' must be 0-23." };
        hour = hourRaw!;
    }

    const dowRaw = coerceInt(input.day_of_week);
    let dayOfWeek: number | undefined;
    if (input.day_of_week !== undefined && input.day_of_week !== null && input.day_of_week !== "") {
        if (!isInt(dowRaw)) return { ok: false, error: "cron_at 'day_of_week' must be an integer (0=Sunday)." };
        if (dowRaw! < 0 || dowRaw! > 6) return { ok: false, error: "cron_at 'day_of_week' must be 0-6 (Sunday=0)." };
        dayOfWeek = dowRaw!;
    }

    const domRaw = coerceInt(input.day_of_month);
    let dayOfMonth: number | undefined;
    if (input.day_of_month !== undefined && input.day_of_month !== null && input.day_of_month !== "") {
        if (!isInt(domRaw)) return { ok: false, error: "cron_at 'day_of_month' must be an integer." };
        if (domRaw! < 1 || domRaw! > 31) return { ok: false, error: "cron_at 'day_of_month' must be 1-31." };
        dayOfMonth = domRaw!;
    }

    if (dayOfWeek !== undefined && dayOfMonth !== undefined) {
        return { ok: false, error: "cron_at cannot combine 'day_of_week' and 'day_of_month'." };
    }
    if ((dayOfWeek !== undefined || dayOfMonth !== undefined) && hour === undefined) {
        return { ok: false, error: "cron_at 'day_of_week' / 'day_of_month' require 'hour'." };
    }

    const tz = typeof input.tz === "string" ? input.tz.trim() : "";
    if (!tz) return { ok: false, error: "cron_at requires 'tz' (IANA timezone, e.g. 'UTC' or 'America/Los_Angeles')." };
    if (!isValidTimezone(tz)) return { ok: false, error: `cron_at 'tz' is not a recognized IANA timezone: ${tz}` };

    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) return { ok: false, error: "cron_at requires a non-empty 'reason'." };

    let maxFires: number | undefined;
    if (input.max_fires !== undefined && input.max_fires !== null && input.max_fires !== "") {
        const mfRaw = coerceInt(input.max_fires);
        if (!isInt(mfRaw) || (mfRaw as number) <= 0) {
            return { ok: false, error: "cron_at 'max_fires' must be a positive integer." };
        }
        maxFires = mfRaw as number;
    }

    return {
        ok: true,
        schedule: {
            minute,
            ...(hour !== undefined ? { hour } : {}),
            ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
            ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
            tz,
            reason,
            ...(maxFires !== undefined ? { maxFires } : {}),
            firesCompleted: 0,
        },
    };
}

/** Extract local wall-clock parts for `utcMs` in `tz` (no DST disambiguation here). */
interface LocalParts {
    year: number;
    month: number; // 1-12
    day: number;   // 1-31
    hour: number;
    minute: number;
    second: number;
    // 0=Sunday..6=Saturday
    weekday: number;
}

const PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
    let f = PART_FORMATTER_CACHE.get(tz);
    if (f) return f;
    f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
    });
    PART_FORMATTER_CACHE.set(tz, f);
    return f;
}

const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

function getLocalParts(utcMs: number, tz: string): LocalParts {
    const parts = getFormatter(tz).formatToParts(new Date(utcMs));
    let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, weekday = 0;
    for (const p of parts) {
        switch (p.type) {
            case "year": year = Number(p.value); break;
            case "month": month = Number(p.value); break;
            case "day": day = Number(p.value); break;
            case "hour": hour = Number(p.value) === 24 ? 0 : Number(p.value); break;
            case "minute": minute = Number(p.value); break;
            case "second": second = Number(p.value); break;
            case "weekday": weekday = WEEKDAY_MAP[p.value] ?? 0; break;
        }
    }
    return { year, month, day, hour, minute, second, weekday };
}

/**
 * Find the UTC ms timestamp whose local wall-clock matches `target` in `tz`.
 *
 * Returns `null` if no such instant exists (DST spring-forward gap).
 * For DST fall-back ambiguity, returns the earlier (pre-transition) instant.
 *
 * Uses bisection over a 2-day window around the naive guess, anchored by the
 * IANA-zone formatter. This is O(log n) iterations and is independent of
 * absolute time so it stays deterministic.
 */
function findUtcForLocalWallTime(target: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): number | null {
    // Naive guess: treat the target as UTC.
    const naive = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0);

    // Search a +/- 26h window around the naive guess to cover any offset/DST gap.
    let lo = naive - 26 * 60 * 60 * 1000;
    let hi = naive + 26 * 60 * 60 * 1000;

    // We want the smallest utcMs whose local parts >= target. Then check exact match.
    const cmp = (utcMs: number): number => {
        const p = getLocalParts(utcMs, tz);
        // Compare (y, m, d, h, min) lexicographically vs target.
        if (p.year !== target.year) return p.year - target.year;
        if (p.month !== target.month) return p.month - target.month;
        if (p.day !== target.day) return p.day - target.day;
        if (p.hour !== target.hour) return p.hour - target.hour;
        return p.minute - target.minute;
    };

    // Ensure lo < target < hi or saturate.
    if (cmp(lo) > 0) return null;
    if (cmp(hi) < 0) return null;

    // Binary search for the smallest minute-aligned utcMs with cmp >= 0.
    while (lo + 60000 < hi) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
        if (mid === lo) break;
        if (cmp(mid) < 0) lo = mid;
        else hi = mid;
    }
    // hi is now the smallest minute boundary with cmp(hi) >= 0.
    if (cmp(hi) !== 0) return null; // exact local time does not exist (DST gap)
    // Snap to minute boundary in case of off-by-one in iteration.
    const snapped = Math.floor(hi / 60000) * 60000;
    if (cmp(snapped) !== 0) return null;
    return snapped;
}

/** Days in a given (1-12) month for a year, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Compute the next deterministic fire time for `schedule` strictly after `afterUtcMs`.
 *
 * This is a pure function. Call it from inside an activity to record the result
 * in durable history (the proposal contract).
 *
 * If `lastOccurrenceKey` matches the candidate occurrence key (DST fall-back
 * duplicate wall-time), the next candidate is selected so the same local
 * label does not fire twice.
 */
export function computeCronAtNextFire(
    schedule: Pick<CronAtSchedule, "minute" | "hour" | "dayOfWeek" | "dayOfMonth" | "tz">,
    afterUtcMs: number,
    lastOccurrenceKey?: string,
): CronAtNextFire {
    const recurrence = classifyRecurrence(schedule);
    const tz = schedule.tz;

    // Anchor candidate at the local wall-clock for `afterUtcMs`.
    const afterLocal = getLocalParts(afterUtcMs, tz);

    let skipped = 0;
    // Walk forward up to ~370 attempts to cover any leap-year/short-month skipping.
    let candidate: { year: number; month: number; day: number; hour: number; minute: number } = {
        year: afterLocal.year,
        month: afterLocal.month,
        day: afterLocal.day,
        hour: recurrence === "hourly" ? afterLocal.hour : (schedule.hour ?? 0),
        minute: schedule.minute,
    };

    // Step generator for the candidate forward by one recurrence unit.
    const step = () => {
        if (recurrence === "hourly") {
            // advance by 1 hour
            const t = Date.UTC(candidate.year, candidate.month - 1, candidate.day, candidate.hour, 0) + 60 * 60 * 1000;
            const d = new Date(t);
            candidate.year = d.getUTCFullYear();
            candidate.month = d.getUTCMonth() + 1;
            candidate.day = d.getUTCDate();
            candidate.hour = d.getUTCHours();
        } else if (recurrence === "daily") {
            const t = Date.UTC(candidate.year, candidate.month - 1, candidate.day) + 24 * 60 * 60 * 1000;
            const d = new Date(t);
            candidate.year = d.getUTCFullYear();
            candidate.month = d.getUTCMonth() + 1;
            candidate.day = d.getUTCDate();
        } else if (recurrence === "weekly") {
            const t = Date.UTC(candidate.year, candidate.month - 1, candidate.day) + 24 * 60 * 60 * 1000;
            const d = new Date(t);
            candidate.year = d.getUTCFullYear();
            candidate.month = d.getUTCMonth() + 1;
            candidate.day = d.getUTCDate();
        } else {
            // monthly: advance to next month, same day_of_month target
            const m = candidate.month + 1;
            candidate.year = m > 12 ? candidate.year + 1 : candidate.year;
            candidate.month = m > 12 ? 1 : m;
            candidate.day = schedule.dayOfMonth ?? candidate.day;
        }
    };

    // Initial alignment.
    if (recurrence === "monthly" && schedule.dayOfMonth !== undefined) {
        candidate.day = schedule.dayOfMonth;
    }
    if (recurrence === "weekly" && schedule.dayOfWeek !== undefined) {
        // Walk to the right weekday (>=0..6 forward) without changing other parts.
        // We need a real weekday for the candidate; if (year, month, day) is invalid
        // (rare in initial assignment), fall back to today.
        const todayWeekday = afterLocal.weekday;
        const targetWeekday = schedule.dayOfWeek;
        const daysAhead = (targetWeekday - todayWeekday + 7) % 7;
        if (daysAhead > 0) {
            const t = Date.UTC(candidate.year, candidate.month - 1, candidate.day) + daysAhead * 24 * 60 * 60 * 1000;
            const d = new Date(t);
            candidate.year = d.getUTCFullYear();
            candidate.month = d.getUTCMonth() + 1;
            candidate.day = d.getUTCDate();
        }
    }

    for (let i = 0; i < 400; i++) {
        // Validate dayOfMonth fits in the candidate month for monthly schedules.
        if (recurrence === "monthly" && schedule.dayOfMonth !== undefined) {
            const dim = daysInMonth(candidate.year, candidate.month);
            if (schedule.dayOfMonth > dim) {
                skipped++;
                step();
                continue;
            }
        }

        const utcMs = findUtcForLocalWallTime(candidate, tz);
        if (utcMs === null) {
            // DST gap: skip this occurrence.
            skipped++;
            step();
            continue;
        }

        if (utcMs <= afterUtcMs) {
            step();
            continue;
        }

        // Build occurrence key from the local wall-clock label + recurrence.
        const occurrenceKey = buildOccurrenceKey(candidate, recurrence, tz, schedule);
        if (lastOccurrenceKey && occurrenceKey === lastOccurrenceKey) {
            // Fall-back duplicate or stale key — skip.
            skipped++;
            step();
            continue;
        }

        // For weekly recurrence, ensure the weekday matches after the step.
        if (recurrence === "weekly" && schedule.dayOfWeek !== undefined) {
            const localCheck = getLocalParts(utcMs, tz);
            if (localCheck.weekday !== schedule.dayOfWeek) {
                step();
                continue;
            }
        }

        return {
            nextFireAtMs: utcMs,
            occurrenceKey,
            localTime: formatLocalTime(candidate, tz),
            skippedOccurrences: skipped,
        };
    }

    throw new Error(`cron_at: failed to find next fire within 400 candidate iterations for tz=${tz}`);
}

function buildOccurrenceKey(
    parts: { year: number; month: number; day: number; hour: number; minute: number },
    recurrence: CronAtRecurrence,
    tz: string,
    schedule: Pick<CronAtSchedule, "dayOfWeek" | "dayOfMonth">,
): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const ymd = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    const hm = `${pad(parts.hour)}:${pad(parts.minute)}`;
    const rec =
        recurrence === "hourly"
            ? "H"
            : recurrence === "daily"
            ? "D"
            : recurrence === "weekly"
            ? `W${schedule.dayOfWeek}`
            : `M${schedule.dayOfMonth}`;
    return `${rec}|${tz}|${ymd}T${hm}`;
}

function formatLocalTime(parts: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:00 ${tz}`;
}

/** Build a human-readable description for status surfaces and prompts. */
export function describeCronAt(schedule: Pick<CronAtSchedule, "minute" | "hour" | "dayOfWeek" | "dayOfMonth" | "tz">): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const recurrence = classifyRecurrence(schedule);
    const hour = schedule.hour ?? 0;
    const time = `${pad(hour)}:${pad(schedule.minute)} ${schedule.tz}`;
    switch (recurrence) {
        case "hourly":
            return `hourly at :${pad(schedule.minute)} (${schedule.tz})`;
        case "daily":
            return `daily at ${time}`;
        case "weekly": {
            const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            return `weekly on ${dayNames[schedule.dayOfWeek ?? 0]} at ${time}`;
        }
        case "monthly":
            return `monthly on day ${schedule.dayOfMonth} at ${time}`;
    }
}
