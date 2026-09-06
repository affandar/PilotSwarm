import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelRects, clockwisePanels } from '../../web/src/moa/geometry.js';
import { normalizeMoa } from '../../ui/core/src/moa.js';
const leaf = id => ({ id, type: 'empty' });
const tree = { id: 'root', type: 'split', direction: 'row', ratio: 60, first: leaf('left'), second: { id: 'right', type: 'split', direction: 'column', ratio: 25, first: leaf('top'), second: leaf('bottom') } };
test('map partitions the desktop split area, including unequal nested sizes', () => {
    const rects = panelRects(tree);
    assert.deepEqual(rects.map(({ node, ...rect }) => rect), [
        { x: 0, y: 0, width: .6, height: 1 },
        { x: .6, y: 0, width: .4, height: .25 },
        { x: .6, y: .25, width: .4, height: .75 },
    ]);
    assert.equal(rects.reduce((sum, r) => sum + r.width * r.height, 0), 1);
    assert.deepEqual(clockwisePanels(tree, 2).map(n => n.id), ['left', 'top', 'bottom']);
    assert.deepEqual(panelRects(null), []);
    assert.deepEqual(clockwisePanels(null), []);
});
test('saved desktop aspect survives normalization; invalid values cannot distort the phone map', () => {
    assert.equal(normalizeMoa({ version: 2, tree, aspectRatio: 2.1 }).aspectRatio, 2.1);
    for (const value of [0, -1, Infinity, NaN, '2', 100]) assert.equal(normalizeMoa({ version: 2, tree, aspectRatio: value }).aspectRatio, undefined);
    assert.deepEqual(normalizeMoa({ version: 2, tree: null }), { version: 2, tree: null });
});
