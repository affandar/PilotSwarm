import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PilotSwarmClient, PilotSwarmSession } from "../../dist/client.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { SIGNAL_STATE_KEY, SIGNAL_MAX_INLINE_BYTES, validateSignalWaitInput } from "../../dist/session-signals.js";
import { DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_LATEST_VERSION } from "../../dist/orchestration-registry.js";

const WAIT = {
    waitId: "wait-1",
    names: ["build_ready"],
    reason: "Waiting for the build",
    startedAt: "2026-09-16T09:00:00.000Z",
};
const SUMMARY = {
    version: 1,
    signalId: "receipt-1",
    name: "build_ready",
    source: { kind: "api", actorId: "user:entra/reader" },
    raisedAt: "2026-09-16T09:00:01.000Z",
    wake: false,
    dataBytes: 19,
};

function harness(options = {}) {
    const row = {
        sessionId: "s1", state: "pending", createdAt: new Date(0), updatedAt: new Date(0),
        ...options.row,
    };
    const rows = new Map([...(options.ancestors ?? []).map(value => [value.sessionId, value]), [row.sessionId, row]]);
    const calls = [], starts = [], enqueues = [], updates = [], valueReads = [], responses = new Map();
    let status = options.status ?? "NotFound";
    let version = Object.hasOwn(options, "version") ? options.version : "1.0.80";
    let customStatus = options.customStatus ?? {};
    const catalog = {
        getSession: async id => { calls.push(["row", id]); return rows.get(id) ?? null; },
        getSessionCreationConfig: async id => {
            calls.push(["config", id]);
            return options.config ?? { boundAgentName: "analyst", toolNames: ["lookup"] };
        },
        updateSession: async (id, patch) => {
            updates.push({ id, patch });
            Object.assign(rows.get(id), patch);
        },
    };
    const duroxide = {
        getStatus: async () => {
            calls.push(["status"]);
            if (options.statusError) throw options.statusError;
            return { status, customStatus: JSON.stringify(customStatus), customStatusVersion: 1 };
        },
        getInstanceInfo: async () => {
            calls.push(["instance"]);
            if (status === "NotFound") throw new Error("Instance not found");
            return { status, orchestrationVersion: version };
        },
        startOrchestrationVersioned: async (id, name, input, requestedVersion) => {
            starts.push({ id, name, input, version: requestedVersion });
            status = options.queuedStart ? "NotFound" : "Running";
            version = options.racingVersion ?? requestedVersion;
        },
        waitForStatusChange: async () => {
            calls.push(["initialization"]);
            if (options.initializationError) throw options.initializationError;
            status = "Running";
            return { status, customStatus: JSON.stringify({ status: "idle" }), customStatusVersion: 1 };
        },
        enqueueEvent: async (id, queue, raw) => {
            const payload = JSON.parse(raw);
            enqueues.push({ id, queue, payload });
            if (payload.id) {
                responses.set(`command.response.${payload.id}`, {
                    schemaVersion: 1, version: 1, emittedAt: 1, cmd: payload.cmd, id: payload.id,
                    result: options.stopResult ?? { outcome: "stopped", waitId: payload.args?.waitId },
                });
            }
        },
        getValue: async (_id, key) => {
            valueReads.push(key);
            if (responses.has(key)) return JSON.stringify(responses.get(key));
            if (options.valueError) throw options.valueError;
            return key === SIGNAL_STATE_KEY ? options.signalState ?? null : null;
        },
    };
    const client = PilotSwarmClient._fromRuntime({ waitThreshold: 30 }, catalog, duroxide);
    const session = new PilotSwarmSession(row.sessionId, client);
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._catalog = catalog;
    mgmt._duroxideClient = duroxide;
    mgmt._started = true;
    return {
        row, rows, calls, starts, enqueues, updates, valueReads, duroxide, catalog, client, session, mgmt,
        setCustomStatus: value => { customStatus = value; },
    };
}

