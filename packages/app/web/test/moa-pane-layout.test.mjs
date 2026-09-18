import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneDrop, paneExtension, paneLayout, dropEdge, emptySessionPanes } from '../src/moa/pane-layout.js';
import { moaLeaves, normalizeMoaLayout } from '../../ui/core/src/moa.js';
import { panelRects } from '../src/moa/geometry.js';
const leaf = id => ({ id, type: 'chat', sessionId: `session-${id}` });
const split = (id, direction, first, second, ratio = 50) => ({ id, type: 'split', direction, ratio, first, second });
const example = split('root', 'row', leaf('super'), split('right', 'column', leaf('paw'), split('bottom', 'row', leaf('b'), leaf('c'), 40), 60), 30);
const rect = (tree, id) => { const { node, ...box } = panelRects(tree).find(p => p.node.id === id); return box; };
const nearly = (a, b) => assert.ok(Math.abs(a-b) < 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);

test('centre swap exchanges only the two panes and leaves source data immutable', () => {
    const before = structuredClone(example);
    const result = paneDrop(example, 'b', 'paw');
    assert.equal(result.kind, 'swap');
    assert.deepEqual(rect(result.tree, 'b'), rect(example, 'paw'));
    assert.deepEqual(rect(result.tree, 'paw'), rect(example, 'b'));
    assert.deepEqual(rect(result.tree, 'super'), rect(example, 'super'));
    assert.deepEqual(rect(result.tree, 'c'), rect(example, 'c'));
    assert.deepEqual(example, before);
});

test('example extends B upward, keeps Superagent untouched, and aligns PAW above C', () => {
    const result = paneDrop(example, 'b', 'paw', 'extend');
    assert.equal(result.kind, 'extend'); assert.equal(result.label, 'Extend upward');
    const b = rect(result.tree, 'b'), paw = rect(result.tree, 'paw'), c = rect(result.tree, 'c');
    nearly(b.height, 1); nearly(b.width, rect(example, 'b').width);
    nearly(paw.x, c.x); nearly(paw.width, c.width); nearly(paw.height, .6);
    assert.deepEqual(rect(result.tree, 'super'), rect(example, 'super'));
    assert.deepEqual(normalizeMoaLayout({ tree: result.tree }).tree, result.tree);
});

test('all four T-junction orientations rotate on either side with unequal ratios', () => {
    for (const outer of ['row', 'column']) for (const parentFirst of [true, false]) for (const sourceFirst of [true, false]) {
        const parent = split('parent', outer === 'row' ? 'column' : 'row', sourceFirst ? leaf('a') : leaf('b'), sourceFirst ? leaf('b') : leaf('a'), 37);
        const tree = split('outer', outer, parentFirst ? parent : leaf('c'), parentFirst ? leaf('c') : parent, 63);
        const ext = paneExtension(tree, 'a', 'c');
        assert.ok(ext); assert.equal(paneDrop(tree, 'a', 'c', 'extend').kind, 'extend');
        assert.equal(paneDrop(tree, 'a', 'c', ext.edge).kind, 'move');
        const a = rect(ext.tree, 'a');
        nearly(outer === 'row' ? a.width : a.height, 1);
        nearly(outer === 'row' ? a.height : a.width, sourceFirst ? .37 : .63);
        assert.deepEqual(normalizeMoaLayout({ tree: ext.tree }).tree, ext.tree);
        assert.deepEqual(moaLeaves(ext.tree).map(n => n.id).sort(), ['a','b','c']);
    }
});

test('deep moves preserve every pane once, IDs, bindings and the persisted schema', () => {
    // Exhaust every legal move across a full 16-pane dashboard, including
    // nested subtrees, siblings, empty panes and two canvases of one session.
    let i = 0;
    const make = depth => depth === 0 ? { id: `p${i++}`, type: 'empty' } : split(`s${depth}-${i}`, depth % 2 ? 'row' : 'column', make(depth-1), make(depth-1), 35 + depth*7);
    const tree = make(4);
    tree.first.first.first.first = { id: 'p0', type: 'canvas', sessionId: 'same-session', slot: 1 };
    tree.first.first.first.second = { id: 'p1', type: 'canvas', sessionId: 'same-session', slot: 2 };
    const original = structuredClone(tree), leaves = moaLeaves(tree);
    for (const source of leaves) for (const target of leaves) for (const edge of ['center','left','right','top','bottom','extend']) {
        const result = paneDrop(tree, source.id, target.id, edge);
        if (source.id === target.id) { assert.equal(result, null); continue; }
        if (!result) continue;
        assert.deepEqual(moaLeaves(result.tree).sort((a,b) => a.id.localeCompare(b.id)), [...leaves].sort((a,b) => a.id.localeCompare(b.id)));
        assert.deepEqual(normalizeMoaLayout({ tree: result.tree }).tree, result.tree);
    }
    assert.deepEqual(tree, original);
});

