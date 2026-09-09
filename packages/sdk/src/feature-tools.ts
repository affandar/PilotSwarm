import { defineTool } from "@github/copilot-sdk";
import type { FeatureMutation, FeatureStore, FeatureViewer } from "./feature-store.js";

export const FEATURE_OPERATION_SPECS = [
    { method: "listFeatureFlagUsers", name: "list_feature_flag_users", kind: "users", scope: "cluster", description: "Admin: find users and their IDs for feature preferences." },
    { method: "listFeatureFlags", name: "list_feature_flags", kind: "read", scope: "cluster", description: "List code-defined feature flags, defaults and current revisions." },
    { method: "getClusterFeatureFlags", name: "get_cluster_feature_flags", kind: "read", scope: "cluster", description: "Read cluster feature settings and allowUserOverride policy." },
    { method: "setClusterFeatureFlag", name: "set_cluster_feature_flag", kind: "set", scope: "cluster", description: "Admin: set cluster enabled and allowUserOverride atomically. Read the current revision first." },
    { method: "resetClusterFeatureFlag", name: "reset_cluster_feature_flag", kind: "unset", scope: "cluster", description: "Admin: reset cluster settings to published code defaults." },
    { method: "getMyFeatureFlags", name: "get_my_feature_flags", kind: "read", scope: "user", description: "Read your feature preferences and effective values." },
    { method: "setMyFeatureFlag", name: "set_my_feature_flag", kind: "set", scope: "user", description: "Set your feature preference. Locked cluster policy still wins." },
    { method: "unsetMyFeatureFlag", name: "unset_my_feature_flag", kind: "unset", scope: "user", description: "Remove your feature preference to inherit cluster policy." },
    { method: "getUserFeatureFlags", name: "get_user_feature_flags", kind: "read", scope: "user", targetUser: true, description: "Admin: read a specific user's feature preferences." },
    { method: "setUserFeatureFlag", name: "set_user_feature_flag", kind: "set", scope: "user", targetUser: true, description: "Admin: set a specific user's feature preference." },
    { method: "unsetUserFeatureFlag", name: "unset_user_feature_flag", kind: "unset", scope: "user", targetUser: true, description: "Admin: remove a specific user's preference to inherit cluster policy." },
    { method: "listFeatureFlagChanges", name: "list_feature_flag_changes", kind: "audit", scope: "cluster", description: "Admin: read feature-setting audit history." },
] as const;
export type FeatureOperationSpec = typeof FEATURE_OPERATION_SPECS[number];
export function featureToolParameters(spec: FeatureOperationSpec) {
    const properties: Record<string, { type: string; description?: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }> = {};
    const required: string[] = [];
    if ("targetUser" in spec) { properties.userId = { type: "integer", minimum: 1 }; required.push("userId"); }
    if (spec.kind === "set" || spec.kind === "unset") {
        properties.featureKey = { type: "string", description: "A key from list_feature_flags." };
        properties.expectedRevision = { type: "string", description: "Revision returned by the latest read; reload on conflict." };
        properties.requestId = { type: "string", minLength: 1, maxLength: 128, description: "Unique ID for this change. Reuse unchanged when retrying an uncertain response." };
        required.push("featureKey", "expectedRevision", "requestId");
    }
    if (spec.kind === "set") { properties.enabled = { type: "boolean" }; required.push("enabled"); }
    if (spec.kind === "set" && spec.scope === "cluster") { properties.allowUserOverride = { type: "boolean" }; required.push("allowUserOverride"); }
    if (spec.kind === "audit") properties.limit = { type: "integer", minimum: 1, maximum: 200 };
    if (spec.kind === "users") properties.query = { type: "string", maxLength: 200 };
    return { type: "object" as const, properties, required, additionalProperties: false };
}
export function runFeatureStoreOperation(store: FeatureStore, spec: FeatureOperationSpec, viewer: FeatureViewer, args: Record<string, any>) {
    const userId = "targetUser" in spec ? args.userId : undefined;
    if (spec.kind === "read") return store.read(viewer, spec.scope, userId);
    if (spec.kind === "audit") return store.changes(viewer, args.limit);
    if (spec.kind === "users") return store.users(viewer, args.query);
    return store.mutate(viewer, spec.scope, args as FeatureMutation, spec.kind === "unset", userId);
}
export function createFeatureTools(store: FeatureStore, resolveViewer: () => Promise<FeatureViewer>) {
    return FEATURE_OPERATION_SPECS.map(spec => defineTool(spec.name, {
        description: spec.description,
        parameters: featureToolParameters(spec),
        handler: async (args: Record<string, any>) => JSON.stringify(await runFeatureStoreOperation(store, spec, await resolveViewer(), args)),
    }));
}
