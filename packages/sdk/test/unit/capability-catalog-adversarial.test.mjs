import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityCatalog, capabilityRef, parseCapabilityRef } from '../../dist/capability-catalog.js';

const alice = { provider: 'oidc', subject: 'alice' };
const bob = { provider: 'oidc', subject: 'bob' };
const reader = 'durable-alice-session';

function source(id, overrides = {}) {
    return {
        id, name: id, source: 'published', revision: `sha-${id}-v1`, scope: 'shared',
        artifacts: [{ kind: 'skill', name: 'incident-review', description: `Incident review from ${id}`, body: `BODY:${id}` }],
        tools: new Map(), mcpServers: {}, ...overrides,
    };
}

function fact(overrides = {}) {
    return {
        scopeKey: 'shared:skills/incident-review', key: 'skills/incident-review',
        shared: true, etag: 7, deletedAt: null, agentId: 'facts-manager', sessionId: null,
        tags: [], createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-02'),
        value: {
            name: 'incident-review', description: 'Incident review curated guidance', instructions: 'CURATED_BODY',
            confidence: 'low', expires_at: '2026-09-20', contradiction_count: 2,
        }, ...overrides,
    };
}

function store(initial = [fact()]) {
    const calls = [];
    let rows = initial;
    return {
        capabilities: { search: true }, calls,
        replace(next) { rows = next; },
        async searchFacts(query, options, access) {
            calls.push({ operation: 'search', query, options, access });
            return { count: rows.length, mode: 'hybrid', facts: rows.map(f => ({ ...f, score: 1, signals: { lexical: 1 } })) };
        },
        async readFacts(query, access) {
            calls.push({ operation: 'read', query, access });
            const found = rows.filter(f => f.shared && f.deletedAt == null && query.scopeKeys?.includes(f.scopeKey));
            return { count: found.length, facts: found };
        },
    };
}

test('default search unions static, own/shared published and curated skills without collapsing identical names', async () => {
    const sources = [source('deployment', { source: 'static' }), source('shared-package'), source('alice-package', { scope: 'user', owner: alice }), source('bob-package', { scope: 'user', owner: bob })];
    const catalog = new CapabilityCatalog(() => sources, store());
    const result = await catalog.search(alice, reader, { query: 'incident review', limit: 30 });
    assert.equal(result.capabilities.length, 4);
    assert.deepEqual(new Set(result.capabilities.map(c => c.source)), new Set(['static', 'published', 'curated']));
    assert.equal(new Set(result.capabilities.map(c => c.ref)).size, 4);
    assert.ok(result.capabilities.every(c => c.name === 'incident-review'));
    assert.ok(!JSON.stringify(result).includes('bob-package'));
    assert.deepEqual(result.coverage, { static: 'available', published: 'available', curated: 'available' });
});

test('same-name references load exactly the selected body and never use name precedence', async () => {
    const sources = [source('deployment', { source: 'static' }), source('shared-package'), source('alice-package', { scope: 'user', owner: alice })];
    const catalog = new CapabilityCatalog(() => sources);
    const result = await catalog.search(alice, reader, { query: 'incident review' });
    for (const hit of result.capabilities) {
        const parsed = parseCapabilityRef(hit.ref);
        assert.equal((await catalog.load(alice, reader, hit.ref, 'skill')).body, `BODY:${parsed.s}`);
    }
});

test('foreign private metadata and forged exact references stay inaccessible, including provider mismatches', async () => {
    const hidden = source('bob-package', { scope: 'user', owner: bob });
    const catalog = new CapabilityCatalog(() => [hidden, source('shared')]);
    const ref = capabilityRef(hidden.id, hidden.revision, 'skill', 'incident-review');
    for (const owner of [alice, null, { provider: 'different-provider', subject: bob.subject }]) {
        const result = await catalog.search(owner, reader, { query: 'incident review', limit: 30 });
        assert.equal(result.capabilities.length, 1);
        assert.ok(!JSON.stringify(result).includes('bob-package'));
        await assert.rejects(catalog.load(owner, reader, ref, 'skill'), /unavailable|inaccessible/i);
    }
    assert.equal((await catalog.load(bob, 'durable-bob', ref, 'skill')).body, 'BODY:bob-package');
});