for (const surface of ["session", "management"]) {
    test(`${surface}: first signal starts from durable config/lineage without a model prompt or running CMS state`, async () => {
        const h = harness({
            row: { parentSessionId: "root", agentId: "analyst" },
            ancestors: [{ sessionId: "root", state: "idle", parentSessionId: null }],
            config: { model: "provider:model", boundAgentName: "analyst", toolNames: ["lookup"], bootstrapNestingLevel: 4 },
        });
        const options = { data: { build: 7 }, signalId: "build-7" };
        const result = surface === "session"
            ? await h.session.raiseSignal("build_ready", options)
            : await h.mgmt.raiseSignal("s1", "build_ready", options);
        assert.equal(h.starts.length, 1);
        assert.equal(h.starts[0].version, DURABLE_SESSION_LATEST_VERSION);
        assert.equal(h.starts[0].input.parentSessionId, "root");
        assert.equal(h.starts[0].input.nestingLevel, 4);
        assert.equal(h.starts[0].input.config.boundAgentName, "analyst");
        assert.equal(h.starts[0].input.config.model, "provider:model");
        assert.deepEqual(h.starts[0].input.config.toolNames, ["lookup"]);
        assert.equal(Object.hasOwn(h.starts[0].input.config, "bootstrapNestingLevel"), false);
        assert.equal(h.enqueues.length, 1);
        assert.equal(h.enqueues[0].queue, "messages");
        assert.deepEqual(Object.keys(h.enqueues[0].payload), ["signal"]);
        const signal = h.enqueues[0].payload.signal;
        assert.equal(signal.wake, false);
        assert.deepEqual(signal.data, { build: 7 });
        assert.deepEqual(signal.source, { kind: "api" });
        assert.equal(signal.version, 1);
        assert.deepEqual(result, { signalId: "build-7", name: "build_ready", raisedAt: signal.raisedAt, status: "queued" });
        assert.equal(new Date(signal.raisedAt).toISOString(), signal.raisedAt);
        assert.deepEqual(h.updates, [{ id: "s1", patch: { orchestrationId: "session-s1" } }]);
        assert.equal(h.row.state, "pending");
        assert.equal(h.session.lastOrchestrationId, undefined, "a signal does not pretend send()/wait() has a user turn");
    });
}

test("signals reuse the prompt start path's fail-closed lineage restoration", async () => {
    const h = harness({ row: { parentSessionId: "missing" } });
    await assert.rejects(h.mgmt.raiseSignal("s1", "build_ready"), { code: "SESSION_LINEAGE_INVALID" });
    assert.equal(h.starts.length, 0);
    assert.equal(h.enqueues.length, 0);
    assert.equal(h.updates.length, 0);
});

test("a queued native start is confirmed through status before a signal is enqueued", async () => {
    const h = harness({ queuedStart: true });
    await h.session.raiseSignal("build_ready");
    assert.equal(h.starts.length, 1);
    assert.ok(h.calls.findIndex(([name]) => name === "initialization")
        < h.calls.findIndex(([name]) => name === "instance"));
    assert.equal(h.enqueues.length, 1);
    assert.equal(h.row.state, "pending");
});

test("a prior pending start is observed, not restarted or treated as a compatible execution", async () => {
    const h = harness({ row: { orchestrationId: "session-s1" } });
    await h.mgmt.raiseSignal("s1", "build_ready");
    assert.equal(h.starts.length, 0);
    assert.ok(h.calls.some(([name]) => name === "initialization"));
    assert.equal(h.enqueues.length, 1);
});

test("missing workers time out initialization without falsely reporting an accepted signal", async () => {
    const h = harness({ queuedStart: true, initializationError: new Error("Operation timed out") });
    await assert.rejects(h.session.raiseSignal("build_ready"), error =>
        error.code === "SIGNALS_UNSUPPORTED" && error.status === 409 && /No signal was queued/.test(error.message));
    assert.equal(h.starts.length, 1);
    assert.equal(h.enqueues.length, 0);
    assert.equal(h.row.state, "pending");
});

