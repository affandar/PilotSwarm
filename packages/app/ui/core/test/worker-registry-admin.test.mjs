/**
 * Worker-registry UI core — the Admin → Workers view-model.
 *
 * Both hosts (web table, TUI lines-builder) render from selectAdminConsole's
 * `workers` view, so this is the parity floor for both surfaces: section
 * gating (admin-only tree row), liveness windowing, phase counts, sorting,
 * and the controller fetch path over transport.listWorkers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    applyWorkerFleetViewOptions,
    selectAdminConsole,
    selectWorkerDetailsPane,
} from "../src/index.js";

const ADMIN = { provider: "test", subject: "root", email: "root@test", isAdmin: true };

function makeController(transportOverrides = {}, profile = ADMIN) {
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getCurrentUserProfile: async () => ({ ...profile, githubCopilotKeySet: false, profileSettings: {} }),
        listCreatableAgents: async () => [],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, store };
}

function workerRow(id, overrides = {}) {
    return {
        workerNodeId: id,
        pool: "aks-default",
        phase: "ready",
        owner: null,
        registeredAt: new Date(Date.now() - 3_600_000),
        updatedAt: new Date(),
        info: {
            sdkVersion: "0.5.29",
            consumes: ["agent-packages"],
            repos: ["PilotSwarm"],
            provenance: {
                displayName: "General worker",
                hostname: "aks-node-1",
                processStartedAt: "2026-08-30T01:00:00.000Z",
                sdkVersion: "0.5.29",
                applicationVersion: "0.5.37",
                sourceCommit: "0123456789abcdef",
                buildId: "build-37",
                image: {
                    ref: "registry/pilotswarm-worker:build-37",
                    digest: "sha256:037",
                },
            },
            runtime: { substrate: "kubernetes", hostname: "aks-node-1" },
        },
        health: {
            uptimeS: 7500,
            rssBytes: 210 * 1024 * 1024,
            heapUsedBytes: 90e6,
            eventLoopDelayP99Ms: 4.2,
            activeSessions: 3,
            workerSlots: { busy: 3, total: 8 },
        },
        state: { "agent-packages": { epoch: 7, installed: { "incident-kit": { semver: "1.4.0", status: "ok" }, "broken-kit": { semver: "1.0.0", status: "error" } } } },
        ...overrides,
    };
}

test("workers view: liveness window, phase counts, pool sort, health text", async () => {
    const { controller, store } = makeController({
        listWorkers: async () => [
            workerRow("pod-b"),
            workerRow("pod-a", { pool: "aks-default", phase: "draining" }),
            workerRow("laptop-1", {
                pool: "affan-laptop",
                owner: { provider: "test", subject: "affan" },
                info: { sdkVersion: "0.5.29", consumes: [], runtime: { substrate: "process" } },
                state: {},
            }),
            workerRow("pod-dead", { updatedAt: new Date(Date.now() - 10 * 60_000), phase: "ready" }),
        ],
    });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, githubCopilotKeySet: false, profileSettings: {} } });

    controller.setAdminSection("workers");
    await controller.refreshAdminWorkers();

    const view = selectAdminConsole(store.getState());
    assert.equal(view.section, "workers");

    // Admin-only tree row, selected.
    const treeRow = view.settingsTree.find((row) => row.id === "workers");
    assert.ok(treeRow, "admins get a Workers section in the settings tree");
    assert.equal(treeRow.selected, true);

    const workers = view.workers;
    assert.equal(workers.error, null);
    assert.equal(workers.rows.length, 4);
    // Pool-major sort: affan-laptop < aks-default; ids ascend within a pool.
    assert.deepEqual(workers.rows.map((row) => row.id), ["laptop-1", "pod-a", "pod-b", "pod-dead"]);

    // 90s liveness window: the 10-minute-silent pod is registered, not live.
    const dead = workers.rows.find((row) => row.id === "pod-dead");
    assert.equal(dead.live, false);
    assert.equal(workers.counts.registered, 4);
    assert.equal(workers.counts.live, 3);
    assert.equal(workers.counts.ready, 2);
    assert.equal(workers.counts.draining, 1);
    assert.equal(workers.counts.pools, 2);
    assert.equal(workers.summaryText, "3 live / 4 registered");

    // Health/state formatting the hosts print verbatim.
    const podB = workers.rows.find((row) => row.id === "pod-b");
    assert.equal(podB.phase, "ready");
    assert.equal(podB.sessions, 3);
    assert.equal(podB.uptimeText, "2h 5m");
    assert.equal(podB.eventLoopText, "4.2ms");
    assert.equal(podB.pkgEpoch, 7);
    assert.equal(podB.pkgText, "1 ok · 1 error");
    assert.equal(podB.substrate, "kubernetes");
    assert.equal(podB.displayName, "General worker");
    assert.equal(podB.hostname, "aks-node-1");
    assert.equal(podB.owner, "unknown");
    assert.equal(podB.applicationVersion, "0.5.37");
    assert.equal(podB.sourceCommitShort, "0123456789ab");
    assert.equal(podB.buildId, "build-37");
    assert.equal(podB.imageDigest, "sha256:037");
    assert.equal(podB.affinityText, "repo:PilotSwarm");
    assert.equal(podB.utilizationText, "3/8 (38%)");

    const laptop = workers.rows.find((row) => row.id === "laptop-1");
    assert.equal(laptop.owner, "affan");
    assert.equal(laptop.substrate, "process");
    assert.equal(laptop.pkgText, null, "worker without agent-packages state shows no pkg column");
    assert.equal(laptop.displayName, "unknown");
    assert.equal(laptop.hostname, "unknown", "hostname is never derived from workerNodeId");
});

test("workers view filters and sorts mixed provenance without guessing missing values", async () => {
    const { controller, store } = makeController({
        listWorkers: async () => [
            workerRow("worker-v2", {
                owner: { provider: "team", subject: "Build Systems" },
                info: {
                    sdkVersion: "0.6.0",
                    provenance: {
                        displayName: "Build worker",
                        hostname: "host-v2",
                        processStartedAt: "2026-08-30T03:00:00.000Z",
                        sdkVersion: "0.6.0",
                        applicationVersion: "2.0.0",
                        sourceCommit: "bbbbbbbbbbbbbbbb",
                        buildId: "build-200",
                        image: { ref: "registry/worker:v2", digest: "sha256:200" },
                    },
                },
            }),
            workerRow("worker-v1", {
                owner: { provider: "team", subject: "Agent Platform" },
                info: {
                    sdkVersion: "0.5.0",
                    provenance: {
                        displayName: "Legacy worker",
                        hostname: "host-v1",
                        processStartedAt: "2026-08-30T02:00:00.000Z",
                        sdkVersion: "0.5.0",
                        applicationVersion: "1.0.0",
                        sourceCommit: "aaaaaaaaaaaaaaaa",
                        buildId: "build-100",
                        image: { ref: "registry/worker:v1", digest: "sha256:100" },
                    },
                },
            }),
            workerRow("worker-unknown", {
                updatedAt: new Date(Date.now() - 10 * 60_000),
                info: {},
                health: {},
            }),
        ],
    });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, githubCopilotKeySet: false, profileSettings: {} } });
    controller.setAdminSection("workers");
    await controller.refreshAdminWorkers();

    const rows = selectAdminConsole(store.getState()).workers.rows;
    const unknown = rows.find((row) => row.id === "worker-unknown");
    assert.equal(unknown.displayName, "unknown");
    assert.equal(unknown.hostname, "unknown");
    assert.equal(unknown.owner, "unknown");
    assert.equal(unknown.applicationVersion, "unknown");
    assert.equal(unknown.sourceCommit, "unknown");
    assert.equal(unknown.buildIdentity, "unknown");
    assert.equal(unknown.utilizationText, "unknown");

    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        field: "owner", query: "agent platform",
    }).map((row) => row.id), ["worker-v1"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        field: "version", query: "2.0",
    }).map((row) => row.id), ["worker-v2"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        field: "commit", query: "bbbb",
    }).map((row) => row.id), ["worker-v2"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        field: "build", query: "sha256:100",
    }).map((row) => row.id), ["worker-v1"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        status: "stale",
    }).map((row) => row.id), ["worker-unknown"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        sort: "version",
    }).map((row) => row.id), ["worker-v1", "worker-v2", "worker-unknown"]);
    assert.deepEqual(applyWorkerFleetViewOptions(rows, {
        sort: "stale",
    }).map((row) => row.id), ["worker-unknown", "worker-v1", "worker-v2"]);
});

test("workers section is hidden from non-admins; unknown sections fall back to providers", async () => {
    const { store } = makeController({}, { ...ADMIN, subject: "alice", isAdmin: false });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({
        type: "admin/profile/loaded",
        profile: { provider: "test", subject: "alice", email: "a@test", isAdmin: false, githubCopilotKeySet: false, profileSettings: {} },
    });

    const view = selectAdminConsole(store.getState());
    assert.equal(view.settingsTree.some((row) => row.id === "workers"), false,
        "non-admins never see the Workers section");

    store.dispatch({ type: "admin/section", section: "bogus" });
    assert.equal(selectAdminConsole(store.getState()).section, "providers");
});

test("transport without listWorkers degrades to a visible error, not a crash", async () => {
    const { controller, store } = makeController();
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, githubCopilotKeySet: false, profileSettings: {} } });

    controller.setAdminSection("workers");
    await controller.refreshAdminWorkers();

    const view = selectAdminConsole(store.getState());
    assert.equal(view.section, "workers");
    assert.match(view.workers.error, /not available/);
    assert.equal(view.workers.rows.length, 0);
});

test("selected worker details render a chronological durable Job timeline", async () => {
    const calls = [];
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId, options) => {
            calls.push({ workerNodeId, options });
            return [
                {
                    timelineId: "event:1",
                    at: "2026-08-29T12:00:01.000Z",
                    kind: "session_event",
                    eventType: "session.turn_started",
                    workerNodeId,
                    generatorId: "generator-1",
                    generatorName: "Standard Fix",
                    jobId: "job-1",
                    jobKey: "work-item-1001",
                    stateRunId: "state-run-1",
                    stateName: "Validating",
                    stateRevision: 4,
                    sessionId: "session-1",
                    summary: null,
                    details: {},
                },
                {
                    timelineId: "operation:1",
                    at: "2026-08-29T12:00:02.000Z",
                    kind: "external_operation",
                    eventType: "job.external_operation_completed",
                    workerNodeId,
                    generatorId: "generator-1",
                    generatorName: "Standard Fix",
                    jobId: "job-1",
                    jobKey: "work-item-1001",
                    stateRunId: "state-run-1",
                    stateName: "Validating",
                    stateRevision: 4,
                    sessionId: "session-1",
                    summary: null,
                    details: { operationKind: "pvs", status: "succeeded" },
                },
                {
                    timelineId: "transition:1",
                    at: "2026-08-29T12:00:03.000Z",
                    kind: "state_transition",
                    eventType: "job.state_transition",
                    workerNodeId,
                    generatorId: "generator-1",
                    generatorName: "Standard Fix",
                    jobId: "job-1",
                    jobKey: "work-item-1001",
                    stateRunId: "state-run-1",
                    stateName: "Validating",
                    stateRevision: 4,
                    sessionId: "session-1",
                    summary: "PVS passed with durable run evidence.",
                    details: { fromState: "Validating", toState: "Validated" },
                },
            ];
        },
    });
    store.dispatch({ type: "admin/workers/loaded", list: [workerRow("pod-a")] });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    assert.equal(calls.at(-1).workerNodeId, "pod-a");
    assert.equal(calls.at(-1).options.limit, 1_000);
    assert.ok(Number.isFinite(new Date(calls.at(-1).options.since).getTime()));
    const pane = selectWorkerDetailsPane(store.getState());
    assert.equal(pane.timelineSwimlane.workerName, "General worker");
    assert.equal(pane.timelineSwimlane.workerNodeId, "pod-a");
    assert.deepEqual(pane.timelineTable.rows.map((row) => ({
        timestamp: row.timestamp,
        jobId: row.jobId,
        sessionId: row.sessionId,
        activity: row.activity,
    })), [
        {
            timestamp: "2026-08-29 12:00:01Z",
            jobId: "job-1",
            sessionId: "session-1",
            activity: "State execution started · Validating r4",
        },
        {
            timestamp: "2026-08-29 12:00:02Z",
            jobId: "job-1",
            sessionId: "session-1",
            activity: "External operation completed · pvs · succeeded · Validating r4",
        },
        {
            timestamp: "2026-08-29 12:00:03Z",
            jobId: "job-1",
            sessionId: "session-1",
            activity: "Validating -> Validated · Validating r4 · PVS passed with durable run evidence.",
        },
    ]);
    const text = pane.lines.map((line) => {
        const runs = Array.isArray(line) ? line : [line];
        return runs.map((run) => run.text || "").join("");
    }).join("\n");
    assert.match(text, /TIMELINE \(3\)/);
    assert.match(text, /TIMESTAMP\s+JOB ID\s+SESSION ID\s+ACTIVITY/);
    assert.match(text, /2026-08-29 12:00:01Z\s+job-1\s+session-1\s+State execution started · Validating r4/);
    assert.match(text, /2026-08-29 12:00:02Z\s+job-1\s+session-1\s+External operation completed · pvs · succeeded · Validating r4/);
    assert.match(text, /2026-08-29 12:00:03Z\s+job-1\s+session-1\s+Validating -> Validated · Validating r4 · PVS passed with durable run evidence/);
});

test("worker utilization prefers a registry display name without inferring from hostname", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async () => [],
    });
    store.dispatch({
        type: "admin/workers/loaded",
        list: [workerRow("authoritative-worker-id", {
            info: {
                displayName: "Repo Build Worker",
                runtime: { hostname: "machine-name-must-not-win" },
            },
        })],
    });

    controller.selectNodeMapNode("authoritative-worker-id", "authoritative-worker-id");
    await controller.refreshWorkerTimeline("authoritative-worker-id");

    const swimlane = selectWorkerDetailsPane(store.getState()).timelineSwimlane;
    assert.equal(swimlane.workerName, "Repo Build Worker");
    assert.equal(swimlane.workerNodeId, "authoritative-worker-id");
});

test("worker timeline swimlanes separate Job turns from unattributed time", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId) => [
            {
                timelineId: "job-1:start",
                at: "2026-08-29T12:00:00.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Diagnosing",
                stateRevision: 2,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "job-1:end",
                at: "2026-08-29T12:00:10.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Diagnosing",
                stateRevision: 2,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "cleanup-only",
                at: "2026-08-29T12:00:15.000Z",
                kind: "session_event",
                eventType: "session.affinity_released",
                workerNodeId,
                generatorName: "Old Generator",
                jobId: "cleanup-only-job",
                jobKey: "old-job",
                sessionId: "old-session",
                details: { reason: "idle" },
            },
            {
                timelineId: "job-2:handoff",
                at: "2026-08-29T12:00:20.000Z",
                kind: "session_event",
                eventType: "session.lossy_handoff",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-2",
                jobKey: "work-item-1002",
                stateName: "Validating",
                stateRevision: 4,
                sessionId: "session-2",
                details: {},
            },
            {
                timelineId: "job-2:start",
                at: "2026-08-29T12:00:25.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-2",
                jobKey: "work-item-1002",
                stateName: "Validating",
                stateRevision: 4,
                sessionId: "session-2",
                details: {},
            },
            {
                timelineId: "job-2:transition",
                at: "2026-08-29T12:00:35.000Z",
                kind: "state_transition",
                eventType: "job.state_transition",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-2",
                jobKey: "work-item-1002",
                stateName: "Validating",
                stateRevision: 4,
                sessionId: "session-2",
                summary: "PVS passed.",
                details: { fromState: "Validating", toState: "Validated" },
            },
            {
                timelineId: "job-2:execution-completed",
                at: "2026-08-29T12:00:38.000Z",
                kind: "session_event",
                eventType: "session.turn_execution_completed",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-2",
                jobKey: "work-item-1002",
                stateName: "Validating",
                stateRevision: 4,
                sessionId: "session-2",
                details: { resultType: "completed" },
            },
            {
                timelineId: "job-2:end",
                at: "2026-08-29T12:00:40.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                generatorName: "Standard Fix",
                jobId: "job-2",
                jobKey: "work-item-1002",
                stateName: "Validating",
                stateRevision: 4,
                sessionId: "session-2",
                details: {},
            },
        ],
    });
    store.dispatch({ type: "admin/workers/loaded", list: [workerRow("pod-a")] });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    const swimlane = selectWorkerDetailsPane(store.getState()).timelineSwimlane;
    assert.deepEqual(swimlane.lanes.map((lane) => lane.key), [
        "overhead",
        "idle",
        "job:job-1",
        "job:job-2",
    ], "cleanup-only events do not create misleading Job lanes");
    assert.deepEqual(swimlane.segments.map((segment) => ({
        laneKey: segment.laneKey,
        kind: segment.kind,
        label: segment.label,
        sessionId: segment.sessionId || null,
        durationMs: segment.durationMs,
    })), [
        { laneKey: "idle", kind: "idle", label: "Idle / available", sessionId: null, durationMs: 10_000 },
        { laneKey: "overhead", kind: "overhead", label: "Session preparation", sessionId: "session-2", durationMs: 5_000 },
        { laneKey: "overhead", kind: "overhead", label: "Turn finalization", sessionId: "session-2", durationMs: 2_000 },
        { laneKey: "job:job-1", kind: "work", label: "Diagnosing", sessionId: "session-1", durationMs: 10_000 },
        { laneKey: "job:job-2", kind: "work", label: "Validating", sessionId: "session-2", durationMs: 10_000 },
        { laneKey: "job:job-2", kind: "work_wrap_up", label: "Turn wrap-up", sessionId: "session-2", durationMs: 3_000 },
    ]);
    assert.equal(swimlane.durationMs, 40_000);
    assert.equal(
        new Date(swimlane.startAt).getTime() - new Date(swimlane.displayStartAt).getTime(),
        5_000,
    );
    assert.equal(swimlane.displayDurationMs, 45_000);
    assert.equal(swimlane.busyMs, 23_000);
    assert.equal(swimlane.overheadMs, 7_000);
    assert.equal(swimlane.idleMs, 10_000);
    assert.equal(swimlane.busyMs + swimlane.overheadMs + swimlane.idleMs, swimlane.durationMs);
    assert.deepEqual(swimlane.markers.map((marker) => ({
        laneKey: marker.laneKey,
        kind: marker.kind,
        label: marker.label,
        sessionId: marker.sessionId,
    })), [
        {
            laneKey: "job:job-2",
            kind: "transition",
            label: "Validating -> Validated",
            sessionId: "session-2",
        },
    ]);
});

test("completed worker timelines stop accounting at the final Job and add display-only tail room", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId) => [
            {
                timelineId: "turn:start",
                at: "2026-08-29T12:00:00.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Publishing",
                stateRevision: 6,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "turn:execution-completed",
                at: "2026-08-29T12:00:08.000Z",
                kind: "session_event",
                eventType: "session.turn_execution_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Publishing",
                stateRevision: 6,
                sessionId: "session-1",
                details: { resultType: "completed" },
            },
            {
                timelineId: "turn:completed",
                at: "2026-08-29T12:00:10.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Publishing",
                stateRevision: 6,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "job:completed",
                at: "2026-08-29T12:00:11.000Z",
                kind: "state_transition",
                eventType: "job.state_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Published",
                stateRevision: 7,
                sessionId: "session-1",
                details: { fromState: "Published", toState: "Published", terminal: true },
            },
            {
                timelineId: "session:cleanup",
                at: "2026-08-29T12:00:30.000Z",
                kind: "session_event",
                eventType: "session.affinity_released",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "Published",
                stateRevision: 7,
                sessionId: "session-1",
                details: { reason: "idle" },
            },
        ],
    });
    store.dispatch({ type: "admin/workers/loaded", list: [workerRow("pod-a")] });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    const swimlane = selectWorkerDetailsPane(store.getState()).timelineSwimlane;
    assert.equal(swimlane.endAt, "2026-08-29T12:00:11.000Z");
    assert.equal(swimlane.displayEndAt, "2026-08-29T12:00:16.000Z");
    assert.equal(swimlane.durationMs, 11_000);
    assert.equal(swimlane.displayDurationMs, 21_000);
    assert.equal(swimlane.busyMs, 8_000);
    assert.equal(swimlane.overheadMs, 2_000);
    assert.equal(swimlane.idleMs, 1_000);
    assert.equal(
        swimlane.segments.some((segment) => segment.label === "Post-turn bookkeeping"),
        false,
        "cleanup after the terminal Job does not become worker overhead",
    );
    assert.equal(
        swimlane.markers.some((marker) => marker.key === "session:cleanup"),
        false,
        "events after the final Job completion are outside the displayed timeline",
    );
});

test("worker timeline shows runnable Jobs queued behind a single worker slot", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId) => [
            {
                timelineId: "job-1:start",
                at: "2026-08-29T12:00:00.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "active-job",
                stateName: "Diagnosing",
                stateRevision: 1,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "job-1:end",
                at: "2026-08-29T12:00:30.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "active-job",
                stateName: "Diagnosing",
                stateRevision: 1,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "capacity-wait:job-2",
                at: "2026-08-29T12:00:30.000Z",
                kind: "worker_capacity_wait",
                eventType: "job.worker_capacity_wait",
                workerNodeId,
                jobId: "job-2",
                jobKey: "queued-job",
                stateName: "Validating",
                stateRevision: 2,
                sessionId: "session-2",
                details: {
                    runnableAt: "2026-08-29T12:00:10.000Z",
                    workerAcquiredAt: "2026-08-29T12:00:30.000Z",
                    waitDurationMs: 20_000,
                },
            },
            {
                timelineId: "job-2:start",
                at: "2026-08-29T12:00:30.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-2",
                jobKey: "queued-job",
                stateName: "Validating",
                stateRevision: 2,
                sessionId: "session-2",
                details: {},
            },
            {
                timelineId: "job-2:end",
                at: "2026-08-29T12:00:40.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-2",
                jobKey: "queued-job",
                stateName: "Validating",
                stateRevision: 2,
                sessionId: "session-2",
                details: {},
            },
        ],
    });
    store.dispatch({
        type: "admin/workers/loaded",
        list: [workerRow("pod-a", {
            health: {
                uptimeS: 7500,
                workerSlots: { total: 1 },
            },
        })],
    });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    const pane = selectWorkerDetailsPane(store.getState());
    const capacityWait = pane.timelineSwimlane.segments.find(
        (segment) => segment.kind === "capacity_wait",
    );
    assert.deepEqual({
        laneKey: capacityWait.laneKey,
        label: capacityWait.label,
        compute: capacityWait.compute,
        color: capacityWait.color,
        durationMs: capacityWait.durationMs,
        workerConcurrency: capacityWait.workerConcurrency,
        blockingJobs: capacityWait.blockingJobs,
    }, {
        laneKey: "job:job-2",
        label: "Queued · waiting for worker",
        compute: false,
        color: "red",
        durationMs: 20_000,
        workerConcurrency: 1,
        blockingJobs: ["active-job"],
    });
    assert.match(
        capacityWait.activity,
        /Another Job\/turn occupied worker capacity during this wait: Job active-job/,
    );
    assert.match(capacityWait.activity, /No compute is allocated to this Job/);
    assert.equal(pane.timelineSwimlane.capacityWaitMs, 20_000);
    const queuedLane = pane.timelineSwimlane.lanes.find((lane) => lane.jobId === "job-2");
    assert.deepEqual({
        status: queuedLane.status,
        activeMs: queuedLane.activeMs,
        queuedMs: queuedLane.queuedMs,
        waitMs: queuedLane.waitMs,
        overheadMs: queuedLane.overheadMs,
        efficiencyPercent: queuedLane.efficiencyPercent,
    }, {
        status: "in_progress",
        activeMs: 10_000,
        queuedMs: 20_000,
        waitMs: 0,
        overheadMs: 0,
        efficiencyPercent: 33,
    });
    assert.equal(
        pane.timelineSwimlane.markers.some((marker) => marker.key === "capacity-wait:job-2"),
        false,
        "capacity waits render as spans, not point markers",
    );
    assert.match(
        pane.timelineTable.rows.find((row) => row.key === "capacity-wait:job-2").activity,
        /Queued · waiting for worker/,
    );
});

test("worker timeline splits a short human wait from a long red worker queue wait", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId) => [
            {
                timelineId: "turn:start:1",
                at: "2026-08-29T12:00:00.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "human:start",
                at: "2026-08-29T12:00:04.000Z",
                kind: "session_event",
                eventType: "session.input_required_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: { question: "Approve?" },
            },
            {
                timelineId: "turn:end:1",
                at: "2026-08-29T12:00:05.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "capacity-wait:input:1",
                at: "2026-08-29T12:01:05.000Z",
                kind: "worker_capacity_wait",
                eventType: "job.worker_capacity_wait",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {
                    runnableAt: "2026-08-29T12:00:05.500Z",
                    workerAcquiredAt: "2026-08-29T12:01:05.000Z",
                    waitDurationMs: 59_500,
                    waitSource: "human_input",
                },
            },
            {
                timelineId: "capacity:acquired",
                at: "2026-08-29T12:01:05.000Z",
                kind: "session_event",
                eventType: "session.worker_capacity_acquired",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {
                    acquiredAt: "2026-08-29T12:01:05.000Z",
                    turnIndex: 2,
                    acquireMode: "warm",
                },
            },
            {
                timelineId: "turn:start:2",
                at: "2026-08-29T12:01:06.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "turn:end:2",
                at: "2026-08-29T12:01:10.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
        ],
    });
    store.dispatch({
        type: "admin/workers/loaded",
        list: [workerRow("pod-a", {
            health: { workerSlots: { total: 1 } },
        })],
    });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    const segments = selectWorkerDetailsPane(store.getState()).timelineSwimlane.segments;
    const humanWait = segments.find((segment) => segment.kind === "human_wait");
    const capacityWait = segments.find((segment) => segment.kind === "capacity_wait");
    assert.equal(humanWait.durationMs, 500);
    assert.equal(humanWait.color, "yellow");
    assert.equal(capacityWait.durationMs, 59_500);
    assert.equal(capacityWait.color, "red");
    assert.equal(capacityWait.label, "Queued · waiting for worker");
    assert.equal(capacityWait.compute, false);
    assert.equal(capacityWait.startAt, "2026-08-29T12:00:05.500Z");
    assert.equal(capacityWait.endAt, "2026-08-29T12:01:05.000Z");
});

test("worker timeline swimlanes render human and system waits as non-compute spans", async () => {
    const { controller, store } = makeController({
        getWorkerTimeline: async (workerNodeId) => [
            {
                timelineId: "turn:start:1",
                at: "2026-08-29T12:00:00.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "human:start",
                at: "2026-08-29T12:00:04.000Z",
                kind: "session_event",
                eventType: "session.input_required_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: { question: "Approve the proposed fix?" },
            },
            {
                timelineId: "turn:end:1",
                at: "2026-08-29T12:00:05.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "turn:start:2",
                at: "2026-08-29T12:00:30.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "system:request",
                at: "2026-08-29T12:00:34.000Z",
                kind: "session_event",
                eventType: "session.system_wait_requested",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: { signalKey: "review:1", reason: "Waiting for code review" },
            },
            {
                timelineId: "turn:end:2",
                at: "2026-08-29T12:00:35.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "FixProposed",
                stateRevision: 3,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "system:start",
                at: "2026-08-29T12:00:40.000Z",
                kind: "session_event",
                eventType: "session.system_wait_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: { signalKey: "review:1", reason: "Waiting for code review" },
            },
            {
                timelineId: "system:start:duplicate",
                at: "2026-08-29T12:00:45.000Z",
                kind: "session_event",
                eventType: "session.system_wait_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: { signalKey: "review:1", reason: "Waiting for code review" },
            },
            {
                timelineId: "system:end",
                at: "2026-08-29T12:00:50.000Z",
                kind: "session_event",
                eventType: "session.system_wait_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {
                    signalKey: "review:1",
                    payload: {
                        provider: "mock",
                        kind: "code_review",
                        operationId: "review-op-1",
                    },
                },
            },
            {
                timelineId: "system:affinity-release",
                at: "2026-08-29T12:00:55.000Z",
                kind: "session_event",
                eventType: "session.affinity_released",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "system:restart",
                at: "2026-08-29T12:01:00.000Z",
                kind: "session_event",
                eventType: "session.system_wait_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: { signalKey: "review:1", reason: "Waiting for code review" },
            },
            {
                timelineId: "system:resume-preparation",
                at: "2026-08-29T12:01:08.000Z",
                kind: "session_event",
                eventType: "session.lossy_handoff",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "turn:start:3",
                at: "2026-08-29T12:01:10.000Z",
                kind: "session_event",
                eventType: "session.turn_started",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "turn:end:3",
                at: "2026-08-29T12:01:15.000Z",
                kind: "session_event",
                eventType: "session.turn_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {},
            },
            {
                timelineId: "transition:end",
                at: "2026-08-29T12:01:20.000Z",
                kind: "state_transition",
                eventType: "job.state_transition",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "AutomatedCodeReview",
                stateRevision: 4,
                sessionId: "session-1",
                details: {
                    fromState: "AutomatedCodeReview",
                    toState: "AutomatedCodeReviewApproved",
                },
            },
            {
                timelineId: "completion:end",
                at: "2026-08-29T12:01:30.000Z",
                kind: "state_transition",
                eventType: "job.state_completed",
                workerNodeId,
                jobId: "job-1",
                jobKey: "work-item-1001",
                stateName: "PRPublished",
                stateRevision: 6,
                sessionId: "session-1",
                summary: "Delivery completed.",
                details: {
                    fromState: "PRPublished",
                    toState: "PRPublished",
                    terminal: true,
                },
            },
        ],
    });
    store.dispatch({ type: "admin/workers/loaded", list: [workerRow("pod-a")] });

    controller.selectNodeMapNode("pod-a", "pod-a");
    await controller.refreshWorkerTimeline("pod-a");

    const swimlane = selectWorkerDetailsPane(store.getState()).timelineSwimlane;
    const waits = swimlane.segments.filter((segment) => segment.compute === false);
    assert.equal(
        waits.some((segment) => segment.kind === "capacity_wait"),
        false,
        "human and system waits are not inferred to be runnable capacity waits",
    );
    assert.deepEqual(waits.map((segment) => ({
        kind: segment.kind,
        label: segment.label,
        color: segment.color,
        durationMs: segment.durationMs,
        sessionId: segment.sessionId,
    })), [
        {
            kind: "human_wait",
            label: "Response wait",
            color: "yellow",
            durationMs: 25_000,
            sessionId: "session-1",
        },
        {
            kind: "system_wait",
            label: "Observed-condition wait · Mock Automated Code Review",
            color: "magenta",
            durationMs: 33_000,
            sessionId: "session-1",
        },
    ]);
    assert.equal(swimlane.busyMs, 15_000);
    assert.equal(swimlane.overheadMs, 2_000);
    assert.equal(swimlane.idleMs, 73_000);
    assert.equal(swimlane.busyMs + swimlane.overheadMs + swimlane.idleMs, swimlane.durationMs);
    assert.deepEqual(
        swimlane.markers.map((marker) => ({ kind: marker.kind, label: marker.label })),
        [
            { kind: "transition", label: "AutomatedCodeReview -> AutomatedCodeReviewApproved" },
            { kind: "completion", label: "PRPublished completed" },
        ],
        "paired wait boundaries are represented by spans instead of duplicate dots",
    );
});

test("an older worker timeline response cannot overwrite a newer refresh", async () => {
    const pending = [];
    const { controller, store } = makeController({
        getWorkerTimeline: async () => new Promise((resolve) => pending.push(resolve)),
    });

    const older = controller.refreshWorkerTimeline("pod-a");
    const newer = controller.refreshWorkerTimeline("pod-a");
    pending[1]([{ timelineId: "new", at: "2026-08-29T12:00:02.000Z" }]);
    await newer;
    pending[0]([{ timelineId: "old", at: "2026-08-29T12:00:01.000Z" }]);
    await older;

    assert.deepEqual(
        store.getState().admin.workers.timelineByWorkerId["pod-a"].entries.map((entry) => entry.timelineId),
        ["new"],
    );
});
