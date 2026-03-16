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

// ─── Logging ─────────────────────────────────────────────────────

export function pass(name) {
    console.log(`  ✅ ${name}`);
}

export function skip(name, reason = "") {
    console.log(`  ⏭️  ${name}${reason ? ` (${reason})` : ""}`);
}
