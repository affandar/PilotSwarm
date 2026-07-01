import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFiles, systemAgentUUID, systemChildAgentUUID, type AgentConfig } from "./agent-loader.js";
import {
    DURABLE_SESSION_LATEST_VERSION,
    DURABLE_SESSION_ORCHESTRATION_NAME,
} from "./orchestration-registry.js";
import type { SessionCatalog } from "./cms.js";
import type { OrchestrationInput, SerializableSessionConfig } from "./types.js";

const __sdkDir = path.dirname(fileURLToPath(import.meta.url));

export interface SystemAgentSessionPlan {
    agent: AgentConfig & { id: string };
    sessionId: string;
    parentSessionId?: string;
    depth: number;
}

export interface SystemAgentStartResult {
    agentId: string;
    agentName: string;
    sessionId: string;
    parentSessionId?: string;
    status: "started" | "existing" | "raced";
}

export function buildSystemAgentBootstrapPayload(
    agent: AgentConfig,
    defaultModel: string,
    opts: {
        sessionId: string;
        blobEnabled?: boolean;
        dehydrateThreshold: number;
        parentSessionId?: string;
        defaultReasoningEffort?: SerializableSessionConfig["reasoningEffort"];
    },
): {
    serializableConfig: SerializableSessionConfig;
    input: OrchestrationInput;
} {
    const serializableConfig: SerializableSessionConfig = {
        model: defaultModel,
        ...(opts.defaultReasoningEffort ? { reasoningEffort: opts.defaultReasoningEffort } : {}),
        boundAgentName: agent.name,
        agentIdentity: agent.id,
        promptLayering: {
            kind: agent.promptLayerKind ?? (agent.namespace === "pilotswarm" ? "pilotswarm-system-agent" : "app-system-agent"),
        },
        toolNames: agent.tools ?? undefined,
    };

    const input: OrchestrationInput = {
        sessionId: opts.sessionId,
        config: serializableConfig,
        sourceOrchestrationVersion: DURABLE_SESSION_LATEST_VERSION,
        iteration: 0,
        ...(agent.initialPrompt ? { prompt: agent.initialPrompt, bootstrapPrompt: true } : {}),
        blobEnabled: opts.blobEnabled,
        dehydrateThreshold: opts.dehydrateThreshold,
        idleTimeout: -1,
        inputGracePeriod: -1,
        isSystem: true,
        agentId: agent.id,
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    };

    return { serializableConfig, input };
}

function readPluginNamespace(absDir: string): string {
    const pluginJsonPath = path.join(absDir, "plugin.json");
    if (!fs.existsSync(pluginJsonPath)) return path.basename(absDir);
    try {
        const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
        return typeof pluginJson.name === "string" && pluginJson.name.trim()
            ? pluginJson.name.trim()
            : path.basename(absDir);
    } catch {
        return path.basename(absDir);
    }
}

function loadSystemAgentsFromPluginDir(absDir: string, layer: "management" | "app"): AgentConfig[] {
    const agentsDir = path.join(absDir, "agents");
    if (!fs.existsSync(agentsDir)) return [];
    const namespace = readPluginNamespace(absDir);
    return loadAgentFiles(agentsDir)
        .filter((agent) => agent.system && agent.id)
        .map((agent) => ({
            ...agent,
            namespace,
            promptLayerKind: layer === "management" ? "pilotswarm-system-agent" : "app-system-agent",
        }));
}

export function loadSystemAgentConfigs(opts: {
    pluginDirs?: string[];
    disableManagementAgents?: boolean;
    systemAgents?: AgentConfig[];
} = {}): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!opts.disableManagementAgents) {
        const sdkPluginsDir = path.resolve(__sdkDir, "..", "plugins");
        agents.push(...loadSystemAgentsFromPluginDir(path.join(sdkPluginsDir, "mgmt"), "management"));
    }
    for (const pluginDir of opts.pluginDirs ?? []) {
        const absDir = path.resolve(pluginDir);
        if (!fs.existsSync(absDir)) continue;
        agents.push(...loadSystemAgentsFromPluginDir(absDir, "app"));
    }
    for (const agent of opts.systemAgents ?? []) {
        if (agent.system && agent.id) agents.push(agent);
    }

    const byId = new Map<string, AgentConfig>();
    for (const agent of agents) {
        if (agent.id) byId.set(agent.id, agent);
    }
    return [...byId.values()];
}

