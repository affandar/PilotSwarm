import test from 'node:test';
import assert from 'node:assert/strict';
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectActiveChat } from '../src/index.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
function setup(extra = {}) {
 const store = createStore(appReducer, createInitialState());
 const sessions = ['a','b'].map(sessionId => ({sessionId, title:sessionId, status:'idle'}));
 const attached = [];
 const transport = {listSessions:async()=>sessions, getSession:async id=>sessions.find(s=>s.sessionId===id), getSessionEvents:async()=>[], subscribeSession:id=>{attached.push(id); return ()=>{};}, ...extra};
 const controller = new PilotSwarmUiController({store,transport});
 store.dispatch({type:'sessions/loaded',sessions});
 return {store,controller,attached};
}
test('profile restores at boot, but never navigates after explicit selection',()=>{
 const {store} = setup();
 store.dispatch({type:'profileSettings/apply',settings:{activeSessionId:'a'}});
 assert.equal(store.getState().sessions.activeSessionId,'a');
 store.dispatch({type:'sessions/selected',sessionId:'b'});
 store.dispatch({type:'profileSettings/apply',settings:{activeSessionId:'a'}});
 assert.equal(store.getState().sessions.activeSessionId,'b');
});
test('slow forced history reads are coalesced, and failures allow retry',async()=>{
 const gate = deferred(); let calls=0;
 const {controller} = setup({getSessionEvents:()=>{calls++;return gate.promise;}});
 const one=controller.ensureSessionHistory('a',{force:true});
 const two=controller.ensureSessionHistory('a',{force:true});
 assert.equal(calls,1); gate.resolve([]); await Promise.all([one,two]);
 await controller.ensureSessionHistory('a',{force:true}); assert.equal(calls,2);
 let fail=true;
 controller.transport.getSessionEvents=async()=>{if(fail)throw Error('offline');return [];};
 await assert.rejects(controller.ensureSessionHistory('b',{force:true}),/offline/);
 fail=false; await controller.ensureSessionHistory('b',{force:true});
});
test('history and detail start together; stale A completion cannot attach over B',async()=>{
 const gate=deferred(); const reads=[];
 const {controller,attached}=setup({getSessionEvents:async id=>{reads.push('history:'+id);return id==='a'?gate.promise:[];},getSession:async id=>{reads.push('detail:'+id);return {sessionId:id};}});
 const a=controller.loadSession('a');
 assert.deepEqual(reads.slice(0,2),['history:a','detail:a']);
 await controller.loadSession('b');
 gate.resolve([]);await a;
 assert.deepEqual(attached,['b']);controller.detachActiveSession();
});
test('background refresh cannot reattach A after B selection during history fetch',async()=>{
 const gate=deferred();const entered=deferred();
 const {controller,store,attached}=setup({getSessionEvents:async id=>{if(id==='a'){entered.resolve();return gate.promise;}return [];}});
 store.dispatch({type:'sessions/selected',sessionId:'a'});
 const refresh=controller.refreshSessions();await entered.promise;
 await controller.loadSession('b');gate.resolve([]);await refresh;
 assert.equal(store.getState().sessions.activeSessionId,'b');
 assert.deepEqual(attached,['b']);controller.detachActiveSession();
});
test('A to B to A attaches only the latest visit to A',async()=>{
 const a=deferred(), b=deferred();
 const {controller,attached}=setup({getSessionEvents:async id=>(id==='a'?a:b).promise});
 const first=controller.loadSession('a'); const middle=controller.loadSession('b'); const last=controller.loadSession('a');
 a.resolve([]);await Promise.all([first,last]);b.resolve([]);await middle;
 assert.deepEqual(attached,['a']);controller.detachActiveSession();
});
test('periodic catalog ticks do not queue behind an unfinished poll',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const {controller}=setup({start:async()=>{}});const gate=deferred();let calls=0;
 controller.refreshSessions=async()=>{if(++calls>1)await gate.promise;};
 await controller.start();
 t.mock.timers.tick(4000);t.mock.timers.tick(12000);
 assert.equal(calls,2);gate.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 t.mock.timers.tick(4000);assert.equal(calls,3);
});
test('folder and session catalogs start concurrently',async()=>{
 const gate=deferred();let foldersStarted=false;
 const {controller}=setup({listSessions:()=>gate.promise,listSessionGroups:async()=>{foldersStarted=true;return [];}});
 const pending=controller.refreshSessions();await Promise.resolve();assert(foldersStarted);
 gate.resolve([]);await pending;
});

test('a loading history without splash has loading copy; failure has retry copy',async()=>{
 const gate=deferred();const {controller,store}=setup({getSessionEvents:()=>gate.promise});
 store.dispatch({type:'sessions/selected',sessionId:'a'});
 const pending=controller.ensureSessionHistory('a',{force:true});
 assert.match(selectActiveChat(store.getState())[0].text,/Loading conversation/);
 gate.resolve([]);await pending;
 assert(!selectActiveChat(store.getState()).some(m=>/Loading conversation/.test(m.text)));
 controller.transport.getSessionEvents=async()=>{throw Error('offline');};
 await assert.rejects(controller.ensureSessionHistory('a',{force:true}));
 assert.match(selectActiveChat(store.getState())[0].text,/again to retry/);
});

for (const sessionSplash of [false, true]) {
 test(`loading preserves ${sessionSplash ? 'session' : 'branding'} splash variants with a loading footer`,()=>{
  const state=createInitialState();
  state.branding={title:'Portal',splash:'DEFAULT ART',splashMobile:'MOBILE DEFAULT ART'};
  state.sessions.activeSessionId='a';
  state.sessions.byId.a={sessionId:'a',title:'Agent',...(sessionSplash?{splash:'AGENT ART',splashMobile:'MOBILE AGENT ART'}:{})};
  const history={chat:[],events:[],loadState:'loading'};
  state.history.bySessionId.set('a',history);
  const [card]=selectActiveChat(state);
  assert.equal(card.splash,true);
  assert.match(card.text,new RegExp(`^${sessionSplash?'AGENT':'DEFAULT'} ART`));
  assert.match(card.mobileText,new RegExp(`^MOBILE ${sessionSplash?'AGENT':'DEFAULT'} ART`));
  for(const text of [card.text,card.mobileText]) {
   assert.match(text,/Loading conversation…\{\/gray-fg\}$/);
   assert.doesNotMatch(text,/Start interacting/);
  }
  history.loadState='loaded';
  assert.match(selectActiveChat(state)[0].text,/Start interacting/);
  assert.doesNotMatch(selectActiveChat(state)[0].text,/Loading conversation/);
  history.chat=[{id:'reply',role:'assistant',text:'Cached conversation'}];
  history.loadState='loading';
  assert.equal(selectActiveChat(state)[0].text,'Cached conversation');
 });
}
