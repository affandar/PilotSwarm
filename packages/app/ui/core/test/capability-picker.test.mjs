// Session capabilities UI (capability-profiles Phases 3/4).
//
// The create chain gains an optional Capabilities step after the agent
// picker: pre-checked to the chosen agent's catalog profile, with the
// user's CHANGES becoming an enable/disable override delta threaded into
// createSession/createSessionForAgent as `capabilities`. An untouched
// picker yields NO override, and without a published catalog the step is
// skipped entirely (current behavior). The Manage-session Capabilities tab
// commits staged deltas via configureSession (applies next turn).
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    applyCapabilityOverrideToChecked,
    buildCapabilityBaseline,
    buildCapabilityOverrideDelta,
    buildCapabilityPickerItems,
    buildCapabilitySkillGroups,
    buildCapabilityToolGroups,
    computeForcedTools,
    createInitialState,
    createStore,
    selectCapabilityPickerModal,
} from "../src/index.js";

const CATALOG = {
    mcpServers: [
        { name: "github", isDefault: true },
        { name: "jira", isDefault: false },
    ],
    skills: [
        // Ungrouped skills fall under the "Other" sub-heading.
        { name: "deploy", description: "Deploy the service" },
        // Extended skill (off by default) in a named group; interleaved to prove
        // grouping regroups rather than assuming catalog order.
        { name: "analyze", description: "Analyze telemetry", group: "research", tier: "extended" },
        { name: "review" },
        { name: "triage", description: "Triage issues", group: "research" },
        // Skill → tool dependency: enabling `publish` force-holds write_artifact.
        { name: "publish", description: "Publish artifacts", requiredTools: ["write_artifact"] },
        // System skill — hidden from a normal picker entirely.
        { name: "sweeper", group: "maintenance", tier: "system" },
    ],
    tools: [
        { name: "store_fact", group: "facts" },
        { name: "read_facts", group: "facts" },
        { name: "write_artifact", group: "artifacts" },
        { name: "read_artifact", group: "artifacts" },
        { name: "lonely_tool" },
        // Extended tool group (off by default, opt-in); two members so a single
        // toggle stays an individual (non-collapsed) delta.
        { name: "graph_stats", group: "graph", tier: "extended" },
        { name: "graph_search", group: "graph", tier: "extended" },
        // System tool — hidden; its group (observability) has no other members,
        // so the group must not render at all.
        { name: "read_fleet_stats", group: "observability", tier: "system" },
        // Durable-session protocol floor: locked (always-on, non-removable).
        { name: "wait", group: "session", locked: true },
        { name: "cron", group: "session" },
    ],
    agentDefaults: {
        alpha: { mcpServers: ["github"], skills: null, tools: [] },
    },
};

function makeController(transportOverrides = {}) {
    const sessions = Array.isArray(transportOverrides.sessions) ? [...transportOverrides.sessions] : [];
    const calls = { createSession: [], createSessionForAgent: [], configureSession: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        createSession: async (options = {}) => {
            calls.createSession.push(options);
            const session = { sessionId: `s${calls.createSession.length}`, title: "Session", status: "idle" };
            sessions.push(session);
            return session;
        },
        createSessionForAgent: async (agentName, options = {}) => {
            calls.createSessionForAgent.push({ agentName, options });
            const session = { sessionId: `a${calls.createSessionForAgent.length}`, agentId: agentName, title: agentName, status: "idle" };
            sessions.push(session);
            return session;
        },
        configureSession: async (sessionId, capabilities) => {
            calls.configureSession.push({ sessionId, capabilities });
            return { appliesOn: "next_turn" };
        },
        getSessionCapabilities: async () => null,
        getCapabilityCatalog: () => CATALOG,
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha Agent" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    delete transport.sessions;
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, calls, store };
}

function modalItemIndex(store, id) {
    const modal = store.getState().ui.modal;
    const index = (modal?.items || []).findIndex((item) => item.id === id);
    assert.ok(index >= 0, `modal item ${id} exists`);
    return index;
}

