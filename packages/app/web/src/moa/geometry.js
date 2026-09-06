// The same binary split tree drives desktop layout, map geometry and navigation.
export function panelRects(tree, bounds = { x: 0, y: 0, width: 1, height: 1 }) {
    if (!tree) return [];
    if (tree.type !== "split") return [{ node: tree, ...bounds }];
    const ratio = tree.ratio / 100;
    const { x, y, width, height } = bounds;
    return tree.direction === "row"
        ? [...panelRects(tree.first, { x, y, width: width * ratio, height }), ...panelRects(tree.second, { x: x + width * ratio, y, width: width * (1 - ratio), height })]
        : [...panelRects(tree.first, { x, y, width, height: height * ratio }), ...panelRects(tree.second, { x, y: y + height * ratio, width, height: height * (1 - ratio) })];
}
export function clockwisePanels(tree, aspectRatio = 16 / 9) {
    const angle = r => (Math.atan2(r.y + r.height / 2 - .5, (r.x + r.width / 2 - .5) * aspectRatio) + Math.PI * 3 / 4 + Math.PI * 2) % (Math.PI * 2);
    const rects = panelRects(tree);
    const ordered = [...rects].sort((a, b) => angle(a) - angle(b)).map(r => r.node);
    const start = ordered.findIndex(node => node.id === rects[0]?.node.id);
    return [...ordered.slice(start), ...ordered.slice(0, start)];
}
// Never steal a native control, horizontal code/table scroll, or a text selection.
export function canSwipeFrom(target, root) {
    if (target.closest?.("button,input,textarea,select,a,iframe,[contenteditable='true']")) return false;
    for (let node = target; node && node !== root; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return false;
    }
    return !window.getSelection()?.toString();
}
