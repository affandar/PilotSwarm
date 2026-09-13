import test from 'node:test';
import assert from 'node:assert/strict';
import { appReducer, createInitialState, selectSessionRows } from '../src/index.js';
const apply = (state, type, rest = {}) => appReducer(state, { type, ...rest });
const sessions = [
    { sessionId: 'a', title: 'session a', updatedAt: 100, createdAt: 1 },
    { sessionId: 'b', title: 'session b', updatedAt: 300, createdAt: 2 },
    { sessionId: 'c', title: 'session c', updatedAt: 200, createdAt: 3 },
];
const fixture = () => apply(apply(createInitialState(), 'profileSettings/apply', { settings: { sessionOrder: ['c','a','b'] } }), 'sessions/loaded', { sessions });
const ids = s => s.sessions.flat.map(r => r.sessionId);
test('updated order is frozen across updates, refresh applies it, and saved restores placement', () => {
    let s = fixture();
    assert.deepEqual(ids(s), ['c','a','b']);
    s = apply(s, 'sessions/sortMode', { mode: 'updated' });
    assert.deepEqual(ids(s), ['b','c','a']);
    s = apply(s, 'sessions/merged', { session: { ...sessions[0], updatedAt: 900 } });
    assert.deepEqual(ids(s), ['b','c','a']);
    s = apply(s, 'sessions/loaded', { sessions: [{ ...sessions[0], updatedAt: 900 }, ...sessions.slice(1)] });
    assert.deepEqual(ids(s), ['b','c','a']);
    s = apply(s, 'sessions/refreshSort');
    assert.deepEqual(ids(s), ['a','b','c']);
    s = apply(s, 'sessions/sortMode', { mode: 'saved' });
    assert.deepEqual(ids(s), ['c','a','b']);
    assert.deepEqual(s.sessions.manualOrder, ['c','a','b']);
});
test('usage and profile updates wait for refresh and preserve newer local usage', () => {
    let s = apply(fixture(), 'profileSettings/apply', { settings: { sessionSortMode: 'used', sessionUsedAt: { a: 500, b: 100 } } });
    assert.deepEqual(ids(s), ['a','b','c']);
    s = apply(s, 'sessions/used', { sessionId: 'c', at: 900 });
    s = apply(s, 'profileSettings/apply', { settings: { sessionUsedAt: { c: 50 } } });
    assert.equal(s.sessions.usedAt.c, 900);
    assert.deepEqual(ids(s), ['a','b','c']);
    s = apply(s, 'sessions/refreshSort');
    assert.deepEqual(ids(s), ['c','a','b']);
    s = apply(s, 'sessions/selected', { sessionId: 'b' });
    assert.deepEqual(ids(s), ['c','a','b']);
    assert.ok(s.sessions.usedAt.b > 900);
});
test('new rows append without disturbing a snapshot and search honors it', () => {
    let s = apply(fixture(), 'sessions/sortMode', { mode: 'updated' });
    s = apply(s, 'sessions/merged', { session: { sessionId: 'd', title: 'session d', updatedAt: 999 } });
    assert.deepEqual(ids(s), ['b','c','a','d']);
    s = apply(s, 'sessions/filterQuery', { query: 'session' });
    // Use the same synthetic state shape as the popup list.
    s = { ...s, sessions: { ...s.sessions, filterQuery: 'session' } };
    assert.deepEqual(selectSessionRows(s).map(r => r.sessionId), ['b','c','a','d']);
});
test('pinned sections, folders and child hierarchy survive recency sorting', () => {
    let s = apply(createInitialState(), 'sessions/loaded', { sessions: [
        ...sessions, { sessionId: 'child', title: 'child', parentSessionId: 'a', updatedAt: 9999 },
        { sessionId: 'group:g', title: 'Folder', isGroup: true },
        { sessionId: 'inside', title: 'inside', groupId: 'g', updatedAt: 8888 },
    ] });
    s = apply(s, 'profileSettings/apply', { settings: { pinnedSessionIds: ['c'], collapsedSessionIds: [] } });
    s = apply(s, 'sessions/sortMode', { mode: 'updated' });
    const rows = s.sessions.flat;
    assert.equal(rows[0].sessionId, 'c');
    assert.equal(rows.find(r => r.sessionId === 'child').depth, rows.find(r => r.sessionId === 'a').depth + 1);
    assert.equal(rows.find(r => r.sessionId === 'inside').depth, rows.find(r => r.sessionId === 'group:g').depth + 1);
});
test('restored recency mode waits for the first session catalog after groups load', () => {
    let s = apply(createInitialState(), 'profileSettings/apply', { settings: { sessionSortMode: 'updated' } });
    s = apply(s, 'sessions/groupsLoaded', { groups: [{ sessionId: 'group:g', isGroup: true, title: 'Folder' }] });
    assert.deepEqual(s.sessions.sortSnapshot, []);
    s = apply(s, 'sessions/loaded', { sessions });
    assert.deepEqual(ids(s).filter(id => !id.startsWith('group:')), ['b','c','a']);
});
