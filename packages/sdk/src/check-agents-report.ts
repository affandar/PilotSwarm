/**
 * The `check_agents` report, as a DELTA.
 *
 * On waldemort chk (2026-08-30) the tool was called 124 times at 5–13K chars
 * each, and 84% of the lines were identical to the previous call. Every copy
 * stays in the parent's transcript and is re-read by every later model call.
 *
 * Children that changed since the parent's last call get the full block
 * (Output capped); the rest are one roster line each. "Changed" is decided
 * against a memo of what the parent last saw — status + a hash of the
 * result text per child — which the caller persists (session-proxy stores it
 * as a `session.check_agents_memo` CMS event). No memo means everything is
 * new and everything is printed in full, so a lost memo only costs one
 * extra full report.
 *
 * Pure: no I/O, so it is unit-testable without the inline client.
 *
 * @internal
 */
import { createHash } from "node:crypto";

export const CHECK_AGENTS_OUTPUT_CAP = 1000;
export const CHECK_AGENTS_MEMO_EVENT = "session.check_agents_memo";

export interface CheckAgentsChild {
    orchId: string;
    title?: string | null;
    status?: string | null;
    contractStatus?: string | null;
    verdict?: string | null;
    iterations?: number | null;
    contractViolations?: unknown[] | null;
    result?: string | null;
    error?: string | null;
}

export interface CheckAgentsMemo {
    at?: string;
    perChild?: Record<string, { status: string; hash: string }>;
}

export interface CheckAgentsReport {
    text: string;
    changed: number;
    perChild: Record<string, { status: string; hash: string }>;
}

function capOutput(text: string): string {
    if (text.length <= CHECK_AGENTS_OUTPUT_CAP) return text;
    return `${text.slice(0, CHECK_AGENTS_OUTPUT_CAP)}… [${text.length - CHECK_AGENTS_OUTPUT_CAP} more chars; read_agent_events for the full result]`;
}

function fullBlock(agent: CheckAgentsChild): string {
    const violations = Array.isArray(agent.contractViolations) && agent.contractViolations.length > 0
        ? `    Violations: ${agent.contractViolations.map((v: any) => v?.code || v?.message || "violation").join(", ")}\n`
        : "";
    return `  - Agent ${agent.orchId}\n` +
        `    Title: ${agent.title ?? "(untitled)"}\n` +
        `    Status: ${agent.status}\n` +
        `    Contract: ${agent.contractStatus ?? "none"}\n` +
        `    Verdict: ${agent.verdict ?? "none"}\n` +
        `    Iterations: ${agent.iterations ?? 0}\n` +
        violations +
        `    Output: ${capOutput(String(agent.result ?? agent.error ?? "(no output yet)"))}`;
}

export function fingerprintChild(agent: CheckAgentsChild): { status: string; hash: string } {
    return {
        status: String(agent.status ?? ""),
        hash: createHash("sha1").update(String(agent.result ?? agent.error ?? "")).digest("hex").slice(0, 12),
    };
}

export function buildCheckAgentsReport(
    children: CheckAgentsChild[],
    memo: CheckAgentsMemo | null | undefined,
    opts: { full?: boolean } = {},
): CheckAgentsReport {
    const perChild: Record<string, { status: string; hash: string }> = {};
    let changed = 0;
    const since = memo?.at ?? "your last check";
    const lines = children.map((agent) => {
        const fp = fingerprintChild(agent);
        perChild[agent.orchId] = fp;
        const seen = memo?.perChild?.[agent.orchId];
        const isChanged = !memo || !seen || seen.status !== fp.status || seen.hash !== fp.hash;
        if (isChanged) changed += 1;
        if (opts.full || isChanged) return fullBlock(agent);
        return `  - Agent ${agent.orchId} · ${agent.status} · unchanged since ${since}`;
    });
    const header = opts.full || !memo
        ? `Sub-agent status report (${children.length} agents)`
        : `Sub-agent status report (${children.length} agents, ${changed} changed since ${since}; pass full=true for all)`;
    return { text: `[SYSTEM: ${header}:\n${lines.join("\n")}]`, changed, perChild };
}
