import { randomUUID } from "node:crypto";
import type { CopilotSession } from "@github/copilot-sdk";

export interface NativeTaskSummary {
    id: string;
    toolCallId: string;
    agentId?: string;
    title: string;
    profile?: string;
    model?: string;
    status: "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    toolCalls: number;
    preview?: string;
    result?: string;
    error?: string;
    recentActivity?: Array<{ message: string; timestamp: string }>;
}

export interface NativeTasksPayload {
    version: 1;
    ownerId: string;
    ownerStartedAt: number;
    turnIndex: number;
    revision: number;
    phase: "live" | "idle";
    tasks: NativeTaskSummary[];
    truncated?: boolean;
}

interface Options {
    turnIndex?: number;
    intervalMs?: number;
    timeoutMs?: number;
    emit: (event: { eventType: string; data: any }) => void;
}

const terminal = (status: string) => !["running", "waiting"].includes(status);
const text = (value: unknown, limit = 240): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
const iso = (value: unknown): string => typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : new Date().toISOString();
const resultText = (data: any) => text(data?.result?.detailedContent ?? data?.result?.content
    ?? data?.result?.textResultForLlm ?? data?.result ?? data?.content, 4_096);
const failed = (data: any) => data?.success === false || data?.result?.success === false || Boolean(data?.error)
    || ["failure", "failed", "rejected", "denied"].includes(data?.result?.resultType ?? data?.resultType);

/** A read-only, per-turn projection of native work. Registry notifications are
 * invalidations, never transcript entries. Lifecycle events remain authoritative;
 * deleting/reusing a CLI registry entry cannot rewrite a completed invocation.
 */
export class NativeTaskObserver {
    private readonly ownerId = randomUUID();
    private readonly ownerStartedAt = Date.now();
    private readonly tasks = new Map<string, NativeTaskSummary>();
    private readonly agents = new Map<string, string>();
    private readonly toolCalls = new Set<string>();
    private readonly persisted = new Map<string, string>();
    private readonly intervalMs: number;
    private revision = 0;
    private phase: "live" | "idle" = "live";
    private closed = false;
    private truncated = false;
    private publishTimer?: ReturnType<typeof setTimeout>;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private rpcTimer?: ReturnType<typeof setTimeout>;
    private lastPublished = -Infinity;
    private lastRefresh = -Infinity;
    private refreshing = false;
    private dirty = false;
    private rpcDisabled = false;

    constructor(private readonly session: Pick<CopilotSession, "rpc">, private readonly options: Options) {
        this.intervalMs = Math.max(1, options.intervalMs ?? 500);
    }

