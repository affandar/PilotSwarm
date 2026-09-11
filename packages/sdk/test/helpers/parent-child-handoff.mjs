/** Real spawn and child runtime; only durable persistence/enqueue is injected. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../../src/session-manager.ts';
import { ModelProviderRegistry } from '../../src/model-providers.ts';
import { registerActivities, createSessionManagerProxy } from '../../src/session-proxy.ts';
import { HANDOFF_ACTIVITY_NAMES, AGENT_HANDOFF_CAPABILITY } from '../../src/activity-routing.ts';
import { handleSubAgentAction } from '../../src/orchestration/agents.ts';
import { createAgentDiscoveryTool } from '../../src/agent-discovery.ts';
import { resolveEffectiveSpawnOwner } from '../../src/cms.ts';
import { createNativeCopilotProvider } from './native-copilot-provider.mjs';

export const ALICE = { provider: 'fixture', subject: 'alice', email: 'alice@example.test', displayName: null };
export const BOB = { provider: 'fixture', subject: 'bob', email: 'bob@example.test', displayName: null };
export const MODEL = 'fixture:gpt-5.6-terra';
export const shared = { name: 'analyst', id: 'analyst', description: 'Shared analyst', prompt: 'SHARED_ANALYST_INSTRUCTIONS',
    tools: ['handoff_load', 'handoff_search'], initialRequiredTool: 'handoff_load', initialPrompt: 'DEFAULT_ANALYST_ASSIGNMENT',
    packageId: 'pkg-shared', packageScope: 'shared', title: 'Shared analyst', splash: 'SHARED_SPLASH', splashMobile: 'SHARED_MOBILE' };
export const privateCopy = { ...shared, prompt: 'PRIVATE_ANALYST_INSTRUCTIONS', splashMobile: 'PRIVATE_MOBILE', packageId: 'pkg-alice', packageScope: 'user', packageOwner: ALICE };
export const systemPrompt = body => body.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string'
    ? m.content : m.content.map(p => p.text ?? '').join('\n')).join('\n');
export const toolNames = body => body.tools?.map(t => t.function?.name) ?? [];
const context = { traceInfo() {}, isCancelled: () => false };

export async function handoffHarness(transport, options, run) {
    const home = mkdtempSync(join(tmpdir(), 'ps-handoff-'));
    const parentId = randomUUID(), rows = new Map(), events = [], calls = [], registeredTools = [], children = [], queued = [], handlers = new Map();
    const definitions = options.agents ?? [shared];
    const parentConfig = { model: MODEL, reasoningEffort: 'medium', waitThreshold: 40,
        systemMessage: 'PARENT_PERSONA_MUST_NOT_LEAK',
        boundAgentName: 'parent-specialist', boundAgentPackageId: 'pkg-parent', agentIdentity: 'parent-specialist',
        isCrawler: true, isHarvester: true, toolNames: ['parent_only', 'deployment_tool'], ...options.parentConfig };
    rows.set(parentId, { sessionId: parentId, status: 'running', owner: options.owner === undefined ? ALICE : options.owner,
        isSystem: options.systemParent ?? false, parentSessionId: options.ancestor ? 'ancestor' : null,
        model: parentConfig.model, reasoningEffort: parentConfig.reasoningEffort });
    if (options.ancestor) rows.set('ancestor', { sessionId: 'ancestor', ...options.ancestor });
    let stage = 0;
    const server = await createNativeCopilotProvider(() => {
        const names = options.callTools ?? ['handoff_load', 'handoff_search'];
        if (stage < names.length) return { tools: [{ name: names[stage++], args: {} }] };
        return { content: 'CHILD_COMPLETED' };
    });
    const registry = new ModelProviderRegistry({ providers: [{ id: 'fixture', type: 'openai', baseUrl: server.baseUrl,
        apiKey: 'local-scripted-provider', models: ['gpt-5.6-terra', 'gpt-5.6-sol'] }] });
    const lookup = {};
    for (const agent of definitions) {
        const copy = { prompt: agent.prompt, kind: 'app-agent', toolNames: agent.tools ?? [], packageId: agent.packageId,
            packageScope: agent.packageScope, packageOwner: agent.packageOwner };
        if (!lookup[agent.name]) lookup[agent.name] = { ...copy, copies: [copy] };
        else lookup[agent.name].copies.push(copy);
        // Worker preserves namespace identity for static definitions that share
        // a canonical name. Published definitions already carry package pins.
        if (!agent.packageId && agent.namespace) lookup[`${agent.namespace}:${agent.name}`] = { ...copy };
    }
    const manager = new SessionManager(undefined, null, { modelProviders: registry, nativeSubagents: 'off', turnTimeoutMs: 10_000,
        frameworkBasePrompt: 'FRAMEWORK_DEFAULT_INSTRUCTIONS', appDefaultPrompt: 'APP_DEFAULT_INSTRUCTIONS',
        frameworkBaseToolNames: ['framework_tool'], appDefaultToolNames: ['app_tool'], agentPromptLookup: lookup,
        workingDirectory: home }, join(home, 'sessions'));
    const makeTool = (name, owner) => ({ name, description: `${name} owned by ${owner}`, parameters: { type: 'object', properties: {} },
        handler: async () => { calls.push({ name, owner }); return `${owner}:${name}:EXECUTED`; } });
    const flat = new Map(['framework_tool', 'app_tool', 'deployment_tool'].map(name => [name, makeTool(name, 'deployment')]));
    const staticTools = new Map(flat);
    const byPackage = new Map([['pkg-parent', new Map([['parent_only', makeTool('parent_only', 'pkg-parent')]])]]);
    flat.set('parent_only', byPackage.get('pkg-parent').get('parent_only'));
    const staticNames = new Set(['framework_tool', 'app_tool', 'deployment_tool']);
    for (const agent of definitions) {
        const tools = new Map((agent.tools ?? []).map(name => [name, makeTool(name, agent.packageId ?? 'deployment')]));
        if (agent.packageId) byPackage.set(agent.packageId, tools);
        else for (const [name, tool] of tools) { staticNames.add(name); staticTools.set(name, tool); }
        for (const [name, tool] of tools) flat.set(name, tool);
    }
    // Match PilotSwarmWorker._pushMergedToolRegistry: deployment registrations
    // win flat-name collisions after package tools are merged.
    for (const [name, tool] of staticTools) flat.set(name, tool);
    manager.setToolRegistry(flat, { byPackage, staticNames });
    manager.setFactStore({ readFacts: async () => ({ facts: [], count: 0 }), storeFact: async () => ({}), deleteFact: async () => ({}) });
    const catalog = {
        getSession: async id => rows.get(id) ?? null,
        updateSession: async (id, patch) => Object.assign(rows.get(id) ?? {}, patch),
        recordEvents: async (sessionId, entries) => { events.push(...entries.map(entry => ({ ...entry, sessionId }))); },
        upsertSessionMetricSummary: async () => {}, setActiveTurnIndex: async () => {}, getChildOutcome: async () => null, upsertChildOutcome: async () => {},
        getSessionEventsBefore: async () => [], getUserRole: async () => ({ role: 'user', seenAt: new Date() }),
    };
    manager.setSessionCatalog(catalog);
    const discoveryTool = createAgentDiscoveryTool({
        getUserAgents: () => definitions,
        getSystemAgents: () => options.systemAgents ?? [],
        getCallerOwnerKey: async sessionId => {
            if (!sessionId) return null;
            const owner = await resolveEffectiveSpawnOwner(id => catalog.getSession(id), sessionId);
            return owner?.provider && owner?.subject ? `${owner.provider}\u0001${owner.subject}` : null;
        },
    });
    const discover = async (args = {}) => JSON.parse(await discoveryTool.handler(args, {
        sessionId: parentId, durableSessionId: parentId,
    }));
    let inlineArgs;
    const proxyManager = new Proxy(manager, { get(target, key) {
        if (key === 'getOrCreate') return async (id, ...args) => {
            if (id === parentId) return { abort() {}, runTurn: async (_prompt, turn) => ({ type: 'completed',
                content: await turn.controlToolBridge.spawnAgent(inlineArgs), events: [] }) };
            const managed = await target.getOrCreate(id, ...args);
            const copilot = managed.getCopilotSession();
            const register = copilot.registerTools.bind(copilot);
            copilot.registerTools = tools => { registeredTools.push(...tools); return register(tools); };
            return managed;
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, proxyManager, null, undefined, catalog,
        undefined, 'in-memory://handoff', undefined, undefined, options.systemAgents ?? [], null, [], definitions, null, 'test-worker');
    const runTurnHandler = () => {
        const handler = handlers.get(HANDOFF_ACTIVITY_NAMES.runTurn);
        if (!handler) throw new Error('Current handoff runTurn activity is not registered');
        return handler;
    };
    transport.active = { rows, createChild: async config => {
        const id = config.sessionId ?? randomUUID();
        const row = { ...config, sessionId: id, isSystem: false, status: 'running' };
        rows.set(id, row);
        const child = { config: structuredClone(config), row, sessionId: id }; children.push(child);
        return { sessionId: id, send: async (prompt, turnOptions) => {
            child.prompt = prompt; child.turnOptions = turnOptions;
            queued.push(async () => { child.result = await runTurnHandler()(context, { sessionId: id, config: child.config,
                prompt, turnIndex: 0, parentSessionId: parentId, nestingLevel: child.config.nestingLevel,
                bootstrap: turnOptions.bootstrap, requiredTool: turnOptions.requiredTool }); });
        } };
    } };
    const invoke = async (path, args) => {
        let reply;
        if (path === 'inline') {
            inlineArgs = args;
            const result = await runTurnHandler()(context, { sessionId: parentId, config: parentConfig, prompt: 'Delegate the assignment', turnIndex: 1 });
            reply = result.content ?? result.message;
        } else {
            const runtime = { ctx: { traceInfo() {} }, input: { sessionId: parentId }, options: { nestingLevel: 0 },
                state: { config: parentConfig, subAgents: [], pendingPrompt: '' },
                manager: createSessionManagerProxy({ scheduleActivity: (name, input) => ({ name, input,
                    withTag(tag) { return { name, input, tag }; } }) }, 'agent-handoff-v2') };
            const mapping = { agent_name: 'agentName', required_tool: 'requiredTool', tool_names: 'toolNames', system_message: 'systemMessage',
                reasoning_effort: 'reasoningEffort', context_tier: 'contextTier' };
            const action = { type: 'spawn_agent', task: '', ...Object.fromEntries(Object.entries(args).map(([key, val]) => [mapping[key] ?? key, val])) };
            const generator = handleSubAgentAction(runtime, action);
            let step = generator.next();
            while (!step.done) {
                const activity = step.value;
                if (Object.values(HANDOFF_ACTIVITY_NAMES).includes(activity.name) && activity.tag !== AGENT_HANDOFF_CAPABILITY) {
                    throw new Error(`Untagged handoff activity ${activity.name}`);
                }
                try { step = generator.next(await handlers.get(activity.name)(context, activity.input)); }
                catch (error) { step = generator.throw(error); }
            }
            reply = runtime.state.pendingPrompt;
        }
        for (const execute of queued.splice(0)) await execute();
        return reply;
    };
    try { await run({ invoke, discover, children, rows, events, calls, registeredTools, server, manager, parentId, parentConfig }); }
    finally { transport.active = null; await manager.shutdown(); await server.close(); rmSync(home, { recursive: true, force: true }); }
}
