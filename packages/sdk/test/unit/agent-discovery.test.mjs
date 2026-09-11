import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentDiscoveryTool, listAgentDefinitionsForCaller } from '../../dist/agent-discovery.js';
import { resolveAgentDefinitionForCaller } from '../../dist/session-proxy.js';
import { PilotSwarmWorker } from '../../dist/worker.js';

const alice = { provider: 'test', subject: 'alice' };
const bob = { provider: 'test', subject: 'bob' };
const ownerKey = owner => owner ? `${owner.provider}\u0001${owner.subject}` : null;
const staticAgent = { name: 'repository-reader', namespace: 'local', description: 'Reads this checkout', prompt: 'STATIC_PROMPT', tools: ['read_repository'], skills: ['local-repo'], mcpServers: ['repository'] };
const published = { name: 'incident-investigator', description: 'Investigates production incidents', prompt: 'PUBLISHED_PROMPT', tools: ['incident_lookup'], packageId: 'shared-pkg', packageScope: 'shared', initialRequiredTool: 'incident_lookup', mcpServers: { incidents: { headers: { Authorization: 'SECRET_TOKEN' }, url: 'https://private.example' } } };
const privateAgent = { ...published, description: 'Personal incident role', prompt: 'ALICE_PROMPT', packageId: 'alice-pkg', packageScope: 'user', packageOwner: alice, tools: ['personal_incident_lookup'] };
const foreign = { name: 'bob-private', prompt: 'BOB_SECRET_PROMPT', description: 'BOB_SECRET_DESCRIPTION', tools: ['bob_secret_tool'], packageId: 'bob-pkg', packageScope: 'user', packageOwner: bob };
const system = { name: 'daemon', id: 'daemon-id', prompt: 'SYSTEM_PROMPT', system: true };

async function list(agents, owner = alice, extra = {}) {
    return listAgentDefinitionsForCaller({ userAgents: agents, systemAgents: [system], getCallerOwnerKey: async () => ownerKey(owner), ...extra });
}

test('lists static and published role metadata without prompts, credentials or endpoints', async () => {
    const rows = await list([staticAgent, published]);
    const local = rows.find(row => row.name === staticAgent.name);
    const shared = rows.find(row => row.name === published.name);
    assert.equal(local.source, 'static');
    assert.equal(shared.source, 'published');
    assert.equal(shared.scope, 'cluster');
    assert.deepEqual(local.skills, ['local-repo']);
    assert.deepEqual(local.mcpServers, ['repository']);
    assert.deepEqual(shared.mcpServers, ['incidents']);
    assert.equal(shared.initialRequiredTool, 'incident_lookup');
    assert.equal(shared.description, published.description);
    assert.deepEqual(shared.tools, ['incident_lookup']);
    assert.ok(rows.every(row => row.creatable && !row.system));
    for (const value of ['STATIC_PROMPT', 'PUBLISHED_PROMPT', 'SECRET_TOKEN', 'private.example']) {
        assert.ok(!JSON.stringify(rows).includes(value));
    }
});

test('personal shadow and explicit shared reference resolve to exactly the advertised copies', async () => {
    const agents = [published, privateAgent, foreign, staticAgent];
    const rows = await list(agents);
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.agent_name === published.name).description, privateAgent.description);
    assert.equal(rows.find(row => row.agent_name === `__shared:${published.name}`).description, published.description);
    assert.ok(!JSON.stringify(rows).includes('bob'));
    for (const row of rows) {
        const def = await resolveAgentDefinitionForCaller({ agentName: row.agent_name, userAgents: agents, getCallerOwnerKey: async () => ownerKey(alice) });
        assert.ok(def);
        assert.equal(def.name, row.name);
        assert.deepEqual(def.tools, row.tools);
        assert.equal(def.packageScope === 'user', row.scope === 'user');
        assert.equal(def.initialRequiredTool ?? null, row.initialRequiredTool);
    }
});

test('another caller gets shared definitions and only their own private definitions', async () => {
    const rows = await list([privateAgent, published, foreign], bob);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.name === published.name).description, published.description);
    assert.equal(rows.find(row => row.name === foreign.name).scope, 'user');
    assert.ok(!JSON.stringify(rows).includes('Personal incident role'));
});

test('a hidden private fuzzy alias is never exposed as a public spawn reference', async () => {
    const hidden = { ...foreign, name: 'Repository Reader Agent', namespace: 'bob-secret-project' };
    const rows = await list([hidden, staticAgent]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_name, staticAgent.name);
    assert.ok(!JSON.stringify(rows).includes(hidden.name));
    assert.ok(!JSON.stringify(rows).includes(hidden.namespace));
});

test('missing or failing owner resolution hides private metadata', async () => {
    for (const getCallerOwnerKey of [async () => null, async () => { throw new Error('catalog unavailable'); }]) {
        const rows = await list([privateAgent, published, foreign], null, { getCallerOwnerKey });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].description, published.description);
    }
});

test('malformed user package ownership fails closed for listing and direct selection', async () => {
    const orphan = { ...privateAgent, name: 'orphan', packageOwner: null };
    assert.deepEqual(await list([orphan]), []);
    assert.equal(await resolveAgentDefinitionForCaller({ agentName: 'orphan', userAgents: [orphan], getCallerOwnerKey: async () => ownerKey(alice) }), null);
});

test('same canonical names in different namespaces return working exact references', async () => {
    const first = { ...staticAgent, name: 'reviewer', namespace: 'repository' };
    const second = { ...staticAgent, name: 'reviewer', namespace: 'incident', prompt: 'INCIDENT', tools: ['incident_lookup'] };
    const rows = await list([first, second]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
        const def = await resolveAgentDefinitionForCaller({ agentName: row.agent_name, userAgents: [first, second], getCallerOwnerKey: async () => ownerKey(alice) });
        assert.equal(def.namespace, row.namespace);
        assert.deepEqual(def.tools, row.tools);
    }
});

