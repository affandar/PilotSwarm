import { describe, it, expect } from "vitest";
import {
    normalizeCronAtInput,
    computeCronAtNextFire,
    classifyRecurrence,
    isValidTimezone,
    describeCronAt,
} from "../../src/cron-at.ts";

describe("cron_at: timezone validation", () => {
    it("accepts common IANA zones", () => {
        expect(isValidTimezone("UTC")).toBe(true);
        expect(isValidTimezone("America/Los_Angeles")).toBe(true);
        expect(isValidTimezone("America/New_York")).toBe(true);
        expect(isValidTimezone("Europe/London")).toBe(true);
    });
    it("rejects bogus zones", () => {
        expect(isValidTimezone("Not/A/Zone")).toBe(false);
        expect(isValidTimezone("")).toBe(false);
        expect(isValidTimezone("UTC+5")).toBe(false);
    });
});

describe("cron_at: input normalization", () => {
    it("requires minute", () => {
        const r = normalizeCronAtInput({ tz: "UTC", reason: "x" });
        expect(r.ok).toBe(false);
    });
    it("requires tz", () => {
        const r = normalizeCronAtInput({ minute: 0, reason: "x" });
        expect(r.ok).toBe(false);
    });
    it("requires non-blank reason", () => {
        const r = normalizeCronAtInput({ minute: 0, tz: "UTC", reason: "   " });
        expect(r.ok).toBe(false);
    });
    it("rejects minute outside 0-59", () => {
        expect(normalizeCronAtInput({ minute: -1, tz: "UTC", reason: "r" }).ok).toBe(false);
        expect(normalizeCronAtInput({ minute: 60, tz: "UTC", reason: "r" }).ok).toBe(false);
    });
    it("rejects hour outside 0-23", () => {
        expect(normalizeCronAtInput({ minute: 0, hour: 24, tz: "UTC", reason: "r" }).ok).toBe(false);
    });
    it("rejects day_of_week + day_of_month combined", () => {
        const r = normalizeCronAtInput({ minute: 0, hour: 0, day_of_week: 1, day_of_month: 1, tz: "UTC", reason: "r" });
        expect(r.ok).toBe(false);
    });
    it("requires hour when day_of_week or day_of_month is set", () => {
        expect(normalizeCronAtInput({ minute: 0, day_of_week: 1, tz: "UTC", reason: "r" }).ok).toBe(false);
        expect(normalizeCronAtInput({ minute: 0, day_of_month: 5, tz: "UTC", reason: "r" }).ok).toBe(false);
    });
    it("rejects invalid timezone", () => {
        expect(normalizeCronAtInput({ minute: 0, tz: "Bogus/Zone", reason: "r" }).ok).toBe(false);
    });
    it("rejects non-positive max_fires", () => {
        expect(normalizeCronAtInput({ minute: 0, tz: "UTC", reason: "r", max_fires: 0 }).ok).toBe(false);
        expect(normalizeCronAtInput({ minute: 0, tz: "UTC", reason: "r", max_fires: -1 }).ok).toBe(false);
    });
    it("accepts a valid hourly schedule", () => {
        const r = normalizeCronAtInput({ minute: 5, tz: "UTC", reason: "ping" });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.schedule.minute).toBe(5);
            expect(r.schedule.tz).toBe("UTC");
            expect(r.schedule.firesCompleted).toBe(0);
        }
    });
    it("accepts a daily schedule", () => {
        const r = normalizeCronAtInput({ minute: 0, hour: 2, tz: "UTC", reason: "audit" });
        expect(r.ok).toBe(true);
    });
    it("accepts a weekly schedule (Mon 09:00 ET)", () => {
        const r = normalizeCronAtInput({ minute: 0, hour: 9, day_of_week: 1, tz: "America/New_York", reason: "weekly review" });
        expect(r.ok).toBe(true);
    });
    it("accepts a monthly schedule (day 1 at 04:00)", () => {
        const r = normalizeCronAtInput({ minute: 0, hour: 4, day_of_month: 1, tz: "UTC", reason: "monthly billing" });
        expect(r.ok).toBe(true);
    });
});

describe("cron_at: recurrence classification", () => {
    it("infers recurrence from fields", () => {
        expect(classifyRecurrence({ hour: undefined })).toBe("hourly");
        expect(classifyRecurrence({ hour: 2 })).toBe("daily");
        expect(classifyRecurrence({ hour: 2, dayOfWeek: 3 })).toBe("weekly");
        expect(classifyRecurrence({ hour: 2, dayOfMonth: 15 })).toBe("monthly");
    });
});

describe("cron_at: describeCronAt", () => {
    it("formats human-readable strings", () => {
        expect(describeCronAt({ minute: 5, tz: "UTC" })).toContain("hourly");
        expect(describeCronAt({ minute: 0, hour: 2, tz: "UTC" })).toContain("daily");
        expect(describeCronAt({ minute: 0, hour: 9, dayOfWeek: 1, tz: "America/New_York" })).toContain("Mon");
        expect(describeCronAt({ minute: 0, hour: 4, dayOfMonth: 1, tz: "UTC" })).toContain("day 1");
    });
});

