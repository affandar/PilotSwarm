/**
 * Artifact API v2 — consolidated three-tool surface with a real data plane.
 *
 * Guards the redesign born from the 2026-07-12 Diagon Alley incident, where
 * agents (correctly) refused to trust byte transfers that transit model
 * tokens and invented staging-pod ceremonies instead. The contract locked
 * here:
 *   - write_artifact accepts exactly one source: content | fromFile | fromArtifact
 *   - fromFile streams worker-local files (jailed paths) without model transit
 *   - fromArtifact copies server-side, with an optional SHA-256 precondition
 *   - read_artifact serves metaOnly | toFile | bounded inline (utf-8/base64)
 *   - every result carries sha256 + artifactLink (export_artifact is gone)
 *   - pinned artifacts survive bulk cleanup
 *   - base prompts teach filesystem isolation (pods don't share files)
 *
 * Run: node --test test/unit/artifact-api-v2.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactTools } from "../../dist/artifact-tools.js";
import { FilesystemArtifactStore } from "../../dist/session-store.js";

const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
    0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
]);

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-artifact-v2-"));
    const store = new FilesystemArtifactStore(path.join(dir, "store"));
    const tools = createArtifactTools({ blobStore: store });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const ctx = { durableSessionId: "sess-a" };
    const call = async (name, params, context = ctx) =>
        JSON.parse(String(await byName[name].handler(params, context)));
    return { dir, store, tools, byName, ctx, call, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ── surface shape ───────────────────────────────────────────────

test("exactly three tools; export_artifact is retired", () => {
    const h = harness();
    try {
        assert.deepEqual(h.tools.map((t) => t.name).sort(), ["list_artifacts", "read_artifact", "write_artifact"]);
    } finally { h.cleanup(); }
});

// ── write: sources & provenance ────────────────────────────────

test("inline write returns sha256 and artifactLink", async () => {
    const h = harness();
    try {
        const res = await h.call("write_artifact", { filename: "note.md", content: "# hello\n" });
        assert.equal(res.success, true);
        assert.equal(res.sha256, sha(Buffer.from("# hello\n")));
        assert.equal(res.artifactLink, "artifact://sess-a/note.md");
    } finally { h.cleanup(); }
});

test("zero or multiple sources → EXCLUSIVE_SOURCE teaching error", async () => {
    const h = harness();
    try {
        const none = await h.call("write_artifact", { filename: "x.md" });
        assert.equal(none.error, "EXCLUSIVE_SOURCE");
        assert.match(none.hint, /exactly one of/);
        const two = await h.call("write_artifact", { filename: "x.md", content: "hi", fromFile: "/tmp/y" });
        assert.equal(two.error, "EXCLUSIVE_SOURCE");
    } finally { h.cleanup(); }
});

test("fromFile streams a worker-local binary with sniffed type and file provenance", async () => {
    const h = harness();
    try {
        const filePath = path.join(h.dir, "img.png");
        fs.writeFileSync(filePath, PNG_BYTES);
        const res = await h.call("write_artifact", { fromFile: filePath });
        assert.equal(res.success, true);
        assert.equal(res.filename, "img.png", "filename defaults to basename");
        assert.equal(res.contentType, "image/png", "content type sniffed from magic bytes");
        assert.equal(res.isBinary, true);
        assert.equal(res.sha256, sha(PNG_BYTES));
        assert.equal(res.source, "file");
        assert.equal(res.sourceDetail, fs.realpathSync(filePath), "provenance records the jailed (realpath) origin");
    } finally { h.cleanup(); }
});

test("fromFile sniffs NUL-free UTF-8 as text/plain", async () => {
    const h = harness();
    try {
        const filePath = path.join(h.dir, "plain.log");
        fs.writeFileSync(filePath, "just some logs\n");
        const res = await h.call("write_artifact", { fromFile: filePath });
        assert.equal(res.contentType, "text/plain");
        assert.equal(res.isBinary, false);
    } finally { h.cleanup(); }
});

test("fromFile outside the jail → PATH_OUTSIDE_WORKDIR", async () => {
    const h = harness();
    try {
        process.env.PILOTSWARM_ARTIFACT_FILE_ROOTS = h.dir;
        const outside = path.join(os.homedir(), ".no-such-artifact-root", "f.bin");
        const res = await h.call("write_artifact", { fromFile: outside, filename: "f.bin" });
        assert.equal(res.error, "PATH_OUTSIDE_WORKDIR");
    } finally {
        delete process.env.PILOTSWARM_ARTIFACT_FILE_ROOTS;
        h.cleanup();
    }
});

test("fromArtifact copies server-side with copy provenance", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", { filename: "src.md", content: "payload" });
        const res = await h.call(
            "write_artifact",
            { fromArtifact: { sessionId: "sess-a", filename: "src.md" } },
            { durableSessionId: "sess-b" },
        );
        assert.equal(res.success, true);
        assert.equal(res.sessionId, "sess-b");
        assert.equal(res.sha256, sha(Buffer.from("payload")));
        assert.equal(res.source, "copy");
        assert.equal(res.sourceDetail, "artifact://sess-a/src.md");
    } finally { h.cleanup(); }
});

test("fromArtifact with wrong expectedSha256 → SHA_MISMATCH and the copy is deleted", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", { filename: "src.md", content: "payload" });
        const res = await h.call(
            "write_artifact",
            { fromArtifact: { sessionId: "sess-a", filename: "src.md", expectedSha256: "0".repeat(64) } },
            { durableSessionId: "sess-b" },
        );
        assert.equal(res.error, "SHA_MISMATCH");
        assert.equal(await h.store.statArtifact("sess-b", "src.md"), null, "failed copy must not linger");
    } finally { h.cleanup(); }
});

// ── read: modes ────────────────────────────────────────────────

test("metaOnly returns provenance without content", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", { filename: "note.md", content: "# hello\n" });
        const res = await h.call("read_artifact", { sessionId: "sess-a", filename: "note.md", metaOnly: true });
        assert.equal(res.success, true);
        assert.equal(res.sha256, sha(Buffer.from("# hello\n")));
        assert.equal(res.content, undefined);
        const missing = await h.call("read_artifact", { sessionId: "sess-a", filename: "nope.md", metaOnly: true });
        assert.equal(missing.error, "ARTIFACT_NOT_FOUND");
    } finally { h.cleanup(); }
});

test("toFile materializes bytes on the worker filesystem", async () => {
    const h = harness();
    try {
        const src = path.join(h.dir, "img.png");
        fs.writeFileSync(src, PNG_BYTES);
        await h.call("write_artifact", { fromFile: src });
        const dest = path.join(h.dir, "out", "copy.png");
        const res = await h.call("read_artifact", { sessionId: "sess-a", filename: "img.png", toFile: dest });
        assert.equal(res.success, true);
        assert.equal(res.path, fs.realpathSync(path.join(h.dir, "out")) + path.sep + "copy.png");
        assert.equal(sha(fs.readFileSync(dest)), sha(PNG_BYTES), "bytes round-trip exactly");
        assert.equal(res.content, undefined, "toFile must not also inline content");
    } finally { h.cleanup(); }
});

test("toFile overwrites a pre-existing local file (turn rescheduled onto the producing worker)", async () => {
    const h = harness();
    try {
        // Producer: local file → artifact.
        const local = path.join(h.dir, "report.md");
        fs.writeFileSync(local, "artifact truth v1");
        await h.call("write_artifact", { fromFile: local, filename: "report.md" });
        // Same worker, later turn: local copy has drifted (or is stale scratch).
        fs.writeFileSync(local, "stale local drift — must be replaced");
        const res = await h.call("read_artifact", { sessionId: "sess-a", filename: "report.md", toFile: local });
        assert.equal(res.success, true);
        assert.equal(
            fs.readFileSync(local, "utf8"),
            "artifact truth v1",
            "the artifact store is the source of truth; toFile must overwrite local state",
        );
    } finally { h.cleanup(); }
});

test("metaOnly + toFile → EXCLUSIVE_MODE", async () => {
    const h = harness();
    try {
        const res = await h.call("read_artifact", { sessionId: "sess-a", filename: "x", metaOnly: true, toFile: "/tmp/x" });
        assert.equal(res.error, "EXCLUSIVE_MODE");
    } finally { h.cleanup(); }
});

test("binary inline read without base64 teaches toFile/base64; with base64 round-trips", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", {
            filename: "tiny.png", content: PNG_BYTES.toString("base64"),
            contentType: "image/png", encoding: "base64",
        });
        const refused = await h.call("read_artifact", { sessionId: "sess-a", filename: "tiny.png" });
        assert.equal(refused.error, "ARTIFACT_IS_BINARY");
        assert.match(refused.hint, /toFile/);
        assert.equal(refused.sizeBytes, PNG_BYTES.length);
        const b64 = await h.call("read_artifact", { sessionId: "sess-a", filename: "tiny.png", encoding: "base64" });
        assert.equal(b64.success, true);
        assert.equal(sha(Buffer.from(b64.content, "base64")), sha(PNG_BYTES));
    } finally { h.cleanup(); }
});

test("inline reads are bounded: truncated flag, range, and full-file sha256", async () => {
    const h = harness();
    try {
        const big = "x".repeat(1000);
        await h.call("write_artifact", { filename: "big.md", content: big });
        const res = await h.call("read_artifact", { sessionId: "sess-a", filename: "big.md", maxBytes: 100, offset: 50 });
        assert.equal(res.truncated, true);
        assert.deepEqual(res.range, { offset: 50, length: 100 });
        assert.equal(res.content.length, 100);
        assert.equal(res.sha256, sha(Buffer.from(big)), "sha256 is always the FULL artifact hash");
    } finally { h.cleanup(); }
});

// ── list & pin ─────────────────────────────────────────────────

test("list_artifacts carries sha256 metadata", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", { filename: "a.md", content: "A" });
        const res = await h.call("list_artifacts", {});
        assert.equal(res.count, 1);
        assert.equal(res.files[0].sha256, sha(Buffer.from("A")));
    } finally { h.cleanup(); }
});

test("pin at write time persists through stat and pin toggling works", async () => {
    const h = harness();
    try {
        await h.call("write_artifact", { filename: "keep.md", content: "K", pin: true });
        const stat = await h.store.statArtifact("sess-a", "keep.md");
        assert.equal(stat.pinned, true);
        const unpinned = await h.store.setArtifactPinned("sess-a", "keep.md", false);
        assert.notEqual(unpinned.pinned, true);
    } finally { h.cleanup(); }
});

// ── base prompt contract (filesystem isolation) ────────────────

test("sub-agent and top-level base prompts teach filesystem isolation + fromFile/toFile handoff", () => {
    const agents = fs.readFileSync(new URL("../../dist/orchestration/agents.js", import.meta.url), "utf8");
    const proxy = fs.readFileSync(new URL("../../dist/session-proxy.js", import.meta.url), "utf8");
    for (const [name, text] of [["agents", agents], ["session-proxy", proxy]]) {
        assert.match(text, /FILESYSTEM ISOLATION/, `${name}: names the constraint`);
        assert.match(text, /do NOT share a filesystem|can NEVER see your local files/, `${name}: states pods don't share files`);
        assert.match(text, /fromFile/, `${name}: teaches the data-plane write`);
        assert.match(text, /toFile/, `${name}: teaches the data-plane read`);
    }
    assert.doesNotMatch(agents, /export_artifact/, "agents prompt no longer references the retired tool");
});