test('all ordinary sides split the target equally even when extension is available', () => {
    for (const edge of ['left','right','top','bottom']) {
        const result = paneDrop(example, 'b', 'paw', edge);
        assert.equal(result.kind, 'move');
        const b = rect(result.tree, 'b'), paw = rect(result.tree, 'paw'), old = rect(example, 'paw');
        const row = edge === 'left' || edge === 'right';
        nearly(b.width, old.width / (row ? 2 : 1));
        nearly(b.height, old.height / (row ? 1 : 2));
        nearly(paw.width, b.width); nearly(paw.height, b.height);
        if (edge === 'left') nearly(b.x + b.width, paw.x);
        if (edge === 'right') nearly(paw.x + paw.width, b.x);
        if (edge === 'top') nearly(b.y + b.height, paw.y);
        if (edge === 'bottom') nearly(paw.y + paw.height, b.y);
        assert.deepEqual(rect(result.tree, 'super'), rect(example, 'super'));
    }
    assert.equal(paneDrop(example, 'super', 'paw', 'extend'), null);
});

test('unknown IDs, self drops, split targets and invalid edges are harmless', () => {
    for (const [a,b,e] of [['missing','b','center'],['b','b','center'],['root','b','left'],['b','right','top'],['b','paw','garbage']]) assert.equal(paneDrop(example,a,b,e),null);
    assert.equal(paneDrop(null, 'a', 'b'), null);
});

test('flat geometry exactly partitions nested space with fixed-width dividers', () => {
    const { panels, dividers } = paneLayout(example);
    for (const [width, height] of [[1600,900],[400,300],[2600,1400]]) {
        const boxes = [...panels, ...dividers].map(({box}) => Object.fromEntries(Object.entries(box).map(([key,[f,p]]) => [key,f*(['x','width'].includes(key) ? width : height)+p])));
        nearly(boxes.reduce((sum,b) => sum+b.width*b.height,0),width*height);
        for (const a of boxes) for (const b of boxes) if (a !== b) assert.ok(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x) < 1e-8 || Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y) < 1e-8);
        for (const {node,box} of dividers) assert.deepEqual(box[node.direction === 'row' ? 'width' : 'height'],[0,8]);
    }
});

test('edge zones have a generous centre and reject off-panel drops', () => {
    assert.equal(dropEdge(50,50,100,100),'center');
    for (const [x,y,edge] of [[1,50,'left'],[99,50,'right'],[50,1,'top'],[50,99,'bottom']]) assert.equal(dropEdge(x,y,100,100),edge);
    for (const [x,y,w,h] of [[-1,20,100,100],[20,101,100,100],[0,0,0,10]]) assert.equal(dropEdge(x,y,w,h),null);
});

test('session removal clears all matching bindings and preserves layout geometry and unrelated state', () => {
    const shared = {id:'canvas',type:'canvas',sessionId:'session-b',slot:3};
    const value = { activeDashboardId:'one', composerMode:'shared', dashboards:[
        {id:'one',name:'One',focusedPanelId:'b',tree:example},
        {id:'two',name:'Two',focusedPanelId:'canvas',tree:shared},
        {id:'three',tree:leaf('other')},
    ]};
    const before = structuredClone(value);
    const result = emptySessionPanes(value, ['session-b']);
    assert.deepEqual(value, before);
    assert.deepEqual(moaLeaves(result.dashboards[0].tree).find(n=>n.id==='b'), {id:'b',type:'empty'});
    assert.deepEqual(result.dashboards[1].tree, {id:'canvas',type:'empty'});
    assert.equal(result.dashboards[2], value.dashboards[2]);
    assert.deepEqual(rect(result.dashboards[0].tree,'b'), rect(example,'b'));
    assert.equal(result.dashboards[0].focusedPanelId,'b');
    assert.equal(result.activeDashboardId,'one');
    assert.equal(result.composerMode,'shared');
    assert.equal(emptySessionPanes(result,['session-b']),result);
    assert.equal(emptySessionPanes(value,[]),value);
    assert.equal(emptySessionPanes(value,['unknown-session']),value);
});
