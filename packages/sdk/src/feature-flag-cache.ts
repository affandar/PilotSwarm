import { FEATURE_FLAGS, assertResolveOptions, featureOwnerKey, isFeatureKey, resolveFeatureDefinition, unresolvedFeature,
    type FeatureDecision, type FeatureDefinition, type FeatureKey, type FeatureOwner,
    type FeatureSetting, type FeatureSnapshot, type ResolveOptions } from "./feature-flags.js";

export interface FeatureCacheStore {
    revisions(): Promise<Array<{ featureKey: string; revision: string }>>;
    snapshot(keys: string[]): Promise<FeatureSnapshot>;
}
interface CachedFeature { definition: FeatureDefinition; cluster?: FeatureSetting; users: Map<string, FeatureSetting> }

/** One poll at a time; complete per-feature replacement makes unset observable. */
export class FeatureFlagCache {
    private features = new Map<string, CachedFeature>();
    private initialized = false;
    private loading: Promise<void> | null = null;
    private stopped = false;
    private listeners = new Set<() => void>();
    private lastError: string | null = null;
    private lastCheckedAt: string | null = null;
    private lastLoadedAt: string | null = null;
    constructor(private readonly store: FeatureCacheStore, private readonly readTimeoutMs = 10_000) {}
    private async read<T>(operation: () => Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Feature configuration read timed out")), this.readTimeoutMs);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    resolve(key: FeatureKey, owner: FeatureOwner | null | undefined, options: ResolveOptions): FeatureDecision {
        assertResolveOptions(options);
        const stale = this.lastError !== null;
        if (!isFeatureKey(key)) return unresolvedFeature(key, options, "unknown_key", stale);
        if (!this.initialized) return unresolvedFeature(key, options, "cache_unavailable", stale);
        const value = this.features.get(key);
        if (!value) return unresolvedFeature(key, options, "catalog_missing", stale);
        return resolveFeatureDefinition(value.definition, value.cluster, owner ? value.users.get(featureOwnerKey(owner)) : undefined, stale);
    }
    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    get state() {
        return { appliedRevisions: Object.fromEntries([...this.features].map(([key, v]) => [key, v.definition.revision])),
            supportedKeys: Object.keys(FEATURE_FLAGS), protocolVersion: 1, initialized: this.initialized,
            lastCheckedAt: this.lastCheckedAt, lastLoadedAt: this.lastLoadedAt, lastError: this.lastError };
    }
    pollRevisionsAndRefresh(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.loading) return this.loading;
        this.loading = this.refresh().finally(() => { this.loading = null; });
        return this.loading;
    }
    private async refresh(): Promise<void> {
        try {
            const revisions = await this.read(() => this.store.revisions());
            if (!Array.isArray(revisions) || revisions.some(r => typeof r.featureKey !== "string" || !/^[1-9]\d*$/.test(r.revision))
                || new Set(revisions.map(r => r.featureKey)).size !== revisions.length) throw new Error("Invalid feature revision catalog");
            const advertised = new Map(revisions.map(r => [r.featureKey, r.revision]));
            const changed = revisions.filter(r => this.features.get(r.featureKey)?.definition.revision !== r.revision).map(r => r.featureKey);
            const snapshot = changed.length ? await this.read(() => this.store.snapshot(changed)) : { definitions: [], settings: [] };
            const next = new Map(this.features);
            for (const key of next.keys()) if (!advertised.has(key)) next.delete(key);
            for (const key of changed) next.delete(key);
            const loaded = new Set<string>();
            for (const definition of snapshot.definitions) {
                if (!changed.includes(definition.featureKey) || loaded.has(definition.featureKey)
                    || typeof definition.defaultEnabled !== "boolean" || typeof definition.defaultAllowUserOverride !== "boolean"
                    || !/^[1-9]\d*$/.test(definition.revision)
                    || BigInt(definition.revision) < BigInt(advertised.get(definition.featureKey)!)
                    || BigInt(definition.revision) < BigInt(this.features.get(definition.featureKey)?.definition.revision ?? "0")) {
                    throw new Error("Invalid or stale feature snapshot");
                }
                loaded.add(definition.featureKey);
                next.set(definition.featureKey, { definition: { ...definition }, users: new Map() });
            }
            for (const setting of snapshot.settings) {
                const value = next.get(setting.featureKey);
                if (!loaded.has(setting.featureKey) || !value || typeof setting.enabled !== "boolean"
                    || !/^[1-9]\d*$/.test(setting.revision) || BigInt(setting.revision) > BigInt(value.definition.revision)) throw new Error("Invalid feature setting snapshot");
                const copy = { ...setting, ...(setting.owner ? { owner: { ...setting.owner } } : {}) };
                if (setting.scope === "cluster") {
                    if (value.cluster || setting.userId !== null || typeof setting.allowUserOverride !== "boolean") throw new Error("Invalid cluster feature setting");
                    value.cluster = copy;
                } else if (setting.scope === "user" && setting.owner?.provider && setting.owner.subject && setting.userId != null && setting.allowUserOverride === null) {
                    const key = featureOwnerKey(setting.owner);
                    if (value.users.has(key)) throw new Error("Duplicate user feature setting");
                    value.users.set(key, copy);
                } else throw new Error("Invalid user feature setting");
            }
            if (this.stopped) return;
            const changedState = !this.initialized || changed.length > 0 || next.size !== this.features.size;
            this.features = next; this.initialized = true; this.lastError = null;
            this.lastCheckedAt = new Date().toISOString();
            if (changedState) {
                this.lastLoadedAt = this.lastCheckedAt;
                for (const listener of this.listeners) listener();
            }
        } catch (error) {
            if (!this.stopped) { this.lastError = String((error as Error)?.message ?? error); this.lastCheckedAt = new Date().toISOString(); }
        }
    }
    async stop(): Promise<void> { this.stopped = true; this.listeners.clear(); await this.loading; }
}
