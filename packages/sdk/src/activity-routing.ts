/**
 * Duroxide activity routing for durable sessions.
 *
 * Two independent mechanisms share this module, and they meet on `runTurn`:
 *
 *   1. CAPABILITY ROUTING (`AGENT_HANDOFF_CAPABILITY`, `HANDOFF_ACTIVITY_NAMES`)
 *      — the complete named-agent handoff contract. Old orchestrations omit the
 *      contract and keep their exact activity names, inputs and descriptors;
 *      orchestrations 1.0.75 and later opt in.
 *   2. OWNER/REPO AFFINITY (`runTurnRoutingTag`, `scopeWorkerTagFilter`) — a
 *      session's turn may only run on a worker enlisted in that session's repo,
 *      and, for personal workers, only on the owner's own worker.
 *
 * Duroxide carries ONE tag per scheduled activity (`withTag` replaces, it does
 * not accumulate), so the two cannot both be expressed as tags on the same
 * activity. The split is deliberate:
 *
 *   - Support activities of the handoff contract (resolveAgentConfig,
 *     resolveAgentForRequiredTool, spawnChildSession, getSessionStatus,
 *     listChildSessions) are owner/repo-agnostic and carry the capability tag,
 *     so a worker that cannot execute the contract never dequeues them.
 *   - `runTurn`/`runTurn2` carry the repo/owner affinity tag instead: isolation
 *     is a security boundary (a repo fleet must never run another repo's — or
 *     another owner's — turn inside its enlistment), and it must hold for every
 *     orchestration version, contract or not. The capability requirement on a
 *     turn is therefore carried by the two non-tag halves of the contract that
 *     `routeHandoffActivity` and `routedActivityName` still enforce: the
 *     tag-routing support check (fail closed on an SDK that cannot route), and
 *     the versioned activity name (`runTurnV3` / `runTurnEpochV3`), which a
 *     worker built before the contract never registers — so a stale worker in
 *     the repo fleet fails the activity loudly instead of silently running a
 *     turn whose handoff semantics it does not implement.
 *
 * @internal
 */
import { createHash } from "node:crypto";
import type { TagFilter } from "duroxide";
import type { SerializableSessionConfig, SessionOwnerInfo } from "./types.js";

// ─── Capability routing: named-agent handoff contract ────────────

/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Orchestrations 1.0.75 and later opt into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
export type ActivityRoutingContract = "agent-handoff-v2";
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
    getSessionStatus: "getSessionStatusV2",
    listChildSessions: "listChildSessionsV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

/**
 * Tag a contract activity with the handoff capability.
 *
 * Callers that must also pin repo/owner affinity (`runTurn`) re-tag the
 * returned task with `runTurnRoutingTag` — the last `withTag` wins, and the
 * affinity tag is the one the worker matches on. The value of this call on that
 * path is the fail-closed check below: an SDK that cannot express routing tags
 * cannot honour EITHER contract, and must not silently schedule untagged work.
 */
export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(AGENT_HANDOFF_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any, versionedHandler = handler): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], versionedHandler);
}

// ─── Owner / repo affinity routing ───────────────────────────────

export type OwnerAffinityPrincipal = Pick<SessionOwnerInfo, "provider" | "subject">;

const OWNER_TAG_PREFIX = "owner:v1:";

function normalizedOwner(owner: OwnerAffinityPrincipal): OwnerAffinityPrincipal {
    const provider = owner.provider?.trim().toLowerCase();
    const subject = owner.subject?.trim();
    if (!provider || !subject) {
        throw new Error("Owner affinity requires a non-empty provider and subject");
    }
    return { provider, subject };
}

/** Stable, non-reversible routing identity for one authenticated owner. */
export function ownerAffinityKey(owner: OwnerAffinityPrincipal): string {
    const normalized = normalizedOwner(owner);
    return createHash("sha256")
        .update(`${normalized.provider}\0${normalized.subject}`)
        .digest("hex")
        .slice(0, 32);
}

