/**
 * Versioned CAS conformance — FilesystemSessionStore backend
 * (session-lifecycle-protocol §4.1).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FilesystemSessionStore } from "../../src/session-store.ts";

import { registerSnapshotConformanceSuite, makeSessionLayout } from "../helpers/snapshot-conformance.js";

const roots = [];
afterAll(() => {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

function makeFsStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-snap-fs-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    const storeDir = path.join(root, "session-store");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { store: new FilesystemSessionStore(storeDir, sessionStateDir), sessionStateDir, storeDir };
}

registerSnapshotConformanceSuite("snapshot protocol conformance (filesystem)", async () => {
    const { store, sessionStateDir } = makeFsStore();
    return {
        store,
        sessionStateDir,
        newSessionId: () => `snap-fs-${randomUUID()}`,
        // A legacy snapshot is whatever the pre-protocol paths wrote:
        // checkpoint() produces a tar + meta.json with no version field.
        writeLegacySnapshot: (sessionId) => store.checkpoint(sessionId),
    };
});

describe("mixed-codec chain (gzip legacy → brotli commit)", () => {
    it("hydrates a real gzip snapshot, commits brotli, and recovers across the codec boundary", async () => {
        const { store, sessionStateDir, storeDir } = makeFsStore();
        const sessionId = `mixed-${randomUUID()}`;
        const dir = makeSessionLayout(sessionStateDir, sessionId, "gzip-era");

        // Seed a GENUINE gzip legacy snapshot the way an old binary wrote it:
        // a real `.tar.gz` (gzip) + meta.json with NO codec/version field.
        const gzipTar = path.join(storeDir, `${sessionId}.tar.gz`);
        execSync(`tar -czf "${gzipTar}" -C "${sessionStateDir}" "${sessionId}"`);
        fs.writeFileSync(
            path.join(storeDir, `${sessionId}.meta.json`),
            JSON.stringify({ sessionId, sizeBytes: fs.statSync(gzipTar).size, worker: "old", dehydratedAt: new Date().toISOString() }),
        );

        // Probe sees it as legacy (no version); hydrate must DECODE GZIP
        // (codec inferred from the absent field → gzip) and restore intact.
        const probe = await store.probeSnapshot(sessionId);
        expect(probe.legacy).toBe(true);
        fs.writeFileSync(path.join(dir, "events.jsonl"), "clobbered\n");
        const h1 = await store.hydrateSnapshot(sessionId);
        expect(h1.legacy).toBe(true);
        expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).toContain("gzip-era");

        // Commit on top of the gzip legacy → brotli v1 (.tar.br).
        fs.appendFileSync(path.join(dir, "events.jsonl"), '{"turn":1}\n');
        const c1 = await store.commitSnapshot(sessionId, { baseVersion: 0, turnKey: "t1" });
        expect(c1.version).toBe(1);
        expect(c1.rawSizeBytes).toBeGreaterThan(0);
        expect(fs.readdirSync(storeDir).some((f) => f === `${sessionId}.v1.tar.br`)).toBe(true);

        // Hydrate the brotli snapshot across the boundary — byte-exact.
        fs.rmSync(dir, { recursive: true, force: true });
        const h2 = await store.hydrateSnapshot(sessionId);
        expect(h2.version).toBe(1);
        expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).toContain('"turn":1');

        // Already-committed recovery of turn 1 must also work over brotli.
        const retry = await store.commitSnapshot(sessionId, { baseVersion: 0, turnKey: "t1" });
        expect(retry.alreadyCommitted).toBe(true);
        expect(retry.version).toBe(1);
    });

    it("carries rawSizeBytes and a plausible compression ratio through commit + probe", async () => {
        const { store, sessionStateDir } = makeFsStore();
        const sessionId = `ratio-${randomUUID()}`;
        const dir = makeSessionLayout(sessionStateDir, sessionId, "ratio");
        // Compressible payload: repetitive JSONL brotli-4 crushes.
        fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ a: 1, b: "xyz" })}\n`.repeat(4000));

        const committed = await store.commitSnapshot(sessionId, { baseVersion: 0, turnKey: "t1" });
        expect(committed.rawSizeBytes).toBeGreaterThan(committed.sizeBytes);
        expect(committed.rawSizeBytes / committed.sizeBytes).toBeGreaterThan(3);

        const probe = await store.probeSnapshot(sessionId);
        expect(probe.rawSizeBytes).toBe(committed.rawSizeBytes);
        expect(probe.version).toBe(1);
    });
});
