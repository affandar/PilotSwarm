/**
 * Spawn-tree visibility regression tests.
 *
 * Two changes are pinned here:
 *
 *   1. `resolveSpawnTreeSessionIds` (worker.ts) returns the entire spawn
 *      tree the caller belongs to — root ancestor + all of root's
 *      descendants minus the caller — so siblings and cousins are
 *      visible to facts reads, not just direct ancestors/descendants.
 *
 *   2. The base agent prompt (`default.agent.md`) and the runtime
 *      sub-agent preamble (`orchestration.ts`) both warn that the local
 *      filesystem is ephemeral and direct durable state into artifacts
 *      and facts. These are LLM-facing contract surfaces; if a refactor
 *      drops the warning, the model regresses to "I saved it to /tmp"
 *      behavior.
 */

import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveSpawnTreeSessionIds } from "../../src/worker.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_SDK_ROOT = join(__dirname, "..", "..");

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Build a mock catalog from a parent map { sessionId: parentSessionId|null }.
 * `getDescendantSessionIds(root)` returns every session whose ancestor
 * chain leads back to `root` (excluding root itself), matching the CMS
 * recursive-CTE behavior.
 */
function mockCatalog(parents) {
    return {
        async getSession(sessionId) {
            if (!(sessionId in parents)) return null;
            return { parentSessionId: parents[sessionId] };
        },
        async getDescendantSessionIds(rootSessionId) {
            const out = [];
            for (const [sid, parent] of Object.entries(parents)) {
                if (sid === rootSessionId) continue;
                let current = parent;
                const seen = new Set();
                while (current && !seen.has(current)) {
                    seen.add(current);
                    if (current === rootSessionId) {
                        out.push(sid);
                        break;
                    }
                    current = parents[current] ?? null;
                }
            }
            return out;
        },
    };
}

// ─── 1. Spawn-tree visibility (siblings + cousins) ────────────────

describe("resolveSpawnTreeSessionIds", () => {
    it("returns the root ancestor and every descendant of root, minus self", async () => {
        // root
        // ├── childA  (caller)
        // │   └── grandA
        // └── childB  (sibling of caller)
        //     └── grandB  (cousin of caller)
        const catalog = mockCatalog({
            root: null,
            childA: "root",
            childB: "root",
            grandA: "childA",
            grandB: "childB",
        });

        const lineage = await resolveSpawnTreeSessionIds("childA", catalog);
        const set = new Set(lineage);

        assert(set.has("root"), "ancestor 'root' should be visible");
        assert(set.has("grandA"), "own descendant 'grandA' should be visible");
        assert(set.has("childB"), "sibling 'childB' should be visible (REGRESSION: pre-fix this was hidden)");
        assert(set.has("grandB"), "cousin 'grandB' should be visible (REGRESSION: pre-fix this was hidden)");
        assert(!set.has("childA"), "caller's own session id must not appear in lineage");
        assertEqual(lineage.length, set.size, "no duplicate session ids");
    });

    it("returns just descendants when the caller is the root", async () => {
        const catalog = mockCatalog({
            root: null,
            childA: "root",
            childB: "root",
            grandA: "childA",
        });

        const lineage = await resolveSpawnTreeSessionIds("root", catalog);
        const set = new Set(lineage);

        assert(set.has("childA"), "child should be visible");
        assert(set.has("childB"), "child should be visible");
        assert(set.has("grandA"), "grandchild should be visible");
        assert(!set.has("root"), "root must not include itself");
    });

    it("returns the full sibling set even for a leaf grandchild", async () => {
        // root
        // ├── childA → grandA (caller)
        // ├── childB → grandB
        // └── childC → grandC
        const catalog = mockCatalog({
            root: null,
            childA: "root",
            childB: "root",
            childC: "root",
            grandA: "childA",
            grandB: "childB",
            grandC: "childC",
        });

        const lineage = await resolveSpawnTreeSessionIds("grandA", catalog);
        const set = new Set(lineage);

        for (const expected of ["root", "childA", "childB", "childC", "grandB", "grandC"]) {
            assert(set.has(expected), `expected '${expected}' in spawn-tree lineage of grandA`);
        }
        assert(!set.has("grandA"), "grandA must not include itself");
    });

    it("returns empty when the caller is a standalone root with no descendants", async () => {
        const catalog = mockCatalog({ solo: null });
        const lineage = await resolveSpawnTreeSessionIds("solo", catalog);
        assertEqual(lineage.length, 0, "solo session has no spawn-tree peers");
    });

    it("does not leak sessions from a different spawn tree", async () => {
        // tree-1: rootA → callerA
        // tree-2: rootB → otherB    (must remain invisible)
        const catalog = mockCatalog({
            rootA: null,
            callerA: "rootA",
            rootB: null,
            otherB: "rootB",
        });

        const lineage = await resolveSpawnTreeSessionIds("callerA", catalog);
        const set = new Set(lineage);

        assert(set.has("rootA"), "own root visible");
        assert(!set.has("rootB"), "foreign root must not leak");
        assert(!set.has("otherB"), "foreign descendant must not leak");
    });

    it("survives a self-parent cycle without infinite-looping", async () => {
        // Defensive: malformed CMS rows should not hang the worker.
        const catalog = mockCatalog({ stuck: "stuck" });
        const lineage = await resolveSpawnTreeSessionIds("stuck", catalog);
        assertEqual(lineage.length, 0, "self-parent cycle resolves to empty lineage");
    });
});

