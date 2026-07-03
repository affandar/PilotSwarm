import type { ApiClient } from "pilotswarm-sdk/api";
import type {
    GraphStore, GraphNodeInput, GraphEdgeInput, GraphNodeQuery, GraphEdgeQuery, GraphNodeHit,
    GraphEdgeHit, GraphNodeRef, GraphEdgeRef, SubGraph, GraphNamespaceInfo, GraphNamespaceListQuery,
    GraphNamespaceInput, GraphNamespaceQuery, GraphNamespaceDeleteResult, GraphEvidenceRemovalResult,
} from "../graph-store.js";
import type { AccessContext } from "../facts-store.js";

/**
 * `GraphStore` over the PilotSwarm Web API. Implements the runtime's graph
 * contract so graph tools/consumers work remotely. Access is server-derived;
 * `AccessContext` args are accepted for parity and ignored on the wire.
 *
 * Evidence-reconciliation methods (`removeGraphEvidence`, `mergeGraphNodes`)
 * are in-cluster harvester machinery and are not exposed over the API.
 */
export class WebGraphStore implements GraphStore {
    private readonly api: ApiClient;

    constructor(api: ApiClient) {
        this.api = api;
    }

    async initialize(): Promise<void> {}
    async close(): Promise<void> {}

    async searchGraphNodes(q: GraphNodeQuery, _access?: AccessContext): Promise<GraphNodeHit[]> {
        return this.api.call("searchGraphNodes", { query: q });
    }

    async searchGraphEdges(q: GraphEdgeQuery, _access?: AccessContext): Promise<GraphEdgeHit[]> {
        return this.api.call("searchGraphEdges", { query: q });
    }

    async graphNeighbourhood(nodeKey: string, depth: number, _access?: AccessContext, opts?: GraphNamespaceQuery): Promise<SubGraph> {
        return this.api.call("graphNeighbourhood", { nodeKey, depth, namespace: opts?.namespace });
    }

    async upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef> {
        return this.api.call("upsertGraphNode", { input: n });
    }

    async upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef> {
        return this.api.call("upsertGraphEdge", { input: e });
    }

    async deleteGraphNode(nodeKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this.api.call("deleteGraphNode", { nodeKey, namespace: opts?.namespace });
    }

    async deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this.api.call("deleteGraphEdge", { fromKey, toKey, predicateKey, namespace: opts?.namespace });
    }

    async mergeGraphNodes(): Promise<void> {
        throw Object.assign(new Error("mergeGraphNodes is not available over the Web API."), { code: "GRAPH_UNSUPPORTED" });
    }

    async removeGraphEvidence(): Promise<GraphEvidenceRemovalResult> {
        throw Object.assign(new Error("removeGraphEvidence is not available over the Web API."), { code: "GRAPH_UNSUPPORTED" });
    }

    async graphStats(opts?: GraphNamespaceQuery): Promise<{ nodeCount: number; edgeCount: number; uncrawledFacts?: number }> {
        return this.api.call("graphStats", { namespace: opts?.namespace });
    }

    async listGraphNamespaces(q?: GraphNamespaceListQuery): Promise<GraphNamespaceInfo[]> {
        return this.api.call("listGraphNamespaces", {
            prefix: q?.prefix,
            includeArchived: q?.includeArchived,
            includeDetails: q?.includeDetails,
        });
    }

    async getGraphNamespace(namespace: string): Promise<GraphNamespaceInfo | null> {
        return this.api.call("getGraphNamespace", { namespace });
    }

    async upsertGraphNamespace(input: GraphNamespaceInput): Promise<GraphNamespaceInfo> {
        return this.api.call("upsertGraphNamespace", { input });
    }

    async deleteGraphNamespace(namespace: string): Promise<GraphNamespaceDeleteResult> {
        return this.api.call("deleteGraphNamespace", { namespace });
    }
}

/** Build a `GraphStore` over the Web API. Returns null when the deployment has no graph store. */
export async function createWebGraphStore(api: ApiClient): Promise<GraphStore | null> {
    const caps = (await api.call("factsCapabilities")) as { graph?: boolean };
    return caps?.graph ? new WebGraphStore(api) : null;
}
