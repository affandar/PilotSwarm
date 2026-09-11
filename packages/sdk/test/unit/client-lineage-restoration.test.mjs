/** Actual client first-send path; no database or provider required. */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";

function fixture(records) {
    const rows = new Map(records.map(row => [row.sessionId, { state: "pending", ...row }]));
    const reads = [], starts = [], messages = [], updates = [];
    const client = new PilotSwarmClient({ waitThreshold: 30 });
    client._catalog = {
        createSession: async (id, record) => { rows.set(id, { sessionId: id, state: "pending", ...record }); },
        getSession: async id => { reads.push(id); return rows.get(id) ?? null; },
        getSessionCreationConfig: async () => ({ boundAgentName: "analyst", boundAgentPackageId: "pkg-selected", toolNames: ["catalog"] }),
        updateSession: async (id, changes) => { updates.push({ id, changes }); },
    };
    client.duroxideClient = {
        startOrchestrationVersioned: async (id, name, input, version) => { starts.push({ id, name, input, version }); },
        enqueueEvent: async (id, queue, message) => { messages.push({ id, queue, message: JSON.parse(message) }); },
    };
    return { client, rows, reads, starts, messages, updates,
        send: (id, prompt = "Start the named assignment") => client._ensureOrchestrationAndSend(id, prompt),
    };
}
const ROOT = { sessionId: "root", parentSessionId: null };
const CHILD = { sessionId: "child", parentSessionId: "root" };
const GRANDCHILD = { sessionId: "grandchild", parentSessionId: "child" };

for (const [sessionId, expectedParent, depth] of [
    ["root", undefined, 0], ["child", "root", 1], ["grandchild", "child", 2],
]) {
    test(`first send on another client restores ${sessionId} lineage without losing named binding`, async () => {
        const h = fixture([ROOT, CHILD, GRANDCHILD]);
        await h.send(sessionId);
        assert.equal(h.starts.length, 1);
        const input = h.starts[0].input;
        assert.equal(input.parentSessionId, expectedParent);
        assert.equal(input.nestingLevel, depth);
        assert.equal(input.config.boundAgentName, "analyst");
        assert.equal(input.config.boundAgentPackageId, "pkg-selected");
        assert.deepEqual(input.config.toolNames, ["catalog"]);
        assert.equal(input.idleTimeout, expectedParent ? -1 : 1800);
        assert.equal(input.inputGracePeriod, expectedParent ? -1 : 30);
        assert.deepEqual(h.reads, depth === 2 ? ["grandchild", "child", "root"] : depth === 1 ? ["child", "root"] : ["root"]);
        assert.equal(h.messages.length, 1);
    });
}

test("same-client explicit create depth wins over reconstructed structural depth, including zero", async () => {
    for (const explicit of [0, 4]) {
        const h = fixture([ROOT]);
        await h.client.createSession({ sessionId: "child", parentSessionId: "root", nestingLevel: explicit });
        await h.send("child");
        assert.equal(h.starts[0].input.parentSessionId, "root");
        assert.equal(h.starts[0].input.nestingLevel, explicit);
    }
});

test("catalog parent is authoritative even if the local parent map is stale", async () => {
    const h = fixture([ROOT, CHILD, GRANDCHILD]);
    h.client.parentSessionIds.set("grandchild", "root");
    await h.send("grandchild");
    assert.equal(h.starts[0].input.parentSessionId, "child");
    assert.equal(h.starts[0].input.nestingLevel, 2);
});

test("a cached parent's explicit logical depth does not invent the reopened child's durable depth", async () => {
    const h = fixture([ROOT, CHILD, GRANDCHILD]);
    h.client.nestingLevels.set("child", 9);
    await h.send("grandchild");
    assert.equal(h.starts[0].input.nestingLevel, 2);
});

for (const [label, records, id] of [
    ["missing session", [ROOT], "missing"],
    ["missing parent", [CHILD], "child"],
    ["missing ancestor", [GRANDCHILD, CHILD], "grandchild"],
    ["self cycle", [{ sessionId: "child", parentSessionId: "child" }], "child"],
    ["ancestor cycle", [GRANDCHILD, { ...CHILD, parentSessionId: "root" }, { ...ROOT, parentSessionId: "child" }], "grandchild"],
]) {
    test(`${label} fails closed before any orchestration or message is created`, async () => {
        const h = fixture(records);
        await assert.rejects(h.send(id), { code: "SESSION_LINEAGE_INVALID" });
        assert.equal(h.starts.length, 0);
        assert.equal(h.messages.length, 0);
        assert.equal(h.updates.length, 0);
        assert.equal(h.client.activeOrchestrations.has(id), false);
        assert.equal(h.client.nestingLevels.has(id), false);
    });
}

test("an explicit create depth cannot bypass a missing parent or cycle", async () => {
    const h = fixture([CHILD]);
    h.client.parentSessionIds.set("child", "root");
    h.client.nestingLevels.set("child", 1);
    await assert.rejects(h.send("child"), { code: "SESSION_LINEAGE_INVALID" });
    assert.equal(h.starts.length, 0);
});

test("lineage traversal is bounded and accepts the exact hop limit", async () => {
    const records = Array.from({ length: 130 }, (_, i) => ({ sessionId: `s${i}`, parentSessionId: i === 129 ? null : `s${i + 1}` }));
    const tooDeep = fixture(records);
    await assert.rejects(tooDeep.send("s0"), error => error.code === "SESSION_LINEAGE_INVALID" && /128 hops/.test(error.message));
    assert.equal(tooDeep.reads.length, 129);
    assert.equal(tooDeep.starts.length, 0);
    const bounded = fixture(records.slice(1));
    await bounded.send("s1");
    assert.equal(bounded.starts[0].input.nestingLevel, 128);
});

test("active sessions do not rewalk ancestry on every message", async () => {
    const h = fixture([ROOT, CHILD, GRANDCHILD]);
    await h.send("grandchild");
    h.reads.length = 0;
    await h.send("grandchild", "Continue the assignment");
    assert.equal(h.starts.length, 1);
    assert.equal(h.messages.length, 2);
    assert.deepEqual(h.reads, ["grandchild"]);
});

test("transient catalog failures do not cache partial lineage; a later send can reconstruct it", async () => {
    const h = fixture([ROOT, CHILD, GRANDCHILD]);
    const get = h.client._catalog.getSession;
    h.client._catalog.getSession = async id => {
        if (id === "root") throw new Error("catalog temporarily unavailable");
        return get(id);
    };
    await assert.rejects(h.send("grandchild"), /catalog temporarily unavailable/);
    assert.equal(h.client.nestingLevels.has("grandchild"), false);
    assert.equal(h.starts.length, 0);
    h.client._catalog.getSession = get;
    await h.send("grandchild");
    assert.equal(h.starts[0].input.nestingLevel, 2);
});
