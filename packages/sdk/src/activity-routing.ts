import { createHash } from "node:crypto";
import type { TagFilter } from "duroxide";
import type { SerializableSessionConfig, SessionOwnerInfo } from "./types.js";

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

/** Resolve the one duroxide tag that must match before a worker can run a turn. */
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
