/**
 * Local test environment configuration.
 *
 * Provides schema isolation, temp directories, and database connectivity
 * for the local integration test suite.
 *
 * Requires PostgreSQL running locally (see docs/contributors/local-integration-test-plan.md).
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll } from "vitest";

// ─── Constants ───────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const TIMEOUT = 180_000;
const TEST_SCHEMA_PREFIX = "ps_test";

// ─── Schema Isolation ────────────────────────────────────────────

/**
 * Generate a unique schema name for test isolation.
 *
 * Format: `<prefix>_it_<timestamp>_<random>`
 * This prevents cross-test pollution.
 */
function sanitizeSuiteLabel(label) {
    return String(label || "test")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 20) || "test";
}

function uniqueSchemaName(kind, suiteName, runId) {
    const suite = sanitizeSuiteLabel(suiteName);
    return `${TEST_SCHEMA_PREFIX}_${kind}_${suite}_${runId}`;
}

function moduleSuiteLabel(moduleUrl) {
    const filePath = fileURLToPath(moduleUrl);
    return basename(filePath)
        .replace(/\.test\.js$/, "")
        .replace(/\.js$/, "");
}

async function dropTestSchemas({ duroxideSchema, cmsSchema, factsSchema }) {
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    try {
        await client.connect();
        await client.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${factsSchema}" CASCADE`);
    } finally {
        try { await client.end(); } catch {}
    }
}

// ─── Test Environment ────────────────────────────────────────────

/**
 * Create an isolated test environment.
 *
 * Returns a context with unique schemas, a temp session-state directory,
 * and the DATABASE_URL for use with PilotSwarmClient/Worker.
 *
 * Call `env.cleanup()` when done to remove temp files and drop schemas.
 */
export function createTestEnv(suiteName = "test") {
    const runId = randomBytes(4).toString("hex");
    const duroxideSchema = uniqueSchemaName("duroxide", suiteName, runId);
    const cmsSchema = uniqueSchemaName("cms", suiteName, runId);
    const factsSchema = uniqueSchemaName("facts", suiteName, runId);
    const sessionStateDir = join(tmpdir(), `pilotswarm-test-${runId}`, "session-state");
    const baseDir = join(tmpdir(), `pilotswarm-test-${runId}`);

    // Create temp directory
    mkdirSync(sessionStateDir, { recursive: true });

    async function reset() {
        if (existsSync(baseDir)) {
            rmSync(baseDir, { recursive: true, force: true });
        }
        mkdirSync(sessionStateDir, { recursive: true });

        try {
            await dropTestSchemas({ duroxideSchema, cmsSchema, factsSchema });
        } catch (err) {
            console.warn(`  ⚠️  Schema cleanup warning: ${err.message}`);
        }
    }

    return {
        store: DATABASE_URL,
        duroxideSchema,
        cmsSchema,
        factsSchema,
        sessionStateDir,
        timeout: TIMEOUT,
        runId,
        reset,

        /** Drop schemas and remove temp files. */
        async cleanup() {
            await reset();
            if (existsSync(baseDir)) {
                rmSync(baseDir, { recursive: true, force: true });
            }
        },
    };
}

/**
 * Suite-scoped environment helper.
 *
 * Creates one randomized schema set per test file, resets it after each test,
 * and drops it when the suite finishes.
 */
export function useSuiteEnv(moduleUrl, suiteName) {
    const label = suiteName ?? moduleSuiteLabel(moduleUrl);
    let env = null;

    beforeAll(async () => {
        env = createTestEnv(label);
    });

    afterEach(async () => {
        if (env) await env.reset();
    });

    afterAll(async () => {
        if (env) {
            await env.cleanup();
            env = null;
        }
    });

    return () => {
        if (!env) {
            throw new Error(`Suite env not initialized for ${label}`);
        }
        return env;
    };
}

/**
 * Preflight check: ensure PostgreSQL is reachable and at least one LLM provider is configured.
 */
export async function preflightChecks() {
    const { loadModelProviders } = await import("pilotswarm-sdk");
    const registry = loadModelProviders();
    if (!process.env.GITHUB_TOKEN && (!registry || registry.allModels.length === 0)) {
        throw new Error(
            "No LLM provider available. Set GITHUB_TOKEN or configure .model_providers.json with valid API keys.",
        );
    }

    const pg = await import("pg");
    const client = new pg.default.Client({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 4000,
    });
    try {
        await client.connect();
        await client.query("SELECT 1");
    } catch (err) {
        throw new Error(
            `PostgreSQL is not reachable at ${DATABASE_URL} (${err.message}). ` +
            `Start Postgres first: docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pilotswarm -p 5432:5432 postgres:16`,
        );
    } finally {
        try { await client.end(); } catch {}
    }
}

export { DATABASE_URL, TEST_SCHEMA_PREFIX, TIMEOUT };
