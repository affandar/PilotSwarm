import type { SessionOwnerInfo } from "./types.js";

export type SessionOwnerKind = "user" | "system" | "unowned";

/**
 * Synthetic principal used by the native TUI / non-authenticated local
 * deployments so user-scoped surfaces (Admin Console, profile settings,
 * per-user GitHub Copilot key) have a stable identity to attach to.
 *
 * Portal / authenticated deployments derive the real principal from the
 * portal auth provider — never use this constant in those code paths.
 */
export const LOCAL_DEFAULT_USER_PRINCIPAL: Readonly<SessionOwnerInfo> = Object.freeze({
    provider: "local",
    subject: "default",
    email: null,
    displayName: "Local User",
});

export interface SessionOwnerFilterOptions {
    includeSystem?: boolean;
    ownerQuery?: string | null;
    ownerKind?: string | null;
}

type SessionOwnerLike = {
    isSystem?: boolean | null;
    owner?: SessionOwnerInfo | null;
};

type OwnerBucketLike = {
    ownerKind?: string | null;
    owner?: SessionOwnerInfo | null;
};

export function normalizeSessionOwnerKind(value: string | null | undefined): SessionOwnerKind | null {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "user" || normalized === "system" || normalized === "unowned") {
        return normalized;
    }
    return null;
}

export function getSessionOwnerKind(session: SessionOwnerLike | null | undefined): SessionOwnerKind {
    if (session?.isSystem) return "system";
    return session?.owner ? "user" : "unowned";
}

export function getOwnerBucketKind(bucket: OwnerBucketLike | null | undefined): SessionOwnerKind {
    const normalized = normalizeSessionOwnerKind(bucket?.ownerKind);
    if (normalized) return normalized;
    return bucket?.owner ? "user" : "unowned";
}

export function formatOwnerLabel(owner: SessionOwnerInfo | null | undefined): string {
    if (!owner) return "";
    const displayName = String(owner.displayName || "").trim();
    const email = String(owner.email || "").trim();
    if (displayName && email && displayName.toLowerCase() !== email.toLowerCase()) {
        return `${displayName} <${email}>`;
    }
    return displayName || email || [owner.provider, owner.subject].filter(Boolean).join(":") || "user";
}

function buildOwnerSearchText(ownerKind: SessionOwnerKind, owner: SessionOwnerInfo | null | undefined): string {
    if (ownerKind !== "user") return ownerKind;
    return [
        formatOwnerLabel(owner),
        owner?.displayName,
        owner?.email,
        owner?.subject,
        owner?.provider,
    ].filter(Boolean).join(" ").toLowerCase();
}

export function matchesSessionOwnerFilters(
    session: SessionOwnerLike | null | undefined,
    filters: SessionOwnerFilterOptions = {},
): boolean {
    if (!session) return false;
    if (filters.includeSystem === false && session.isSystem) return false;

    const ownerKind = getSessionOwnerKind(session);
    const expectedKind = normalizeSessionOwnerKind(filters.ownerKind);
    if (expectedKind && ownerKind !== expectedKind) return false;

    const query = String(filters.ownerQuery || "").trim().toLowerCase();
    if (!query) return true;
    return buildOwnerSearchText(ownerKind, session.owner).includes(query);
}

export function matchesOwnerBucketFilters(
    bucket: OwnerBucketLike | null | undefined,
    filters: Pick<SessionOwnerFilterOptions, "ownerQuery" | "ownerKind"> = {},
): boolean {
    if (!bucket) return false;

    const ownerKind = getOwnerBucketKind(bucket);
    const expectedKind = normalizeSessionOwnerKind(filters.ownerKind);
    if (expectedKind && ownerKind !== expectedKind) return false;

    const query = String(filters.ownerQuery || "").trim().toLowerCase();
    if (!query) return true;
    return buildOwnerSearchText(ownerKind, bucket.owner).includes(query);
}

export function formatSessionOwnerLabel(session: SessionOwnerLike | null | undefined): string {
    const ownerKind = getSessionOwnerKind(session);
    if (ownerKind === "system") return "system";
    if (ownerKind === "unowned") return "unowned";
    return formatOwnerLabel(session?.owner);
}

export function formatOwnerBucketLabel(bucket: OwnerBucketLike | null | undefined): string {
    const ownerKind = getOwnerBucketKind(bucket);
    if (ownerKind === "system") return "system";
    if (ownerKind === "unowned") return "unowned";
    return formatOwnerLabel(bucket?.owner);
}