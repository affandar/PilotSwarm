/** Code-owned definitions. Publish changes through a versioned CMS migration. */
export const FEATURE_FLAGS = {
    "copilot.native_tasks": {
        displayName: "Native Copilot tasks",
        description: "Allow Copilot to delegate local work to native tasks on the same worker.",
        defaultEnabled: false,
        defaultAllowUserOverride: true,
        requiredCapability: "copilot.native_tasks",
    },
    "agents.base_v2": {
        displayName: "Base Agent V2",
        description: "Use the discovery-first base instructions with native tasks. Requires Native Copilot tasks; package tools remain available in either mode.",
        defaultEnabled: false,
        defaultAllowUserOverride: true,
        requiredCapability: "agents.base_v2",
    },
} as const;
export type FeatureKey = keyof typeof FEATURE_FLAGS;
export type ResolveOptions = { fallback: boolean; required?: never } | { required: true; fallback?: never };
export interface FeatureOwner { provider: string; subject: string }
export interface FeatureDefinition {
    featureKey: string; displayName: string; description: string;
    defaultEnabled: boolean; defaultAllowUserOverride: boolean;
    requiredCapability: string | null; revision: string;
}
export interface FeatureSetting {
    settingId: string; featureKey: string; scope: "cluster" | "user";
    userId: number | null; enabled: boolean; allowUserOverride: boolean | null;
    revision: string; updatedBy: string; updatedAt: string;
    owner?: FeatureOwner;
}
export interface FeatureSnapshot { definitions: FeatureDefinition[]; settings: FeatureSetting[] }
export interface FeatureDecision {
    enabled: boolean; source: "cluster" | "user" | "default" | "fallback";
    revision: string | null; stale: boolean;
    reason?: "unknown_key" | "catalog_missing" | "cache_unavailable" | "requires_native_tasks";
}
export class FeatureFlagError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 400) {
        super(message); this.name = "FeatureFlagError";
    }
}
export class FeatureFlagResolutionError extends FeatureFlagError {
    constructor(code: string, key: string) { super(code, `Cannot resolve feature ${key}: ${code}`, 503); this.name = "FeatureFlagResolutionError"; }
}
export function isFeatureKey(key: string): key is FeatureKey { return Object.hasOwn(FEATURE_FLAGS, key); }
export function featureOwnerKey(owner: FeatureOwner): string { return JSON.stringify([owner.provider, owner.subject]); }
export function assertResolveOptions(options: ResolveOptions): void {
    if (!options || typeof options !== "object"
        || !(typeof options.fallback === "boolean" && options.required === undefined
            || options.required === true && options.fallback === undefined)) {
        throw new TypeError("Feature resolution requires either { fallback: boolean } or { required: true }");
    }
}
export function unresolvedFeature(key: string, options: ResolveOptions, reason: FeatureDecision["reason"], stale = false): FeatureDecision {
    if (options.required) throw new FeatureFlagResolutionError(reason!, key);
    return { enabled: options.fallback!, source: "fallback", revision: null, reason, stale };
}
export function resolveFeatureDefinition(definition: FeatureDefinition, cluster?: FeatureSetting, user?: FeatureSetting, stale = false): FeatureDecision {
    const enabled = cluster?.enabled ?? definition.defaultEnabled;
    const allowOverride = cluster?.allowUserOverride ?? definition.defaultAllowUserOverride;
    return { enabled: allowOverride && user ? user.enabled : enabled,
        source: allowOverride && user ? "user" : cluster ? "cluster" : "default",
        revision: definition.revision, stale };
}

/** A narrow prerequisite for the base prompt; saved preferences remain independent. */
export function applyBaseAgentPrerequisite(key: string, decision: FeatureDecision, native: FeatureDecision | undefined): FeatureDecision {
    if (key !== "agents.base_v2" || !decision.enabled || native?.enabled === true) return decision;
    return { ...decision, enabled: false, stale: decision.stale || native?.stale === true, reason: "requires_native_tasks" };
}