    observe(event: { type?: string; eventType?: string; data?: any; agentId?: string; timestamp?: string }): void {
        if (this.closed) return;
        const kind = (event.type ?? event.eventType ?? "").replace(/^native\./, "");
        const data = event.data ?? {};
        if (kind === "session.background_tasks_changed") { this.invalidate(); return; }
        const agentId = text(event.agentId ?? data.nativeAgentId, 200);
        const isChild = Boolean(agentId || data.parentToolCallId);
        const isTaskTool = !isChild && (data.toolName ?? data.name) === "task";
        const lifecycle = kind.startsWith("subagent.");
        const callId = text(lifecycle || isTaskTool ? data.toolCallId ?? (agentId ? this.agents.get(agentId) : undefined)
            : data.parentToolCallId ?? (agentId ? this.agents.get(agentId) : undefined), 200);
        if (!callId) return;
        let task = this.tasks.get(callId);
        if (!task && !(lifecycle || isTaskTool)) return;
        if (!task) {
            if (this.tasks.size >= 32) { this.truncated = true; return; }
            const args = data.arguments ?? data.args ?? {};
            task = { id: callId, toolCallId: callId,
                title: text(args.description ?? args.name ?? data.agentDisplayName) ?? "Native task",
                profile: text(args.agent_type ?? data.agentName), model: text(data.model),
                status: "running", startedAt: iso(event.timestamp), toolCalls: 0 };
            this.tasks.set(callId, task);
        }
        // A completed invocation is immutable except for the parent tool's
        // returned result, which commonly arrives just after its lifecycle
        // completion. Cleanup can emit another completion or child events.
        const wasTerminal = terminal(task.status);
        if (wasTerminal && !isTaskTool) return;
        if (agentId && lifecycle) { task.agentId = agentId; this.agents.set(agentId, callId); }
        if (lifecycle && data.model) task.model = text(data.model);
        if (kind === "subagent.started") {
            task.profile = text(data.agentName ?? data.agentType) ?? task.profile;
            this.invalidate();
        }
        if (kind === "subagent.completed" || kind === "subagent.failed") {
            this.setTerminal(task, kind === "subagent.failed" ? "failed" : data.cancelled === true ? "cancelled" : "completed", event.timestamp);
            if (Number.isFinite(data.durationMs)) task.durationMs = Math.max(0, data.durationMs);
            if (Number.isFinite(data.totalToolCalls)) task.toolCalls = Math.max(task.toolCalls, data.totalToolCalls);
            task.error = text(data.error, 1_000) ?? task.error;
        } else if (kind === "tool.execution_complete" && isTaskTool) {
            const taskFailed = failed(data);
            if (wasTerminal && (task.status !== "completed" || taskFailed)) return;
            this.setTerminal(task, taskFailed ? "failed" : "completed", event.timestamp);
            task.result = resultText(data) ?? task.result;
            if (taskFailed) task.error = text(data.error?.message ?? data.error, 1_000) ?? task.result ?? "Task failed";
            if (task.result) task.preview = text(task.result);
        } else if (isChild && kind === "tool.execution_start") {
            const key = `${callId}:${data.toolCallId}`;
            if (!this.toolCalls.has(key)) {
                this.toolCalls.add(key);
                task.toolCalls++;
            }
            task.preview = text(data.arguments?.description ?? data.args?.description ?? data.toolName) ?? task.preview;
        } else if (isChild && kind === "assistant.message") {
            const content = text(data.content, 4_096);
            if (content) {
                task.preview = text(content);
                // A child message may be commentary. Only a parent task result
                // or registry result establishes the returned result text.
            }
        }
        this.persistBoundary(task);
        this.schedulePublish();
    }

