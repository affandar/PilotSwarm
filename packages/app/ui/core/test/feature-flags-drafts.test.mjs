import test from 'node:test';
import assert from 'node:assert/strict';
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from '../src/index.js';

const KEY='copilot.native_tasks';
const ADMIN={provider:'test',subject:'admin',isAdmin:true};
const flag=(revision='1',extra={})=>({featureKey:KEY,revision,displayName:'Native tasks',description:'Local delegation',
    defaultEnabled:false,defaultAllowUserOverride:false,cluster:{enabled:false,allowUserOverride:true},user:{enabled:false},
    effective:false,source:'user',supported:true,...extra});
const data=(revision='1',extra={})=>({flags:[flag(revision,extra)]});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
function setup(overrides={}) {
 const store=createStore(appReducer,createInitialState({mode:'remote'}));
 store.dispatch({type:'admin/profile/loaded',profile:ADMIN});
 const transport={listSessions:async()=>[],subscribeSession:()=>()=>{},getMyFeatureFlags:async()=>data(),
  getClusterFeatureFlags:async()=>data('1',{user:null,source:'cluster'}),getUserFeatureFlags:async()=>data(),
  listFeatureFlagUsers:async()=>[],listWorkers:async()=>[],...overrides};
 const controller=new PilotSwarmUiController({store,transport});
 return {controller,store,transport,features:()=>store.getState().admin.features};
}

test('editing is local; drafts persist across scopes and selected users and save only the selected target',async()=>{
 const writes=[];
 const h=setup({setUserFeatureFlag:async(userId,input)=>writes.push({userId,input})});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});
 await h.controller.selectFeatureScope('cluster');h.controller.setFeatureDraft(KEY,{enabled:true,allowUserOverride:false});
 await h.controller.selectFeatureScope('users',7);h.controller.setFeatureDraft(KEY,{enabled:true});
 await h.controller.selectFeatureScope('users',8);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
 h.controller.setFeatureDraft(KEY,null);
 assert.equal(writes.length,0);assert.equal(h.controller.getFeatureDraftCount('users'),2);
 await h.controller.selectFeatureScope('users',7);assert.equal(h.controller.getFeatureDraft(KEY).values.enabled,true);
 await h.controller.saveFeatureDraft(KEY);assert.equal(writes.length,1);assert.equal(writes[0].userId,7);
 assert.equal(h.controller.getFeatureDraft(KEY),undefined);assert.equal(h.controller.getFeatureDraftCount('users'),1);
 await h.controller.selectFeatureScope('mine');assert.equal(h.controller.getFeatureDraft(KEY).values.enabled,true);
 await h.controller.discardFeatureDraft(KEY);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
 assert.equal(h.controller.getFeatureDraftCount('cluster'),1);
});

test('background refresh preserves draft and requires explicit review of a new revision',async()=>{
 let revision='1';const writes=[];
 const h=setup({getMyFeatureFlags:async()=>data(revision),setMyFeatureFlag:async input=>writes.push(input)});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});
 revision='2';await h.controller.refreshFeatureFlags({background:true});
 assert.equal(h.features().data.flags[0].revision,'2');assert.equal(h.controller.getFeatureDraft(KEY).expectedRevision,'1');
 await h.controller.saveFeatureDraft(KEY);assert.equal(writes.length,0);assert.match(h.features().error,/Review the latest/);
 h.controller.reviewFeatureDraft(KEY);await h.controller.saveFeatureDraft(KEY);
 assert.equal(writes[0].expectedRevision,'2');assert.equal(h.controller.getFeatureDraft(KEY),undefined);
});

