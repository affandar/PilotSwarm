import { defineTool, type Tool } from "@github/copilot-sdk";
import { CapabilityCatalog, capabilityHash, resolveCapabilitySource, visibleCapabilitySource,
    type CapabilitySource, type CapabilityState, type CapabilitySelection } from "./capability-catalog.js";
import type { FeatureOwner } from "./feature-flags.js";
import { mcpAllowlistAdmits, type McpAllowlistAgent } from "./mcp-loader.js";
import { findReservedPackageToolName } from "./reserved-tool-names.js";

export interface PackageRequest {
    source_ref: string; tools?: string[]; mcp_servers?: string[];
    action?: "add" | "remove"; expected_revision: number; request_id: string;
}
export interface CapabilityServices {
    search(args: any): Promise<unknown>;
    load(ref: string, kind: "skill" | "agent"): Promise<unknown>;
    list(): Promise<unknown>;
    use(args: PackageRequest): Promise<{ changed: boolean; revision: number }>;
}
export const CAPABILITY_TOOL_SPECS = {
    search_capabilities: {
        description: "Search visible static and published skills, authored agent workflows, tools and MCP servers; also curated shared skills. Returns metadata and exact references. Does not load instructions or grant tools. Static/package search is weighted keyword matching; curated search uses the configured hybrid index.",
        parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 },
            kinds: { type: "array", items: { type: "string", enum: ["skill", "agent", "tool", "mcp"] } },
            sources: { type: "array", items: { type: "string", enum: ["static", "published", "curated"] } } }, required: ["query"] },
    },
    load_agent_guidelines: {
        description: "Read an authored agent's own workflow as reference material using its search reference. Before applying it, tell the user which agent supplied the instructions and describe material adaptations. Does not launch an agent, adopt its identity, grant tools, or execute its startup prompt.",
        parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
    list_session_capabilities: {
        description: "List this durable session's explicit package tool/MCP selections, their availability, and the revision required by use_package. No secrets or server configuration are returned.",
        parameters: { type: "object", properties: {} },
    },
    use_package: {
        description: "Add or remove explicitly selected tools/MCP servers from an exact visible source_ref returned by search_capabilities. Does not install packages, grant an agent identity, or load every export. Parent-session only. Selections persist for this durable session; changes refresh the same session at the next turn boundary and continue automatically. Finish native tasks first. Use list_session_capabilities for expected_revision; use a new request_id per logical change and reuse it on retry. Existing original/bound tools cannot be removed here.",
        parameters: { type: "object", properties: { source_ref: { type: "string" }, tools: { type: "array", items: { type: "string" } },
            mcp_servers: { type: "array", items: { type: "string" } }, action: { type: "string", enum: ["add", "remove"] },
            expected_revision: { type: "integer", minimum: 0 }, request_id: { type: "string", minLength: 1, maxLength: 128 } },
            required: ["source_ref", "expected_revision", "request_id"] },
    },
} as const;
export function capabilityToolDeclarations(): Tool<any>[] {
    return Object.entries(CAPABILITY_TOOL_SPECS).map(([name, spec]) => defineTool(name, { ...spec, handler: async () => "Capability service unavailable" }));
}
export function validatePackageRequest(args: PackageRequest): void {
    if (!args || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0
        || typeof args.request_id !== "string" || !args.request_id.trim() || args.request_id.length > 128
        || args.action !== undefined && !["add", "remove"].includes(args.action)) throw new Error("Invalid package request/revision");
    for (const names of [args.tools ?? [], args.mcp_servers ?? []]) {
        if (!Array.isArray(names) || names.length > 64 || names.some(n => typeof n !== "string" || !n || n.length > 200)
            || new Set(names).size !== names.length) throw new Error("Invalid or duplicate tool/server names");
    }
    if (!(args.tools?.length || args.mcp_servers?.length)) throw new Error("Select at least one tool or MCP server");
}
export function nextCapabilityState(state: CapabilityState, sourceId: string, args: PackageRequest): { state: CapabilityState; changed: boolean } {
    validatePackageRequest(args);
    const hash = capabilityHash({
        sourceId,
        sourceRef: args.source_ref,
        action: args.action ?? "add",
        tools: [...(args.tools ?? [])].sort(),
        mcpServers: [...(args.mcp_servers ?? [])].sort(),
    });
    const receipt = state.requests?.find(r => r.id === args.request_id);
    if (receipt) {
        if (receipt.hash !== hash) throw new Error("request_id was already used for a different package change");
        return { state, changed: false };
    }
    if (state.revision !== args.expected_revision) throw new Error("Capability revision conflict; list current selections and retry");
    const old = state.selections.find(s => s.sourceId === sourceId) ?? { sourceId, tools: [], mcpServers: [] };
    const merge = (current: string[], selected: string[]) => args.action === "remove"
        ? current.filter(n => !selected.includes(n)) : [...new Set([...current, ...selected])].sort();
    // Removing one export cannot silently upgrade all remaining exports to a
    // newly published source revision. Preserve the original exact ref until
    // the selection is fully removed or explicitly re-added from a fresh ref.
    const selection = { sourceId,
        sourceRef: args.action === "remove" ? old.sourceRef ?? args.source_ref : args.source_ref,
        tools: merge(old.tools, args.tools ?? []), mcpServers: merge(old.mcpServers, args.mcp_servers ?? []) };
    const selections = state.selections.filter(s => s.sourceId !== sourceId);
    if (selection.tools.length || selection.mcpServers.length) selections.push(selection);
    if (selections.length > 32) throw new Error("At most 32 capability sources may be attached");
    selections.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const changed = capabilityHash(selections) !== capabilityHash(state.selections);
    return { changed, state: { revision: state.revision + 1, selections,
        requests: [...(state.requests ?? []), { id: args.request_id, hash }].slice(-64) } };
}
/** Resolve exact exports. Never fall back to a same-named package or the legacy flat registry. */
export function bindCapabilities(sources: CapabilitySource[], owner: FeatureOwner | null, selections: CapabilitySelection[],
    originalTools: Tool<any>[], originalMcp: Record<string, any>, agent: McpAllowlistAgent | null, strict = false) {
    const tools: Tool<any>[] = []; const mcpServers: Record<string, any> = Object.create(null); const unavailable: string[] = [];
    const toolNames = new Set(originalTools.map(t => t.name)); const mcpNames = new Set(Object.keys(originalMcp));
    const bound: Array<{ sourceId: string; revision: string; tools: string[]; mcpServers: string[] }> = [];
    for (const selection of selections) {
        const source = sources.find(s => s.id === selection.sourceId && visibleCapabilitySource(s, owner));
        if (!source) { if (strict) throw new Error("Capability source unavailable or inaccessible"); unavailable.push(selection.sourceId); continue; }
        if (selection.sourceRef) {
            try {
                const exact = resolveCapabilitySource(sources, owner, selection.sourceRef);
                if (exact.ref.k !== "source" || exact.source !== source) throw new Error("Capability selection source mismatch");
            } catch (error) {
                if (strict) throw error;
                unavailable.push(selection.sourceId);
                continue;
            }
        }
        const selectedTools: Tool<any>[] = []; const selectedMcp: Record<string, any> = {};
        let problem = "";
        for (const name of selection.tools) {
            const tool = source.tools.get(name);
            if (!tool || tool.name !== name) { problem = "Selected tool unavailable"; break; }
            if (toolNames.has(name) || findReservedPackageToolName([name], [], [])) { problem = `Tool name collision or reserved name: ${name}`; break; }
            selectedTools.push(tool);
        }
        for (const name of selection.mcpServers) {
            if (name === "__proto__" || name === "prototype" || name === "constructor"
                || !Object.hasOwn(source.mcpServers, name)) {
                problem = "Selected MCP server unavailable";
                break;
            }
            const cfg = source.mcpServers[name];
            if (!cfg) { problem = "Selected MCP server unavailable"; break; }
            if (mcpNames.has(name)) { problem = `MCP server name collision: ${name}`; break; }
            if (cfg.allowedAgents && !mcpAllowlistAdmits(cfg.allowedAgents, agent)) { problem = "MCP server is restricted to an authorized bound agent"; break; }
            const { allowedAgents: _, ...server } = cfg; selectedMcp[name] = server;
        }
        if (problem) { if (strict) throw new Error(problem); unavailable.push(selection.sourceId); continue; }
        for (const tool of selectedTools) { tools.push(tool); toolNames.add(tool.name); }
        Object.assign(mcpServers, selectedMcp); Object.keys(selectedMcp).forEach(n => mcpNames.add(n));
        bound.push({ sourceId: source.id, revision: source.revision,
            tools: [...selection.tools].sort(), mcpServers: [...selection.mcpServers].sort() });
    }
    return { tools, mcpServers, unavailable, fingerprint: capabilityHash(bound) };
}