async function confirmAgentPickerFor(controller, store, agentId) {
    await controller.openSessionAgentPicker({});
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    const index = modal.items.findIndex((item) => item.id === agentId);
    assert.ok(index >= 0, `agent picker offers ${agentId}`);
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: index } });
    await controller.confirmModal();
}

test("agent picker confirm opens the capability picker pre-checked to the agent profile", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");

    assert.equal(calls.createSessionForAgent.length, 0, "create waits for the capability step");
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "capabilityPicker");
    assert.equal(modal.agentName, "alpha");
    // Agent-granted MCP pre-checked, ungranted not; skills unrestricted →
    // all checked; tools unrestricted → all checked.
    assert.equal(modal.checked.mcpServers.github, true);
    assert.equal(modal.checked.mcpServers.jira, false);
    assert.equal(modal.checked.skills.deploy, true);
    assert.equal(modal.checked.skills.review, true);
    assert.equal(modal.checked.tools.store_fact, true);
    // Groups render collapsed: group rows present, member tool rows absent.
    assert.ok(modal.items.some((item) => item.id === "group:facts"));
    assert.ok(!modal.items.some((item) => item.id === "tool:store_fact"));
    assert.ok(modal.items.some((item) => item.id === "tool:lonely_tool"), "ungrouped tools render as plain rows");
});

test("untouched capability picker creates with NO override (skip affordance)", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.ok(!("capabilities" in calls.createSessionForAgent[0].options), "no delta → no override");
    assert.equal(store.getState().ui.modal, null);
});

test("toggling off an agent-granted MCP server yields a disable delta", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "mcp:github"));
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        mcpServers: { disable: ["github"] },
    });
});

test("group toggle stores the group NAME; individual tool toggle stores the tool name", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    // Whole-group toggle off → the delta names the group.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        tools: { disable: ["facts"] },
    });

    // A single member toggled via the expanded group → the tool name.
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:facts"));
    assert.ok(modalItemIndex(store, "tool:store_fact") >= 0, "expanded group exposes member rows");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:store_fact"));
    await controller.confirmModal();
    assert.deepEqual(calls.createSessionForAgent[1].options.capabilities, {
        tools: { disable: ["store_fact"] },
    });
});

test("tri-state group toggle checks all members from a partial state", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:facts"));
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:store_fact"));
    // Partial (1/2 checked) → group toggle re-checks everything → no delta.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();
    assert.ok(!("capabilities" in calls.createSessionForAgent[0].options));
});

test("generic sessions start fully-enabled and emit disable deltas when unchecking", async () => {
    // Regression: a generic (no-agent) session runs UNRESTRICTED at the
    // worker — all tools/skills default-on, base MCP set attached. The
    // baseline must reflect that so unchecking produces a real disable delta.
    // (Previously the generic baseline was "everything off", so disabling a
    // skill was a silent no-op and the skill stayed live.)
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");

    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "capabilityPicker");
    assert.equal(modal.agentName, null);
    assert.equal(modal.checked.mcpServers.github, true, "base/default MCP server on");
    assert.equal(modal.checked.mcpServers.jira, false, "non-default MCP server off");
    assert.equal(modal.checked.skills.deploy, true, "all skills on for a generic session");
    assert.equal(modal.checked.tools.store_fact, true, "all tools on for a generic session");

    controller.toggleCapabilityPickerItem(modalItemIndex(store, "skill:review"));
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 1);
    assert.deepEqual(calls.createSession[0].capabilities, {
        skills: { disable: ["review"] },
        tools: { disable: ["facts"] },
    });
});

