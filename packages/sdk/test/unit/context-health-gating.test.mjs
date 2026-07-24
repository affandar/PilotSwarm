// context_health is a SELF-scoped footprint/regen sensor: an agent calls it on
// its own session to decide whether to regenerate. Regression guard — it was
// gated to system/tuner agents only, so ordinary sessions (the ones that
// self-regenerate) could not see it. It must ship to non-system agents.
import test from "node:test";
import assert from "node:assert/strict";
import { createInspectTools } from "../../dist/inspect-tools.js";

// The tool LIST is built purely from agentIdentity; the catalog is only touched
// inside handlers, so a stub is enough to assert which tools are exposed.
const stubCatalog = {};
const names = (opts) => createInspectTools({ catalog: stubCatalog, ...opts }).map((t) => t.name);

test("ordinary (non-system) session gets context_health", () => {
    assert.ok(names({ agentIdentity: undefined }).includes("context_health"), "generic session");
    assert.ok(names({ agentIdentity: "deepwiki" }).includes("context_health"), "bound agent session");
});

test("agent-tuner still gets context_health", () => {
    assert.ok(names({ agentIdentity: "agent-tuner" }).includes("context_health"));
});

test("context_health takes no parameters (self-scoped)", () => {
    const tool = createInspectTools({ catalog: stubCatalog, agentIdentity: "deepwiki" })
        .find((t) => t.name === "context_health");
    assert.ok(tool, "tool present");
    assert.deepEqual(tool.parameters?.properties ?? {}, {}, "no inputs — reads the caller's own session");
});