test("native queued initialization accepts the first signal without a fake prompt or activity", async () => {
    const sessionId = crypto.randomUUID();
    const orchestrationId = `session-${sessionId}`;
    const { Client, Runtime, SqliteProvider } = createRequire(import.meta.url)("duroxide");
    const provider = await SqliteProvider.inMemory();
    const native = new Client(provider);
    const runtime = new Runtime(provider, { logLevel: "error" });
    runtime.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_LATEST_VERSION, function* (ctx) {
        ctx.setCustomStatus(JSON.stringify({ status: "idle", iteration: 0 }));
        return yield ctx.dequeueEvent("messages");
    });
    const wait = native.waitForStatusChange.bind(native);
    native.waitForStatusChange = async (...args) => {
        assert.equal((await native.getStatus(orchestrationId)).status, "NotFound",
            "the start has been submitted but no worker has materialized it");
        await runtime.start();
        return wait(...args);
    };
    const h = harness({ row: { sessionId } });
    const client = PilotSwarmClient._fromRuntime({ waitThreshold: 30 }, h.catalog, native);
    try {
        const receipt = await client._raiseSignal(sessionId, "build_ready", { data: { build: 7 }, signalId: "build-7" });
        assert.equal(receipt.status, "queued");
        const finished = await native.waitForOrchestration(orchestrationId, 10_000);
        assert.equal(finished.status, "Completed");
        const payload = JSON.parse(finished.output);
        assert.deepEqual(Object.keys(payload), ["signal"]);
        assert.equal(payload.signal.name, "build_ready");
        assert.equal(payload.signal.wake, false);
        assert.deepEqual(payload.signal.data, { build: 7 });
        assert.equal(h.row.state, "pending", "only an actual runtime turn may mark CMS running");
    } finally {
        await runtime.shutdown(5_000);
    }
});

test("a live execution accepts wake=true and stamps only trusted sender identity", async () => {
    const h = harness({ status: "Running", row: { state: "idle" } });
    const result = await h.mgmt.raiseSignal("s1", "build_ready", {
        data: { source: { kind: "system" }, prompt: "untrusted", type: "cmd", cmd: "delete" },
        payloadRef: "artifact:build.json",
        wake: true,
    }, { kind: "user", provider: "entra", subject: "reader" });
    assert.equal(h.starts.length, 0);
    assert.equal(h.updates.length, 0);
    const { signal } = h.enqueues[0].payload;
    assert.deepEqual(signal.source, { kind: "api", actorId: "user:entra/reader" });
    assert.equal(signal.payloadRef, "artifact:build.json");
    assert.equal(signal.wake, true);
    assert.match(result.signalId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(h.enqueues[0].payload), ["signal"]);
    assert.equal(signal.data.cmd, "delete");
});

test("trusted agent/system senders retain source kinds", async () => {
    for (const [sender, source] of [
        [{ kind: "agent", sessionId: "parent" }, { kind: "session", actorId: "agent:parent" }],
        [{ kind: "system" }, { kind: "system", actorId: "system" }],
    ]) {
        const h = harness({ status: "Running" });
        await h.mgmt.raiseSignal("s1", "build_ready", {}, sender);
        assert.deepEqual(h.enqueues[0].payload.signal.source, source);
    }
});