    /** Never await telemetry on the model path, including hung JSON-RPC calls. */
    finish(status: "interrupted" | "cancelled" = "interrupted"): void {
        if (this.closed) return;
        this.closed = true;
        this.phase = "idle";
        for (const task of this.tasks.values()) {
            if (!terminal(task.status)) {
                this.setTerminal(task, status);
                this.persistBoundary(task);
            }
        }
        if (this.publishTimer) clearTimeout(this.publishTimer);
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.rpcTimer) clearTimeout(this.rpcTimer);
        this.publish();
    }

    private setTerminal(task: NativeTaskSummary, status: NativeTaskSummary["status"], timestamp?: string): void {
        // Cleanup cancellation and late registry reads must not override an
        // already observed answer, failure, or cancellation.
        if (terminal(task.status)) return;
        task.status = status;
        task.completedAt = iso(timestamp);
        task.durationMs = Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt));
        if (status === "cancelled") task.error = "Task was cancelled before returning a result.";
        if (status === "interrupted") task.error = "The parent turn ended before a task result was confirmed.";
    }

    private persistBoundary(task: NativeTaskSummary): void {
        if (this.persisted.has(task.id) && !terminal(task.status)) return;
        const signature = JSON.stringify(task);
        if (this.persisted.get(task.id) === signature) return;
        this.persisted.set(task.id, signature);
        this.emit("native.task_updated", { ...this.copy(task), ownerId: this.ownerId, ownerStartedAt: this.ownerStartedAt,
            turnIndex: this.options.turnIndex ?? -1, revision: ++this.revision });
    }

    private emit(eventType: string, data: unknown): void {
        try { this.options.emit({ eventType, data }); } catch { /* telemetry cannot fail a turn */ }
    }

    private copy(task: NativeTaskSummary): NativeTaskSummary {
        return { ...task, ...(task.recentActivity ? { recentActivity: task.recentActivity.map(line => ({ ...line })) } : {}) };
    }

    private publish(): void {
        this.publishTimer = undefined;
        this.lastPublished = Date.now();
        const payload: NativeTasksPayload = { version: 1, ownerId: this.ownerId, ownerStartedAt: this.ownerStartedAt,
            turnIndex: this.options.turnIndex ?? -1, revision: ++this.revision, phase: this.phase,
            tasks: [...this.tasks.values()].map(task => this.copy(task)), ...(this.truncated ? { truncated: true } : {}) };
        // JSON escaping and non-ASCII text can exceed the nominal character
        // budget. Keep the live row below the plane's 256 KiB limit as well.
        while (Buffer.byteLength(JSON.stringify(payload)) > 240_000 && payload.tasks.length) {
            payload.tasks.shift();
            payload.truncated = true;
        }
        this.emit("session.native_tasks_tick", payload);
    }

    private schedulePublish(): void {
        if (this.publishTimer || this.closed) return;
        this.publishTimer = setTimeout(() => this.publish(), Math.max(1, this.intervalMs - (Date.now() - this.lastPublished)));
        this.publishTimer.unref?.();
    }

    private invalidate(): void {
        if (this.closed || this.rpcDisabled) return;
        this.dirty = true;
        if (this.refreshing || this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); },
            Math.max(Math.min(300, this.intervalMs), this.intervalMs - (Date.now() - this.lastRefresh)));
        this.refreshTimer.unref?.();
    }

    private async refresh(): Promise<void> {
        if (this.closed || this.rpcDisabled) return;
        this.dirty = false;
        this.refreshing = true;
        this.lastRefresh = Date.now();
        // Disable registry observation for this turn if an RPC hangs. Do not
        // enqueue more requests behind it; event-based status keeps working.
        this.rpcTimer = setTimeout(() => { this.rpcDisabled = true; }, this.options.timeoutMs ?? 1_500);
        this.rpcTimer.unref?.();
        const active = () => !this.closed && !this.rpcDisabled;
        try {
            const response = await this.session.rpc.tasks.list();
            if (!active()) return;
            // allSettled keeps one failed child RPC from releasing the batch
            // while another request is still pending behind it.
            await Promise.allSettled(response.tasks.filter(row => row.type === "agent").slice(0, 32).map(async row => {
                if (row.type !== "agent") return;
                const task = this.tasks.get(row.toolCallId);
                // Registry-only work has no transcript anchor. In particular,
                // don't import restored tasks from a prior worker/turn.
                if (!task) return;
                if (!terminal(task.status)) {
                    task.agentId = row.id;
                    this.agents.set(row.id, task.id);
                    if (row.status === "idle" || row.status === "running") task.status = row.status === "idle" ? "waiting" : "running";
                    task.model = text(row.resolvedModel ?? row.model) ?? task.model;
                }
                task.result ??= text(row.result, 4_096);
                if (terminal(task.status)) { this.persistBoundary(task); return; }
                const { progress } = await this.session.rpc.tasks.getProgress({ id: row.id });
                if (!active() || terminal(task.status) || progress?.type !== "agent") return;
                task.recentActivity = progress.recentActivity.slice(-5).map(line => ({ message: text(line.message) ?? "", timestamp: iso(line.timestamp) }));
                task.preview = text(progress.latestIntent) ?? task.recentActivity.at(-1)?.message ?? task.preview;
            }));
            if (active()) this.schedulePublish();
        } catch { /* Experimental registry RPC failures are cosmetic. */ }
        finally {
            if (this.rpcTimer) clearTimeout(this.rpcTimer);
            this.rpcTimer = undefined;
            this.refreshing = false;
            if (this.dirty && active()) this.invalidate();
        }
    }
}
