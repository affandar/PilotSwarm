import type { CopilotSession, CustomAgentConfig, SessionHooks, Tool } from "@github/copilot-sdk";

export type NativeSubagentMode = "off" | "sync";

export function resolveNativeSubagents(value: unknown = process.env.PILOTSWARM_NATIVE_SUBAGENTS): NativeSubagentMode {
    if (value == null || value === "" || value === "off") return "off";
    if (value === "sync") return "sync";
    throw new Error("nativeSubagents / PILOTSWARM_NATIVE_SUBAGENTS must be off or sync");
}

// Scope native workers to CLI tools. In particular, do not inherit the
// parent's PilotSwarm tools or loaded durable-agent definitions.
export const NATIVE_SUBAGENT_TOOLS = ["view", "grep", "rg", "glob", "bash", "powershell", "read_bash", "read_powershell", "list_bash", "stop_bash", "stop_powershell"];
export const NATIVE_BUILTIN_AGENTS = ["explore", "task", "general-purpose", "code-review", "research", "security-review", "rubber-duck", "rem-agent"];
export const NATIVE_EXCLUDED_TOOLS = ["write_agent", "manage_schedule", "run_factory", "factories_manage"];
const names = new Set(["swarm-explore", "swarm-task"]);
const childTools = new Set(NATIVE_SUBAGENT_TOOLS);

export const NATIVE_SUBAGENT_GUIDANCE = `
## Native local delegation
The native task tool is enabled for bounded, synchronously awaited work on this worker.
Use task(agent_type="swarm-explore", mode="sync") for substantial exploration needing separate context,
or task(agent_type="swarm-task", mode="sync") for tests, builds, and verbose commands.
Provide full context and ask for findings/results. Simple lookups are best done directly.
Native workers have local CLI tools only and use your current model. They return results through task.
PilotSwarm child contracts, facts, wake-ups, and complete_agent apply ONLY to spawn_agent children.
Use spawn_agent for independent durable work, timers, or future follow-ups.
Native background mode and write_agent are unavailable. Do not override native worker models.
`;

export function nativeSubagentDefinitions(model: string): CustomAgentConfig[] {
    return [
        { name: "swarm-explore", description: "Explore the local workspace and return concise source-backed findings.",
            prompt: "Investigate the delegated question in the local workspace. Return concise findings with file references. Do not edit files. If you need user input or durable tools, report that to the parent. Complete the assigned investigation and return.", },
        { name: "swarm-task", description: "Run local tests, builds, and commands; summarize success and include failure details.",
            prompt: "Perform the delegated commands in the local workspace. Return a concise outcome; include actionable error details on failure. Await your commands; do not detach processes or schedule later work. If you need user input or durable tools, report that to the parent.", },
    ].map(agent => ({ ...agent, model, tools: [...NATIVE_SUBAGENT_TOOLS], infer: true }));
}

/** Native execution remains in the CLI. Compose policy around the native tool. */
export function nativeSubagentHooks(model: string, hooks?: SessionHooks): SessionHooks {
    return {
        ...hooks,
        onPreToolUse: async (input, invocation) => {
            const previous = await hooks?.onPreToolUse?.(input, invocation);
            if (previous?.permissionDecision === "deny") return previous;
            const deny = (reason: string) => ({ ...previous, permissionDecision: "deny" as const, permissionDecisionReason: reason });
            const isChild = Boolean(input.sessionId && input.sessionId !== invocation.sessionId);
            if (isChild && !childTools.has(input.toolName)) {
                return deny("Native workers can use only local CLI tools. Return this request to your PilotSwarm parent.");
            }
            if (NATIVE_EXCLUDED_TOOLS.includes(input.toolName)) {
                return deny("Detached native work is unavailable. Use task with mode=sync or PilotSwarm spawn_agent.");
            }
            const args = previous?.modifiedArgs ?? input.toolArgs;
            if (isChild && (input.toolName === "bash" || input.toolName === "powershell")) {
                const shell = args as Record<string, unknown> | undefined;
                if (shell?.detach === true || (shell?.mode !== undefined && shell.mode !== "sync")) {
                    return deny("Native workers must await commands; detached/background shells are unavailable.");
                }
            }
            if (input.toolName !== "task") return previous;
            if (!args || typeof args !== "object" || Array.isArray(args)) return deny("task arguments must be an object");
            const task = args as Record<string, unknown>;
            if (!names.has(String(task.agent_type))) return deny("Use the native swarm-explore or swarm-task agent.");
            if (task.mode !== undefined && task.mode !== "sync") return deny("Use task(mode=sync). Background native tasks are unavailable on this worker.");
            if (task.model !== undefined && task.model !== model) return deny("Native workers must use the parent session model; omit the model override.");
            if (task.reasoning_effort !== undefined || task.context_tier !== undefined) {
                return deny("Native workers inherit parent reasoning/context settings; omit overrides.");
            }
            // Pin the admitted parent model rather than allowing runtime-specific
            // specialist defaults or an application hook to change providers.
            return { ...previous, modifiedArgs: { ...task, mode: "sync", model } };
        },
    };
}

export function isNativeChildEvent(event: any): boolean {
    return Boolean(event?.agentId || event?.data?.nativeAgentId || event?.data?.parentToolCallId);
}

/** Retire reusable native agents before the worker can snapshot or release its lock.
 * Do not waitForPending(): its ten-minute wait may schedule follow-up turns.
 * A timeout/failure rejects the activity rather than claiming a safe boundary.
 */
export async function settleNativeSubagents(session: CopilotSession, { timeoutMs = 5_000, rejectRunning = false }: { timeoutMs?: number; rejectRunning?: boolean } = {}): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const timeoutError = () => new Error("Native subagent cleanup timed out; turn cannot commit");
    const checked = async <T,>(operation: Promise<T>): Promise<T> => {
        const result = await operation;
        // A timed-out RPC can resolve later. It must never continue into a
        // subsequent turn and cancel that turn's newly created native agents.
        if (expired) throw timeoutError();
        return result;
    };
    const settle = async () => {
        const tasks = (await checked(session.rpc.tasks.list())).tasks.filter(task => task.type === "agent");
        const hadRunning = tasks.some(task => task.status === "running");
        for (const task of tasks) {
            if (task.status === "running" || task.status === "idle") {
                await checked(session.rpc.tasks.cancel({ id: task.id }));
            }
        }
        const remaining = (await checked(session.rpc.tasks.list())).tasks.filter(task => task.type === "agent");
        if (remaining.some(task => task.status === "running" || task.status === "idle")) {
            throw new Error("Native subagent cleanup failed: a native agent is still active");
        }
        for (const task of remaining) await checked(session.rpc.tasks.remove({ id: task.id }));
        if (rejectRunning && hadRunning) {
            throw new Error("Native execution contract violated: agent was still running after parent completion (cancelled)");
        }
    };
    try {
        await Promise.race([
            settle(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => { expired = true; reject(timeoutError()); }, timeoutMs);
            }),
        ]);
    } finally { if (timer) clearTimeout(timer); }
}

/** Defense in depth if a CLI tool name collides with an external tool name.
 * Apply both at declaration time and when per-turn handlers are refreshed.
 */
export function guardNativeExternalTools(tools: Tool<any>[], parentSessionId: string): Tool<any>[] {
    return tools.map(tool => {
        const handler = tool.handler;
        if (!handler) return tool;
        return {
            ...tool,
            handler: (args, invocation) => {
                if (invocation.sessionId !== parentSessionId) {
                    throw new Error("Native workers cannot invoke PilotSwarm external tools; return the request to the parent.");
                }
                return handler(args, invocation);
            },
        };
    });
}
