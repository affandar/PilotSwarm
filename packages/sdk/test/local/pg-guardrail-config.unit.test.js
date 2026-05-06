/**
 * Unit tests for buildPgGuardrailConfig env parsing.
 *
 * Does not require PostgreSQL — pure env-variable parsing logic.
 */

import { describe, it } from "vitest";
import { assertEqual, assert } from "../helpers/assertions.js";
import { buildPgGuardrailConfig } from "../../src/index.ts";

// ─── Defaults ────────────────────────────────────────────────────────────────

describe("buildPgGuardrailConfig defaults", () => {
    it("returns default max=10 when DB_POOL_MAX is absent", () => {
        const cfg = buildPgGuardrailConfig({});
        assertEqual(cfg.max, 10, "default pool max should be 10");
    });

    it("returns default connectionTimeoutMillis=5000 when absent", () => {
        const cfg = buildPgGuardrailConfig({});
        assertEqual(cfg.connectionTimeoutMillis, 5_000);
    });

    it("returns default idleTimeoutMillis=30000 when absent", () => {
        const cfg = buildPgGuardrailConfig({});
        assertEqual(cfg.idleTimeoutMillis, 30_000);
    });

    it("returns default query_timeout=15000 when absent", () => {
        const cfg = buildPgGuardrailConfig({});
        assertEqual(cfg.query_timeout, 15_000);
    });

    it("omits statement_timeout when PG_STATEMENT_TIMEOUT_MS is absent", () => {
        const cfg = buildPgGuardrailConfig({});
        assert(!("statement_timeout" in cfg), "statement_timeout should be absent by default");
    });
});

// ─── Valid env values ─────────────────────────────────────────────────────────

describe("buildPgGuardrailConfig valid env values", () => {
    it("parses DB_POOL_MAX from env", () => {
        const cfg = buildPgGuardrailConfig({ DB_POOL_MAX: "25" });
        assertEqual(cfg.max, 25);
    });

    it("parses PG_CONNECTION_TIMEOUT_MS from env", () => {
        const cfg = buildPgGuardrailConfig({ PG_CONNECTION_TIMEOUT_MS: "8000" });
        assertEqual(cfg.connectionTimeoutMillis, 8_000);
    });

    it("parses PG_IDLE_TIMEOUT_MS from env", () => {
        const cfg = buildPgGuardrailConfig({ PG_IDLE_TIMEOUT_MS: "60000" });
        assertEqual(cfg.idleTimeoutMillis, 60_000);
    });

    it("parses PG_QUERY_TIMEOUT_MS from env", () => {
        const cfg = buildPgGuardrailConfig({ PG_QUERY_TIMEOUT_MS: "20000" });
        assertEqual(cfg.query_timeout, 20_000);
    });

    it("includes statement_timeout when PG_STATEMENT_TIMEOUT_MS is positive", () => {
        const cfg = buildPgGuardrailConfig({ PG_STATEMENT_TIMEOUT_MS: "25000" });
        assertEqual(cfg.statement_timeout, 25_000);
    });
});

// ─── Invalid / edge env values ────────────────────────────────────────────────

describe("buildPgGuardrailConfig invalid env values fall back to defaults", () => {
    it("uses default for DB_POOL_MAX=NaN string", () => {
        const cfg = buildPgGuardrailConfig({ DB_POOL_MAX: "bad" });
        assertEqual(cfg.max, 10);
    });

    it("uses default for DB_POOL_MAX=0 (below min=1)", () => {
        const cfg = buildPgGuardrailConfig({ DB_POOL_MAX: "0" });
        assertEqual(cfg.max, 10);
    });

    it("uses default for DB_POOL_MAX=-5 (negative)", () => {
        const cfg = buildPgGuardrailConfig({ DB_POOL_MAX: "-5" });
        assertEqual(cfg.max, 10);
    });

    it("uses default for PG_QUERY_TIMEOUT_MS=bad", () => {
        const cfg = buildPgGuardrailConfig({ PG_QUERY_TIMEOUT_MS: "abc" });
        assertEqual(cfg.query_timeout, 15_000);
    });

    it("uses default for PG_CONNECTION_TIMEOUT_MS=bad", () => {
        const cfg = buildPgGuardrailConfig({ PG_CONNECTION_TIMEOUT_MS: "" });
        assertEqual(cfg.connectionTimeoutMillis, 5_000);
    });

    it("omits statement_timeout when PG_STATEMENT_TIMEOUT_MS=0", () => {
        const cfg = buildPgGuardrailConfig({ PG_STATEMENT_TIMEOUT_MS: "0" });
        assert(!("statement_timeout" in cfg), "statement_timeout should be absent for 0");
    });

    it("omits statement_timeout when PG_STATEMENT_TIMEOUT_MS is non-numeric", () => {
        const cfg = buildPgGuardrailConfig({ PG_STATEMENT_TIMEOUT_MS: "none" });
        assert(!("statement_timeout" in cfg), "statement_timeout should be absent for non-numeric");
    });
});
