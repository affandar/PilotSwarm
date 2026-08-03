/**
 * Installed-package DISK LAYOUT under per-user namespaces.
 *
 * Why this exists as its own suite: package provenance is the ONLY thing
 * keeping a user-scope agent private. Workers install every tenant's packages
 * side by side (the install manifest is deliberately unfiltered), so the
 * mapping from "installed directory" back to "which user owns this" is a
 * security boundary, not bookkeeping.
 *
 * The bug this was written against, found in adversarial review of 0043:
 * the cache key was `name@semver.sha256`, which contains nothing about the
 * OWNER. Two users publishing the same name at the same version with
 * byte-identical content therefore resolved to the SAME directory — and the
 * worker's dir→owner map is a Map, so one of the two owners silently
 * overwrote the other. The loser was then denied their own agent.
 *
 * Identical content is the realistic case, not a contrived one: it is exactly
 * what happens when two people install the same package from the same source.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/agent-package-install-layout.test.js
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installAgentPackages } from "../../dist/agent-package-installer.js";

const ALICE = { provider: "dev", subject: "alice" };
const BOB = { provider: "dev", subject: "bob" };

/** A catalog stub that serves a fixed install manifest. */
function fakeCatalog(entries) {
    return {
        async agentRegistryEpoch() { return 1; },
        async getAgentPackagesInstallManifest() { return entries; },
    };
}

/**
 * Artifact store returning one tiny valid package tarball for every request.
 * Content is identical across owners on purpose — that is the collision.
 */
function fakeArtifactStore(tarBySha) {
    return {
        async download(filename) {
            const found = tarBySha.get(filename);
            if (!found) throw new Error(`no artifact ${filename}`);
            return found;
        },
    };
}

function entry(overrides) {
    return {
        packageId: "pkg-id", name: "triager", scope: "shared", owner: null,
        semver: "1.0.0", sha256: "deadbeefdeadbeefdeadbeef", sizeBytes: 10,
        artifactFilename: "triager@1.0.0.tar.gz", manifest: {},
        ...overrides,
    };
}

describe("installed package disk layout", () => {
    it("two owners with IDENTICAL content get separate directories", async () => {
        // Same name, same semver, same sha256 — the exact shape that used to
        // collapse to one directory.
        const shared = { name: "triager", semver: "1.0.0", sha256: "aaaaaaaaaaaaaaaaaaaaaaaa" };
        const entries = [
            entry({ ...shared, packageId: "id-alice", scope: "user", owner: ALICE }),
            entry({ ...shared, packageId: "id-bob", scope: "user", owner: BOB }),
        ];

        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-layout-"));
        try {
            // Download always fails here — we only care about the KEYS chosen,
            // and a failed download still records the intended dir. That keeps
            // this suite free of tarball fixtures.
            const result = await installAgentPackages({
                catalog: fakeCatalog(entries),
                artifactStore: fakeArtifactStore(new Map()),
                cacheDir,
            });

            expect(result.packages).toHaveLength(2);
            const [a, b] = result.packages;
            expect(a.dir).not.toBe(b.dir);
            // And each dir must be attributable to exactly one owner.
            expect(a.owner).toEqual(ALICE);
            expect(b.owner).toEqual(BOB);
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    it("shared packages keep the historical bare key so caches stay warm", async () => {
        const entries = [entry({ packageId: "id-shared", scope: "shared", owner: null })];
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-layout-"));
        try {
            const result = await installAgentPackages({
                catalog: fakeCatalog(entries),
                artifactStore: fakeArtifactStore(new Map()),
                cacheDir,
            });
            // Changing the shared key would invalidate every existing cache
            // dir on every worker in a fleet, for no benefit — shared names
            // are still globally unique.
            expect(path.basename(result.packages[0].dir)).toBe("triager@1.0.0.deadbeefdead");
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    it("GC keeps a live package whose owner-discriminated dir was superseded", async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-layout-"));
        try {
            // An older owner-discriminated dir for a package that is STILL live.
            const stale = path.join(cacheDir, "triager@0.9.0.oldsha000000.uidalice0000");
            const foreign = path.join(cacheDir, "retired-pkg@1.0.0.abcabcabcabc");
            fs.mkdirSync(stale, { recursive: true });
            fs.mkdirSync(foreign, { recursive: true });

            await installAgentPackages({
                catalog: fakeCatalog([entry({ packageId: "id-alice", scope: "user", owner: ALICE })]),
                artifactStore: fakeArtifactStore(new Map()),
                cacheDir,
            });

            // The old VERSION of a live package survives — warm sessions may
            // still be running stdio MCP servers out of it.
            expect(fs.existsSync(stale), "old version of a live package must survive GC").toBe(true);
            // A package that left the manifest entirely is collected.
            expect(fs.existsSync(foreign), "a package no longer in the manifest is pruned").toBe(false);
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