test("the create chain threads model AND capabilities into createSessionForAgent", async () => {
    const model = { qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" };
    const { controller, store, calls } = makeController({
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
    });

    await controller.openModelPicker();
    await controller.confirmModal();
    const agentModal = store.getState().ui.modal;
    assert.equal(agentModal?.type, "sessionAgentPicker");
    const alphaIndex = agentModal.items.findIndex((item) => item.id === "alpha");
    store.dispatch({ type: "ui/modal", modal: { ...agentModal, selectedIndex: alphaIndex } });
    await controller.confirmModal();

    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "mcp:jira"));
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.equal(calls.createSessionForAgent[0].options.model, "openai:gpt-test");
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        mcpServers: { enable: ["jira"] },
    });
});

test("the capability step is skipped entirely when no catalog is published", async () => {
    for (const catalog of [null, { mcpServers: [], skills: [], tools: [], agentDefaults: {} }]) {
        const { controller, store, calls } = makeController({
            getCapabilityCatalog: () => catalog,
        });
        await confirmAgentPickerFor(controller, store, "alpha");
        assert.equal(store.getState().ui.modal, null, "no capability modal without a catalog");
        assert.equal(calls.createSessionForAgent.length, 1, "creates immediately (current behavior)");
        assert.ok(!("capabilities" in calls.createSessionForAgent[0].options));
    }
});

test("an async getCapabilityCatalog (direct transport) still opens the picker", async () => {
    const { controller, store } = makeController({
        getCapabilityCatalog: async () => CATALOG,
    });
    await confirmAgentPickerFor(controller, store, "alpha");
    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
});

test("Esc cancels the whole flow without creating", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
    controller.closeModal();
    assert.equal(store.getState().ui.modal, null);
    assert.equal(calls.createSessionForAgent.length, 0);
});

test("Manage-tab Apply calls configureSession with the staged delta, null clears", async () => {
    const { controller, store, calls } = makeController();
    const delta = { mcpServers: { disable: ["github"] } };
    const result = await controller.configureSessionCapabilities("a1", delta);
    assert.deepEqual(calls.configureSession, [{ sessionId: "a1", capabilities: delta }]);
    assert.deepEqual(result, { appliesOn: "next_turn" });
    assert.equal(store.getState().ui.statusText, "Capabilities apply on the next turn");

    await controller.configureSessionCapabilities("a1", null);
    assert.deepEqual(calls.configureSession[1], { sessionId: "a1", capabilities: null });
});

test("loadSessionCapabilities returns the catalog and the stored override", async () => {
    const override = { skills: { disable: ["deploy"] } };
    const { controller } = makeController({
        getSessionCapabilities: async (sessionId) => (sessionId === "a1" ? override : null),
    });
    const view = await controller.loadSessionCapabilities("a1");
    assert.equal(view.catalog, CATALOG);
    assert.deepEqual(view.override, override);
});

test("effective checks = agent defaults + stored override applied (Manage tab)", () => {
    const { members } = buildCapabilityToolGroups(CATALOG);
    const baseline = buildCapabilityBaseline(CATALOG, "alpha");
    const effective = applyCapabilityOverrideToChecked(baseline, {
        mcpServers: { enable: ["jira"], disable: ["github"] },
        tools: { disable: ["facts"], enable: ["store_fact"] },
    }, members);
    assert.equal(effective.mcpServers.jira, true);
    assert.equal(effective.mcpServers.github, false);
    // Group disable expands to members; the individual enable refines it.
    assert.equal(effective.tools.read_facts, false);
    assert.equal(effective.tools.store_fact, true);
    assert.equal(effective.tools.write_artifact, true, "untouched axis entries keep the baseline");

    // Round-trip: staging no further changes reproduces the same override
    // deltas relative to the agent baseline.
    const delta = buildCapabilityOverrideDelta(baseline, effective, members);
    assert.deepEqual(delta, {
        mcpServers: { enable: ["jira"], disable: ["github"] },
        tools: { disable: ["read_facts"] },
    });
});

