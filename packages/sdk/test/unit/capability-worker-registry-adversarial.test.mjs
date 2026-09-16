import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PilotSwarmWorker } from '../../dist/worker.js';
import { CapabilityCatalog, capabilityRef } from '../../dist/capability-catalog.js';
import { packageAgentKey } from '../../dist/session-manager.js';
import { validateAgentPackageDir } from '../../dist/agent-package-format.js';

const alice = { provider: 'oidc', subject: 'alice' };
const bob = { provider: 'oidc', subject: 'bob' };
function write(root, relative, text) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
}
function plugin(root, name, body, agent = true) {
    const dir = path.join(root, name);
    write(dir, 'plugin.json', JSON.stringify({ name, version: '1.0.0' }));
    write(dir, 'skills/incident-method/SKILL.md', `---\nname: incident-method\ndescription: Incident method\n---\n${body}\n`);
    if (agent) write(dir, 'agents/incident-review.agent.md', `---\nschemaVersion: 1\nversion: 1.0.0\nname: incident-review\ndescription: Incident review\nskills:\n  - incident-method\n---\nRAW_AGENT:${name}\n`);
    return dir;
}

test('worker registry preserves package revision, owner, raw guidelines and same-name skills through refresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-capability-registry-'));
    let worker;
    try {
        const deployment = plugin(root, 'deployment', 'STATIC_SKILL');
        const mine = plugin(root, 'mine', 'ALICE_SKILL');
        const foreign = plugin(root, 'foreign', 'BOB_SKILL');
        worker = new PilotSwarmWorker({ sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true, pluginDirs: [deployment] });
        worker._packageDirOwners = new Map([
            [mine, { packageId: 'alice-package', revision: 'alice-sha-1', scope: 'user', owner: alice }],
            [foreign, { packageId: 'bob-package', revision: 'bob-sha-1', scope: 'user', owner: bob }],
        ]);
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [deployment, mine, foreign];
        worker._loadPlugins();
        const catalog = new CapabilityCatalog(() => worker._getCapabilitySources());
        const result = await catalog.search(alice, 'alice-session', { query: 'incident', kinds: ['skill', 'agent'], limit: 30 });
        assert.equal(result.capabilities.length, 4);
        assert.ok(!JSON.stringify(result).includes('bob-package'));
        const own = result.capabilities.find(c => c.kind === 'skill' && c.scope === 'user');
        assert.equal(own.revision, 'alice-sha-1');
        assert.match((await catalog.load(alice, 'alice-session', own.ref, 'skill')).body, /ALICE_SKILL/);
        const workflow = result.capabilities.find(c => c.kind === 'agent' && c.scope === 'user');
        const loaded = await catalog.load(alice, 'alice-session', workflow.ref, 'agent');
        assert.match(loaded.body, /RAW_AGENT:mine/);
        assert.ok(!loaded.body.includes('ALICE_SKILL'), 'raw agent body must stay separate from declared skill preloading');
        assert.deepEqual(loaded.skills, ['incident-method']);
        await assert.rejects(catalog.load(alice, 'alice-session', capabilityRef('bob-package', 'bob-sha-1', 'skill', 'incident-method'), 'skill'), /unavailable|inaccessible/i);

        worker._packageDirOwners.delete(mine);
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [deployment, foreign];
        worker._loadPlugins();
        await assert.rejects(catalog.load(alice, 'alice-session', own.ref, 'skill'), /unavailable|inaccessible/i);
        assert.equal((await catalog.search(alice, 'alice-session', { query: 'incident', limit: 30 })).capabilities.length, 2);
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('V2 SDK skill directories and declared-agent bodies exclude unrelated shared packages without changing V1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-owner-skill-dirs-'));
    let worker;
    try {
        const deployment = plugin(root, 'deployment', 'STATIC_METHOD');
        const mine = plugin(root, 'mine', 'OWNED_METHOD');
        const foreign = plugin(root, 'foreign', 'FOREIGN_METHOD');
        worker = new PilotSwarmWorker({ sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true });
        worker._packageDirOwners = new Map([
            [mine, { packageId: 'mine-shared', scope: 'shared', owner: alice, revision: '1' }],
            [foreign, { packageId: 'foreign-shared', scope: 'shared', owner: bob, revision: '1' }],
        ]);
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [deployment, mine, foreign];
        worker._loadPlugins();

        const dirs = worker._getBaseV2SkillDirectories(alice);
        assert.ok(dirs.includes(path.join(deployment, 'skills')));
        assert.ok(dirs.includes(path.join(mine, 'skills')));
        assert.ok(!dirs.includes(path.join(foreign, 'skills')));
        assert.ok(!worker._getBaseV2SkillDirectories(null).includes(path.join(mine, 'skills')));
        assert.ok(worker._loadedSkillDirs.includes(path.join(foreign, 'skills')), 'V1 still receives the old directory list');

        const entry = worker._agentPromptLookup['incident-review'];
        const deploymentCopy = entry.copies.find(copy => !copy.packageId);
        const ownedCopy = entry.copies.find(copy => copy.packageId === 'mine-shared');
        assert.match(deploymentCopy.prompt, /FOREIGN_METHOD/, 'V1 retains its existing composition');
        assert.match(deploymentCopy.baseV2Prompt, /STATIC_METHOD/);
        assert.doesNotMatch(deploymentCopy.baseV2Prompt, /FOREIGN_METHOD|OWNED_METHOD/);
        assert.match(ownedCopy.baseV2Prompt, /OWNED_METHOD/, 'explicitly selected package agent keeps its own declared skills');
        assert.doesNotMatch(ownedCopy.baseV2Prompt, /FOREIGN_METHOD/);
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('direct skill directories, custom agents and MCP servers are present in the static registry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-capability-inline-'));
    let worker;
    try {
        write(root, 'skills/direct-expertise/SKILL.md', '---\nname: direct-expertise\ndescription: Direct expertise\n---\nDIRECT_SKILL_BODY\n');
        worker = new PilotSwarmWorker({
            sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true,
            skillDirectories: [path.join(root, 'skills')],
            customAgents: [{ name: 'direct-reviewer', description: 'Direct reviewer', prompt: 'DIRECT_AGENT_BODY' }],
            mcpServers: { direct_lookup: { type: 'http', url: 'https://private.example/mcp', tools: ['*'] } },
        });
        const catalog = new CapabilityCatalog(() => worker._getCapabilitySources());
        for (const [name, kind] of [['direct-expertise', 'skill'], ['direct-reviewer', 'agent'], ['direct_lookup', 'mcp']]) {
            const result = await catalog.search(alice, 'alice-session', { query: name, kinds: [kind], sources: ['static'], limit: 30 });
            const hit = result.capabilities.find(c => c.name === name && c.kind === kind);
            assert.ok(hit, `${name} should be discoverable from direct worker configuration`);
            assert.equal(hit.source, 'static');
        }
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('valid same-name skills within one package have distinct exact refs and load their selected bodies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-capability-duplicate-'));
    let worker;
    try {
        const dir = plugin(root, 'duplicate-skills', 'FIRST_BODY', false);
        write(dir, 'skills/second/SKILL.md', '---\nname: incident-method\ndescription: Incident method alternate\n---\nSECOND_BODY\n');
        const validation = await validateAgentPackageDir(dir);
        assert.equal(validation.ok, true, JSON.stringify(validation.errors));
        worker = new PilotSwarmWorker({ sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true });
        worker._packageDirOwners = new Map([[dir, { packageId: 'duplicate-package', revision: 'duplicate-sha', scope: 'shared', owner: null }]]);
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [dir];
        worker._loadPlugins();
        const catalog = new CapabilityCatalog(() => worker._getCapabilitySources());
        const result = await catalog.search(alice, 'alice-session', { query: 'incident-method', kinds: ['skill'], sources: ['published'], limit: 30 });
        assert.equal(result.capabilities.length, 2);
        assert.equal(new Set(result.capabilities.map(c => c.ref)).size, 2, 'different skill artifacts must never advertise the same exact ref');
        const bodies = await Promise.all(result.capabilities.map(async c => (await catalog.load(alice, 'alice-session', c.ref, 'skill')).body.trim()));
        assert.deepEqual(new Set(bodies), new Set(['FIRST_BODY', 'SECOND_BODY']));
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('opted-in bundled agents enter static discovery and unselected bundled agents remain absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-capability-bundled-'));
    let worker;
    try {
        const dir = path.join(root, 'policy');
        write(dir, 'plugin.json', JSON.stringify({ name: 'policy', version: '1.0.0' }));
        write(dir, 'session-policy.json', JSON.stringify({ creation: { bundledAgents: ['generic-crawler'] } }));
        worker = new PilotSwarmWorker({ sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true, pluginDirs: [dir] });
        const catalog = new CapabilityCatalog(() => worker._getCapabilitySources());
        const found = await catalog.search(alice, 'alice-session', { query: 'generic-crawler', kinds: ['agent'], sources: ['static'], limit: 30 });
        assert.ok(found.capabilities.some(c => c.name === 'generic-crawler'));
        write(dir, 'session-policy.json', JSON.stringify({ creation: { bundledAgents: [] } }));
        worker._resetLoadedPluginState();
        worker._loadPlugins();
        const absent = await catalog.search(alice, 'alice-session', { query: 'generic-crawler', kinds: ['agent'], sources: ['static'], limit: 30 });
        assert.ok(!absent.capabilities.some(c => c.name === 'generic-crawler'));
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('same-named package MCP servers stay package-qualified and cannot become defaults', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-capability-mcp-'));
    let worker;
    try {
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        for (const [dir, name, url] of [[first, 'first-kit', 'https://first.test/mcp'], [second, 'second-kit', 'https://second.test/mcp']]) {
            write(dir, 'plugin.json', JSON.stringify({ name, version: '1.0.0' }));
            write(dir, '.mcp.json', JSON.stringify({ lookup: { type: 'http', url, tools: ['read'], default: true } }));
            write(dir, 'agents/reviewer.agent.md', `---\nschemaVersion: 2\nversion: 1.0.0\nname: reviewer\ndescription: Reviewer\nmcpServers:\n  - lookup\n---\nReview.\n`);
        }
        worker = new PilotSwarmWorker({ sessionStateDir: path.join(root, 'sessions'), disableManagementAgents: true });
        worker._packageDirOwners = new Map([
            [first, { packageId: 'pkg-first', revision: 'sha-first', scope: 'shared', owner: null }],
            [second, { packageId: 'pkg-second', revision: 'sha-second', scope: 'shared', owner: null }],
        ]);
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [first, second];
        worker._loadPlugins();

        assert.equal(worker.agentMcpServers[packageAgentKey('pkg-first', 'reviewer')].lookup.url, 'https://first.test/mcp');
        assert.equal(worker.agentMcpServers[packageAgentKey('pkg-second', 'reviewer')].lookup.url, 'https://second.test/mcp');
        assert.ok(!Object.hasOwn(worker.baseMcpServers, 'lookup'));
    } finally {
        if (worker) await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
