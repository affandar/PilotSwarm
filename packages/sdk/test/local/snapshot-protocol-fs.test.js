/**
 * Versioned CAS conformance — FilesystemSessionStore backend
 * (session-lifecycle-protocol §4.1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { registerSnapshotConformanceSuite } from "../helpers/snapshot-conformance.js";

const roots = [];
afterAll(() => {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

registerSnapshotConformanceSuite("snapshot protocol conformance (filesystem)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-snap-fs-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    const storeDir = path.join(root, "session-store");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    const store = new FilesystemSessionStore(storeDir, sessionStateDir);
    return {
        store,
        sessionStateDir,
        newSessionId: () => `snap-fs-${randomUUID()}`,
        // A legacy snapshot is whatever the pre-protocol paths wrote:
        // checkpoint() produces a tar + meta.json with no version field.
        writeLegacySnapshot: (sessionId) => store.checkpoint(sessionId),
    };
});