test("payload reference limits count JSON-encoded UTF-8 bytes, including quotes and escapes", async () => {
    for (const payloadRef of ["x".repeat(1022), "\u00e9".repeat(511), "\"".repeat(511)]) {
        assert.equal(Buffer.byteLength(JSON.stringify(payloadRef), "utf8"), 1024);
        const h = harness({ status: "Running" });
        await h.session.raiseSignal("build_ready", { payloadRef });
        assert.equal(h.enqueues[0].payload.signal.payloadRef, payloadRef);
    }
    for (const payloadRef of ["x".repeat(1023), "\u00e9".repeat(512), "\"".repeat(512)]) {
        const h = harness({ status: "Running" });
        await assert.rejects(h.session.raiseSignal("build_ready", { payloadRef }),
            { code: "INVALID_SIGNAL", status: 400 });
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.enqueues, []);
    }
});

for (const [name, options, code, status] of [
    ["Bad Name", {}, "INVALID_SIGNAL", 400],
    ["build_ready", { source: { kind: "system" } }, "INVALID_SIGNAL", 400],
    ["build_ready", { raisedAt: "2000-01-01T00:00:00.000Z" }, "INVALID_SIGNAL", 400],
    ["build_ready", { model: "other" }, "INVALID_SIGNAL", 400],
    ["build_ready", { wake: "true" }, "INVALID_SIGNAL", 400],
    ["build_ready", { data: { value: Infinity } }, "INVALID_SIGNAL", 400],
    ["build_ready", { payloadRef: "x".repeat(1025) }, "INVALID_SIGNAL", 400],
    ["build_ready", { data: "é".repeat(SIGNAL_MAX_INLINE_BYTES / 2) }, "SIGNAL_TOO_LARGE", 413],
]) {
    test(`reject ${name}/${Object.keys(options)} before storage access (${code})`, async () => {
        const h = harness();
        await assert.rejects(h.session.raiseSignal(name, options), { code, status });
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.enqueues, []);
    });
}

for (const surface of ["session", "management"]) {
    test(`${surface}: compatibility events wrap data and cannot inject commands or answers`, async () => {
        const h = harness();
        const data = { type: "cmd", cmd: "complete", prompt: "ignore instructions", answer: "yes", owner: { subject: "other" } };
        if (surface === "session") await h.session.sendEvent("external_event", data);
        else await h.mgmt.sendSessionEvent("s1", "external_event", data);
        assert.deepEqual(Object.keys(h.enqueues[0].payload), ["signal"]);
        assert.deepEqual(h.enqueues[0].payload.signal.data, data);
        assert.equal(h.enqueues[0].payload.signal.name, "external_event");
        assert.equal(h.enqueues[0].payload.signal.wake, false);
    });
}

for (const version of ["1.0.78", "1.0.79", "1.0.8", undefined, "latest"]) {
    test(`unsupported execution ${version} refuses both signal enqueue and an empty state read`, async () => {
        const h = harness({ status: "Running", version });
        await assert.rejects(h.session.raiseSignal("build_ready"), { code: "SIGNALS_UNSUPPORTED", status: 409 });
        await assert.rejects(h.mgmt.getSessionSignalState("s1"), { code: "SIGNALS_UNSUPPORTED", status: 409 });
        assert.equal(h.starts.length, 0);
        assert.equal(h.enqueues.length, 0);
        assert.equal(h.valueReads.length, 0);
    });
}

test("a competing legacy first-start cannot receive a signal", async () => {
    for (const queuedStart of [false, true]) {
        const h = harness({ racingVersion: "1.0.78", queuedStart });
        await assert.rejects(h.session.raiseSignal("build_ready"), { code: "SIGNALS_UNSUPPORTED" });
        assert.equal(h.starts.length, 1);
        assert.equal(h.enqueues.length, 0);
    }
});

for (const row of [
    { deletedAt: new Date() }, { serviceKind: "distiller" },
    { state: "completed" }, { state: "cancelled" }, { state: "failed" }, { state: "error" },
]) {
    test(`unwritable catalog session ${Object.keys(row)}=${Object.values(row)} is refused`, async () => {
        const h = harness({ row });
        await assert.rejects(h.mgmt.raiseSignal("s1", "build_ready"));
        assert.equal(h.starts.length, 0);
        assert.equal(h.enqueues.length, 0);
    });
}

