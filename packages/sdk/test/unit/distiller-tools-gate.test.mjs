// read_transcript_page is registered fleet-wide but MUST refuse any caller
// whose CMS row is not an actual regen-distiller service session, and must
// only ever read the served session's archive under the strict name shape.
// These are the security-load-bearing checks (adversarial-review finding).
import test from "node:test";
import assert from "node:assert/strict";
import { createDistillerTools, REGEN_DISTILLER_SERVICE_KIND } from "../../dist/distiller-tools.js";

function harness({ callerRow, archiveBody = '{"seq":1,"eventType":"user.message","data":{"content":"hi"}}' } = {}) {
    const reads = [];
    const catalog = { getSession: async (id) => (id === callerRow?.sessionId ? callerRow : null) };
    const blobStore = {
        downloadArtifact: async (sessionId, filename) => {
            reads.push({ sessionId, filename });
            return { body: Buffer.from(archiveBody, "utf8") };
        },
    };
    const [tool] = createDistillerTools({ catalog, blobStore });
    return { tool, reads };
}

const call = (tool, args, callerSessionId) => tool.handler(args, { durableSessionId: callerSessionId });

test("a non-service caller is refused (no service columns)", async () => {
    const callerRow = { sessionId: "c1", serviceKind: null, serviceOf: null };
    const { tool, reads } = harness({ callerRow });
    const res = await call(tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, "c1");
    assert.match(res.error, /reserved for the regen-distiller/i);
    assert.equal(reads.length, 0, "no archive read attempted");
});

test("a session that merely SET agentId=regen-distiller (no service columns) is refused", async () => {
    // The lockdown strips its tools, but even if it kept the pager, the gate
    // keys on serviceKind (worker-only), not the spoofable agentId.
    const callerRow = { sessionId: "c1", agentId: REGEN_DISTILLER_SERVICE_KIND, serviceKind: null, serviceOf: null };
    const { tool } = harness({ callerRow });
    const res = await call(tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, "c1");
    assert.match(res.error, /reserved for the regen-distiller/i);
});

test("a real distiller reads ONLY its served session's archive", async () => {
    const callerRow = { sessionId: "d1", serviceKind: REGEN_DISTILLER_SERVICE_KIND, serviceOf: "victim-or-owner" };
    const { tool, reads } = harness({ callerRow });
    const res = await call(tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, "d1");
    assert.equal(res.error, undefined, "no error for a valid distiller");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].sessionId, "victim-or-owner", "reads serviceOf, never a caller-supplied session id");
    assert.equal(res.entries[0].role, "user");
});

test("non-archive / traversal filenames are refused before any read", async () => {
    const callerRow = { sessionId: "d1", serviceKind: REGEN_DISTILLER_SERVICE_KIND, serviceOf: "s9" };
    for (const bad of ["../secrets.json", "package-e0-abc.json", "transcript-e0-abc.jsonl/../x", "session.db", "transcript-e0-../evil.jsonl"]) {
        const { tool, reads } = harness({ callerRow });
        const res = await call(tool, { artifact: bad, page: 1 }, "d1");
        assert.match(res.error, /transcript-e/i, `refused: ${bad}`);
        assert.equal(reads.length, 0, `no read for: ${bad}`);
    }
});

test("no session context is refused", async () => {
    const { tool } = harness({ callerRow: null });
    const res = await call(tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, undefined);
    assert.match(res.error, /no session context/i);
});