// ─── LOCKED tools + skill→tool dependency locking ──────────────────
//
// The catalog carries `tools[].locked` (durable-session protocol floor —
// always on, non-removable) and `skills[].requiredTools` (force-held while
// the skill is enabled). Both render checked + disabled with a hint and can
// NEVER enter a `tools.disable` delta.

// Read the presentation row the selector renders for a picker item id.
function pickerRow(store, id) {
    const modal = store.getState().ui.modal;
    const itemIndex = (modal?.items || []).findIndex((item) => item.id === id);
    assert.ok(itemIndex >= 0, `picker has item ${id}`);
    const presentation = selectCapabilityPickerModal(store.getState());
    const rowIndex = (presentation.rowItemIndexes || []).indexOf(itemIndex);
    assert.ok(rowIndex >= 0, `presentation renders a row for ${id}`);
    const runs = presentation.rows[rowIndex];
    const text = (Array.isArray(runs) ? runs : [runs]).map((run) => run?.text || "").join("");
    return { itemIndex, rowIndex, text, nonInteractive: Boolean(presentation.rowNonInteractive?.[rowIndex]) };
}

test("computeForcedTools reports locked tools and enabled-skill required tools", () => {
    const noSkills = computeForcedTools(CATALOG, { skills: {} });
    assert.deepEqual(noSkills.wait, { locked: true, requiredBy: [] });
    assert.ok(!noSkills.write_artifact, "write_artifact is only forced by an enabled skill");
    const withPublish = computeForcedTools(CATALOG, { skills: { publish: true } });
    assert.deepEqual(withPublish.write_artifact, { locked: false, requiredBy: ["publish"] });
    assert.deepEqual(withPublish.wait, { locked: true, requiredBy: [] });
});

test("a LOCKED base tool renders checked + disabled and toggling it is a no-op with no delta", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:session"));

    const row = pickerRow(store, "tool:wait");
    assert.equal(row.nonInteractive, true, "locked tool is non-interactive");
    assert.match(row.text, /\[x\]/, "locked tool renders checked");
    assert.match(row.text, /locked/, "locked tool shows the locked hint");

    // A click is a no-op: state unchanged, modal stays open.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:wait"));
    assert.equal(store.getState().ui.modal.checked.tools.wait, true, "still on after a no-op click");
    assert.equal(store.getState().ui.modal.type, "capabilityPicker", "modal stays open");

    await controller.confirmModal();
    assert.equal(calls.createSession.length, 1);
    assert.ok(!("capabilities" in calls.createSession[0]), "a locked-only picker yields no override");
});

test("enabling a skill force-checks + disables its required tools; they never enter tools.disable", async () => {
    const { controller, store, calls } = makeController();
    // alpha is skills-unrestricted, so `publish` is enabled → write_artifact
    // is force-held.
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:artifacts"));

    const waRow = pickerRow(store, "tool:write_artifact");
    assert.equal(waRow.nonInteractive, true, "skill-required tool is non-interactive");
    assert.match(waRow.text, /\[x\]/, "skill-required tool renders checked");
    assert.match(waRow.text, /required by publish/, "shows which skill forces it");

    // No-op click on the forced tool leaves it held on.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:write_artifact"));
    assert.equal(store.getState().ui.modal.checked.tools.write_artifact, true, "held on");

    // Disabling the whole artifacts group only drops the removable member —
    // write_artifact is excluded from the disable delta.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:artifacts"));
    await controller.confirmModal();
    assert.equal(calls.createSessionForAgent.length, 1);
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        tools: { disable: ["read_artifact"] },
    });
});

test("generic: a required-tool skill (on by default) force-holds its tool out of any disable delta", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");
    // publish is on (generic = all skills on) → write_artifact is force-held.
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:artifacts"));
    assert.equal(pickerRow(store, "tool:write_artifact").nonInteractive, true, "held while publish is on");

    // Disabling the artifacts group drops only the removable member.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:artifacts"));
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 1);
    const caps = calls.createSession[0].capabilities;
    assert.deepEqual(caps.tools, { disable: ["read_artifact"] });
    assert.ok(!(caps.tools.disable || []).includes("write_artifact"),
        "the skill's required tool never appears in a disable delta");
});

