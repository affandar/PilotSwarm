import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../react/src/web-app.js',import.meta.url),'utf8');
const start=source.indexOf('        const pollProfileSettings = async () => {');
const end=source.indexOf('\n\n        pollProfileSettings().catch',start);
function setup() {
 let resolve; let state={activeSessionId:'a',ui:{},admin:{profile:{}}}; const applied=[];
 const ref=current=>({current});
 const c={active:true,transport:{getCurrentUserProfile:()=>new Promise(r=>resolve=r)},controller:{getState:()=>state,dispatch:a=>applied.push(a)},normalizeProfileSettings:x=>x,otherTouchScaleKey:()=> 'mobile',buildDefaultProfileSettingsFromState:()=>({}),materializeProfileSettings:x=>x,profileSettingsFromViewState:x=>({activeSessionId:x.activeSessionId}),profileViewState:x=>x,
 profileSettingsPollInFlightRef:ref(false),otherTouchScaleRef:ref(false),desktopRightPaneModeRef:ref(null),desktopPanesRef:ref(null),defaultProfileSettingsRef:ref({}),profileSettingsHydratedRef:ref(true),lastProfileSettingsJsonRef:ref(JSON.stringify({activeSessionId:'a'})),appliedProfileSettingsJsonRef:ref(JSON.stringify({activeSessionId:'x'})),profileSettingsSaveTimerRef:ref(null),profileSettingsSaveInFlightRef:ref(0),profileSettingsEditRevisionRef:ref(0)};
 vm.createContext(c);vm.runInContext(source.slice(start,end)+'\nglobalThis.poll=pollProfileSettings;',c);
 return {c,applied,reply:()=>resolve({profileSettings:{activeSessionId:'a'}}),selectB:()=>{state={...state,activeSessionId:'b'};c.profileSettingsEditRevisionRef.current++;c.lastProfileSettingsJsonRef.current=JSON.stringify({activeSessionId:'b'});}};
}
test('delayed profile read is discarded even after newer local save completes',async()=>{
 const t=setup();const p=t.c.poll();t.selectB();t.reply();await p;assert.deepEqual(t.applied,[]);
});
test('profile cannot apply while a queued save remains outstanding',async()=>{
 const t=setup();t.c.profileSettingsSaveInFlightRef.current=2;const p=t.c.poll();t.c.profileSettingsSaveInFlightRef.current--;t.reply();await p;assert.deepEqual(t.applied,[]);
});
test('uncontended remote profile still applies',async()=>{
 const t=setup();const p=t.c.poll();t.reply();await p;assert.equal(t.applied[0].type,'profileSettings/apply');
});
