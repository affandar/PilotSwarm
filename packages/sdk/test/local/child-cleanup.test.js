/** Runtime and orchestration cleanup protocol; no live model or database. */
import { describe, it, expect, vi } from 'vitest';
const transport = vi.hoisted(() => ({ active: null, commands: [] }));
vi.mock('../../src/client.js', () => ({ PilotSwarmClient: class {
    systemSessions = new Set();
    async start() {} async stop() {}
    async listSessions() { return [...transport.active.rows.values()]; }
    async _getSessionInfo(id) { return transport.active.rows.get(id); }
    _getDuroxideClient() { return { enqueueEvent: async (id, queue, body) => {
        transport.commands.push({ id, queue, command: JSON.parse(body) });
    } }; }
} }));
import { handoffHarness } from '../helpers/parent-child-handoff.mjs';
import { beginGracefulShutdown, finalizePendingShutdown, handleSubAgentAction, parseChildUpdate, refreshTrackedSubAgents } from '../../src/orchestration/agents.ts';
import { beginGracefulShutdown as frozenShutdown } from '../../src/orchestration_1_0_76/agents.ts';
import { bufferChildUpdate, buildPendingChildDigestSystemPrompt, buildContinueInput } from '../../src/orchestration/lifecycle.ts';
import { createInitialState, deriveOptions } from '../../src/orchestration/state.ts';

function fixture(overrides = {}, effects = {}) {
    const input = { sessionId: 'child', parentSessionId: 'parent', config: {}, iteration: 5, ...overrides };
    const options = deriveOptions(input);
    const sent = [], events = [], commands = [], cms = [], deleted = [], destroyed = [], values = new Map();
    const effect = (kind, args) => ({ kind, ...args });
    const runtime = {
        input, options, state: createInitialState(input, options),
        versions: { currentVersion: '1.0.77', latestVersion: '1.0.77' },
        ctx: { traceInfo() {}, setCustomStatus() {},
            getValue: key => values.get(key) ?? null, setValue: (key, value) => values.set(key, value),
            clearValue: key => values.delete(key), utcNow: () => effect('now'),
        },
        manager: {
            listChildSessions: () => effect('children'),
            getSessionStatus: () => effect('status'),
            sendToSession: (id, prompt) => effect('send', { id, prompt }),
            recordSessionEvent: (id, entries) => effect('events', { id, entries }),
            updateCmsState: (id, state) => effect('cms', { id, state }),
            sendCommandToSession: (id, command) => effect('command', { id, command }),
            getDescendantSessionIds: () => effect('descendants'),
            deleteSession: id => effect('delete', { id }),
        },
        session: { destroy: () => effect('destroy') },
    };
    const drive = generator => {
        let next = generator.next();
        for (let n = 0; !next.done && n < 100; n++) {
            const e = next.value;
            if (effects.failAudit && e.kind === 'events'
                && e.entries.some(entry => entry.eventType === 'session.child_cleanup_completed')) {
                next = generator.throw(new Error('audit store unavailable'));
                continue;
            }
            let answer;
            switch (e.kind) {
                case 'now': answer = 1000; break;
                case 'children': answer = JSON.stringify(effects.children ?? input.subAgents ?? []); break;
                case 'status': answer = JSON.stringify(effects.status ?? {}); break;
                case 'send': sent.push(e); break;
                case 'events': events.push(e); break;
                case 'cms': cms.push(e); break;
                case 'command': commands.push(e); break;
                case 'descendants': answer = []; break;
                case 'delete': deleted.push(e.id); break;
                case 'destroy': destroyed.push(input.sessionId); break;
                default: throw new Error(`Unimplemented fixture effect: ${JSON.stringify(e)}`);
            }
            next = generator.next(answer);
        }
        expect(next.done, 'generator must settle').toBe(true);
    };
    return { runtime, drive, sent, events, commands, cms, deleted, destroyed };
}

