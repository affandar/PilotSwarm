import { moaLeaves, replaceMoaNode } from "../../../ui/core/src/moa.js";

const edges = ["left", "right", "top", "bottom"];
const directions = { left: "row", right: "row", top: "column", bottom: "column" };
const leading = edge => edge === "left" || edge === "top";

function pathTo(tree, id) {
    if (!tree) return null;
    if (tree.id === id) return [tree];
    if (tree.type !== "split") return null;
    const child = pathTo(tree.first, id) || pathTo(tree.second, id);
    return child ? [tree, ...child] : null;
}

// Rotate the T-junction above a pane. The enclosing split and its untouched
// siblings retain their sizes; no sessions or empty panes are discarded.
export function paneExtension(tree, sourceId, targetId) {
    const path = pathTo(tree, sourceId);
    if (!path || path.length < 3) return null;
    const source = path.at(-1), parent = path.at(-2), grand = path.at(-3);
    if (source.type === "split" || parent.direction === grand.direction) return null;
    const neighbour = grand.first.id === parent.id ? grand.second : grand.first;
    if (!moaLeaves(neighbour).some(node => node.id === targetId)) return null;
    const sourceFirst = parent.first.id === sourceId;
    const sibling = sourceFirst ? parent.second : parent.first;
    const remaining = { ...grand, first: grand.first.id === parent.id ? sibling : grand.first,
        second: grand.second.id === parent.id ? sibling : grand.second };
    const rotated = { ...parent, first: sourceFirst ? source : remaining, second: sourceFirst ? remaining : source };
    const edge = parent.direction === "row" ? (sourceFirst ? "left" : "right") : (sourceFirst ? "top" : "bottom");
    const toward = grand.direction === "column" ? (grand.first.id === parent.id ? "downward" : "upward") : (grand.first.id === parent.id ? "right" : "left");
    return { edge, label: `Extend ${toward}`, tree: replaceMoaNode(tree, grand.id, rotated) };
}

export function paneDrop(tree, sourceId, targetId, edge = "center") {
    const sourcePath = pathTo(tree, sourceId), targetPath = pathTo(tree, targetId);
    const source = sourcePath?.at(-1), target = targetPath?.at(-1);
    if (!source || !target || sourceId === targetId || source.type === "split" || target.type === "split") return null;
    if (edge === "center") {
        const swap = node => node.id === sourceId ? target : node.id === targetId ? source : node.type === "split"
            ? { ...node, first: swap(node.first), second: swap(node.second) } : node;
        return { kind: "swap", label: "Swap panes", tree: swap(tree) };
    }
    if (edge === "extend") {
        const extension = paneExtension(tree, sourceId, targetId);
        return extension ? { ...extension, kind: "extend" } : null;
    }
    if (!edges.includes(edge)) return null;
    // Removal frees the source's parent ID. Reuse it for the new split, keeping
    // previews deterministic and the persisted tree within the same node limit.
    const parent = sourcePath.at(-2);
    const withoutSource = replaceMoaNode(tree, sourceId, null);
    const next = { id: parent.id, type: "split", direction: directions[edge], ratio: 50,
        first: leading(edge) ? source : target, second: leading(edge) ? target : source };
    const result = replaceMoaNode(withoutSource, targetId, next);
    if (JSON.stringify(result) === JSON.stringify(tree)) return null;
    return { kind: "move", label: { left: "Split left half", right: "Split right half", top: "Split top half", bottom: "Split bottom half" }[edge], tree: result };
}

// Pixel-independent geometry, including the 8px dividers. Keeping the leaves
// as keyed siblings lets React move panes without unmounting their controllers,
// transcript DOM, composers or sandboxed canvas iframes.
export function paneLayout(tree, gap = 8) {
    const panels = [], dividers = [];
    const walk = (node, box) => {
        if (!node) return;
        if (node.type !== "split") { panels.push({ node, box }); return; }
        const row = node.direction === "row", axis = row ? "x" : "y", size = row ? "width" : "height";
        const ratio = node.ratio / 100;
        const extent = [box[size][0], box[size][1] - gap];
        const firstSize = extent.map(v => v * ratio), secondSize = extent.map(v => v * (1 - ratio));
        const dividerStart = [box[axis][0] + firstSize[0], box[axis][1] + firstSize[1]];
        dividers.push({ node, bounds: box, box: { ...box, [axis]: dividerStart, [size]: [0, gap] } });
        walk(node.first, { ...box, [size]: firstSize });
        walk(node.second, { ...box, [axis]: [dividerStart[0], dividerStart[1] + gap], [size]: secondSize });
    };
    walk(tree, { x: [0, 0], y: [0, 0], width: [1, 0], height: [1, 0] });
    return { panels, dividers };
}
export const boxStyle = box => Object.fromEntries(Object.entries(box).map(([key, [fraction, pixels]]) =>
    [key === "x" ? "left" : key === "y" ? "top" : key, `calc(${fraction * 100}% + ${pixels}px)`]));

export function dropEdge(x, y, width, height) {
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return null;
    const distances = { left: x / width, right: 1 - x / width, top: y / height, bottom: 1 - y / height };
    const edge = edges.reduce((best, next) => distances[next] < distances[best] ? next : best);
    return distances[edge] < .24 ? edge : "center";
}

// Clear every chat/canvas binding for confirmed unavailable sessions without
// changing pane IDs, split proportions, focus or unrelated dashboard state.
export function emptySessionPanes(value, sessionIds) {
    const gone = new Set(sessionIds);
    const visit = node => {
        if (!node) return node;
        if (node.type !== "split") return gone.has(node.sessionId) ? { id: node.id, type: "empty" } : node;
        const first = visit(node.first), second = visit(node.second);
        return first === node.first && second === node.second ? node : { ...node, first, second };
    };
    const dashboards = value.dashboards.map(d => {
        const tree = visit(d.tree);
        return tree === d.tree ? d : { ...d, tree };
    });
    return dashboards.every((d, i) => d === value.dashboards[i]) ? value : { ...value, dashboards };
}