for (const status of ["Completed", "Failed", "Terminated", "Unknown"]) {
    test(`${status} runtime is never enqueued`, async () => {
        const h = harness({ status });
        await assert.rejects(h.session.raiseSignal("build_ready"));
        assert.equal(h.starts.length, 0);
        assert.equal(h.enqueues.length, 0);
    });
}

test("a missing old instance is not silently restarted", async () => {
    const h = harness({ row: { orchestrationId: "session-s1", state: "idle" } });
    await assert.rejects(h.mgmt.raiseSignal("s1", "build_ready"), { code: "SIGNALS_UNSUPPORTED" });
    assert.equal(h.starts.length, 0);
    assert.equal(h.enqueues.length, 0);
});

test("runtime read failures fail closed rather than claiming queue acceptance", async () => {
    const h = harness({ statusError: new Error("runtime unavailable") });
    await assert.rejects(h.mgmt.raiseSignal("s1", "build_ready"), /runtime unavailable/);
    assert.equal(h.starts.length, 0);
    assert.equal(h.enqueues.length, 0);
});

test("only a confirmed compatible execution with absent state returns an empty signal state", async () => {
    const live = harness({ status: "Running" });
    assert.deepEqual(await live.mgmt.getSessionSignalState("s1"), { version: 1, interrupted: false, buffered: [] });
    assert.deepEqual(live.valueReads, [SIGNAL_STATE_KEY]);
    const unstarted = harness();
    await assert.rejects(unstarted.mgmt.getSessionSignalState("s1"), { code: "SIGNALS_UNSUPPORTED" });
    assert.deepEqual(unstarted.valueReads, []);
});

test("signal state exposes only metadata, never raw buffer slots or inline payloads", async () => {
    const h = harness({
        status: "Running",
        signalState: JSON.stringify({
            version: 1, interrupted: true, pendingWait: { ...WAIT, data: "private" },
            buffered: [{ ...SUMMARY, data: { secret: "private" } }],
        }),
    });
    assert.deepEqual(await h.mgmt.getSessionSignalState("s1"), {
        version: 1, interrupted: true, pendingWait: WAIT, buffered: [SUMMARY],
    });
    assert.deepEqual(h.valueReads, [SIGNAL_STATE_KEY]);
});

test("signal state preserves the explicit race wait mode without changing legacy waits", async () => {
    for (const [version, pendingWait] of [
        ["1.0.80", WAIT],
        ["1.0.81", { ...WAIT, mode: "any" }],
    ]) {
        const h = harness({
            status: "Running", version,
            signalState: JSON.stringify({ version: 1, interrupted: false, pendingWait, buffered: [] }),
        });
        assert.deepEqual(await h.mgmt.getSessionSignalState("s1"), {
            version: 1, interrupted: false, pendingWait, buffered: [],
        });
    }
});

test("signal wait mode rejects unsupported values instead of silently changing semantics", async () => {
    for (const mode of ["signal", "all", "", null, true, 1]) {
        const h = harness({
            status: "Running", version: "1.0.81",
            signalState: JSON.stringify({ version: 1, interrupted: false, pendingWait: { ...WAIT, mode }, buffered: [] }),
        });
        await assert.rejects(h.mgmt.getSessionSignalState("s1"), { code: "SIGNAL_STATE_INVALID" });
    }
});

const raceOutcome = (winner, timer = "tombstoned") => ({
    version: 1,
    waitId: WAIT.waitId,
    completedAt: "2026-09-16T09:00:05.000Z",
    waitDurationMs: 5000,
    winner,
    losers: { unconsumedSignals: "buffered", otherUserInput: "queued", timer },
});

