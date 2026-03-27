import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";

describe("temp session layout", () => {
    it("uses a temp base directory and removes it on cleanup", async () => {
        const env = createTestEnv("temp-session-cleanup");

        expect(env.baseDir.startsWith(tmpdir())).toBe(true);
        expect(env.baseDir.startsWith(homedir())).toBe(false);
        expect(relative(env.baseDir, env.sessionStateDir)).toBe("session-state");
        expect(existsSync(env.baseDir)).toBe(true);
        expect(existsSync(env.sessionStateDir)).toBe(true);

        await env.cleanup();

        expect(existsSync(env.baseDir)).toBe(false);
        expect(existsSync(env.sessionStateDir)).toBe(false);
    });
});