export function resolveSystemAgentSessionPlans(agents: AgentConfig[]): SystemAgentSessionPlan[] {
    const systemAgentsById = new Map(
        agents
            .filter((agent): agent is AgentConfig & { id: string } => Boolean(agent.id))
            .map((agent) => [agent.id, agent]),
    );
    const sessionIdCache = new Map<string, string>();
    const depthCache = new Map<string, number>();
    const resolvingSessionIds = new Set<string>();

    const resolveSystemSessionId = (agent: AgentConfig & { id: string }): string => {
        const cached = sessionIdCache.get(agent.id);
        if (cached) return cached;
        if (resolvingSessionIds.has(agent.id)) {
            throw new Error(`Cyclic system-agent parent graph detected at "${agent.id}"`);
        }
        resolvingSessionIds.add(agent.id);
        const sessionId = agent.parent
            ? systemChildAgentUUID(
                systemAgentsById.get(agent.parent)
                    ? resolveSystemSessionId(systemAgentsById.get(agent.parent)!)
                    : systemAgentUUID(agent.parent),
                agent.id,
            )
            : systemAgentUUID(agent.id);
        resolvingSessionIds.delete(agent.id);
        sessionIdCache.set(agent.id, sessionId);
        return sessionId;
    };

    const resolveDepth = (agent: AgentConfig & { id: string }): number => {
        const cached = depthCache.get(agent.id);
        if (cached != null) return cached;
        const depth = agent.parent && systemAgentsById.get(agent.parent)
            ? resolveDepth(systemAgentsById.get(agent.parent)!) + 1
            : 0;
        depthCache.set(agent.id, depth);
        return depth;
    };

    return [...systemAgentsById.values()]
        .map((agent) => ({
            agent,
            sessionId: resolveSystemSessionId(agent),
            parentSessionId: agent.parent
                ? (systemAgentsById.get(agent.parent)
                    ? resolveSystemSessionId(systemAgentsById.get(agent.parent)!)
                    : systemAgentUUID(agent.parent))
                : undefined,
            depth: resolveDepth(agent),
        }))
        .sort((a, b) => a.depth - b.depth);
}

function filterPlansForTarget(plans: SystemAgentSessionPlan[], agentId?: string): SystemAgentSessionPlan[] {
    if (!agentId) return plans;
    const byId = new Map(plans.map((plan) => [plan.agent.id, plan]));
    const included = new Set<string>();
    let current = byId.get(agentId);
    while (current) {
        included.add(current.agent.id);
        current = current.agent.parent ? byId.get(current.agent.parent) : undefined;
    }
    return plans.filter((plan) => included.has(plan.agent.id));
}

export async function startSystemAgents(opts: {
    catalog: Pick<SessionCatalog, "getSession" | "createSession" | "updateSession">;
    duroxideClient: any;
    agents: AgentConfig[];
    defaultModel: string;
    defaultReasoningEffort?: SerializableSessionConfig["reasoningEffort"];
    blobEnabled?: boolean;
    dehydrateThreshold: number;
    agentId?: string;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): Promise<SystemAgentStartResult[]> {
    const plans = filterPlansForTarget(resolveSystemAgentSessionPlans(opts.agents), opts.agentId);
    const results: SystemAgentStartResult[] = [];

    for (const plan of plans) {
        const { agent, sessionId, parentSessionId } = plan;
        const orchestrationId = `session-${sessionId}`;
        try {
            const existingRow = await opts.catalog.getSession(sessionId).catch(() => null);
            if (existingRow) {
                if (existingRow.model && existingRow.model !== opts.defaultModel) {
                    opts.warn?.(
                        `[PilotSwarmWorker] System agent ${agent.name} is reusing persisted session ${sessionId.slice(0, 8)} ` +
                        `with model ${existingRow.model}, while configured defaultModel is ${opts.defaultModel}. ` +
                        `Reset the system session if you want it recreated under the configured default.`,
                    );
                }
                results.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    sessionId,
                    ...(parentSessionId ? { parentSessionId } : {}),
                    status: "existing",
                });
                continue;
            }

            const { input } = buildSystemAgentBootstrapPayload(agent, opts.defaultModel, {
                sessionId,
                blobEnabled: opts.blobEnabled,
                dehydrateThreshold: opts.dehydrateThreshold,
                ...(opts.defaultReasoningEffort ? { defaultReasoningEffort: opts.defaultReasoningEffort } : {}),
                ...(parentSessionId ? { parentSessionId } : {}),
            });

            await opts.catalog.createSession(sessionId, {
                model: opts.defaultModel,
                ...(opts.defaultReasoningEffort ? { reasoningEffort: opts.defaultReasoningEffort } : {}),
                ...(parentSessionId ? { parentSessionId } : {}),
                isSystem: true,
                agentId: agent.id,
                splash: agent.splash ?? undefined,
            });
            const title = agent.title ?? (agent.name.charAt(0).toUpperCase() + agent.name.slice(1) + " Agent");
            await opts.catalog.updateSession(sessionId, { title });

            await opts.duroxideClient.startOrchestrationVersioned(
                orchestrationId,
                DURABLE_SESSION_ORCHESTRATION_NAME,
                input,
                DURABLE_SESSION_LATEST_VERSION,
            );

            await opts.catalog.updateSession(sessionId, {
                orchestrationId,
                state: "running",
                lastActiveAt: new Date(),
            });

            opts.log?.(`[PilotSwarmWorker] System agent started: ${agent.name} (${sessionId.slice(0, 8)})`);
            results.push({
                agentId: agent.id,
                agentName: agent.name,
                sessionId,
                ...(parentSessionId ? { parentSessionId } : {}),
                status: "started",
            });
        } catch (err: any) {
            if (err.message?.includes("already exists") || err.message?.includes("duplicate")) {
                results.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    sessionId,
                    ...(parentSessionId ? { parentSessionId } : {}),
                    status: "raced",
                });
                continue;
            }
            opts.warn?.(`[PilotSwarmWorker] System agent ${agent.name} start failed: ${err.message}`);
            throw err;
        }
    }

    return results;
}