test('orphaned private packages cannot become public through absent ownership', async () => {
    const orphan = source('orphan', { scope: 'user', owner: null });
    const catalog = new CapabilityCatalog(() => [orphan]);
    for (const owner of [alice, null]) {
        assert.deepEqual((await catalog.search(owner, reader, { query: 'incident review' })).capabilities, []);
        await assert.rejects(catalog.load(owner, reader, capabilityRef(orphan.id, orphan.revision, 'skill', 'incident-review'), 'skill'), /unavailable|inaccessible/i);
    }
});

test('discovery exposes bounded metadata but no instruction body, MCP configuration or handler material', async () => {
    const entry = source('shared', {
        artifacts: [{ kind: 'agent', name: 'incident-review', description: 'Incident '.repeat(200), body: 'SECRET_BODY', initialPrompt: 'SECRET_START', tools: ['lookup'], mcpServers: ['incidents'] }],
        tools: new Map([['lookup', { name: 'lookup', parameters: { secret: 'SECRET_SCHEMA' }, handler() { throw new Error('must not run'); } }]]),
        mcpServers: { incidents: { url: 'https://SECRET_HOST', headers: { Authorization: 'SECRET_CREDENTIAL' } } },
    });
    const result = await new CapabilityCatalog(() => [entry]).search(alice, reader, { query: 'incident' });
    assert.equal(result.capabilities.length, 1);
    assert.ok(result.capabilities[0].description.length <= 600);
    for (const secret of ['SECRET_BODY', 'SECRET_START', 'SECRET_SCHEMA', 'SECRET_HOST', 'SECRET_CREDENTIAL']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('published and static revision changes reject old refs instead of silently loading the replacement', async () => {
    for (const origin of ['static', 'published']) {
        let sources = [source('same-id', { source: origin })];
        const catalog = new CapabilityCatalog(() => sources);
        const hit = (await catalog.search(alice, reader, { query: 'incident review' })).capabilities[0];
        sources = [source('same-id', { source: origin, revision: 'new-revision', artifacts: [{ kind: 'skill', name: 'incident-review', description: 'Incident review', body: 'NEW_BODY' }] })];
        await assert.rejects(catalog.load(alice, reader, hit.ref, 'skill'), /changed|revision|stale/i);
        const fresh = (await catalog.search(alice, reader, { query: 'incident review' })).capabilities[0];
        assert.equal((await catalog.load(alice, reader, fresh.ref, 'skill')).body, 'NEW_BODY');
    }
});

test('removed sources and ownership changes invalidate prior references even when a same-name public copy remains', async () => {
    let sources = [source('mine', { scope: 'user', owner: alice }), source('shared')];
    const catalog = new CapabilityCatalog(() => sources);
    const ref = capabilityRef('mine', sources[0].revision, 'skill', 'incident-review');
    sources = [source('mine', { scope: 'user', owner: bob }), sources[1]];
    await assert.rejects(catalog.load(alice, reader, ref, 'skill'), /unavailable|inaccessible/i);
    sources = [sources[1]];
    await assert.rejects(catalog.load(alice, reader, ref, 'skill'), /unavailable|inaccessible/i);
});

test('loaders reject wrong kinds, source refs, unknown artifacts and fuzzy names', async () => {
    const entry = source('shared');
    const catalog = new CapabilityCatalog(() => [entry]);
    for (const kind of ['agent', 'tool', 'mcp', 'source']) {
        await assert.rejects(catalog.load(alice, reader, capabilityRef(entry.id, entry.revision, kind, 'incident-review'), 'skill'), /Expected a skill reference/);
    }
    for (const name of ['Incident Review', 'incident-review-agent', 'missing', '../../secrets']) {
        await assert.rejects(catalog.load(alice, reader, capabilityRef(entry.id, entry.revision, 'skill', name), 'skill'), /unavailable/i);
    }
});

test('malformed references cannot be interpreted as paths or permissive alternate identifiers', () => {
    const encoded = value => 'cap1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const invalid of [null, 12, '', '/etc/passwd', 'cap2.abc', 'cap1.%%%=', `cap1.${'a'.repeat(4096)}`, encoded({ s: 'x', r: '1', k: 'admin', n: 'x' }), encoded({ s: ['x'], r: '1', k: 'skill', n: 'x' }), encoded({ s: 'x', r: '1', k: 'skill' })]) {
        assert.throws(() => parseCapabilityRef(invalid), /Invalid capability reference/);
    }
});

test('curated search pins hybrid/shared/skills and exact reads preserve the record revision and caller access', async () => {
    const facts = store();
    const catalog = new CapabilityCatalog(() => [], facts);
    const result = await catalog.search(alice, reader, { query: 'incident review', sources: ['curated'], limit: 4 });
    assert.equal(result.capabilities.length, 1);
    assert.deepEqual(facts.calls[0], { operation: 'search', query: 'incident review', options: { mode: 'hybrid', namespace: 'skills', scope: 'shared', limit: 4 }, access: { readerSessionId: reader, unrestricted: false } });
    const loaded = await catalog.load(alice, reader, result.capabilities[0].ref, 'skill');
    assert.equal(loaded.skill.instructions, 'CURATED_BODY');
    assert.equal(loaded.revision, '7');
    assert.deepEqual(facts.calls[1], { operation: 'read', query: { scopeKeys: ['shared:skills/incident-review'], scope: 'shared', limit: 1 }, access: { readerSessionId: reader, unrestricted: false } });
});

test('curated discovery carries evidence from the actual snake_case fact schema', async () => {
    const result = await new CapabilityCatalog(() => [], store()).search(alice, reader, { query: 'incident review' });
    const hit = result.capabilities[0];
    assert.equal(hit.confidence, 'low');
    assert.equal(hit.expiresAt ?? hit.expires_at, '2026-09-20');
    assert.equal(hit.contradictions ?? hit.contradiction_count, 2);
});

test('curated string values parse their instructions and exact key characters never become wildcard reads', async () => {
    const unusual = fact({ key: 'skills/a_%*', scopeKey: 'shared:skills/a_%*', value: JSON.stringify({ name: 'incident-review', instructions: 'EXACT_STRING_BODY' }) });
    const facts = store([unusual]);
    const catalog = new CapabilityCatalog(() => [], facts);
    const hit = (await catalog.search(alice, reader, { query: 'incident' })).capabilities[0];
    assert.equal((await catalog.load(alice, reader, hit.ref, 'skill')).skill.instructions, 'EXACT_STRING_BODY');
    const call = facts.calls.find(c => c.operation === 'read');
    assert.deepEqual(call.query.scopeKeys, ['shared:skills/a_%*']);
    assert.equal(call.query.keyPattern, undefined);
});

test('curated refs cannot cross to private facts, non-skills keys, agent reads or another record name', async () => {
    const privateFact = fact({ shared: false, scopeKey: 'session:bob:skills/incident-review', sessionId: 'bob' });
    const nonSkill = fact({ key: 'tools/credentials', scopeKey: 'shared:tools/credentials' });
    const facts = store([fact(), privateFact, nonSkill]);
    const catalog = new CapabilityCatalog(() => [], facts);
    const found = await catalog.search(alice, reader, { query: 'incident review', sources: ['curated'] });
    assert.equal(found.capabilities.length, 1);
    const refs = [
        capabilityRef(`curated:${privateFact.scopeKey}`, '7', 'skill', privateFact.key),
        capabilityRef(`curated:${nonSkill.scopeKey}`, '7', 'skill', nonSkill.key),
        capabilityRef('curated:shared:skills/incident-review', '7', 'skill', 'skills/other-record'),
    ];
    for (const ref of refs) await assert.rejects(catalog.load(alice, reader, ref, 'skill'), /Invalid|unavailable|inaccessible/);
    await assert.rejects(catalog.load(alice, reader, capabilityRef('curated:shared:skills/incident-review', '7', 'agent', 'skills/incident-review'), 'agent'), /Invalid curated/);
});

test('curated changed revisions and deleted records invalidate discovered refs', async () => {
    const facts = store();
    const catalog = new CapabilityCatalog(() => [], facts);
    const hit = (await catalog.search(alice, reader, { query: 'incident review' })).capabilities[0];
    facts.replace([fact({ etag: 8, value: { instructions: 'REPLACEMENT' } })]);
    await assert.rejects(catalog.load(alice, reader, hit.ref, 'skill'), /changed|stale/i);
    facts.replace([]);
    await assert.rejects(catalog.load(alice, reader, hit.ref, 'skill'), /unavailable|inaccessible/i);
});

test('host-reserved curated prefixes are absent from search and cannot be loaded by a forged ref', async () => {
    const secret = fact({ key: 'skills/private/credentials', scopeKey: 'shared:skills/private/credentials', value: { name: 'SECRET_NAME', instructions: 'SECRET_BODY' } });
    const facts = store([fact(), secret]);
    const catalog = new CapabilityCatalog(() => [], facts, ['skills/private/']);
    const result = await catalog.search(alice, reader, { query: 'incident review' });
    assert.equal(result.capabilities.length, 1);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    await assert.rejects(catalog.load(alice, reader, capabilityRef(`curated:${secret.scopeKey}`, '7', 'skill', secret.key), 'skill'), /unavailable|inaccessible/i);
});

test('curated tombstones do not reappear in metadata even if a provider includes deleted search rows', async () => {
    const deleted = fact({ deletedAt: new Date('2026-09-03'), value: { name: 'DELETED_SKILL', instructions: 'DELETED_BODY' } });
    const catalog = new CapabilityCatalog(() => [], store([deleted]));
    const result = await catalog.search(alice, reader, { query: 'incident review' });
    assert.deepEqual(result.capabilities, []);
    assert.equal(result.coverage.curated, 'available');
});

test('curated backend absence and failure report unavailable coverage without suppressing local results', async () => {
    for (const facts of [undefined, { capabilities: { search: false } }, { capabilities: { search: true }, async searchFacts() { throw new Error('PRIVATE_ENDPOINT_ERROR'); } }]) {
        const result = await new CapabilityCatalog(() => [source('shared'), source('local', { source: 'static' })], facts).search(alice, reader, { query: 'incident review' });
        assert.equal(result.capabilities.length, 2);
        assert.equal(result.coverage.curated, 'unavailable');
        assert.ok(!JSON.stringify(result).includes('PRIVATE_ENDPOINT_ERROR'));
    }
});

test('source and kind filters prevent excluded backend calls and preserve matching artifact kinds', async () => {
    const facts = store();
    const artifacts = ['skill', 'agent', 'tool', 'mcp'].map(kind => ({ kind, name: 'incident-review', description: 'Incident review', body: `BODY:${kind}` }));
    const catalog = new CapabilityCatalog(() => [source('shared', { artifacts }), source('local', { source: 'static', artifacts })], facts);
    const tools = await catalog.search(alice, reader, { query: 'incident review', kinds: ['tool'], sources: ['published', 'curated'] });
    assert.equal(tools.capabilities.length, 1);
    assert.equal(tools.capabilities[0].kind, 'tool');
    assert.equal(tools.capabilities[0].source, 'published');
    assert.equal(facts.calls.length, 0);
    const skills = await catalog.search(alice, reader, { query: 'incident review', kinds: ['skill'], sources: ['static'] });
    assert.equal(skills.capabilities.length, 1);
    assert.equal(skills.capabilities[0].source, 'static');
    assert.equal(facts.calls.length, 0);
});

test('guideline loading returns its own body and reference notice without executing handlers or startup text', async () => {
    let executions = 0;
    const entry = source('workflow', {
        artifacts: [{ kind: 'agent', name: 'incident-review', description: 'Incident review', body: 'RAW_AGENT_BODY', skills: ['review-method'], tools: ['launch'], initialPrompt: 'Run launch now' }],
        tools: new Map([['launch', { name: 'launch', handler() { executions++; } }]]),
    });
    const catalog = new CapabilityCatalog(() => [entry]);
    const hit = (await catalog.search(alice, reader, { query: 'incident review', kinds: ['agent'] })).capabilities[0];
    const loaded = await catalog.load(alice, reader, hit.ref, 'agent');
    assert.equal(loaded.body, 'RAW_AGENT_BODY');
    assert.equal(loaded.mode, 'reference');
    assert.match(loaded.notice, /tell the user.*incident-review/);
    assert.equal(executions, 0);
    assert.deepEqual(loaded.skills, ['review-method']);
});

test('query validation and output limit bound discovery work', async () => {
    const artifacts = Array.from({ length: 50 }, (_, n) => ({ kind: 'skill', name: `incident-${n}`, description: 'Incident review', body: 'body' }));
    const catalog = new CapabilityCatalog(() => [source('many', { artifacts })]);
    for (const query of ['', '   ', 'x'.repeat(2001), null]) await assert.rejects(catalog.search(alice, reader, { query }), /query/);
    for (const args of [{ kinds: ['unknown'] }, { sources: ['private'] }]) await assert.rejects(catalog.search(alice, reader, { query: 'incident', ...args }), /Unknown/);
    for (const limit of [0, -1, 1.5, Infinity, NaN]) await assert.rejects(catalog.search(alice, reader, { query: 'incident', limit }), /limit/);
    assert.equal((await catalog.search(alice, reader, { query: 'incident', limit: 999 })).capabilities.length, 30);
    assert.equal((await catalog.search(alice, reader, { query: 'incident', limit: 2 })).capabilities.length, 2);
});