for (const [tool, command, status] of [
    ['completeAgent', 'done', 'completed'], ['cancelAgent', 'cancel', 'cancelled'], ['deleteAgent', 'delete', 'cancelled'],
]) describe(`${tool} cleanup`, () => {
    it('stamps the real parent in the inline bridge and closes without a new parent prompt', async () => {
        transport.commands = [];
        await handoffHarness(transport, { parentControl: (bridge, args) => bridge[tool](args) }, async h => {
            h.rows.set('child', { sessionId: 'child', parentSessionId: h.parentId, status: 'idle', isSystem: false });
            const reply = await h.invoke('inline', { agent_id: 'child', requestedBy: 'forged', reason: 'operator text' });
            expect(reply).toContain('requested');
            expect(transport.commands).toHaveLength(1);
            const queued = transport.commands[0];
            expect(queued).toMatchObject({ id: 'session-child', queue: 'messages', command: { cmd: command, requestedBy: h.parentId } });
            expect(queued.command.id).toBeTruthy();
            const f = fixture({ parentSessionId: h.parentId });
            f.drive(beginGracefulShutdown(f.runtime, command, queued.command));
            expect(f.sent).toEqual([]);
            if (command === 'delete') expect(f.deleted).toEqual(['child']);
            else expect(f.cms).toContainEqual(expect.objectContaining({ state: status }));
            expect(f.destroyed).toEqual(['child']);
            expect(f.events).toContainEqual(expect.objectContaining({ id: h.parentId, entries: [expect.objectContaining({
                eventType: 'session.child_cleanup_completed', data: { childSessionId: 'child', commandId: queued.command.id, requestedBy: h.parentId, status },
            })] }));
            expect(h.server.requests).toHaveLength(0);
        });
    });

    it('stamps the parent in the durable control path', () => {
        const f = fixture({ sessionId: 'parent', parentSessionId: undefined, subAgents: [
            { sessionId: 'child', orchId: 'session-child', task: 'work', status: 'running' },
        ] });
        const type = { done: 'complete_agent', cancel: 'cancel_agent', delete: 'delete_agent' }[command];
        f.drive(handleSubAgentAction(f.runtime, { type, agentId: 'session-child', reason: 'reason', requestedBy: 'forged' }));
        expect(f.commands).toHaveLength(1);
        expect(f.commands[0]).toMatchObject({ id: 'child', command: { cmd: command, requestedBy: 'parent' } });
    });

    it('still reports an external termination even when its reason says Completed by parent', () => {
        const f = fixture();
        f.drive(beginGracefulShutdown(f.runtime, command, { type: 'cmd', cmd: command, id: 'external', args: { reason: 'Completed by parent' } }));
        expect(f.sent).toHaveLength(1);
        expect(parseChildUpdate(f.sent[0].prompt)).toMatchObject({ sessionId: 'child', updateType: status, content: 'Completed by parent' });
        expect(f.events.flatMap(e => e.entries).some(e => e.eventType === 'session.child_cleanup_completed')).toBe(false);
    });

    it('preserves cleanup origin while descendants drain across continue-as-new', () => {
        const f = fixture({ subAgents: [{ sessionId: 'grandchild', orchId: 'session-grandchild', task: 'nested work', status: 'running' }] });
        f.drive(beginGracefulShutdown(f.runtime, command, { type: 'cmd', cmd: command, id: 'close-child', requestedBy: 'parent' }));
        expect(f.runtime.state.pendingShutdown).toMatchObject({ commandId: 'close-child', requestedBy: 'parent' });
        expect(f.commands[0].command.requestedBy).toBe('child');
        const carried = JSON.parse(JSON.stringify(buildContinueInput(f.runtime)));
        const resumed = fixture(carried);
        expect(resumed.runtime.state.pendingShutdown.requestedBy).toBe('parent');
        resumed.drive(finalizePendingShutdown(resumed.runtime));
        expect(resumed.sent).toEqual([]);
        expect(resumed.events.flatMap(e => e.entries)).toContainEqual(expect.objectContaining({
            eventType: 'session.child_cleanup_completed', data: expect.objectContaining({ commandId: 'close-child', status }),
        }));
        expect(resumed.runtime.state.orchestrationResult).toBe(command === 'done' ? 'done' : command === 'delete' ? 'deleted' : 'cancelled');
    });

    it('still terminates when recording the cleanup audit fails', () => {
        const f = fixture({}, { failAudit: true });
        f.drive(beginGracefulShutdown(f.runtime, command, { type: 'cmd', cmd: command, id: 'close-child', requestedBy: 'parent' }));
        expect(f.sent).toEqual([]);
        expect(f.destroyed).toEqual(['child']);
        expect(f.runtime.state.orchestrationResult).toBe(command === 'done' ? 'done' : command === 'delete' ? 'deleted' : 'cancelled');
    });
});

it.each([
    { id: 'request', requestedBy: 'someone-else' },
    { id: 'request', requestedBy: { sessionId: 'parent' } },
    { id: '', requestedBy: 'parent' },
    { id: '   ', requestedBy: 'parent' },
])('does not suppress with invalid provenance: %j', metadata => {
    const f = fixture();
    f.drive(beginGracefulShutdown(f.runtime, 'done', { type: 'cmd', cmd: 'done', ...metadata }));
    expect(f.sent).toHaveLength(1);
});

