// Static-grep test for every Dockerfile.worker build invocation.
//
// The worker image has two runtime targets:
//   * `runtime`       (the smoke-free default; LAST stage in Dockerfile.worker)
//   * `runtime-smoke` (the OBO live-smoke variant; opt-in)
//
// Production paths must build the default by either (a) omitting `--target`
// entirely (relying on the last-stage convention enforced by
// dockerfile-worker.test.mjs) or (b) passing `--target runtime` explicitly.
//
// Smoke deploys must pass `--target runtime-smoke` explicitly. No caller
// may smuggle smoke in by accident — for example by typoing `runtime-smoke`
// where they meant `runtime`, or by passing an unrelated `--target`.
//
// This test walks the script + workflow + skill surfaces in the repo,
// finds every `docker build` / `docker buildx build` invocation that
// targets `deploy/Dockerfile.worker`, and asserts each invocation's
// `--target` (if any) is one of the two sanctioned values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SCAN_ROOTS = [
    join(REPO_ROOT, "scripts"),
    join(REPO_ROOT, "deploy", "scripts"),
    join(REPO_ROOT, ".github", "workflows"),
    join(REPO_ROOT, ".github", "skills"),
];

const SCAN_EXTENSIONS = new Set([".sh", ".mjs", ".js", ".ts", ".yml", ".yaml", ".md", ".ps1"]);

// Skip this test file itself plus dockerfile-worker.test.mjs to avoid the
// regex below false-matching against assertion strings or test-stage
// declarations.
const SCAN_SKIP_BASENAMES = new Set([
    "build-call-sites.test.mjs",
    "dockerfile-worker.test.mjs",
]);

function walkFiles(dir) {
    const out = [];
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            out.push(...walkFiles(full));
            continue;
        }
        if (!st.isFile()) continue;
        if (SCAN_SKIP_BASENAMES.has(entry)) continue;
        const dot = entry.lastIndexOf(".");
        const ext = dot >= 0 ? entry.slice(dot) : "";
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        out.push(full);
    }
    return out;
}

// Match `docker build` / `docker buildx build` invocations that target
// `Dockerfile.worker`. Captures the full command (potentially spanning
// multiple shell-escaped backslash-continuation lines).
//
// Strategy: find each `docker (buildx )?build` token, then greedily
// consume forward up to either the next bare `docker` line, a `;`/`&&`
// shell sep, or 30 lines — whichever comes first. This generously
// over-captures so we don't miss flags split across continuations.
function extractWorkerBuildInvocations(src) {
    const lines = src.split("\n");
    const invocations = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/\bdocker(\s+buildx)?\s+build\b/.test(lines[i])) continue;
        // Capture forward up to 30 lines or until a clear command boundary.
        const chunkLines = [];
        for (let j = i; j < Math.min(lines.length, i + 30); j++) {
            chunkLines.push(lines[j]);
            const trimmed = lines[j].trimEnd();
            // Continuation lines end with `\` (shell) or `^` (CMD); if
            // neither AND not a YAML list item AND we already have at
            // least one line, treat as terminator.
            if (j > i) {
                const prev = chunkLines[chunkLines.length - 2].trimEnd();
                const continues = /[\\^]$/.test(prev);
                if (!continues) break;
            }
        }
        const chunk = chunkLines.join("\n");
        if (/Dockerfile\.worker\b/.test(chunk)) {
            invocations.push({ startLine: i + 1, text: chunk });
        }
    }
    return invocations;
}

function extractTargetFlag(invocation) {
    // Matches `--target <value>` or `--target=<value>` with the value
    // optionally wrapped in quotes. Returns the unquoted value or null.
    const m = invocation.match(/--target(?:\s+|=)["']?([A-Za-z0-9_.-]+)["']?/);
    return m ? m[1] : null;
}

test("every Dockerfile.worker build invocation uses no --target or `--target runtime`/`runtime-smoke`", () => {
    const offenders = [];
    let invocationCount = 0;
    for (const root of SCAN_ROOTS) {
        for (const file of walkFiles(root)) {
            let src;
            try {
                src = readFileSync(file, "utf8");
            } catch {
                continue;
            }
            const invocations = extractWorkerBuildInvocations(src);
            for (const inv of invocations) {
                invocationCount++;
                const target = extractTargetFlag(inv.text);
                if (target !== null && target !== "runtime" && target !== "runtime-smoke") {
                    offenders.push({
                        file: relative(REPO_ROOT, file),
                        line: inv.startLine,
                        target,
                    });
                }
            }
        }
    }
    assert.ok(
        invocationCount > 0,
        "Expected at least one `docker build` / `docker buildx build` invocation against Dockerfile.worker " +
            "in scripts/, deploy/scripts/, .github/workflows/ or .github/skills/. Found zero — " +
            "either the scan roots are wrong or all build invocations were removed.",
    );
    assert.deepEqual(
        offenders,
        [],
        `Found Dockerfile.worker build invocation(s) with disallowed --target value(s). ` +
            `Allowed: no --target (defaults to last stage = \`runtime\`), \`--target runtime\`, ` +
            `or \`--target runtime-smoke\`. Offenders:\n` +
            offenders.map((o) => `  ${o.file}:${o.line} (--target ${o.target})`).join("\n"),
    );
});