test("unchecking the skill releases its required tools back to toggleable", async () => {
    const { controller, store } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:artifacts"));
    assert.equal(pickerRow(store, "tool:write_artifact").nonInteractive, true, "held while publish is on");

    // Turn the skill off → the required tool is released.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "skill:publish"));
    const released = pickerRow(store, "tool:write_artifact");
    assert.equal(released.nonInteractive, false, "released tool is toggleable again");
    assert.doesNotMatch(released.text, /required by/, "the required-by hint is gone");

    // And it now actually toggles off.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:write_artifact"));
    assert.equal(store.getState().ui.modal.checked.tools.write_artifact, false, "now removable");
});

test("a tool that is BOTH locked and would-be-disabled stays out of the delta", () => {
    const { members } = buildCapabilityToolGroups(CATALOG);
    const baseline = buildCapabilityBaseline(CATALOG, "alpha");
    assert.equal(baseline.tools.wait, true, "the locked tool baselines on");

    // A checked map that (wrongly) turns the locked tool off and disables a
    // normal tool.
    const checked = {
        mcpServers: { ...baseline.mcpServers },
        skills: { ...baseline.skills },
        tools: { ...baseline.tools, wait: false, read_facts: false },
    };
    const forced = computeForcedTools(CATALOG, checked);
    const delta = buildCapabilityOverrideDelta(baseline, checked, members, forced);
    assert.ok(delta.tools.disable.includes("read_facts"), "the normal tool is disabled");
    assert.ok(!delta.tools.disable.includes("wait"), "the locked tool never enters disable");

    // Proof the forced filter is what protects the invariant: without it the
    // locked tool would leak into the disable list.
    const unfiltered = buildCapabilityOverrideDelta(baseline, checked, members, null);
    assert.ok(unfiltered.tools.disable.includes("wait"), "unfiltered delta would violate the invariant");
});

// ─── 4-tier capability model: system HIDDEN, extended off-by-default + hint,
//     skills grouped ──────────────────────────────────────────────────────

// All row text the selector renders for the current modal (headings + rows).
function allPickerRowText(store) {
    const presentation = selectCapabilityPickerModal(store.getState());
    return (presentation.rows || []).map((row) =>
        (Array.isArray(row) ? row : [row]).map((run) => run?.text || "").join(""));
}

test("system-tier tools and skills never appear in the picker items or rows", async () => {
    const { controller, store } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    const modal = store.getState().ui.modal;

    // Item list: no system tool, no system skill, no all-system group.
    assert.ok(!modal.items.some((item) => item.id === "tool:read_fleet_stats"), "system tool hidden");
    assert.ok(!modal.items.some((item) => item.id === "skill:sweeper"), "system skill hidden");
    assert.ok(!modal.items.some((item) => item.id === "group:observability"), "all-system group hidden");
    // Even expanded, the system tool cannot be reached.
    assert.ok(!modal.items.some((item) => item.id === "tool:read_fleet_stats"));

    // Rendered rows (including headings) never mention the system entries.
    const text = allPickerRowText(store).join("\n");
    assert.doesNotMatch(text, /read_fleet_stats/, "system tool absent from rows");
    assert.doesNotMatch(text, /sweeper/, "system skill absent from rows");
    assert.doesNotMatch(text, /observability/, "empty-after-filter group heading absent");

    // buildCapabilityToolGroups/SkillGroups drop system entries at the source.
    const { groups } = buildCapabilityToolGroups(CATALOG);
    assert.ok(!groups.some((g) => g.name === "observability"), "no observability tool group");
    const skillGroups = buildCapabilitySkillGroups(CATALOG);
    assert.ok(!skillGroups.some((g) => g.group === "maintenance"), "no maintenance skill group");
    assert.ok(!skillGroups.some((g) => g.skills.some((s) => s.name === "sweeper")), "sweeper filtered");
});

