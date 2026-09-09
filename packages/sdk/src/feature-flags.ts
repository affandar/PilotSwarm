/** Code-owned definitions. Publish changes through a versioned CMS migration. */
export const FEATURE_FLAGS = {
    "copilot.native_tasks": {
        displayName: "Native Copilot tasks",
        description: "Allow Copilot to delegate local work to native tasks on the same worker.",
        defaultEnabled: false,
        defaultAllowUserOverride: false,
        requiredCapability: "copilot.native_tasks",
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
    reason?: "unknown_key" | "catalog_missing" | "cache_unavailable";
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
