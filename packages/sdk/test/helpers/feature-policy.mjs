import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";

/** Explicit policy for isolated native runtime fixtures, with real cache refresh. */
export async function createFeaturePolicy(initial = true) {
    const featureKey = "copilot.native_tasks";
    let enabled = initial, revision = 1, user = null;
    const cache = new FeatureFlagCache({
        revisions: async () => [{ featureKey, revision: String(revision) }],
        snapshot: async () => ({ definitions: [{ featureKey, ...FEATURE_FLAGS[featureKey], revision: String(revision) }],
            settings: [{ featureKey, scope: "cluster", userId: null, enabled, allowUserOverride: Boolean(user), revision: String(revision) }, ...(user ? [user] : [])] }),
    });
    await cache.pollRevisionsAndRefresh();
    return { cache, async set(value) { enabled = value; revision++; await cache.pollRevisionsAndRefresh(); },
        async setForUser(owner, value) { revision++; user = { featureKey, scope: "user", userId: 1, owner, enabled: value, allowUserOverride: null, revision: String(revision) }; await cache.pollRevisionsAndRefresh(); } };
}
