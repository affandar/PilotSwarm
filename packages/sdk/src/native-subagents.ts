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
export const NATIVE_CRITIC_TOOLS = ["view", "grep", "rg", "glob"];
export const NATIVE_BUILTIN_AGENTS = ["explore", "task", "general-purpose", "code-review", "research", "security-review", "rubber-duck", "rem-agent"];
export const NATIVE_EXCLUDED_TOOLS = ["write_agent", "manage_schedule", "run_factory", "factories_manage"];
const names = new Set(["swarm-explore", "swarm-task", "swarm-rubber-duck"]);
const childTools = new Set(NATIVE_SUBAGENT_TOOLS);

export const NATIVE_SUBAGENT_GUIDANCE = `
## Native local delegation
Choose delegation by role fit, expected lifetime, scale, execution location, and the user's intent.
First consider the available user-creatable named agents. If one is customized for the required role,
prefer spawn_agent(agent_name=<exact name>) over a generic durable agent or native task.
Use the agent index already in context, or ps_list_agents when discovery is needed; do not invent names.
Match its capabilities and source access, not just a similar name. A specialist can perform its own
intake: spawn the matching role rather than asking the user for details that role is designed to collect.
Give named children their assignment through the contract and message_agent, not task/system_message overrides.
User words such as "subagent", "sub-agent", "spawn", or "spin off" are strong hints for durable spawn_agent:
default to durable when the intended mechanism is otherwise ambiguous; short duration alone does not
override that hint. "Spin off an agent to summarize the README" therefore favors durable execution.
These are contextual hints, not literal keyword rules: "spawn a native task" still asks for native
execution when its lifetime and capabilities fit.
Prefer durable spawn_agent for expected long-running sessions, broad scale-out across independently
managed work, ongoing monitoring, work outliving this turn, recovery across restarts, or cross-worker work.
Native tasks share this worker and the parent's turn time budget; they are not independent durable sessions.
Filesystem sharing is only between a native task and its IMMEDIATE parent session.
If you are a durable child, a path reported by your durable parent or sibling is not
your local file. Before asking your native task to process it, use read_artifact(toFile)
to materialize that session's published artifact in YOUR working directory, then pass
your local path to task. Native tasks have no artifact tools and cannot fetch it for you.
The presence of a producer path alongside an artifact reference does not establish
shared storage, even when the request explicitly asks you to use a native task.
Use native task for bounded, synchronously awaited local work that fits this turn and benefits from separate context:
task(agent_type="swarm-explore", mode="sync") for investigation, or task(agent_type="swarm-task", mode="sync")
for tests, builds, and verbose commands.
Same-worker files and uncommitted changes favor native execution
when the user has left the delegation mechanism open. Local files alone do not cancel a durable hint:
"use subagents in parallel to compare README.md and package.json" favors durable children with source
access or artifact handoff, even though the files are small. An explicit requirement to execute in this
exact checkout with uncommitted edits, however, favors native tasks when the work fits this turn.
Preserve explicit topology: separate agents/sessions that themselves run native tasks means spawn_agent
children, each using native tasks within its own turn. Do not collapse that into native tasks in the parent.
Resolve "spawn separate subagents for this" from the existing objective and results; do not ask the user
to repeat an established task. Ask only when missing information materially blocks useful action.
Use judgment rather than a fixed duration or agent-count threshold. Simple work without a delegation
request is best done directly. A matching named role takes priority over native convenience.
Durable children may run on another worker: provide task context and repository access or artifacts;
do not assume they can read this worker's local paths. Explain briefly if explicit native execution
cannot satisfy a required lifetime or capability, and use a durable agent to meet that requirement.
Provide full context and ask for findings/results. Simple lookups are best done directly.
Native workers have local CLI tools only. They return results through task.
PilotSwarm child contracts, facts, wake-ups, and complete_agent apply ONLY to spawn_agent children.
Native background mode and write_agent are unavailable.
swarm-explore and swarm-task inherit the parent model, reasoning effort, and context tier.
Omit the model, reasoning_effort, and context_tier arguments; overrides are unavailable.
`;

