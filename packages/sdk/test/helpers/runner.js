/**
 * Test runner — shared runner logic for local integration test suites.
 *
 * Provides a mini test harness that runs named test functions sequentially,
 * tracks pass/fail/skip counts, and supports --test=<filter> for isolation.
 */

import { createTestEnv, preflightChecks } from "./local-env.js";

/**
 * Run a suite of named test functions.
 *
 * @param {string} suiteName       - Display name for the suite
 * @param {Array<[string, Function]>} tests - Array of [name, asyncFn] pairs
 * @param {object} [opts]          - Options
 * @param {boolean} [opts.sharedEnv] - If true, all tests share one environment (default: false)
 */
export async function runSuite(suiteName, tests, opts = {}) {
    await preflightChecks();

    const testArg = process.argv.find(a => a.startsWith("--test="));
    const testFilter = testArg ? testArg.split("=")[1] : null;

    console.log(`\n🧪 ${suiteName}\n`);

    let sharedEnv = null;
    if (opts.sharedEnv) {
        sharedEnv = createTestEnv(suiteName);
    }

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const [name, fn] of tests) {
        if (testFilter && !name.toLowerCase().includes(testFilter.toLowerCase())) {
            continue;
        }

        // Each test gets its own env unless shared
        const env = sharedEnv || createTestEnv(suiteName);

        try {
            console.log(`\n═══ ${name} ═══`);
            await fn(env);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(`     ${err.message}`);
            if (err.stack) {
                const lines = err.stack.split("\n").slice(1, 4);
                for (const line of lines) console.error(`     ${line.trim()}`);
            }
            failed++;
        } finally {
            if (!sharedEnv) {
                await env.cleanup();
            }
        }
    }

    if (sharedEnv) {
        await sharedEnv.cleanup();
    }

    const skippedStr = skipped > 0 ? `, ${skipped} skipped` : "";
    console.log(`\n═══ ${suiteName}: ${passed} passed, ${failed} failed${skippedStr} ═══\n`);
    process.exit(failed > 0 ? 1 : 0);
}
