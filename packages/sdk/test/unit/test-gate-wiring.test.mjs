/**
 * The test gate must actually run the suites it claims to.
 *
 * scripts/run-tests.sh is what everyone means by "the tests". For a long
 * while it ran four phases, and packages/sdk/test/unit plus the whole
 * packages/app workspace were reachable only through their own npm scripts —
 * so a full local pass reported green without ever executing them. That is
 * how a stale assertion survives: not by being wrong, by being unreachable.
 *
 * A guard that only greps for the call is defeated in seconds — comment it
 * out, or wrap it in `if false; then ... fi`. So this strips comments first
 * and then requires the call to sit inside the SAME dispatch block as the
 * phases nobody disputes, and requires the phase body to contain a real
 * command rather than a stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/run-tests.sh", import.meta.url));
const raw = readFileSync(SCRIPT, "utf8");

/** Comments cannot wire anything, so they are not evidence of wiring. */
const live = raw
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

/** The phases a full pass runs, as one contiguous run of bare calls. */
function dispatchBlock() {
    const lines = live.split("\n");
    let best = [];
    let current = [];
    for (const line of lines) {
        const m = /^\s*(run_[a-z_]+_tests|run_sdk_vitest_and_summarize)\s*$/.exec(line);
        if (m) {
            current.push(m[1]);
        } else if (!/^\s*$/.test(line)) {
            if (current.length > best.length) best = current;
            current = [];
        }
    }
    if (current.length > best.length) best = current;
    return best;
}

const REQUIRED = [
    "run_deploy_scripts_tests",
    "run_mcp_server_tests",
    "run_sdk_unit_tests",
    "run_app_tests",
    "run_horizon_store_tests",
];

test("every phase is called from the full-pass dispatch", () => {
    const block = dispatchBlock();
    for (const phase of REQUIRED) {
        assert.ok(
            block.includes(phase),
            `${phase} is not called in the run of phases a full pass executes.\n` +
            `That run is currently: ${block.join(", ") || "(none found)"}\n` +
            `A call that is commented out, or guarded so it never fires, is not wiring.`,
        );
    }
});

test("each phase is defined, and its body runs something", () => {
    for (const phase of REQUIRED) {
        const start = live.indexOf(`${phase}() {`);
        assert.notEqual(start, -1, `${phase} has no definition`);
        const body = live.slice(start, live.indexOf("\n}", start));
        assert.match(
            body, /\b(npm|node|npx)\b/,
            `${phase} defines no command to run — a phase that executes nothing passes for free`,
        );
        assert.match(
            body, /record_run_phase/,
            `${phase} does not record itself, so the summary cannot show whether it ran`,
        );
    }
});

test("the SDK unit phase loads the environment its suites need", () => {
    // These suites build a worker, which reads the repo-root model-providers
    // file, whose defaultModel names a provider whose key lives in .env.
    // Without --env-file the registry drops that provider, the default
    // becomes invalid, and six unrelated tests fail talking about model
    // configuration — which reads as "the feature is broken", not "the
    // runner is missing a flag".
    const start = live.indexOf("run_sdk_unit_tests() {");
    const body = live.slice(start, live.indexOf("\n}", start));
    assert.match(body, /--env-file=\.env/, "run_sdk_unit_tests must pass --env-file=.env");
    assert.match(body, /packages\/sdk\/test\/unit/, "run_sdk_unit_tests must target test/unit");
});

test("the provider-budget suites are reachable from the gate", () => {
    // The vitest phase globs test/local, and the node phase globs test/unit.
    // The FILE EXTENSION decides which runner sees a file: a .test.mjs under
    // test/local, or a .test.js under test/unit, runs nowhere at all.
    const vitestConfig = readFileSync(
        fileURLToPath(new URL("../../vitest.config.js", import.meta.url)), "utf8");
    assert.match(vitestConfig, /test\/local\/\*\*\/\*\.test\.js/,
        "vitest still globs test/local/**/*.test.js");

    const localSuites = [
        "packages/sdk/test/local/provider-budgets.test.js",
        "packages/sdk/test/local/provider-budgets-adversarial.test.js",
    ];
    for (const file of localSuites) {
        assert.ok(file.endsWith(".test.js"), `${file} must end .test.js to be run by vitest`);
        readFileSync(fileURLToPath(new URL(`../../../../${file}`, import.meta.url)), "utf8");
    }

    const unitSuites = [
        "packages/sdk/test/unit/provider-budgets.test.mjs",
        "packages/sdk/test/unit/provider-surface-parity.test.mjs",
    ];
    for (const file of unitSuites) {
        assert.ok(file.endsWith(".test.mjs"), `${file} must end .test.mjs to be run by node --test`);
        readFileSync(fileURLToPath(new URL(`../../../../${file}`, import.meta.url)), "utf8");
    }
});
