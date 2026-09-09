import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryModel, appendEventToHistory, CHAT_HISTORY_EVENT_TYPES } from '../src/history.js';
import { createInitialState, appReducer, selectChatLines } from '../src/index.js';

const event = (seq, eventType, data = {}, sessionId = 's1') => ({ seq, eventType, data, sessionId, createdAt: new Date(1788800000000 + seq * 1000).toISOString() });
function lines(history, browser = true) {
    let state = createInitialState();
    state = appReducer(state, {type:'sessions/loaded',sessions:[{sessionId:'s1',title:'Test',status:'idle'}]});
    state = appReducer(state, {type:'sessions/selected',sessionId:'s1'});
    state = appReducer(state, {type:'history/set',sessionId:'s1',history});
    return selectChatLines(state, 40, browser ? {tableMode:'sentinel'} : {});
}

test('one disclosure follows tool/external aliases through output and completion; reload agrees with live', () => {
    const events = [
        event(1,'tool.execution_start',{toolCallId:'a',toolName:'bash',arguments:{command:'git diff\ngit status'}}),
        event(2,'external_tool.requested',{toolCallId:'a',requestId:'r',toolName:'bash'}),
        event(3,'tool.execution_partial_result',{toolCallId:'a',partialOutput:'first\n'}),
        event(4,'tool.execution_progress',{toolCallId:'a',progressMessage:'Reading'}),
        event(5,'external_tool.completed',{requestId:'r'}),
        event(6,'tool.execution_complete',{toolCallId:'a',success:true,result:{content:'finished'}}),
    ];
    const bulk = buildHistoryModel(events);
    const live = events.reduce(appendEventToHistory,buildHistoryModel());
    assert.deepEqual(live.chat,bulk.chat);
    assert.equal(bulk.chat.length,1);
    const row = lines(bulk).find(line=>line.kind==='chatCall');
    assert.equal(row.text,'bash — git diff');
    assert.equal(row.status,'Done');
    assert.match(row.body,/git status/);
    assert.match(row.body,/finished/);
    assert.doesNotMatch(row.body,/Reading|first/);
    assert.equal(lines(bulk,false).some(line=>line.kind==='chatCall'),false);
    for (const e of events) assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(e.eventType));
    assert.equal(bulk.activity.length,events.length);
});

test('same text is separate per call and durable session; replay cannot duplicate partial output', () => {
    let history=buildHistoryModel([
        event(1,'tool.execution_start',{toolCallId:'a',toolName:'wait_for_agents',arguments:{agent_ids:['child']},durableSessionId:'first'}),
        event(2,'tool.execution_start',{toolCallId:'b',toolName:'wait_for_agents',arguments:{agent_ids:['child']},durableSessionId:'first'}),
        event(3,'tool.execution_start',{toolCallId:'a',toolName:'wait_for_agents',arguments:{agent_ids:['child']},durableSessionId:'second'}),
    ]);
    const partial=event(4,'tool.execution_partial_result',{toolCallId:'a',partialOutput:'x',durableSessionId:'first'});
    history=appendEventToHistory(appendEventToHistory(history,partial),partial);
    assert.equal(history.chat.length,3);
    assert.equal(history.chat[0].partial,'x');
    assert.ok(lines(history).filter(line=>line.kind==='chatCall').every(line=>line.category==='Agent'));
});

test('orphan completions show output, late starts cannot reopen completed calls, failures remain visible', () => {
    const h=buildHistoryModel([
        event(1,'external_tool.completed',{requestId:'missing'}),
        event(2,'tool.execution_complete',{toolCallId:'a',success:false,error:{message:'Permission denied'}}),
        event(3,'tool.execution_start',{toolCallId:'a',toolName:'read_file',arguments:{path:'/repo/README'}}),
    ]);
    assert.equal(h.chat.length,1);
    const row=lines(h).find(line=>line.kind==='chatCall');
    assert.equal(row.status,'Failed');
    assert.match(row.body,/Permission denied/);
    assert.match(row.text,/read_file/);
});

test('agent tasks and cross-session requests collapse in browser with actual first line; human text stays normal', () => {
    const h=buildHistoryModel([
        event(1,'user.message',{content:'ordinary message'}),
        event(2,'user.message',{content:'Check the new design\nSecond line',sender:{kind:'agent',display:'Reviewer'}}),
        event(3,'system.message',{content:'[SESSION_MESSAGE request_id=r from=other subject=Review expects_response=true]\nRequest body:\nInspect the diff\nThen report.'}),
        event(4,'session.agent_spawned',{childSessionId:'child',task:'Review the schema\nLook for races'}),
    ]);
    const rows=lines(h).filter(line=>line.kind==='chatCall');
    assert.equal(rows.length,3);
    assert.match(rows[0].text,/Reviewer — Check the new design$/);
    assert.match(rows[1].text,/Session Request — Inspect the diff$/);
    assert.match(rows[2].text,/Agent started — Review the schema$/);
    assert.match(rows[0].body,/Second line/);
    assert.equal(lines(h,false).some(line=>line.kind==='chatCall'),false);
});

test('identical acknowledgements from different agents remain separate calls', () => {
    const h=buildHistoryModel([
        event(1,'user.message',{content:'Done',sender:{kind:'agent',sessionId:'reviewer'}}),
        event(2,'user.message',{content:'Done',sender:{kind:'agent',sessionId:'builder'}}),
        event(3,'user.message',{content:'Done',sender:{kind:'agent',sessionId:'builder'}}),
    ]);
    assert.equal(h.chat.length,3);
    assert.equal(lines(h).filter(line=>line.kind==='chatCall').length,3);
});