describe("cron_at: next fire computation (UTC)", () => {
    // Anchor: 2026-05-17T01:23:45Z
    const anchor = Date.UTC(2026, 4, 17, 1, 23, 45);

    it("hourly fires at the next HH:MM", () => {
        const r = computeCronAtNextFire({ minute: 30, tz: "UTC" }, anchor);
        // Next :30 is 01:30 UTC same day.
        const d = new Date(r.nextFireAtMs);
        expect(d.getUTCHours()).toBe(1);
        expect(d.getUTCMinutes()).toBe(30);
    });

    it("hourly rolls to next hour when current minute is past", () => {
        const past = Date.UTC(2026, 4, 17, 1, 35, 0);
        const r = computeCronAtNextFire({ minute: 30, tz: "UTC" }, past);
        const d = new Date(r.nextFireAtMs);
        expect(d.getUTCHours()).toBe(2);
        expect(d.getUTCMinutes()).toBe(30);
    });

    it("daily fires at the target hour:minute the next day if past", () => {
        const past = Date.UTC(2026, 4, 17, 3, 0, 0);
        const r = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, past);
        const d = new Date(r.nextFireAtMs);
        expect(d.getUTCDate()).toBe(18);
        expect(d.getUTCHours()).toBe(2);
        expect(d.getUTCMinutes()).toBe(0);
    });

    it("daily fires later today when target is still in the future", () => {
        const before = Date.UTC(2026, 4, 17, 1, 0, 0);
        const r = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, before);
        const d = new Date(r.nextFireAtMs);
        expect(d.getUTCDate()).toBe(17);
        expect(d.getUTCHours()).toBe(2);
    });

    it("weekly Mon 09:00 ET picks the next Monday", () => {
        // Anchor: Sunday 2026-05-17 12:00Z (~ 08:00 ET, Sun)
        const sun = Date.UTC(2026, 4, 17, 12, 0, 0);
        const r = computeCronAtNextFire(
            { minute: 0, hour: 9, dayOfWeek: 1, tz: "America/New_York" },
            sun,
        );
        // Next Monday 09:00 ET == 13:00 UTC during EDT.
        const d = new Date(r.nextFireAtMs);
        expect(d.getUTCDay()).toBe(1); // Monday
        expect(r.localTime).toContain("09:00");
    });

    it("monthly day-31 skips months without a 31st", () => {
        // Anchor: 2026-02-01 (Feb), schedule day 31 hour 0 minute 0
        const feb = Date.UTC(2026, 1, 1, 0, 0, 0);
        const r = computeCronAtNextFire({ minute: 0, hour: 0, dayOfMonth: 31, tz: "UTC" }, feb);
        const d = new Date(r.nextFireAtMs);
        // First month with a 31st on/after Feb 2026 is March.
        expect(d.getUTCMonth()).toBe(2); // March (0-indexed)
        expect(d.getUTCDate()).toBe(31);
        expect(r.skippedOccurrences).toBeGreaterThan(0);
    });

    it("produces a stable occurrence key per fire", () => {
        const r1 = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, anchor);
        const r2 = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, anchor);
        expect(r1.occurrenceKey).toBe(r2.occurrenceKey);
    });

    it("skips a matched lastOccurrenceKey (fall-back guard)", () => {
        const r1 = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, anchor);
        const r2 = computeCronAtNextFire({ minute: 0, hour: 2, tz: "UTC" }, anchor, r1.occurrenceKey);
        expect(r2.nextFireAtMs).toBeGreaterThan(r1.nextFireAtMs);
        expect(r2.occurrenceKey).not.toBe(r1.occurrenceKey);
    });
});

describe("cron_at: DST spring-forward", () => {
    // America/New_York spring forward 2026-03-08 02:00 -> 03:00.
    // Schedule daily 02:30 ET: on 2026-03-08 that time does not exist and should be skipped.
    it("skips non-existent local time during spring forward", () => {
        // Anchor just before the gap window in UTC.
        const beforeGap = Date.parse("2026-03-08T05:00:00Z"); // midnight ET
        const r = computeCronAtNextFire(
            { minute: 30, hour: 2, tz: "America/New_York" },
            beforeGap,
        );
        const d = new Date(r.nextFireAtMs);
        // The skipped 02:30 ET fire should jump to the next day (2026-03-09 02:30 ET).
        // Use the local-time string to verify it didn't accept a non-existent time.
        expect(r.localTime).toContain("02:30");
        // It should be 2026-03-09, not 03-08.
        const iso = d.toISOString();
        expect(iso.startsWith("2026-03-09")).toBe(true);
        expect(r.skippedOccurrences).toBeGreaterThanOrEqual(1);
    });
});

describe("cron_at: DST fall-back", () => {
    // America/New_York falls back on 2026-11-01, so 01:30 occurs twice.
    it("fires once for a repeated local wall-clock label", () => {
        const beforeFirstLocal0130 = Date.parse("2026-11-01T04:00:00Z"); // midnight EDT
        const first = computeCronAtNextFire(
            { minute: 30, hour: 1, tz: "America/New_York" },
            beforeFirstLocal0130,
        );
        const second = computeCronAtNextFire(
            { minute: 30, hour: 1, tz: "America/New_York" },
            beforeFirstLocal0130,
            first.occurrenceKey,
        );
        expect(first.localTime).toContain("2026-11-01T01:30");
        expect(second.occurrenceKey).not.toBe(first.occurrenceKey);
        expect(second.localTime).toContain("2026-11-02T01:30");
    });
});