function ownerScopedTag(owner: OwnerAffinityPrincipal, baseTag: string): string {
    return `${OWNER_TAG_PREFIX}${ownerAffinityKey(owner)}|${baseTag}`;
}

export function isOwnerScopedRoutingTag(tag: string): boolean {
    return tag.startsWith(OWNER_TAG_PREFIX);
}

/**
 * Resolve the one duroxide tag that must match before a worker can run a turn.
 *
 * This tag is applied LAST on the runTurn path (see the module header): repo
 * and owner isolation outrank the handoff capability tag, which the contract
 * still represents through the versioned activity name.
 */
export function runTurnRoutingTag(
    config: Pick<SerializableSessionConfig, "repo" | "ownerAffinity">,
): string {
    const baseTag = config.repo ? `repo:${config.repo}` : "generic";
    return config.ownerAffinity ? ownerScopedTag(config.ownerAffinity, baseTag) : baseTag;
}

/**
 * Scope repo/generic tags to a personal worker owner. Untagged support
 * activities remain available through defaultAnd; only runTurn is owner-bound.
 */
export function scopeWorkerTagFilter(
    filter: TagFilter | undefined,
    owner: OwnerAffinityPrincipal | null | undefined,
): TagFilter | undefined {
    if (filter === "any") {
        throw new Error('PilotSwarm workers cannot use workerTagFilter "any"');
    }
    if (filter === undefined || filter === "none" || filter === "defaultOnly") {
        return filter;
    }
    const tags = "defaultAnd" in filter ? filter.defaultAnd : filter.tags;
    if (!owner) {
        if (tags.some(isOwnerScopedRoutingTag)) {
            throw new Error("Owner-scoped routing tags require workerOwner");
        }
        return filter;
    }

    const expectedPrefix = `${OWNER_TAG_PREFIX}${ownerAffinityKey(owner)}|`;
    const scopeTag = (tag: string): string => {
        if (isOwnerScopedRoutingTag(tag)) {
            if (!tag.startsWith(expectedPrefix)) {
                throw new Error("Worker routing tag owner does not match workerOwner");
            }
            return tag;
        }
        return tag === "generic" || tag.startsWith("repo:")
            ? ownerScopedTag(owner, tag)
            : tag;
    };
    const scoped = [...new Set(tags.map(scopeTag))];
    return "defaultAnd" in filter ? { defaultAnd: scoped } : { tags: scoped };
}

/** Add a required capability without weakening the worker's existing tag mode. */
export function requireWorkerRoutingTag(
    filter: TagFilter | undefined,
    requiredTag: string,
): TagFilter {
    if (filter === "none") return filter;
    if (filter === "any") {
        throw new Error('PilotSwarm workers cannot use workerTagFilter "any"');
    }
    if (filter === undefined || filter === "defaultOnly") {
        return { defaultAnd: [requiredTag] };
    }
    const tags = "defaultAnd" in filter ? filter.defaultAnd : filter.tags;
    const combined = [...new Set([...tags, requiredTag])];
    return "defaultAnd" in filter ? { defaultAnd: combined } : { tags: combined };
}

/** Extract repo affinity from either a legacy or owner-scoped routing tag. */
export function repoFromRoutingTag(tag: string): string | null {
    const separator = tag.indexOf("|");
    const baseTag = isOwnerScopedRoutingTag(tag) && separator >= 0
        ? tag.slice(separator + 1)
        : tag;
    return baseTag.startsWith("repo:") ? baseTag.slice("repo:".length) || null : null;
}

/** Resolve the personal worker identity supplied by trusted host configuration. */
export function workerOwnerFromEnv(
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): OwnerAffinityPrincipal | undefined {
    const provider = env.PILOTSWARM_WORKER_OWNER_PROVIDER?.trim();
    const subject = env.PILOTSWARM_WORKER_OWNER_SUBJECT?.trim();
    if (!provider && !subject) return undefined;
    if (!provider || !subject) {
        throw new Error(
            "PILOTSWARM_WORKER_OWNER_PROVIDER and PILOTSWARM_WORKER_OWNER_SUBJECT must be set together",
        );
    }
    return normalizedOwner({ provider, subject });
}