test('conflicting save plus failed reload blocks retry until latest settings are fetched and reviewed',async()=>{
 let failRead=false,revision='1';const writes=[];
 const h=setup({getMyFeatureFlags:async()=>{if(failRead)throw new Error('read unavailable');return data(revision)},
  setMyFeatureFlag:async input=>{writes.push(input);if(writes.length===1){revision='2';failRead=true;throw Object.assign(new Error('conflict'),{status:409})}}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 assert.equal(h.controller.getFeatureDraft(KEY).needsReview,true);assert.match(h.features().error,/could not be loaded/);
 h.controller.reviewFeatureDraft(KEY);await h.controller.saveFeatureDraft(KEY);assert.equal(writes.length,1);
 // Editing cannot clear the required review or permit another stale write.
 h.controller.setFeatureDraft(KEY,{enabled:false});assert.equal(h.controller.getFeatureDraft(KEY).needsReview,true);
 failRead=false;await h.controller.refreshFeatureFlags();h.controller.reviewFeatureDraft(KEY);
 await h.controller.saveFeatureDraft(KEY);assert.equal(writes.length,2);assert.equal(writes[1].expectedRevision,'2');assert.equal(writes[1].enabled,false);
});

test('lost save response retains a compensating choice equal to stale cached state',async()=>{
 let server=false,revision='1';const writes=[];
 const h=setup({getMyFeatureFlags:async()=>data(revision,{user:{enabled:server},effective:server}),
  setMyFeatureFlag:async input=>{
   writes.push(input);
   if(input.expectedRevision!==revision)throw Object.assign(new Error('conflict'),{status:409});
   server=input.enabled;revision=String(Number(revision)+1);
   if(writes.length===1)throw new Error('response lost');
   return {revision,setting:{enabled:server}};
  }});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 assert.equal(server,true);assert.equal(h.features().data.flags[0].effective,false);assert.equal(h.controller.getFeatureDraft(KEY).uncertain,true);
 h.controller.setFeatureDraft(KEY,{enabled:false});assert.equal(h.controller.getFeatureDraft(KEY).values.enabled,false);
 await h.controller.saveFeatureDraft(KEY);assert.equal(h.controller.getFeatureDraft(KEY).needsReview,true);
 assert.equal(h.features().data.flags[0].effective,true);
 h.controller.reviewFeatureDraft(KEY);await h.controller.saveFeatureDraft(KEY);
 assert.equal(server,false);assert.equal(h.features().data.flags[0].effective,false);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
});

test('discard after a lost response reconciles the saved result and preserves draft if that read fails',async()=>{
 let failRead=false,server=false;
 const h=setup({getMyFeatureFlags:async()=>{if(failRead)throw new Error('offline');return data(server?'2':'1',{user:{enabled:server},effective:server})},
  setMyFeatureFlag:async()=>{server=true;throw new Error('response lost')}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 failRead=true;await h.controller.discardFeatureDraft(KEY);assert.ok(h.controller.getFeatureDraft(KEY));
 failRead=false;await h.controller.discardFeatureDraft(KEY);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
 assert.equal(h.features().data.flags[0].effective,true);
});

test('discard cannot clear uncertainty while a timed-out write could still commit',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=deferred();let server=false,revision='1';
 const h=setup({getMyFeatureFlags:async()=>data(revision,{user:{enabled:server},effective:server}),
  setMyFeatureFlag:async()=>{await pending.promise;server=true;revision='2';return {revision,setting:{enabled:true}}}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});
 const saving=h.controller.saveFeatureDraft(KEY);await new Promise(resolve=>setImmediate(resolve));
 t.mock.timers.tick(10_000);await saving;
 await h.controller.discardFeatureDraft(KEY);assert.ok(h.controller.getFeatureDraft(KEY));assert.match(h.features().error,/still unconfirmed/);
 pending.resolve();await new Promise(resolve=>setImmediate(resolve));
 await h.controller.discardFeatureDraft(KEY);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
 assert.equal(h.features().data.flags[0].effective,true);
});

test('discard reconciliation cannot remove a newer edit in the same scope',async()=>{
 const read=deferred();let reads=0;
 const h=setup({getMyFeatureFlags:async()=>++reads===1?data():read.promise,
  setMyFeatureFlag:async()=>{throw new Error('response lost')}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 const discarding=h.controller.discardFeatureDraft(KEY);
 h.controller.setFeatureDraft(KEY,{enabled:false});
 read.resolve(data('2',{user:{enabled:true},effective:true}));await discarding;
 assert.equal(h.controller.getFeatureDraft(KEY).values.enabled,false);
});

test('uncertain identical retry retains request identity even after another scope was saved',async()=>{
 const calls=[];let revision='1';
 const h=setup({getMyFeatureFlags:async()=>data(revision),setMyFeatureFlag:async input=>{calls.push(input);if(calls.length===1)throw new Error('offline')},
  setClusterFeatureFlag:async()=>{}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 await h.controller.selectFeatureScope('cluster');h.controller.setFeatureDraft(KEY,{enabled:true,allowUserOverride:true});await h.controller.saveFeatureDraft(KEY);
 await h.controller.selectFeatureScope('mine');await h.controller.saveFeatureDraft(KEY);
 assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);
});

test('reset stages DELETE even when explicit cluster values already equal code defaults',async()=>{
 let cluster={enabled:false,allowUserOverride:false};const calls=[];
 const h=setup({getClusterFeatureFlags:async()=>data('1',{cluster,user:null}),resetClusterFeatureFlag:async input=>{calls.push(input);cluster=null}});
 await h.controller.selectFeatureScope('cluster');h.controller.setFeatureDraft(KEY,null);
 assert.equal(h.controller.getFeatureDraft(KEY).values,null);assert.equal(calls.length,0);
 await h.controller.saveFeatureDraft(KEY);assert.equal(calls.length,1);assert.equal('enabled' in calls[0],false);
 assert.equal(h.features().data.flags[0].cluster,null);
 h.controller.setFeatureDraft(KEY,null);assert.equal(h.controller.getFeatureDraft(KEY),undefined);
});

test('acknowledged save updates saved summary even when the subsequent read fails',async()=>{
 let failRead=false;
 const h=setup({getMyFeatureFlags:async()=>{if(failRead)throw new Error('reload unavailable');return data()},
  setMyFeatureFlag:async()=>{failRead=true;return {revision:'2',setting:{enabled:true}}}});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});await h.controller.saveFeatureDraft(KEY);
 assert.equal(h.features().data.flags[0].effective,true);assert.equal(h.features().data.flags[0].revision,'2');
 assert.equal(h.controller.getFeatureDraft(KEY),undefined);assert.match(h.features().error,/reload unavailable/);assert.equal(h.features().notice,'Setting saved.');
});

test('identity change clears every draft and late save cannot remove the new identity draft',async()=>{
 const pending=deferred();
 const h=setup({setMyFeatureFlag:()=>pending.promise});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});const saving=h.controller.saveFeatureDraft(KEY);
 h.store.dispatch({type:'admin/profile/loaded',profile:{...ADMIN,subject:'different'}});
 assert.deepEqual(h.features().drafts,{});
 await h.controller.refreshFeatureFlags();h.controller.setFeatureDraft(KEY,{enabled:true});
 pending.resolve({revision:'2',setting:{enabled:true}});await saving;
 assert.ok(h.controller.getFeatureDraft(KEY));assert.equal(h.features().data.flags[0].effective,false);
});