test('deployment copy shadowed by a personal package remains explicitly selectable', async () => {
    const personal = { ...privateAgent, name: staticAgent.name, namespace: staticAgent.namespace };
    const rows = await list([staticAgent, personal]);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.scope === 'user').agent_name, staticAgent.name);
    assert.equal(rows.find(row => row.source === 'static').agent_name, `__shared:${staticAgent.name}`);
});

test('a selected private copy never advertises tools or skills from its public shadow', async () => {
    const rows = await list([published, { ...privateAgent, tools: [], skills: ['personal-only'], initialRequiredTool: undefined, mcpServers: [] }]);
    const mine = rows.find(row => row.scope === 'user');
    assert.deepEqual(mine.tools, []);
    assert.deepEqual(mine.skills, ['personal-only']);
    assert.deepEqual(mine.mcpServers, []);
    assert.equal(mine.initialRequiredTool, null);
});

test('system diagnostics are separate from spawnable definitions', async () => {
    const rows = await list([published], null, { systemOnly: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'daemon');
    assert.equal(rows[0].creatable, false);
    assert.equal(rows[0].system, true);
});

test('system diagnostics survive a same-name user-creatable definition', async () => {
    const rows = await list([{ ...staticAgent, name: 'daemon' }], null, { systemOnly: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'daemon-id');
    assert.equal(rows[0].creatable, false);
});

test('a unique existing ID reaches a public role behind namespace and owner shadows', async () => {
    const agents = [
        { ...staticAgent, name: 'reviewer', namespace: 'operations' },
        { ...published, name: 'reviewer', namespace: 'security', id: 'security-shared-reviewer' },
        { ...privateAgent, name: 'reviewer', namespace: 'security' },
    ];
    const rows = await list(agents);
    assert.equal(rows.length, 3);
    const shared = rows.find(row => row.id === 'security-shared-reviewer');
    const def = await resolveAgentDefinitionForCaller({ agentName: shared.agent_name, userAgents: agents, getCallerOwnerKey: async () => ownerKey(alice) });
    assert.equal(def.packageId, published.packageId);
    assert.equal(shared.description, published.description);
});

test('one consistent owner lookup is shared across the complete listing', async () => {
    let calls = 0;
    const rows = await list([privateAgent, published, foreign], null, { getCallerOwnerKey: async () => { calls++; return ownerKey(alice); } });
    assert.equal(calls, 1);
    assert.equal(rows.filter(row => row.scope === 'user').length, 1);
});

test('an in-flight package refresh cannot mix old and new metadata in one response', async () => {
    const agents = [privateAgent, published];
    const rows = await list(agents, null, { getCallerOwnerKey: async () => {
        agents.splice(0, agents.length, { ...staticAgent, name: 'next-revision' });
        return ownerKey(alice);
    } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.name === published.name));
    assert.equal((await list(agents))[0].name, 'next-revision');
});

test('actual tool uses durable caller identity, reads fresh definitions and never trusts caller identity arguments', async () => {
    let agents = [privateAgent, published, foreign];
    const callers = [];
    const tool = createAgentDiscoveryTool({
        getUserAgents: () => agents,
        getSystemAgents: () => [system],
        getCallerOwnerKey: async sessionId => { callers.push(sessionId); return sessionId === 'alice-durable' ? ownerKey(alice) : null; },
    });
    assert.deepEqual(Object.keys(tool.parameters.properties), ['systemOnly'], 'do not advertise an option that cannot change the result');
    const initial = JSON.parse(await tool.handler({ owner: bob, sessionId: 'bob' }, { sessionId: 'sdk-id', durableSessionId: 'alice-durable' }));
    assert.deepEqual(callers, ['alice-durable']);
    assert.equal(initial.total, 2);
    assert.ok(!JSON.stringify(initial).includes('bob'));
    agents = [staticAgent]; // package disabled/removed by worker poll
    const refreshed = JSON.parse(await tool.handler({}, { durableSessionId: 'alice-durable' }));
    assert.equal(refreshed.total, 1);
    assert.equal(refreshed.agents[0].source, 'static');
    agents = [privateAgent, published];
    const unknown = JSON.parse(await tool.handler({}, { sessionId: 'alice-durable' }));
    assert.equal(unknown.total, 1);
    assert.equal(unknown.agents[0].scope, 'cluster');
});

test('production base declares discovery for ordinary and named sessions without caller tool overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ps-discovery-admission-'));
    const worker = new PilotSwarmWorker({ store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions') });
    try {
        const tool = createAgentDiscoveryTool({ getUserAgents: () => [staticAgent], getSystemAgents: () => [], getCallerOwnerKey: async () => null });
        worker.registerTools([tool]);
        // Read the production-loaded framework declarations, not a fixture
        // that explicitly grants discovery and could mask a missing default.
        const inherited = worker.sessionManager.workerDefaults.frameworkBaseToolNames;
        assert.ok(inherited.includes('ps_list_agents'));
        for (const extra of [[], ['read_repository']]) {
            const admitted = worker.sessionManager._resolveTools({}, { toolNames: [...inherited, ...extra] });
            const discovery = admitted.find(entry => entry.name === 'ps_list_agents');
            assert.ok(discovery, 'discovery is available without a caller-supplied tools override');
            const result = JSON.parse(await discovery.handler({}, { durableSessionId: 'ordinary-or-named' }));
            assert.equal(result.agents[0].agent_name, staticAgent.name);
        }
    } finally {
        await worker.sessionManager.shutdown();
        rmSync(root, { recursive: true, force: true });
    }
});