it('keeps the substantive result in a parent digest when the child closes in the same batch', () => {
    const parent = fixture({ sessionId: 'parent', parentSessionId: undefined, subAgents: [
        { sessionId: 'child', orchId: 'session-child', task: 'audit', status: 'completed', result: 'AUDIT RESULT: found the defect' },
    ] });
    bufferChildUpdate(parent.runtime, { sessionId: 'child', updateType: 'completed', content: 'AUDIT RESULT: found the defect' }, 0);
    const child = fixture();
    child.drive(beginGracefulShutdown(child.runtime, 'done', { type: 'cmd', cmd: 'done', id: 'close-child', requestedBy: 'parent' }));
    for (const e of child.sent) bufferChildUpdate(parent.runtime, parseChildUpdate(e.prompt), 2000);
    const digest = buildPendingChildDigestSystemPrompt(parent.runtime);
    expect(digest).toContain('AUDIT RESULT: found the defect');
    expect(digest).not.toContain('Completed by parent');
    expect(parent.runtime.state.pendingChildDigest.updates).toHaveLength(1);
});

it('does not mistake a genuine child answer for cleanup', () => {
    const f = fixture({ sessionId: 'parent', parentSessionId: undefined, subAgents: [
        { sessionId: 'child', orchId: 'session-child', task: 'audit', status: 'running' },
    ] });
    bufferChildUpdate(f.runtime, parseChildUpdate('[CHILD_UPDATE from=child type=completed iter=5]\nCompleted by parent'), 0);
    expect(buildPendingChildDigestSystemPrompt(f.runtime)).toContain('Result: Completed by parent');
});

it('keeps legacy shutdown wire shape when no cleanup origin exists', () => {
    const f = fixture({ subAgents: [{ sessionId: 'grandchild', orchId: 'session-grandchild', task: 'work', status: 'running' }] });
    f.drive(beginGracefulShutdown(f.runtime, 'done', { type: 'cmd', cmd: 'done', id: 'external' }));
    expect(JSON.parse(JSON.stringify(buildContinueInput(f.runtime))).pendingShutdown).not.toHaveProperty('requestedBy');
});

it('does not reclassify an external shutdown when a parent command arrives during the drain', () => {
    const f = fixture({ subAgents: [{ sessionId: 'grandchild', orchId: 'session-grandchild', task: 'work', status: 'running' }] });
    f.drive(beginGracefulShutdown(f.runtime, 'done', { type: 'cmd', cmd: 'done', id: 'external' }));
    f.drive(beginGracefulShutdown(f.runtime, 'done', { type: 'cmd', cmd: 'done', id: 'parent-request', requestedBy: 'parent' }));
    expect(f.runtime.state.pendingShutdown.commandId).toBe('external');
    expect(f.runtime.state.pendingShutdown).not.toHaveProperty('requestedBy');
    f.drive(finalizePendingShutdown(f.runtime));
    expect(f.sent).toHaveLength(1);
});

describe.each([
    ['completed', 'done', 'AUDIT RESULT'],
    ['cancelled', 'cancelled', 'AUDIT RESULT'],
    ['completed', 'deleted', 'AUDIT RESULT'],
    ['failed', 'failed', 'AUDIT RESULT'],
    ['completed', undefined, 'AUDIT RESULT'],
    ['completed', 'NEW ANSWER', 'NEW ANSWER'],
    ['idle', 'done', 'done'],
])('child status result %s / %s', (status, result, expected) => {
    const tracked = { sessionId: 'child', orchId: 'session-child', task: 'audit', status: 'completed', result: 'AUDIT RESULT' };

    it.each([true, false])('preserves answers during discovery (preserve terminal task status: %s)', preserveTerminalTaskStatus => {
        const f = fixture({ sessionId: 'parent', parentSessionId: undefined, subAgents: [tracked] }, {
            children: [{ ...tracked, status, result }],
        });
        f.drive(refreshTrackedSubAgents(f.runtime, { preserveTerminalTaskStatus }));
        expect(f.runtime.state.subAgents[0].result).toBe(expected);
    });

    it('shows the answer in an explicit check_agents report', () => {
        const f = fixture({ sessionId: 'parent', parentSessionId: undefined, subAgents: [tracked] }, { status: { status, result } });
        f.drive(handleSubAgentAction(f.runtime, { type: 'check_agents' }));
        expect(f.runtime.state.pendingPrompt).toContain(`Output: ${expected}`);
        expect(f.runtime.state.pendingPrompt).toContain(`Status: ${status}`);
    });
});

it('retains frozen 1.0.76 notification behavior', () => {
    const f = fixture();
    f.drive(frozenShutdown(f.runtime, 'done', { type: 'cmd', cmd: 'done', id: 'close-child', requestedBy: 'parent' }));
    expect(f.sent).toHaveLength(1);
    expect(parseChildUpdate(f.sent[0].prompt)).toMatchObject({ updateType: 'completed', verdict: 'success' });
});
