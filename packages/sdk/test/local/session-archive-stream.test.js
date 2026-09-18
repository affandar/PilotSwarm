import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { archiveSessionDir, extractSessionArchive, FilesystemSessionStore } from "../../src/session-store.ts";

let root;
const id = "archive-stream-fixture";
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-archive-test-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

function writeSession(stateDir, content = "original") {
    const directory = path.join(stateDir, id);
    fs.mkdirSync(path.join(directory, "files"), { recursive: true });
    fs.writeFileSync(path.join(directory, "workspace.yaml"), "session: archive-stream-fixture\n");
    fs.writeFileSync(path.join(directory, "events.jsonl"), content);
    fs.writeFileSync(path.join(directory, "files", "notes.md"), content);
    return directory;
}

async function makeArchive(codec, label = codec, content = "original") {
    const stateDir = path.join(root, `state-${label}`);
    writeSession(stateDir, content);
    const archive = path.join(root, `${label}.archive`);
    await archiveSessionDir(stateDir, id, archive, codec);
    return archive;
}

function expectContent(destination, content = "original") {
    expect(fs.readFileSync(path.join(destination, id, "events.jsonl"), "utf8")).toBe(content);
    expect(fs.readFileSync(path.join(destination, id, "files", "notes.md"), "utf8")).toBe(content);
}

function expectNoStagingLeak() {
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith("ps-extract-"))).toEqual([]);
}

describe("session archive stream validation", () => {
    it.each(["gzip", "brotli"])("restores %s and removes decoded staging files", async (codec) => {
        const archive = await makeArchive(codec);
        const destination = path.join(root, "restored");
        await extractSessionArchive(destination, archive, codec);
        expectContent(destination);
        expectNoStagingLeak();
    });

    it.each(["gzip", "brotli"])("rejects truncated %s before extracting any members", async (codec) => {
        const archive = await makeArchive(codec);
        const bytes = fs.readFileSync(archive);
        fs.writeFileSync(archive, bytes.subarray(0, bytes.length - 4));
        const destination = path.join(root, "restored");
        await expect(extractSessionArchive(destination, archive, codec)).rejects.toBeDefined();
        expect(fs.existsSync(path.join(destination, id))).toBe(false);
        expectNoStagingLeak();
    });

    it("rejects invalid tar after valid decompression and removes staging files", async () => {
        const archive = path.join(root, "invalid.archive");
        fs.writeFileSync(archive, zlib.brotliCompressSync(Buffer.from("not a tar archive\n")));
        await expect(extractSessionArchive(path.join(root, "restored"), archive, "brotli"))
            .rejects.toThrow("tar extract failed");
        expectNoStagingLeak();
    });

    it("preserves logical tar EOF instead of extracting appended archive members", async () => {
        const first = await makeArchive("brotli", "first", "first");
        const second = await makeArchive("brotli", "second", "appended");
        const archive = path.join(root, "concatenated.archive");
        fs.writeFileSync(archive, zlib.brotliCompressSync(Buffer.concat([
            zlib.brotliDecompressSync(fs.readFileSync(first)),
            zlib.brotliDecompressSync(fs.readFileSync(second)),
        ])));
        const destination = path.join(root, "restored");
        await extractSessionArchive(destination, archive, "brotli");
        expectContent(destination, "first");
        expectNoStagingLeak();
    });

    it("survives the early successful tar close that rejects the former stdin pipeline", async () => {
        const archive = await makeArchive("brotli");
        const controlArchive = path.join(root, "control.archive");
        fs.copyFileSync(archive, controlArchive);
        const releaseEof = Promise.withResolvers();
        const originalRead = fs.createReadStream.bind(fs);
        vi.spyOn(fs, "createReadStream").mockImplementation((file, ...options) => {
            const input = originalRead(file, ...options);
            if (file !== archive && file !== controlArchive) return input;
            const held = new Transform({
                transform(chunk, _encoding, callback) { callback(null, chunk); },
                flush(callback) { releaseEof.promise.then(() => callback()); },
            });
            input.on("error", (error) => held.destroy(error));
            return input.pipe(held);
        });
        const controlDestination = path.join(root, "legacy-control");
        fs.mkdirSync(controlDestination);
        let controlExit;
        async function legacyControl() {
            const tar = spawn("tar", ["-xf", "-", "-C", controlDestination]);
            const exited = new Promise((resolve, reject) => {
                tar.once("error", (error) => { releaseEof.resolve(); reject(error); });
                tar.once("close", (code) => {
                    controlExit = code;
                    releaseEof.resolve();
                    if (code === 0) resolve(); else reject(new Error(`control tar exited ${code}`));
                });
            });
            const [stream, child] = await Promise.allSettled([
                pipeline(fs.createReadStream(controlArchive), zlib.createBrotliDecompress(), tar.stdin),
                exited,
            ]);
            if (child.status === "rejected") throw child.reason;
            if (stream.status === "rejected") throw stream.reason;
        }
        const destination = path.join(root, "restored");
        const [current, control] = await Promise.allSettled([
            extractSessionArchive(destination, archive, "brotli"),
            legacyControl(),
        ]);
        expect(controlExit).toBe(0);
        expect(control.status).toBe("rejected");
        expect(["ERR_STREAM_PREMATURE_CLOSE", "EPIPE"]).toContain(control.reason?.code);
        expectContent(controlDestination);
        expect(current.status).toBe("fulfilled");
        expectContent(destination);
        expectNoStagingLeak();
    });

    it.each(["hash mismatch", "truncated stream", "invalid tar"])(
        "keeps dirty local state and committed metadata unchanged after %s",
        async (failure) => {
            const state = path.join(root, "state");
            const sessionDir = writeSession(state);
            const storeDir = path.join(root, "store");
            const store = new FilesystemSessionStore(storeDir, state);
            await store.commitSnapshot(id, { baseVersion: 0, turnKey: "initial" });
            const metadataPath = path.join(storeDir, `${id}.meta.json`);
            const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
            const archive = path.join(storeDir, metadata.tarFile);
            const original = fs.readFileSync(archive);
            const changed = failure === "invalid tar"
                ? zlib.brotliCompressSync(Buffer.from("not a tar archive\n"))
                : original.subarray(0, original.length - 4);
            fs.writeFileSync(archive, changed);
            if (failure !== "hash mismatch") {
                metadata.contentHash = createHash("sha256").update(changed).digest("hex");
                metadata.sizeBytes = changed.length;
                fs.writeFileSync(metadataPath, JSON.stringify(metadata));
            }
            writeSession(state, "dirty-local-state");
            const sentinel = path.join(sessionDir, ".ps-turn-inprogress");
            fs.writeFileSync(sentinel, "dirty");
            const before = fs.readFileSync(metadataPath, "utf8");
            await expect(store.hydrateSnapshot(id)).rejects.toThrow(
                failure === "hash mismatch" ? "Snapshot integrity check failed" : /tar extract failed|unexpected end of file/,
            );
            expectContent(state, "dirty-local-state");
            expect(fs.readFileSync(sentinel, "utf8")).toBe("dirty");
            expect(fs.readFileSync(metadataPath, "utf8")).toBe(before);
            expectNoStagingLeak();
        },
    );
});
