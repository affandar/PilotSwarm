/**
 * Standalone tests for the Postgres SessionFs provider.
 *
 * Exercises every fs_* operation directly through the provider with no
 * Copilot SDK involvement. Each describe block runs against its own
 * randomly-named schema and drops it in afterAll.
 *
 * Requires DATABASE_URL in .env.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPgSessionFsProvider } from "../src/index.js";
import { makeStore } from "./helpers.js";

const SESSION = "session-standalone";

function makeProvider(store) {
    return createPgSessionFsProvider({ store, sessionId: SESSION });
}

describe("PgSessionFsStore: schema lifecycle", () => {
    it("initialize is idempotent (can be called twice)", async () => {
        const { store, cleanup } = await makeStore();
        try {
            await store.initialize(); // second time
            // First migration creates the type — re-running must not throw.
            const r = await store.pool.query(
                `SELECT count(*)::int AS n FROM "${store.schema}".sessionfs_sessions`,
            );
            expect(r.rows[0].n).toBe(0);
        } finally {
            await cleanup();
        }
    });
});

describe("provider: writeFile + readFile + exists + stat", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("writes and reads back a file at root", async () => {
        await fs.writeFile("/hello.txt", "world");
        expect(await fs.readFile("/hello.txt")).toBe("world");
        expect(await fs.exists("/hello.txt")).toBe(true);
    });

    it("writeFile auto-creates parent directories", async () => {
        await fs.writeFile("/a/b/c/deep.txt", "deep");
        expect(await fs.readFile("/a/b/c/deep.txt")).toBe("deep");
        expect(await fs.exists("/a")).toBe(true);
        expect(await fs.exists("/a/b")).toBe(true);
        expect(await fs.exists("/a/b/c")).toBe(true);
    });

    it("writeFile overwrites and updates size", async () => {
        await fs.writeFile("/over.txt", "first");
        await fs.writeFile("/over.txt", "secondsecond");
        expect(await fs.readFile("/over.txt")).toBe("secondsecond");
        const s = await fs.stat("/over.txt");
        expect(s.size).toBe(12);
        expect(s.isFile).toBe(true);
        expect(s.isDirectory).toBe(false);
    });

    it("readFile on missing path throws ENOENT", async () => {
        await expect(fs.readFile("/nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("exists returns false for missing path", async () => {
        expect(await fs.exists("/never.txt")).toBe(false);
    });

    it("stat on missing path throws ENOENT", async () => {
        await expect(fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("readFile on a directory throws", async () => {
        await fs.mkdir("/justdir", false);
        await expect(fs.readFile("/justdir")).rejects.toBeTruthy();
    });
});

describe("provider: appendFile (segment strategy)", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("appends to a fresh file", async () => {
        await fs.appendFile("/log.txt", "line1\n");
        await fs.appendFile("/log.txt", "line2\n");
        await fs.appendFile("/log.txt", "line3\n");
        expect(await fs.readFile("/log.txt")).toBe("line1\nline2\nline3\n");
    });

    it("stat includes pending segment bytes", async () => {
        const s = await fs.stat("/log.txt");
        expect(s.size).toBe("line1\nline2\nline3\n".length);
    });

    it("writeFile truncates pending segments", async () => {
        await fs.writeFile("/log.txt", "RESET");
        expect(await fs.readFile("/log.txt")).toBe("RESET");
        const s = await fs.stat("/log.txt");
        expect(s.size).toBe(5);
    });

    it("append after write resumes correctly", async () => {
        await fs.appendFile("/log.txt", "+more");
        expect(await fs.readFile("/log.txt")).toBe("RESET+more");
    });
});

describe("provider: mkdir + readdir + readdirWithTypes", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("readdir on root returns empty list initially", async () => {
        expect(await fs.readdir("/")).toEqual([]);
    });

    it("mkdir non-recursive requires parent", async () => {
        await expect(fs.mkdir("/x/y", false)).rejects.toBeTruthy();
    });

    it("mkdir recursive creates the chain", async () => {
        await fs.mkdir("/x/y/z", true);
        expect(await fs.exists("/x")).toBe(true);
        expect(await fs.exists("/x/y")).toBe(true);
        expect(await fs.exists("/x/y/z")).toBe(true);
    });

    it("mkdir on existing directory is a no-op", async () => {
        await fs.mkdir("/x/y/z", true);
        const s = await fs.stat("/x/y/z");
        expect(s.isDirectory).toBe(true);
    });

    it("mkdir on existing file fails", async () => {
        await fs.writeFile("/file-here", "content");
        await expect(fs.mkdir("/file-here", true)).rejects.toBeTruthy();
    });

    it("readdir lists immediate children only", async () => {
        await fs.writeFile("/x/a.txt", "a");
        await fs.writeFile("/x/b.txt", "b");
        await fs.mkdir("/x/sub", false);
        const entries = (await fs.readdir("/x")).sort();
        expect(entries).toEqual(["a.txt", "b.txt", "sub", "y"]);
    });

    it("readdirWithTypes annotates entry kind", async () => {
        const entries = (await fs.readdirWithTypes("/x")).sort((a, b) => a.name.localeCompare(b.name));
        const map = Object.fromEntries(entries.map((e) => [e.name, e.type]));
        expect(map["a.txt"]).toBe("file");
        expect(map["sub"]).toBe("directory");
        expect(map["y"]).toBe("directory");
    });

    it("readdir on missing dir throws ENOENT", async () => {
        await expect(fs.readdir("/nope-dir")).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("provider: rm", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("rm a single file", async () => {
        await fs.writeFile("/gone.txt", "bye");
        await fs.rm("/gone.txt", false, false);
        expect(await fs.exists("/gone.txt")).toBe(false);
    });

    it("rm a missing file with force=false throws", async () => {
        await expect(fs.rm("/missing", false, false)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rm a missing file with force=true succeeds", async () => {
        await fs.rm("/missing", false, true);
    });

    it("rm a non-empty dir without recursive throws", async () => {
        await fs.writeFile("/dir1/inside.txt", "x");
        await expect(fs.rm("/dir1", false, false)).rejects.toBeTruthy();
    });

    it("rm a non-empty dir with recursive removes the subtree", async () => {
        await fs.writeFile("/dir2/a.txt", "a");
        await fs.writeFile("/dir2/sub/b.txt", "b");
        await fs.appendFile("/dir2/c.log", "c");
        await fs.rm("/dir2", true, false);
        expect(await fs.exists("/dir2")).toBe(false);
        expect(await fs.exists("/dir2/a.txt")).toBe(false);
        expect(await fs.exists("/dir2/sub/b.txt")).toBe(false);
    });

    it("cannot rm root", async () => {
        await expect(fs.rm("/", true, false)).rejects.toBeTruthy();
    });
});

describe("provider: rename", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("renames a file in place", async () => {
        await fs.writeFile("/src.txt", "hello");
        await fs.rename("/src.txt", "/dst.txt");
        expect(await fs.exists("/src.txt")).toBe(false);
        expect(await fs.readFile("/dst.txt")).toBe("hello");
    });

    it("renames a file across directories", async () => {
        await fs.mkdir("/move", true);
        await fs.writeFile("/a.txt", "A");
        await fs.rename("/a.txt", "/move/a.txt");
        expect(await fs.exists("/a.txt")).toBe(false);
        expect(await fs.readFile("/move/a.txt")).toBe("A");
    });

    it("renames a directory and rewrites descendants", async () => {
        await fs.writeFile("/old/inner/leaf.txt", "leaf");
        await fs.appendFile("/old/inner/journal.log", "j1");
        await fs.appendFile("/old/inner/journal.log", "j2");
        await fs.rename("/old", "/new");
        expect(await fs.exists("/old")).toBe(false);
        expect(await fs.exists("/new/inner")).toBe(true);
        expect(await fs.readFile("/new/inner/leaf.txt")).toBe("leaf");
        expect(await fs.readFile("/new/inner/journal.log")).toBe("j1j2");
    });

    it("rename to existing destination fails", async () => {
        await fs.writeFile("/exists.txt", "x");
        await fs.writeFile("/other.txt", "y");
        await expect(fs.rename("/exists.txt", "/other.txt")).rejects.toBeTruthy();
    });

    it("rename of missing source throws ENOENT", async () => {
        await expect(fs.rename("/none", "/wherever")).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("provider: session isolation", () => {
    let store, cleanup;
    beforeAll(async () => { ({ store, cleanup } = await makeStore()); });
    afterAll(async () => { await cleanup(); });

    it("two sessions do not see each other's files", async () => {
        const a = createPgSessionFsProvider({ store, sessionId: "session-A" });
        const b = createPgSessionFsProvider({ store, sessionId: "session-B" });
        await a.writeFile("/shared.txt", "only-A");
        expect(await b.exists("/shared.txt")).toBe(false);
        await b.writeFile("/shared.txt", "only-B");
        expect(await a.readFile("/shared.txt")).toBe("only-A");
        expect(await b.readFile("/shared.txt")).toBe("only-B");
    });
});

describe("path canonicalization rejects escapes", () => {
    let store, fs, cleanup;
    beforeAll(async () => {
        ({ store, cleanup } = await makeStore());
        fs = makeProvider(store);
    });
    afterAll(async () => { await cleanup(); });

    it("rejects path that escapes root via '..'", async () => {
        await expect(fs.readFile("/a/../../etc")).rejects.toBeTruthy();
    });

    it("collapses '.' and repeated separators", async () => {
        await fs.writeFile("/a/b/c.txt", "ok");
        expect(await fs.readFile("//a/./b///c.txt")).toBe("ok");
    });
});

describe("dropSession removes all session data", () => {
    it("frees nodes + segments in cascade", async () => {
        const { store, cleanup } = await makeStore();
        try {
            const fs = createPgSessionFsProvider({ store, sessionId: "session-doomed" });
            await fs.writeFile("/x.txt", "x");
            await fs.appendFile("/y.log", "y");
            await store.dropSession("session-doomed");
            const r = await store.pool.query(
                `SELECT count(*)::int AS n FROM "${store.schema}".sessionfs_nodes WHERE session_id = $1`,
                ["session-doomed"],
            );
            expect(r.rows[0].n).toBe(0);
            const r2 = await store.pool.query(
                `SELECT count(*)::int AS n FROM "${store.schema}".sessionfs_append_segments WHERE session_id = $1`,
                ["session-doomed"],
            );
            expect(r2.rows[0].n).toBe(0);
        } finally {
            await cleanup();
        }
    });
});
