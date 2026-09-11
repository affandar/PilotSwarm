/**
 * Contract matrix over the actual generator and inline activity bridge, followed
 * through actual SessionManager/ManagedSession and Copilot SDK/CLI inference.
 * The durable client transport is a bounded in-memory fixture; routing/PG tests
 * cover the storage and scheduler separately. No external provider is used.
 */
import { describe, it, expect, vi } from 'vitest';
const transport = vi.hoisted(() => ({ active: null }));
vi.mock('../../src/client.js', () => ({ PilotSwarmClient: class {
    systemSessions = new Set();
    async start() {} async stop() {}
    async listSessions() { return [...transport.active.rows.values()]; }
    async _getSessionInfo(id) { return transport.active.rows.get(id); }
    async createSession(config) { return transport.active.createChild(config); }
} }));
import { handoffHarness, ALICE, BOB, MODEL, shared, privateCopy, systemPrompt, toolNames } from '../helpers/parent-child-handoff.mjs';
import { SYSTEM_USER_PRINCIPAL } from '../../src/cms.ts';
const harness = (opts, run) => handoffHarness(transport, opts, run);

for (const path of ['generator', 'inline']) describe(`parent -> child handoff (${path}, actual child SDK)`, () => {
    it('loads complete named definition and preserves assignment, bootstrap, owner/model and defaults', { timeout: 25_000 }, async () => {
        await harness({}, async h => {
            expect(await h.invoke(path, { agent_name: 'analyst', task: 'CUSTOM_ASSIGNMENT', title: 'My audit' })).toContain('spawned successfully');
            const child = h.children[0];
            expect(child.result).toMatchObject({ type: 'completed', content: 'CHILD_COMPLETED' });
            expect(child.config).toMatchObject({ owner: ALICE, parentSessionId: h.parentId, nestingLevel: 1, model: MODEL,
                reasoningEffort: 'medium', boundAgentName: 'analyst', boundAgentPackageId: 'pkg-shared', toolNames: shared.tools });
            expect(child.row.title).toBe('My audit'); expect(child.prompt).toBe('CUSTOM_ASSIGNMENT');
            expect(child.turnOptions).toMatchObject({ requiredTool: 'handoff_load', bootstrap: true, sender: { kind: 'agent', sessionId: h.parentId } });
            const first = h.server.requests[0];
            for (const marker of ['SHARED_ANALYST_INSTRUCTIONS', 'FRAMEWORK_DEFAULT_INSTRUCTIONS', 'APP_DEFAULT_INSTRUCTIONS', 'FILESYSTEM ISOLATION']) {
                expect(systemPrompt(first)).toContain(marker);
            }
            expect(toolNames(first)).toEqual(expect.arrayContaining(['framework_tool', 'app_tool', 'handoff_load', 'handoff_search', 'spawn_agent', 'read_facts']));
            expect(systemPrompt(first)).not.toContain('PARENT_PERSONA_MUST_NOT_LEAK');
            expect(toolNames(first)).not.toContain('parent_only');
            const creationSpec = first.tools.find(t => t.function?.name === 'spawn_agent').function;
            const turnSpec = h.registeredTools.find(t => t.name === 'spawn_agent');
            expect(turnSpec).toBeDefined();
            for (const spec of [creationSpec, turnSpec]) {
                expect(spec.description).toContain('task supplies your assignment');
                expect(spec.description).not.toContain('Do not also set task');
                expect(spec.parameters.properties.task.description).toContain('whether named or custom');
                expect(spec.parameters.properties.agent_name.description).not.toContain('Do not also set task');
            }
            expect(h.calls).toEqual([{ name: 'handoff_load', owner: 'pkg-shared' }, { name: 'handoff_search', owner: 'pkg-shared' }]);
        });
    });
    it.each(['handoff_load', 'handoff_search'])('required capability %s preserves definition startup', { timeout: 25_000 }, async required => {
        await harness({}, async h => {
            expect(await h.invoke(path, { required_tool: required, task: 'CAPABILITY_ASSIGNMENT' })).toContain('spawned successfully');
            expect(h.children[0].turnOptions.requiredTool).toBe('handoff_load');
            expect(h.children[0].result.type).toBe('completed'); expect(h.children[0].prompt).toBe('CAPABILITY_ASSIGNMENT');
            expect(h.calls.map(c => c.name)).toEqual(['handoff_load', 'handoff_search']);
        });
    });
    it('capability selection does not invent a startup obligation', { timeout: 25_000 }, async () => {
        await harness({ agents: [{ ...shared, initialRequiredTool: undefined }], callTools: [] }, async h => {
            await h.invoke(path, { required_tool: 'handoff_search', task: 'Plan the search; do not run it yet' });
            expect(h.children[0].turnOptions.requiredTool).toBeUndefined();
            expect(h.children[0].result.type).toBe('completed'); expect(h.calls).toEqual([]);
        });
    });
    it.each([{ tools: undefined }, { tools: null }, { tools: [] }])('named tools=$tools keeps only platform/deployment defaults', { timeout: 25_000 }, async ({ tools }) => {
        await harness({ agents: [{ ...shared, tools, initialRequiredTool: undefined }], callTools: ['framework_tool', 'app_tool'] }, async h => {
            await h.invoke(path, { agent_name: 'analyst' });
            expect(h.children[0].config.toolNames).toEqual([]); expect(h.children[0].result.type).toBe('completed');
            expect(h.children[0].prompt).toBe('DEFAULT_ANALYST_ASSIGNMENT');
            const names = toolNames(h.server.requests[0]);
            expect(names).toEqual(expect.arrayContaining(['framework_tool', 'app_tool', 'read_facts', 'spawn_agent']));
            expect(names).not.toContain('parent_only'); expect(names).not.toContain('deployment_tool');
        });
    });
    it.each([{ tool_names: [] }, { tool_names: null }, { tool_names: ['deployment_tool'] }])('rejects supplied named tool override $tool_names before creation', async ({ tool_names }) => {
        await harness({}, async h => {
            expect(await h.invoke(path, { agent_name: 'analyst', tool_names })).toContain('tool_names cannot override');
            expect(h.children).toHaveLength(0); expect(h.server.requests).toHaveLength(0);
        });
    });
    it.each([
        { owner: ALICE, target: 'analyst', marker: 'PRIVATE_ANALYST_INSTRUCTIONS', pkg: 'pkg-alice' },
        { owner: BOB, target: 'analyst', marker: 'SHARED_ANALYST_INSTRUCTIONS', pkg: 'pkg-shared' },
        { owner: ALICE, target: '__shared:analyst', marker: 'SHARED_ANALYST_INSTRUCTIONS', pkg: 'pkg-shared' },
    ])('keeps $target prompt and handlers together for $owner.subject', { timeout: 25_000 }, async f => {
        await harness({ owner: f.owner, agents: [shared, privateCopy] }, async h => {
            await h.invoke(path, { agent_name: f.target, task: 'COPY_ASSIGNMENT' });
            expect(h.children[0].config.boundAgentPackageId).toBe(f.pkg);
            expect(h.children[0].row.splashMobile).toBe(f.pkg === 'pkg-alice' ? 'PRIVATE_MOBILE' : 'SHARED_MOBILE'); expect(h.children[0].prompt).toBe('COPY_ASSIGNMENT');
            expect(systemPrompt(h.server.requests[0])).toContain(f.marker);
            expect(systemPrompt(h.server.requests[0])).not.toContain(f.pkg === 'pkg-alice' ? 'SHARED_ANALYST_INSTRUCTIONS' : 'PRIVATE_ANALYST_INSTRUCTIONS');
            expect(h.calls.every(c => c.owner === f.pkg)).toBe(true); expect(h.children[0].result.type).toBe('completed');
        });
    });
    it.each([{ tool_names: undefined }, { tool_names: [] }, { tool_names: ['deployment_tool'] }])('unnamed tools=$tool_names drops specialist binding but preserves defaults', { timeout: 25_000 }, async ({ tool_names }) => {
        await harness({ callTools: ['framework_tool', 'app_tool'], parentConfig: { boundAgentSource: 'deployment', boundAgentPackageId: undefined } }, async h => {
            await h.invoke(path, { task: 'GENERIC_ASSIGNMENT', ...(tool_names !== undefined ? { tool_names } : {}) });
            const child = h.children[0]; expect(child.result.type).toBe('completed');
            expect(child.config.boundAgentName).toBeUndefined(); expect(child.config.boundAgentPackageId).toBeUndefined();
            expect(child.config.agentIdentity).toBeUndefined(); expect(child.config.boundAgentSource).toBeUndefined(); expect(child.turnOptions.requiredTool).toBeUndefined();
            const names = toolNames(h.server.requests[0]); expect(names).not.toContain('parent_only');
            expect(names).toEqual(expect.arrayContaining(['framework_tool', 'app_tool', 'read_facts']));
            expect(names.includes('deployment_tool')).toBe(tool_names === undefined || tool_names.length > 0);
            expect(systemPrompt(h.server.requests[0])).not.toContain('SHARED_ANALYST_INSTRUCTIONS');
            expect(systemPrompt(h.server.requests[0])).toContain('PARENT_PERSONA_MUST_NOT_LEAK');
        });
    });
    it('custom system_message replaces inherited persona while retaining framework instructions', { timeout: 25_000 }, async () => {
        await harness({ callTools: [] }, async h => {
            await h.invoke(path, { task: 'CUSTOM_PERSONA_ASSIGNMENT', system_message: 'CHILD_CUSTOM_PERSONA' });
            expect(h.children[0].result.type).toBe('completed');
            const prompt = systemPrompt(h.server.requests[0]);
            expect(prompt).toContain('CHILD_CUSTOM_PERSONA'); expect(prompt).not.toContain('PARENT_PERSONA_MUST_NOT_LEAK');
            expect(prompt).toContain('FRAMEWORK_DEFAULT_INSTRUCTIONS'); expect(prompt).toContain('FILESYSTEM ISOLATION');
        });
    });
    it('rejects an explicitly requested detached package tool before inference', { timeout: 25_000 }, async () => {
        await harness({ callTools: [] }, async h => {
            await h.invoke(path, { task: 'DETACHED_ASSIGNMENT', tool_names: ['parent_only'] });
            expect(h.children[0].result).toMatchObject({ type: 'error', retryable: false });
            expect(h.children[0].result.message).toContain('owning named-agent definition'); expect(h.server.requests).toHaveLength(0);
        });
    });
    it.each([
        { label: 'unknown name', args: { agent_name: 'missing' }, contains: 'not found' },
        { label: 'missing capability', args: { required_tool: 'missing' }, contains: 'no caller-visible' },
        { label: 'mismatched capability', args: { agent_name: 'analyst', required_tool: 'missing' }, contains: 'does not declare' },
        { label: 'empty capability', args: { required_tool: ' ' }, contains: 'non-empty' },
        { label: 'prompt override', args: { agent_name: 'analyst', system_message: 'replace named policy' }, contains: 'system_message cannot override' },
        { label: 'unqualified model', args: { agent_name: 'analyst', model: 'gpt-5.6-sol' }, contains: 'not allowed' },
    ])('rejects $label before creation', async f => {
        await harness({}, async h => {
            expect(await h.invoke(path, f.args)).toContain(f.contains); expect(h.children).toHaveLength(0); expect(h.server.requests).toHaveLength(0);
        });
    });
    it('rejects ambiguous capabilities without exposing private candidates', async () => {
        await harness({ owner: BOB, agents: [shared, { ...shared, name: 'other', packageId: 'pkg-other' }, { ...privateCopy, name: 'secret-analyst' }] }, async h => {
            const reply = await h.invoke(path, { required_tool: 'handoff_search' });
            expect(reply).toContain('multiple visible agents'); expect(reply).toContain('other'); expect(reply).not.toContain('secret-analyst');
            expect(h.children).toHaveLength(0);
        });
    });
    it.each([{ agent_name: 'analyst' }, { required_tool: 'handoff_search' }])('refuses foreign-only private definitions: %j', async args => {
        await harness({ owner: BOB, agents: [privateCopy] }, async h => {
            const reply = await h.invoke(path, args); expect(reply).toContain('failed'); expect(reply).not.toContain('PRIVATE_ANALYST_INSTRUCTIONS');
            expect(h.children).toHaveLength(0); expect(h.server.requests).toHaveLength(0);
        });
    });
    it.each([{ agent_name: 'analyst' }, { required_tool: 'handoff_search' }])('fails closed for rootless private-only target %j', async args => {
        await harness({ owner: null, agents: [privateCopy] }, async h => {
            const reply = await h.invoke(path, args);
            expect(reply).toContain('failed'); expect(reply).not.toContain('PRIVATE_ANALYST_INSTRUCTIONS');
            expect(h.children).toHaveLength(0); expect(h.server.requests).toHaveLength(0);
        });
    });
    it.each([
        { owner: null, ancestor: { owner: ALICE }, expected: ALICE, agents: [privateCopy], label: 'owned ancestor' },
        { owner: null, systemParent: true, expected: SYSTEM_USER_PRINCIPAL, agents: [shared], label: 'system parent' },
        { owner: null, expected: undefined, agents: [shared], label: 'unowned lineage' },
    ])('inherits $label ownership without making child a system agent', { timeout: 25_000 }, async f => {
        await harness(f, async h => {
            await h.invoke(path, { required_tool: 'handoff_search', task: 'LINEAGE_ASSIGNMENT' });
            expect(h.children[0].config.owner).toEqual(f.expected); expect(h.children[0].row.isSystem).toBe(false);
            expect(h.children[0].result.type).toBe('completed');
        });
    });
    it('accepts a qualified model override and clears inherited drop policy', { timeout: 25_000 }, async () => {
        await harness({ parentConfig: { detachedPackageToolPolicy: 'drop' } }, async h => {
            await h.invoke(path, { agent_name: 'analyst', model: 'fixture:gpt-5.6-sol', reasoning_effort: 'high' });
            expect(h.children[0].config).toMatchObject({ model: 'fixture:gpt-5.6-sol', reasoningEffort: 'high' });
            expect(h.children[0].config.detachedPackageToolPolicy).not.toBe('drop');
            expect(h.server.requests[0].model).toBe('gpt-5.6-sol'); expect(h.children[0].result.type).toBe('completed');
        });
    });
    it('canonicalizes an explicit shared alias when definition has no id', { timeout: 25_000 }, async () => {
        await harness({ agents: [{ ...shared, id: undefined }, { ...privateCopy, id: undefined }] }, async h => {
            await h.invoke(path, { agent_name: '__shared:analyst', task: 'ALIAS_ASSIGNMENT' });
            expect(h.children[0].config.agentId).toBe('analyst');
            expect(h.children[0].row.splashMobile).toBe('SHARED_MOBILE');
            expect(systemPrompt(h.server.requests[0])).toContain('SHARED_ANALYST_INSTRUCTIONS');
            expect(h.children[0].result.type).toBe('completed');
        });
    });
    it('pins an explicitly selected deployment definition past a private same-name shadow', { timeout: 25_000 }, async () => {
        const deployment = { ...shared, packageId: undefined, packageScope: undefined, prompt: 'DEPLOYMENT_ANALYST_INSTRUCTIONS' };
        const shadow = { ...privateCopy, tools: ['private_load', 'private_search'], initialRequiredTool: 'private_load' };
        await harness({ agents: [deployment, shadow] }, async h => {
            await h.invoke(path, { agent_name: '__shared:analyst', task: 'DEPLOYMENT_ASSIGNMENT' });
            expect(h.children[0].config.boundAgentSource).toBe('deployment');
            expect(h.children[0].config.boundAgentPackageId).toBeUndefined();
            expect(h.children[0].result.type).toBe('completed');
            expect(systemPrompt(h.server.requests[0])).toContain('DEPLOYMENT_ANALYST_INSTRUCTIONS');
            expect(systemPrompt(h.server.requests[0])).not.toContain('PRIVATE_ANALYST_INSTRUCTIONS');
            expect(toolNames(h.server.requests[0])).not.toContain('private_search');
            expect(h.calls).toEqual([{ name: 'handoff_load', owner: 'deployment' }, { name: 'handoff_search', owner: 'deployment' }]);
        });
    });
    it('validates a capability on an explicitly named deployment agent', { timeout: 25_000 }, async () => {
        await harness({ agents: [{ ...shared, packageId: undefined, packageScope: undefined }] }, async h => {
            await h.invoke(path, { agent_name: 'analyst', required_tool: 'handoff_search', task: 'NAMED_CAPABILITY_ASSIGNMENT' });
            expect(h.children[0].turnOptions.requiredTool).toBe('handoff_load');
            expect(h.children[0].config.boundAgentPackageId).toBeUndefined();
            expect(h.children[0].prompt).toBe('NAMED_CAPABILITY_ASSIGNMENT');
            expect(h.calls.every(c => c.owner === 'deployment')).toBe(true);
            expect(h.children[0].result.type).toBe('completed');
        });
    });
    it.each([{ agent_name: 'managed-daemon' }, { required_tool: 'managed_only' }])('refuses worker-managed system target %j', async args => {
        await harness({ agents: [], systemAgents: [{ name: 'managed-daemon', id: 'managed-daemon', system: true,
            prompt: 'SECRET_MANAGED_INSTRUCTIONS', tools: ['managed_only'], creatable: false }] }, async h => {
            expect(await h.invoke(path, args)).toContain('failed');
            expect(h.children).toHaveLength(0); expect(h.server.requests).toHaveLength(0);
        });
    });
    it.each(['named', 'custom'])('forwards explicit %s child contract instead of the parent contract', { timeout: 25_000 }, async kind => {
        const parentContract = { contractId: 'ancestor-contract', goal: 'PARENT_CONTRACT_ONLY', wakeOn: 'completion' };
        const childContract = { contractId: 'child-contract', goal: 'CHILD_CONTRACT_ONLY', wakeOn: 'material_change',
            expectedArtifacts: [{ path: 'findings.md', required: true }], validationMode: 'strict' };
        await harness({ parentConfig: { childContract: parentContract }, callTools: kind === 'named' ? ['handoff_load'] : [] }, async h => {
            expect(await h.invoke(path, { ...(kind === 'named' ? { agent_name: 'analyst' } : {}),
                task: 'Produce the assigned findings', contract: childContract })).toContain('spawned successfully');
            expect(h.children[0].config.childContract).toEqual(childContract);
            expect(h.children[0].row.childContract).toEqual(childContract);
            expect(JSON.stringify(h.children[0].config)).not.toContain('PARENT_CONTRACT_ONLY');
            expect(h.children[0].result, JSON.stringify(h.children[0].result)).toMatchObject({ type: 'completed' });
        });
    });
    it.each(['named', 'custom'])('does not inherit the parent contract when the %s child has none', { timeout: 25_000 }, async kind => {
        await harness({ parentConfig: { childContract: { goal: 'PARENT_CONTRACT_ONLY', wakeOn: 'completion' } },
            callTools: kind === 'named' ? ['handoff_load'] : [] }, async h => {
            expect(await h.invoke(path, { ...(kind === 'named' ? { agent_name: 'analyst' } : {}), task: 'Independent child assignment' }))
                .toContain('spawned successfully');
            expect(h.children[0].config.childContract).toBeUndefined();
            expect(h.children[0].row.childContract).toBeUndefined();
            expect(JSON.stringify(h.children[0].config)).not.toContain('PARENT_CONTRACT_ONLY');
            expect(h.children[0].result, JSON.stringify(h.children[0].result)).toMatchObject({ type: 'completed' });
        });
    });
    it('enforces named startup when inference only invokes the selected capability', { timeout: 25_000 }, async () => {
        await harness({ callTools: ['handoff_search'] }, async h => {
            await h.invoke(path, { required_tool: 'handoff_search', task: 'STARTUP_ENFORCEMENT' });
            expect(h.children[0].turnOptions.requiredTool).toBe('handoff_load'); expect(h.children[0].result.type).toBe('error');
            expect(h.children[0].result.message).toContain('handoff_load'); expect(h.calls.map(c => c.name)).toEqual(['handoff_search']);
        });
    });
});