test("race metadata survives state reads for every typed winner and loser timer disposition", async () => {
    for (const lastRaceOutcome of [
        raceOutcome({ kind: "signal", signalId: SUMMARY.signalId, name: SUMMARY.name, payloadRef: "artifact://build-log" }),
        raceOutcome({ kind: "user", inputId: "input-1", inputKind: "prompt" }),
        raceOutcome({ kind: "user", inputId: "input-2", inputKind: "answer" }, "not_scheduled"),
        raceOutcome({ kind: "timeout", deadline: "2026-09-16T09:00:05.000Z" }, "elapsed"),
        raceOutcome({ kind: "stop" }),
        raceOutcome({ kind: "cancel", disposition: "cancelled" }),
        raceOutcome({ kind: "cancel", disposition: "replaced" }),
        raceOutcome({ kind: "cancel", disposition: "session_terminated" }),
    ]) {
        const h = harness({
            status: "Running", version: "1.0.81",
            signalState: JSON.stringify({ version: 1, interrupted: false, lastRaceOutcome, buffered: [SUMMARY] }),
        });
        assert.deepEqual(await h.mgmt.getSessionSignalState("s1"), {
            version: 1, interrupted: false, lastRaceOutcome, buffered: [SUMMARY],
        });
        assert.deepEqual(h.valueReads, [SIGNAL_STATE_KEY]);
    }
});

test("race metadata rejects corrupt outcomes and embedded payloads through the canonical parser", async () => {
    const valid = raceOutcome({ kind: "signal", signalId: SUMMARY.signalId, name: SUMMARY.name });
    for (const lastRaceOutcome of [
        null, {}, { ...valid, version: 2 }, { ...valid, waitDurationMs: -1 },
        { ...valid, winner: { ...valid.winner, data: { secret: "must-not-leak" } } },
        { ...valid, losers: { ...valid.losers, timer: "elapsed" } },
    ]) {
        const h = harness({
            status: "Running", version: "1.0.81",
            signalState: JSON.stringify({ version: 1, interrupted: false, lastRaceOutcome, buffered: [] }),
        });
        await assert.rejects(h.mgmt.getSessionSignalState("s1"), { code: "SIGNAL_STATE_INVALID" });
    }
});

test("a maximum-name wait's generated reason survives signal-state inspection", async () => {
    const names = Array.from({ length: 8 }, (_, index) => String.fromCharCode(97 + index).repeat(64));
    const request = validateSignalWaitInput({ names });
    assert.ok(Buffer.byteLength(JSON.stringify(request.reason), "utf8") <= 512);
    const h = harness({
        status: "Running",
        signalState: JSON.stringify({ version: 1, interrupted: false, pendingWait: { ...WAIT, names, reason: request.reason }, buffered: [] }),
    });
    const state = await h.mgmt.getSessionSignalState("s1");
    assert.deepEqual(state.pendingWait.names, names);
    assert.equal(state.pendingWait.reason, request.reason);
});

test("corrupt or unreadable signal state is not reported as empty", async () => {
    for (const signalState of ["not JSON", "{}", '{"version":1,"interrupted":false,"buffered":null}',
        JSON.stringify({ version: 1, interrupted: false, buffered: [], pendingWait: { ...WAIT, names: "wrong" } }),
        JSON.stringify({ version: 1, interrupted: false, buffered: [], pendingWait: { ...WAIT, startedAt: 42 } })]) {
        const h = harness({ status: "Running", signalState });
        await assert.rejects(h.mgmt.getSessionSignalState("s1"), { code: "SIGNAL_STATE_INVALID" });
    }
    const h = harness({ status: "Running", valueError: new Error("KV unavailable") });
    await assert.rejects(h.mgmt.getSessionSignalState("s1"), /KV unavailable/);
});

