/**
 * resolveBoundAgentBackfill — self-healing a session's bound agent from the
 * CMS catalog row when the orchestration input lost its creation config.
 *
 * THE BUG THIS PINS (found live on waldemort chk, 2026-08-31): a top-level
 * session's creation config lives in an in-memory map on the API server that
 * created it. With two portal replicas, the first message routinely lands on
 * the OTHER replica, which starts the orchestration with an empty config —
 * `{"waitThreshold":30}` verbatim in the durable input. The session keeps its
 * CMS agentId (title, listings all look bound) but composes NO agent prompt
 * and gets NO agent MCP servers. Every MCP-created agent session on chk ran
 * that way.
 *
 * Run: node --test test/unit/bound-agent-backfill.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveBoundAgentBackfill } from "../../dist/session-proxy.js";

const USER_AGENTS = [
    { name: "runbook-marshal", id: "runbook-marshal" },
    { name: "rcakit-pgflex", id: "rcakit-pgflex" },
    { name: "flex-tm-analyst-v2" },
];

test("an unbound session with a catalog agentId is backfilled to that agent's exact name", () => {
    assert.equal(
        resolveBoundAgentBackfill({ waitThreshold: 30 }, "runbook-marshal", USER_AGENTS),
        "runbook-marshal",
    );
});

test("a session that already carries boundAgentName is never overridden", () => {
    assert.equal(
        resolveBoundAgentBackfill({ boundAgentName: "researcher" }, "runbook-marshal", USER_AGENTS),
        undefined,
    );
});

test("a system agent id is refused — backfilling it would hand it the app default layer", () => {
    // sweeper/facts-manager etc. are not in the USER agent list by construction.
    assert.equal(resolveBoundAgentBackfill({}, "sweeper", USER_AGENTS), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "regen-distiller", USER_AGENTS), undefined);
});

test("an explicit non-app prompt layering blocks the backfill", () => {
    assert.equal(
        resolveBoundAgentBackfill({ promptLayering: { kind: "pilotswarm-system-agent" } }, "runbook-marshal", USER_AGENTS),
        undefined,
    );
    // ...but an explicit app-agent layering does not.
    assert.equal(
        resolveBoundAgentBackfill({ promptLayering: { kind: "app-agent" } }, "runbook-marshal", USER_AGENTS),
        "runbook-marshal",
    );
});

test("no catalog agentId, empty id, or unknown id all mean no backfill", () => {
    assert.equal(resolveBoundAgentBackfill({}, null, USER_AGENTS), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "  ", USER_AGENTS), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "no-such-agent", USER_AGENTS), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "runbook-marshal", []), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "runbook-marshal", undefined), undefined);
});

test("matching is EXACT, not normalized — the prompt lookup is keyed by exact name", () => {
    assert.equal(resolveBoundAgentBackfill({}, "Runbook-Marshal", USER_AGENTS), undefined);
    assert.equal(resolveBoundAgentBackfill({}, "runbookmarshal", USER_AGENTS), undefined);
});

test("a row keyed by id resolves to the agent's name", () => {
    const agents = [{ name: "canonical-name", id: "row-id" }];
    assert.equal(resolveBoundAgentBackfill({}, "row-id", agents), "canonical-name");
});
