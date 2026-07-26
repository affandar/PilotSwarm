// read_transcript_page is registered fleet-wide but MUST refuse any caller
// whose CMS row is not an actual regen-distiller service session, and must
// only ever read the served session's archive under the strict name shape.
// These are the security-load-bearing checks (adversarial-review finding).
import test from "node:test";
import assert from "node:assert/strict";
import { createDistillerTools, REGEN_DISTILLER_SERVICE_KIND } from "../../dist/distiller-tools.js";

// The archive is written by runRegenArchive as `type`, NOT `eventType` (that
// is the CMS row shape). This fixture used to say `eventType`, so the role
// assertion below passed against a reader that classified every real archived
// message as "system" — which is exactly how that bug shipped. Keep this
// fixture in the shape the archive actually produces.
const ARCHIVE_LINE = '{"seq":1,"type":"user.message","data":{"content":"hi"}}';

function harness({ callerRow, archiveBody = ARCHIVE_LINE } = {}) {
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

test("roles survive the archive round-trip, in both record shapes", async () => {
    // Reads the REAL handler, not a copy of its logic: a regression in
    // distiller-tools.ts must fail here. When this read `eventType` only,
    // every archived message came back "system", silently erasing the
    // user/assistant structure the selection strategy exists to preserve.
    const callerRow = { sessionId: "d1", serviceKind: REGEN_DISTILLER_SERVICE_KIND, serviceOf: "s1" };
    const archiveBody = [
        '{"seq":1,"type":"user.message","data":{"content":"mission"}}',
        '{"seq":2,"type":"assistant.message","data":{"content":"ack"}}',
        '{"seq":3,"type":"session.compaction","data":{"content":"noise"}}',
    ].join("\n");

    const { tool } = harness({ callerRow, archiveBody });
    const res = await call(tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, "d1");
    assert.deepEqual(res.entries.map((e) => e.role), ["user", "assistant", "system"]);
    assert.equal(res.entries[0].content, "mission", "content survives too");

    // Legacy CMS-shaped archives still classify, so older archives keep working.
    const legacy = harness({ callerRow, archiveBody: '{"seq":1,"eventType":"assistant.message","data":{"content":"x"}}' });
    const legacyRes = await call(legacy.tool, { artifact: "transcript-e0-abc.jsonl", page: 1 }, "d1");
    assert.equal(legacyRes.entries[0].role, "assistant");
});

test("a chunked archive name is readable", async () => {
    // Multi-chunk archives are named transcript-e<E>-<attempt>.partNNN.jsonl.
    // If that fails the name gate, every oversized regen breaks at the pager.
    const callerRow = { sessionId: "d1", serviceKind: REGEN_DISTILLER_SERVICE_KIND, serviceOf: "s1" };
    const { tool, reads } = harness({ callerRow });
    const res = await call(tool, { artifact: "transcript-e3-a1.part001.jsonl", page: 1 }, "d1");
    assert.equal(res.error, undefined, "chunk names pass the archive-name gate");
    assert.equal(reads[0].filename, "transcript-e3-a1.part001.jsonl");
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