export function nativeSubagentGuidance(criticModel?: string | null): string {
    return NATIVE_SUBAGENT_GUIDANCE + (criticModel
        ? `
## Native rubber-duck critique
The native rubber duck is available using ${criticModel}, a complementary model permitted on this Copilot provider.
Use task(agent_type="swarm-rubber-duck", mode="sync") for a constructive critique of a plan,
implementation, or tests. Subject to the role, lifetime, and user-intent rules above, proactively
consider this critic after a non-trivial plan but before editing, at a complex implementation
checkpoint, after writing tests, or when repeated failures or unexpected results suggest the
approach needs rethinking. These are judgment calls, not mandatory calls on every turn.
Skip trivial work and repeated reviews of unchanged material. An explicit request to rubber duck
a plan or get a local native critique should use this profile when its scope fits.
Give the critic the user's objective, proposed approach, relevant local paths, and known constraints.
It has only local file-reading/search tools: no shell, file editing, web, durable tools, or delegation.
It returns actionable findings; you decide which to address and briefly explain the resulting changes.
The critic uses a complementary model; the native runtime carries the parent reasoning/context settings.
Omit model, reasoning_effort, and context_tier arguments; overrides are unavailable.
`
        : "\nThe native rubber duck is unavailable: no complementary model could be verified on this session's permitted Copilot provider. Do not call swarm-rubber-duck or substitute the built-in rubber-duck. For an explicit critique request, explain the limitation and use an appropriate durable specialist or review directly. swarm-explore and swarm-task remain available.\n");
}

export function nativeSubagentDefinitions(model: string, criticModel?: string | null): CustomAgentConfig[] {
    return [
        { name: "swarm-explore", description: "Explore the local workspace and return concise source-backed findings.",
            prompt: "Investigate the delegated question in the local workspace. Return concise findings with file references. Do not edit files. If you need user input or durable tools, report that to the parent. Complete the assigned investigation and return.", },
        { name: "swarm-task", description: "Run local tests, builds, and commands; summarize success and include failure details.",
            prompt: "Perform the delegated commands in the local workspace. Return a concise outcome; include actionable error details on failure. Await your commands; do not detach processes or schedule later work. If you need user input or durable tools, report that to the parent.", },
        { name: "swarm-rubber-duck", description: "Constructively critique a non-trivial plan, implementation, or tests. Useful before implementation, at complex checkpoints, after tests, or when an approach repeatedly fails.",
            prompt: "Review the supplied work against the user's objective and constraints. Read relevant local files to verify assumptions. Identify substantive correctness, design, security, or test-coverage problems and suggest concrete fixes. For each finding give the evidence or file reference, impact, severity, and recommended change. Distinguish confirmed defects from uncertainties. Avoid style nitpicks, speculative issues, and unrelated scope expansion. If there are no substantive findings, say so. Do not modify files, run commands, delegate, or claim to have run tests. Return a concise critique to the parent; the parent decides what to change. If necessary context or tools are missing, explain that limitation.",
            // The pinned CLI accepts this on create/resume although SDK 1.0.13
            // omits it from CustomAgentConfig's type. Required prevents its
            // preferred-model fallback from turning a critic into the parent.
            tools: NATIVE_CRITIC_TOOLS, modelPolicy: "required" as const },
    ].filter(agent => agent.name !== "swarm-rubber-duck" || Boolean(criticModel))
        .map(agent => ({ ...agent, model: agent.name === "swarm-rubber-duck" ? criticModel! : model,
            tools: [...(agent.tools ?? NATIVE_SUBAGENT_TOOLS)], infer: true }));
}

/** Native execution remains in the CLI. Compose policy around the native tool. */
export function nativeSubagentHooks(model: string, hooks?: SessionHooks, canAdmit: () => boolean = () => true, criticModel?: string | null): SessionHooks {
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
            if (!canAdmit()) return deny("Native tasks are disabled by current feature policy for this turn. Use a durable spawn_agent if needed.");
            if (!args || typeof args !== "object" || Array.isArray(args)) return deny("task arguments must be an object");
            const task = args as Record<string, unknown>;
            if (!names.has(String(task.agent_type))) return deny("Use the native swarm-explore, swarm-task, or swarm-rubber-duck agent.");
            const isCritic = task.agent_type === "swarm-rubber-duck";
            if (isCritic && !criticModel) return deny("Native rubber duck is unavailable: no complementary model is permitted and available on this session's Copilot provider.");
            const selectedModel = isCritic ? criticModel! : model;
            if (task.mode !== undefined && task.mode !== "sync") return deny("Use task(mode=sync). Background native tasks are unavailable on this worker.");
            if (task.model !== undefined && task.model !== selectedModel) return deny(isCritic
                ? "The native critic must use the permitted complementary model selected by the worker; omit the model override."
                : "Native workers must use the parent session model; omit the model override.");
            if (task.reasoning_effort !== undefined || task.context_tier !== undefined) {
                return deny("Native reasoning/context settings are managed by the worker; omit overrides.");
            }
            // Pin the admitted parent model rather than allowing runtime-specific
            // specialist defaults or an application hook to change providers.
            return { ...previous, modifiedArgs: { ...task, mode: "sync", model: selectedModel } };
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
