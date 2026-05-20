export interface AgentSummary {
  name: string;
  namespace: string;
  tier: "framework-base" | "app-default" | "system-managed" | "app-creatable";
  description?: string;
  toolNames?: string[];
  isOverridable: boolean;
  splash?: string;
}

type WorkerWithPossiblePublicApi = {
  listRegisteredAgents?: () => AgentSummary[];
};

type WorkerPrivateShape = {
  _frameworkBasePrompt?: string | null;
  _frameworkBaseToolNames?: string[];
  _appDefaultPrompt?: string | null;
  _appDefaultToolNames?: string[];
  _loadedSystemAgents?: Array<{
    name: string;
    namespace?: string;
    description?: string;
    tools?: string[] | null;
    splash?: string;
  }>;
  _rawLoadedAgents?: Array<{
    name: string;
    namespace?: string;
    description?: string;
    tools?: string[] | null;
    splash?: string;
    system?: boolean;
  }>;
};

export function listRegisteredAgentsShim(worker: WorkerWithPossiblePublicApi & WorkerPrivateShape): AgentSummary[] {
  if (typeof worker.listRegisteredAgents === "function") return worker.listRegisteredAgents();
  const result: AgentSummary[] = [];

  if (worker._frameworkBasePrompt) {
    result.push({
      name: "default",
      namespace: "system",
      tier: "framework-base",
      toolNames: worker._frameworkBaseToolNames ?? [],
      isOverridable: false
    });
  }
  if (worker._appDefaultPrompt) {
    result.push({
      name: "default",
      namespace: "app",
      tier: "app-default",
      toolNames: worker._appDefaultToolNames ?? [],
      isOverridable: false
    });
  }
  for (const agent of worker._loadedSystemAgents ?? []) {
    result.push({
      name: agent.name,
      namespace: agent.namespace ?? "pilotswarm",
      tier: "system-managed",
      description: agent.description,
      toolNames: agent.tools ?? [],
      isOverridable: false,
      splash: agent.splash
    });
  }
  for (const agent of worker._rawLoadedAgents ?? []) {
    if (agent.system) continue;
    result.push({
      name: agent.name,
      namespace: agent.namespace ?? "custom",
      tier: "app-creatable",
      description: agent.description,
      toolNames: agent.tools ?? [],
      isOverridable: true,
      splash: agent.splash
    });
  }
  return result;
}

export function listRegisteredAgentsDedup(worker: WorkerWithPossiblePublicApi & WorkerPrivateShape): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const entry of listRegisteredAgentsShim(worker)) byName.set(entry.name, entry);
  return [...byName.values()];
}

export function defaultAgentInventory(): AgentSummary[] {
  return [
    {
      name: "default",
      namespace: "system",
      tier: "framework-base",
      isOverridable: false,
      toolNames: []
    }
  ];
}

export function assertAgentCanBeScenarioAgent(agentName: string, inventory: AgentSummary[]): void {
  if (agentName === "default") return;
  const entry = inventory.find((agent) => agent.name === agentName);
  if (!entry) throw new Error(`Unknown PilotSwarm agent "${agentName}". Configure worker.pluginDirs or worker.customAgents.`);
  if (entry.tier !== "app-creatable") {
    throw new Error(`Agent "${agentName}" is ${entry.tier}, not app-creatable. System-managed agents are not valid scenario agents in v1.`);
  }
}

export function assertPromptOverridesAreOverridable(promptOverrides: Record<string, unknown> | undefined, inventory: AgentSummary[]): void {
  for (const name of Object.keys(promptOverrides ?? {})) {
    const entry = inventory.find((agent) => agent.name === name);
    if (!entry) throw new Error(`Unknown promptOverrides agent "${name}". Configure worker.pluginDirs or worker.customAgents.`);
    if (!entry.isOverridable) {
      throw new Error(`Agent "${name}" is not overridable in v1. Built-in and system-managed prompt overrides require the v1.1 upstream APIs described in §11.6.6.`);
    }
  }
}
