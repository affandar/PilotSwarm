import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { runDurableFilesystemBoundary } from "../helpers/durable-filesystem-boundary.mjs";

const parentRequest = body => body.tools.some(t => t.function?.name === "read_artifact");
function scripted({ assumeShared = false, fakeChecksum = false } = {}) {
    let step = 0;
    return (body, index, fixture) => {
        if (index > 10) throw new Error("Unexpected inference loop");
        if (parentRequest(body)) {
            if (fakeChecksum) return { content: fixture.expectedHash };
            if (step++ === 0 && !assumeShared) return { tools: [{ name: "read_artifact", args: { sessionId: fixture.sourceId, filename: "payload.bin", toFile: fixture.childPath } }] };
            if (step <= 2) { step = 3; return { tools: [{ name: "task", args: { name: "checksum", description: "Hash the local report", agent_type: "swarm-task", mode: "sync", prompt: "Hash the local report with shasum" } }] }; }
            return { content: body.messages.at(-1).content };
        }
        if (body.messages.at(-1).role === "tool") return { content: body.messages.at(-1).content };
        return { tools: [{ name: "bash", args: { command: `shasum -a 256 '${assumeShared ? fixture.originalPath : fixture.childPath}'`, mode: "sync", description: "Compute actual report checksum" } }] };
    };
}

describe("durable filesystem boundary with native tasks enabled", () => {
    it.each(["parent", "sibling"])("materializes a %s artifact before native hashing (real CLI)", { timeout: 30_000 }, async relation => {
        const result = await runDurableFilesystemBoundary({ relation, respond: scripted() });
        expect(result.failures, JSON.stringify(result)).toEqual([]);
        expect(result.originalRemoved).toBe(true);
        expect(result.transferredBytes).toBe(4096);
        expect(result.reads).toContainEqual(expect.objectContaining({ materialized: true, success: true }));
    });
    it("rejects a native task using its caller's durable parent's file without transfer", { timeout: 30_000 }, async () => {
        const result = await runDurableFilesystemBoundary({ relation: "parent", respond: scripted({ assumeShared: true }) });
        expect(result.pass).toBe(false);
        expect(result.failures.some(f => f.includes("Unexpected native shell"))).toBe(true);
        expect(result.transferredBytes).toBe(0);
    });
    it("rejects a correct checksum claimed without transfer or execution", { timeout: 20_000 }, async () => {
        const result = await runDurableFilesystemBoundary({ relation: "sibling", respond: scripted({ fakeChecksum: true }) });
        expect(result.pass).toBe(false);
        expect(result.failures).toContain("No attributed native checksum execution");
    });
});

describe.skipIf(process.env.PILOTSWARM_LIVE_MODEL_TESTS !== "1")("Terra understands durable versus native filesystem access", () => {
    it.each(["parent", "sibling"])("chooses artifact transfer from a durable %s without being told the transfer method", { timeout: 120_000 }, async relation => {
        if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN required for opt-in live evaluation");
        const result = await runDurableFilesystemBoundary({ relation, token: process.env.GITHUB_TOKEN });
        const out = path.resolve("../../.tmp/native-subagents");
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, `durable-filesystem-${relation}.json`), JSON.stringify(result, null, 2));
        expect(result.failures).toEqual([]);
    });
});
