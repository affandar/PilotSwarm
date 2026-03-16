/**
 * Test assertion helpers.
 *
 * Simple assertion functions that produce clear error messages
 * for the local integration test suite.
 */

// ─── Basic Assertions ────────────────────────────────────────────

export function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual, expected, label = "") {
    if (actual !== expected) {
        throw new Error(
            `${label ? label + ": " : ""}Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
        );
    }
}

export function assertIncludes(str, substring, label = "") {
    if (typeof str !== "string" || !str.includes(substring)) {
        throw new Error(
            `${label ? label + ": " : ""}Expected string to include ${JSON.stringify(substring)} but got ${JSON.stringify(str)}`,
        );
    }
}

export function assertIncludesAny(str, substrings, label = "") {
    if (typeof str !== "string" || !substrings.some(s => str.toLowerCase().includes(s.toLowerCase()))) {
        throw new Error(
            `${label ? label + ": " : ""}Expected string to include one of ${JSON.stringify(substrings)} but got ${JSON.stringify(str)}`,
        );
    }
}

export function assertGreaterOrEqual(actual, expected, label = "") {
    if (actual < expected) {
        throw new Error(
            `${label ? label + ": " : ""}Expected >= ${expected} but got ${actual}`,
        );
    }
}

export function assertNotNull(value, label = "") {
    if (value == null) {
        throw new Error(`${label ? label + ": " : ""}Expected non-null value but got ${value}`);
    }
}

/**
 * Assert that an async function throws an error matching a pattern.
 * @param {Function} fn - Async function expected to throw.
 * @param {string|RegExp} pattern - String or regex the error message must match.
 * @param {string} [label] - Optional label for the assertion.
 */
export async function assertThrows(fn, pattern, label = "") {
    let threw = false;
    let error;
    try {
        await fn();
    } catch (err) {
        threw = true;
        error = err;
    }
    if (!threw) {
        throw new Error(`${label ? label + ": " : ""}Expected function to throw but it did not`);
    }
    const msg = error?.message || String(error);
    const matches = typeof pattern === "string"
        ? msg.toLowerCase().includes(pattern.toLowerCase())
        : pattern.test(msg);
    if (!matches) {
        throw new Error(
            `${label ? label + ": " : ""}Expected error matching ${pattern} but got: "${msg}"`,
        );
    }
}

// ─── Logging ─────────────────────────────────────────────────────

export function pass(_name) {
    // no-op: node:test marks tests as passed automatically
}

export function skip(_name, _reason = "") {
    // no-op: use it.skip() in node:test instead
}
