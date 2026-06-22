// Static-parse tests for deploy/Dockerfile.worker.
//
// The worker image is intentionally split into two runtime targets to keep
// the OBO live-smoke plugin out of every production image:
//
//   * `runtime`       — the smoke-free production image, and the LAST stage
//                       in the file so `docker build` (no --target) resolves
//                       to it implicitly.
//   * `runtime-smoke` — adds packages/obo-smoke-plugin/ for the live-smoke
//                       harness; opt-in via explicit `--target runtime-smoke`.
//
// These tests pin those invariants statically so a future contributor can't
// quietly merge the smoke plugin back into the default image, reorder the
// stages so smoke becomes default, or remove the smoke target altogether.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCKERFILE_PATH = join(REPO_ROOT, "deploy", "Dockerfile.worker");

function readDockerfile() {
    return readFileSync(DOCKERFILE_PATH, "utf8");
}

// Strip comment-only lines (lines whose first non-whitespace char is `#`).
// Keeps lines that contain `#` in the middle (e.g. shell comments inside
// RUN), but for Dockerfile directive parsing this is enough.
function stripCommentLines(src) {
    return src
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
}

// Extract every `FROM ... AS <name>` stage in source order.
function parseStages(src) {
    const re = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/gim;
    const stages = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        if (m[1]) {
            stages.push({ name: m[1], index: m.index });
        }
    }
    return stages;
}

test("Dockerfile.worker declares both `runtime` and `runtime-smoke` stages", () => {
    const stages = parseStages(stripCommentLines(readDockerfile()));
    const names = stages.map((s) => s.name);
    assert.ok(
        names.includes("runtime"),
        `Dockerfile.worker must declare a stage named 'runtime' (got stages: ${names.join(", ")})`,
    );
    assert.ok(
        names.includes("runtime-smoke"),
        `Dockerfile.worker must declare a stage named 'runtime-smoke' (got stages: ${names.join(", ")})`,
    );
});

test("Dockerfile.worker has `runtime` as the LAST stage (so `docker build` defaults to smoke-free)", () => {
    const stages = parseStages(stripCommentLines(readDockerfile()));
    assert.ok(stages.length > 0, "Dockerfile.worker has no named stages");
    const last = stages[stages.length - 1];
    assert.equal(
        last.name,
        "runtime",
        `Last stage must be 'runtime' so bare \`docker build\` resolves to the smoke-free image; ` +
            `got '${last.name}' as last stage`,
    );
});

test("`runtime` stage does NOT copy packages/obo-smoke-plugin (smoke-free invariant)", () => {
    // Slice the file from the `FROM ... AS runtime` line to end-of-file
    // and assert no COPY references the smoke plugin directory.
    const src = stripCommentLines(readDockerfile());
    const stages = parseStages(src);
    const runtimeIdx = stages.findIndex((s) => s.name === "runtime");
    assert.ok(runtimeIdx >= 0, "Expected a `runtime` stage");
    const startOffset = stages[runtimeIdx].index;
    // End offset is start of next stage, or end-of-file if `runtime` is last.
    const next = stages[runtimeIdx + 1];
    const endOffset = next ? next.index : src.length;
    const runtimeBody = src.slice(startOffset, endOffset);
    assert.ok(
        !/packages\/obo-smoke-plugin/.test(runtimeBody),
        `\`runtime\` stage must not reference packages/obo-smoke-plugin (smoke-free invariant). ` +
            `If you intended to add the smoke plugin, do it in the \`runtime-smoke\` stage instead.`,
    );
});

test("`runtime-smoke` stage places the smoke plugin at the canonical PLUGIN_DIRS path", () => {
    // Setup-OboSmokeWorkerApp.ps1 emits PLUGIN_DIRS=/app/packages/obo-smoke-plugin.
    // The runtime-smoke stage must place the plugin at exactly that path so
    // PLUGIN_DIRS-driven loading works without any path translation.
    const src = stripCommentLines(readDockerfile());
    const stages = parseStages(src);
    const smokeIdx = stages.findIndex((s) => s.name === "runtime-smoke");
    assert.ok(smokeIdx >= 0, "Expected a `runtime-smoke` stage");
    const startOffset = stages[smokeIdx].index;
    const next = stages[smokeIdx + 1];
    const endOffset = next ? next.index : src.length;
    const smokeBody = src.slice(startOffset, endOffset);
    // Allow either of the two equivalent COPY forms operators write:
    //   COPY packages/obo-smoke-plugin ./packages/obo-smoke-plugin
    //   COPY packages/obo-smoke-plugin /app/packages/obo-smoke-plugin
    // WORKDIR /app is set in `base`, so the `./` form resolves to /app/.
    const copyRe = /COPY\s+packages\/obo-smoke-plugin\s+(?:\.\/packages\/obo-smoke-plugin|\/app\/packages\/obo-smoke-plugin)/;
    assert.ok(
        copyRe.test(smokeBody),
        `\`runtime-smoke\` stage must COPY packages/obo-smoke-plugin to ./packages/obo-smoke-plugin ` +
            `(or /app/packages/obo-smoke-plugin) so PLUGIN_DIRS=/app/packages/obo-smoke-plugin loads it.`,
    );
});

test("`runtime` stage inherits from a base stage (not from `runtime-smoke` directly)", () => {
    // Coupling `runtime` to `runtime-smoke` would mean the default stage
    // depends on the smoke variant existing — a brittle relationship that
    // makes it too easy for a future contributor to accidentally drag
    // smoke content into the default image.
    const src = stripCommentLines(readDockerfile());
    const re = /^FROM\s+(\S+)\s+AS\s+runtime$/im;
    const m = src.match(re);
    assert.ok(m, "Could not find `FROM ... AS runtime` line");
    const baseName = m[1];
    assert.notEqual(
        baseName,
        "runtime-smoke",
        `\`runtime\` must not inherit FROM \`runtime-smoke\` (got: FROM ${baseName} AS runtime). ` +
            `Use a shared earlier stage (e.g. \`base\`) instead.`,
    );
});