// ─── 2. Ephemeral-filesystem prompt warning ───────────────────────

describe("ephemeral filesystem prompt hardening", () => {
    it("default.agent.md teaches that the local filesystem is ephemeral and routes durable state to artifacts/facts", () => {
        const promptPath = join(
            REPO_SDK_ROOT,
            "plugins",
            "system",
            "agents",
            "default.agent.md",
        );
        const prompt = readFileSync(promptPath, "utf-8");

        assert(
            /Local Filesystem Is Ephemeral/i.test(prompt),
            "default.agent.md should declare a 'Local Filesystem Is Ephemeral' section",
        );
        assert(
            /\bbash\b/.test(prompt) && /not durable/i.test(prompt),
            "warning should explicitly call out that bash-written files are not durable",
        );
        assert(
            /write_artifact/.test(prompt) && /store_fact/.test(prompt),
            "warning should redirect durable state to write_artifact / store_fact",
        );
        assert(
            /(restart|worker.*node|cross.*node|different.*worker)/i.test(prompt),
            "warning should mention worker restarts / migration as a reason the filesystem evaporates",
        );
    });

    it("sub-agent preamble in orchestration.ts warns about ephemeral filesystem and spawn-tree fact sharing", () => {
        const orchPath = join(REPO_SDK_ROOT, "src", "orchestration.ts");
        const orch = readFileSync(orchPath, "utf-8");

        // Locate the live sub-agent preamble.
        const preambleStart = orch.indexOf("[SUB-AGENT CONTEXT]");
        assert(preambleStart > 0, "sub-agent preamble should still exist in orchestration.ts");
        const preamble = orch.slice(preambleStart, preambleStart + 6000);

        assert(
            /spawn tree/i.test(preamble),
            "sub-agent preamble should mention the spawn tree (peer/sibling fact sharing)",
        );
        assert(
            /sibling/i.test(preamble) || /cousin/i.test(preamble) || /peer/i.test(preamble),
            "sub-agent preamble should explicitly call out peers/siblings can read each other's facts",
        );
        assert(
            /\bbash\b/.test(preamble) && /(filesystem|disk)/i.test(preamble),
            "sub-agent preamble should warn about bash / local filesystem durability",
        );
        assert(
            /write_artifact/.test(preamble) && /store_fact/.test(preamble),
            "sub-agent preamble should redirect durable state to artifacts / facts",
        );
    });
});
