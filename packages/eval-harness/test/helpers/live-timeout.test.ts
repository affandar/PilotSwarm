import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertLiveAxisWithinCap,
    computeLiveTestTimeout,
    LIVE_MAX_MODELS,
    LIVE_MAX_TRIALS,
    parseEnvInt,
    parseEnvList,
} from "./live-timeout.js";

describe("computeLiveTestTimeout", () => {
    it("applies the documented formula for typical inputs", () => {
        // 240s × 4 cells + 60s + 30s = 1_050_000
        expect(
            computeLiveTestTimeout({ perCellTimeoutMs: 240_000, cells: 4 }),
        ).toBe(240_000 * 4 + 60_000 + 30_000);
    });

    it("respects custom setupHeadroomMs and slackMs overrides", () => {
        expect(
            computeLiveTestTimeout({
                perCellTimeoutMs: 100_000,
                cells: 2,
                setupHeadroomMs: 10_000,
                slackMs: 5_000,
            }),
        ).toBe(100_000 * 2 + 10_000 + 5_000);
    });

    it("clamps to minTimeoutMs when computed value is smaller", () => {
        // 1ms × 1 cell + 0 + 0 = 1ms < 60_000 default → clamps to 60_000
        expect(
            computeLiveTestTimeout({
                perCellTimeoutMs: 1,
                cells: 1,
                setupHeadroomMs: 0,
                slackMs: 0,
            }),
        ).toBe(60_000);
    });

    it("scales linearly with cells (single-cell vs many-cell)", () => {
        const single = computeLiveTestTimeout({ perCellTimeoutMs: 300_000, cells: 1 });
        const ten = computeLiveTestTimeout({ perCellTimeoutMs: 300_000, cells: 10 });
        expect(ten - single).toBe(300_000 * 9);
    });

    it("rejects non-positive perCellTimeoutMs", () => {
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: 0, cells: 1 }),
        ).toThrow(/perCellTimeoutMs must be > 0/);
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: -1, cells: 1 }),
        ).toThrow(/perCellTimeoutMs must be > 0/);
    });

    it("rejects non-integer or non-positive cells", () => {
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: 1000, cells: 0 }),
        ).toThrow(/cells must be a positive integer/);
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: 1000, cells: 1.5 }),
        ).toThrow(/cells must be a positive integer/);
    });

    it("rejects negative slack/headroom", () => {
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: 1000, cells: 1, slackMs: -1 }),
        ).toThrow(/slackMs must be >= 0/);
        expect(() =>
            computeLiveTestTimeout({ perCellTimeoutMs: 1000, cells: 1, setupHeadroomMs: -1 }),
        ).toThrow(/setupHeadroomMs must be >= 0/);
    });
});

describe("parseEnvList", () => {
    const KEY = "PILOTSWARM_TEST_LIVE_TIMEOUT_LIST";
    afterEach(() => {
        delete process.env[KEY];
    });

    it("returns fallback for unset / empty env", () => {
        expect(parseEnvList(KEY, ["a", "b"])).toEqual(["a", "b"]);
        process.env[KEY] = "";
        expect(parseEnvList(KEY, ["x"])).toEqual(["x"]);
    });

    it("splits comma-separated values and trims whitespace", () => {
        process.env[KEY] = " a , b ,  c";
        expect(parseEnvList(KEY)).toEqual(["a", "b", "c"]);
    });

    it("returns a copy of the fallback (mutation-safe)", () => {
        const fb = ["a"];
        const out = parseEnvList(KEY, fb);
        out.push("b");
        expect(fb).toEqual(["a"]);
    });
});

describe("parseEnvInt", () => {
    const KEY = "PILOTSWARM_TEST_LIVE_TIMEOUT_INT";
    afterEach(() => {
        delete process.env[KEY];
    });

    it("returns fallback for unset / empty env", () => {
        expect(parseEnvInt(KEY, 7)).toBe(7);
        process.env[KEY] = "";
        expect(parseEnvInt(KEY, 7)).toBe(7);
    });

    it("parses valid non-negative integers", () => {
        process.env[KEY] = "0";
        expect(parseEnvInt(KEY, 99)).toBe(0);
        process.env[KEY] = "5";
        expect(parseEnvInt(KEY, 99)).toBe(5);
    });

    it("throws on non-integer / negative / garbage values", () => {
        process.env[KEY] = "foo";
        expect(() => parseEnvInt(KEY, 1)).toThrow(/Invalid/);
        process.env[KEY] = "-1";
        expect(() => parseEnvInt(KEY, 1)).toThrow(/Invalid/);
        process.env[KEY] = "1.5";
        expect(() => parseEnvInt(KEY, 1)).toThrow(/Invalid/);
    });
});

describe("assertLiveAxisWithinCap", () => {
    it("permits values at or below the cap", () => {
        expect(() => assertLiveAxisWithinCap("X", 0, LIVE_MAX_MODELS)).not.toThrow();
        expect(() =>
            assertLiveAxisWithinCap("X", LIVE_MAX_MODELS, LIVE_MAX_MODELS),
        ).not.toThrow();
    });

    it("rejects values above the cap with actionable message", () => {
        expect(() =>
            assertLiveAxisWithinCap("LIVE_MATRIX_MODELS", LIVE_MAX_MODELS + 1, LIVE_MAX_MODELS),
        ).toThrow(/exceeds the LIVE harness cap/);
    });

    it("exposes documented LIVE caps as constants", () => {
        // Stable upper bounds — bumping these is an intentional review action.
        expect(LIVE_MAX_MODELS).toBe(16);
        expect(LIVE_MAX_TRIALS).toBe(10);
    });
});

describe("env+helper integration: representative LIVE matrix shape", () => {
    const KEY_MODELS = "PILOTSWARM_LT_INT_MODELS";
    const KEY_TRIALS = "PILOTSWARM_LT_INT_TRIALS";
    beforeEach(() => {
        delete process.env[KEY_MODELS];
        delete process.env[KEY_TRIALS];
    });
    afterEach(() => {
        delete process.env[KEY_MODELS];
        delete process.env[KEY_TRIALS];
    });

    it("produces a sensible timeout from env-derived models × trials", () => {
        process.env[KEY_MODELS] = "m1,m2,m3";
        process.env[KEY_TRIALS] = "2";
        const models = parseEnvList(KEY_MODELS);
        const trials = parseEnvInt(KEY_TRIALS, 1);
        assertLiveAxisWithinCap(KEY_MODELS, models.length, LIVE_MAX_MODELS);
        assertLiveAxisWithinCap(KEY_TRIALS, trials, LIVE_MAX_TRIALS);
        const timeout = computeLiveTestTimeout({
            perCellTimeoutMs: 240_000,
            cells: models.length * trials,
        });
        // 3 × 2 × 240_000 + 60_000 + 30_000 = 1_530_000
        expect(timeout).toBe(1_530_000);
    });
});