test("empty-after-filter groups do not render (observability was all system)", async () => {
    const { controller, store } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");
    // The graph group (extended, has visible members) survives; observability
    // (all system) does not.
    assert.ok(store.getState().ui.modal.items.some((item) => item.id === "group:graph"), "extended group renders");
    assert.ok(!store.getState().ui.modal.items.some((item) => item.id === "group:observability"), "empty group gone");
    assert.doesNotMatch(allPickerRowText(store).join("\n"), /observability/);
});

test("an extended tool starts unchecked and produces an ENABLE delta when checked", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");

    // Extended tools baseline OFF even for an unrestricted (generic) session.
    assert.equal(store.getState().ui.modal.checked.tools.graph_stats, false, "extended tool starts off");
    assert.equal(store.getState().ui.modal.checked.tools.graph_search, false, "extended tool starts off");

    // Opt one member in (leaving the other off keeps it an individual delta,
    // not a whole-group collapse) → an ENABLE, never a disable.
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:graph"));
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:graph_stats"));
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 1);
    assert.deepEqual(calls.createSession[0].capabilities, { tools: { enable: ["graph_stats"] } });
});

test("checking a whole extended group collapses to a group ENABLE delta", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");
    // Group toggle turns every member on → collapses to the group NAME, enable.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:graph"));
    await controller.confirmModal();
    assert.deepEqual(calls.createSession[0].capabilities, { tools: { enable: ["graph"] } });
});

test("extended tool groups and extended skills render an 'off by default' hint", async () => {
    const { controller, store } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");

    assert.match(pickerRow(store, "group:graph").text, /off by default/, "extended group hint");
    assert.match(pickerRow(store, "skill:analyze").text, /off by default/, "extended skill hint");
    // Default-tier peers carry no such hint.
    assert.doesNotMatch(pickerRow(store, "group:facts").text, /off by default/, "default group has no hint");
    assert.doesNotMatch(pickerRow(store, "skill:deploy").text, /off by default/, "default skill has no hint");
});

test("skills render grouped by their group with an 'Other' fallback", async () => {
    const { controller, store } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    const modal = store.getState().ui.modal;

    // Picker items carry the resolved group ("Other" when absent).
    const groupOf = (id) => modal.items.find((item) => item.id === id)?.group;
    assert.equal(groupOf("skill:deploy"), "Other");
    assert.equal(groupOf("skill:review"), "Other");
    assert.equal(groupOf("skill:analyze"), "research");
    assert.equal(groupOf("skill:triage"), "research");

    // The selector emits a per-group sub-heading for each skill group.
    const text = allPickerRowText(store).join("\n");
    assert.match(text, /Skills · Other/, "Other sub-heading rendered");
    assert.match(text, /Skills · research/, "named-group sub-heading rendered");

    // buildCapabilitySkillGroups buckets by first appearance; no split groups.
    const skillGroups = buildCapabilitySkillGroups(CATALOG);
    const other = skillGroups.find((g) => g.group === "Other");
    const research = skillGroups.find((g) => g.group === "research");
    assert.deepEqual(other.skills.map((s) => s.name), ["deploy", "review", "publish"]);
    assert.deepEqual(research.skills.map((s) => s.name), ["analyze", "triage"]);
});

test("buildCapabilityPickerItems tags tiers and hides system entries", () => {
    const items = buildCapabilityPickerItems(CATALOG, {});
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    assert.equal(byId["group:graph"].tier, "extended", "all-extended group is extended");
    assert.equal(byId["group:facts"].tier, "default", "default group tier");
    assert.equal(byId["skill:analyze"].tier, "extended");
    assert.equal(byId["skill:deploy"].tier, "default");
    assert.ok(!("group:observability" in byId), "system tool group omitted");
    assert.ok(!("skill:sweeper" in byId), "system skill omitted");
});