test("session handles, management views and status reads carry typed signal waits", async () => {
    const h = harness({ status: "Running", row: { state: "waiting" },
        customStatus: { status: "waiting", signalWait: WAIT, signalWaitInterrupted: true } });
    for (const info of [await h.session.getInfo(), await h.mgmt.getSession("s1")]) {
        assert.deepEqual(info.signalWait, WAIT);
        assert.equal(info.signalWaitInterrupted, true);
    }
    const status = await h.mgmt.getSessionStatus("s1");
    assert.deepEqual(status.customStatus.signalWait, WAIT);
    assert.equal(status.customStatus.signalWaitInterrupted, true);
});

test("terminal session views do not present a stale signal wait as pending", async () => {
    const h = harness({ status: "Completed", row: { state: "completed" },
        customStatus: { status: "waiting", signalWait: WAIT, signalWaitInterrupted: false } });
    for (const info of [await h.session.getInfo(), await h.mgmt.getSession("s1")]) {
        assert.equal(info.signalWait, undefined);
        assert.equal(info.signalWaitInterrupted, undefined);
    }
});

test("Stop cancels a parked signal wait via its observed wait-id and the command response channel", async () => {
    const h = harness({ status: "Running", row: { state: "waiting", activeTurnIndex: null },
        customStatus: { status: "waiting", signalWait: WAIT, signalWaitInterrupted: false } });
    assert.deepEqual(await h.mgmt.stopSessionTurn("s1", { reason: "user stopped" }), { outcome: "stopped" });
    const { queue, payload } = h.enqueues[0];
    assert.equal(queue, "messages");
    assert.deepEqual(payload, { type: "cmd", cmd: "cancel_signal_wait", id: payload.id,
        args: { waitId: WAIT.waitId, reason: "user stopped" } });
    assert.ok(h.valueReads.includes(`command.response.${payload.id}`));
});

test("Stop never retargets a replacement wait", async () => {
    const h = harness({ status: "Running", row: { state: "waiting" },
        customStatus: { status: "waiting", signalWait: WAIT },
        stopResult: { outcome: "no_active_turn" } });
    const getInfo = h.duroxide.getInstanceInfo;
    h.duroxide.getInstanceInfo = async () => {
        h.setCustomStatus({ status: "waiting", signalWait: { ...WAIT, waitId: "replacement" } });
        return getInfo();
    };
    assert.deepEqual(await h.mgmt.stopSessionTurn("s1"), { outcome: "no_active_turn" });
    assert.equal(h.enqueues.length, 1);
    assert.equal(h.enqueues[0].payload.args.waitId, WAIT.waitId);
});

test("Stop ignores stale signal-wait metadata on a terminal execution", async () => {
    const h = harness({ status: "Completed", row: { state: "waiting" },
        customStatus: { status: "waiting", signalWait: WAIT } });
    assert.equal((await h.mgmt.stopSessionTurn("s1")).outcome, "no_active_turn");
    assert.equal(h.enqueues.length, 0);
});

test("Stop on an interrupted active model turn retains the existing turn-scoped protocol", async () => {
    const h = harness({ status: "Running", row: { state: "running", activeTurnIndex: 7 },
        customStatus: { status: "running", signalWait: WAIT, signalWaitInterrupted: true },
        stopResult: { outcome: "stopped", turnIndex: 7 } });
    assert.deepEqual(await h.mgmt.stopSessionTurn("s1"), { outcome: "stopped", turnIndex: 7 });
    assert.equal(h.enqueues[0].queue, "stopTurn.7");
    assert.equal(h.enqueues[0].payload.cmd, undefined);
});

test("ordinary idle/timer/cron sessions keep Stop's no-active-turn behavior", async () => {
    for (const customStatus of [{ status: "idle" }, { status: "waiting", waitSeconds: 30 },
        { status: "waiting", cronActive: true }]) {
        const h = harness({ status: "Running", version: "1.0.78", row: { state: customStatus.status }, customStatus });
        assert.equal((await h.mgmt.stopSessionTurn("s1")).outcome, "no_active_turn");
        assert.equal(h.enqueues.length, 0);
        assert.equal(h.valueReads.length, 0);
    }
});
