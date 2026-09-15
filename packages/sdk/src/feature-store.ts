import type { Pool, PoolClient, QueryResult } from "pg";
import { FeatureFlagError, applyBaseAgentPrerequisite, isFeatureKey, resolveFeatureDefinition,
    type FeatureDecision, type FeatureDefinition, type FeatureOwner, type FeatureSetting, type FeatureSnapshot } from "./feature-flags.js";

/** Trusted transport/worker identity, never deserialized from a request body. */
export interface FeatureViewer { principal: FeatureOwner | null; isAdmin: boolean }
export interface FeatureMutation {
    featureKey: string; expectedRevision: string; requestId: string;
    enabled?: boolean; allowUserOverride?: boolean;
}
export interface FeatureView {
    userId: number | null;
    flags: Array<FeatureDefinition & { cluster: FeatureSetting | null; user: FeatureSetting | null;
        effective: boolean; source: string; reason?: FeatureDecision["reason"]; userOverrideIgnored: boolean; supported: boolean }>;
}
export interface FeatureMutationResult { featureKey: string; scope: "cluster" | "user"; userId: number | null; revision: string; setting: FeatureSetting | null }

export class FeatureStore {
    private schema: string;
    constructor(private readonly pool: Pool, schema: string) { this.schema = `"${schema.replace(/"/g, '""')}"`; }
    /** Bound pool acquisition and server work without leaving abandoned work queued. */
    private async query(text: string, values: unknown[] = []): Promise<QueryResult> {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let client: PoolClient;
        try {
            client = await Promise.race([
                this.pool.connect().then(connection => {
                    if (expired) { connection.release(); throw new Error("Feature connection acquired after deadline"); }
                    return connection;
                }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { expired = true; reject(new Error("Feature database connection timed out")); }, 5_000);
                }),
            ]);
        } finally { if (timer) clearTimeout(timer); }
        const bounded = (sql: string, parameters: unknown[] = []) => {
            // pg supports query_timeout per query; older @types/pg only exposes it on ClientConfig.
            const query = { text: sql, values: parameters, query_timeout: 6_000 };
            return client.query(query);
        };
        try {
            await bounded("BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
            const result = await bounded(text, values);
            await bounded("COMMIT");
            client.release();
            return result;
        } catch (error) {
            // Destroying the connection rolls back its transaction and cancels
            // abandoned server work, including a socket that stopped responding.
            client.release(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
    private async call<T>(name: string, args: unknown[] = []): Promise<T> {
        try {
            const { rows } = await this.query(`SELECT ${this.schema}.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS result`, args);
            return rows[0]?.result as T;
        } catch (error: any) {
            const match = /^FEATURE_(FORBIDDEN|INVALID|NOT_FOUND|CONFLICT):\s*(.*)$/s.exec(error?.message ?? "");
            if (match) throw new FeatureFlagError(`FEATURE_${match[1]}`, match[2], { FORBIDDEN: 403, INVALID: 400, NOT_FOUND: 404, CONFLICT: 409 }[match[1]]!);
            throw error;
        }
    }
    private actor(viewer: FeatureViewer): [string | null, string | null, boolean] {
        return [viewer?.principal?.provider ?? null, viewer?.principal?.subject ?? null, viewer?.isAdmin === true];
    }
    async revisions(): Promise<Array<{ featureKey: string; revision: string }>> {
        const { rows } = await this.query(`SELECT * FROM ${this.schema}.cms_feature_revisions()`);
        return rows.map(row => ({ featureKey: row.feature_key, revision: row.revision }));
    }
    snapshot(keys: string[]): Promise<FeatureSnapshot> { return this.call("cms_feature_snapshot", [keys]); }
    async read(viewer: FeatureViewer, scope: "cluster" | "user", userId?: number): Promise<FeatureView> {
        if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) throw new FeatureFlagError("FEATURE_INVALID", "Invalid user ID");
        const result = await this.call<FeatureSnapshot & { userId: number | null }>("cms_feature_read", [...this.actor(viewer), scope, userId ?? null]);
        const decisions = new Map(result.definitions.map(definition => [definition.featureKey, resolveFeatureDefinition(definition,
            result.settings.find(setting => setting.featureKey === definition.featureKey && setting.scope === "cluster"),
            result.settings.find(setting => setting.featureKey === definition.featureKey && setting.scope === "user"))]));
        return { userId: result.userId, flags: result.definitions.map(definition => {
            const cluster = result.settings.find(setting => setting.featureKey === definition.featureKey && setting.scope === "cluster");
            const user = result.settings.find(setting => setting.featureKey === definition.featureKey && setting.scope === "user");
            const decision = applyBaseAgentPrerequisite(definition.featureKey, decisions.get(definition.featureKey)!, decisions.get("copilot.native_tasks"));
            return { ...definition, cluster: cluster ?? null, user: user ?? null, effective: decision.enabled,
                ...(decision.reason ? { reason: decision.reason } : {}),
                source: decision.source, supported: isFeatureKey(definition.featureKey),
                userOverrideIgnored: Boolean(user && !(cluster?.allowUserOverride ?? definition.defaultAllowUserOverride)) };
        }) };
    }
    async mutate(viewer: FeatureViewer, scope: "cluster" | "user", input: FeatureMutation, unset = false, userId?: number): Promise<FeatureMutationResult> {
        if (!input || !isFeatureKey(input.featureKey)) throw new FeatureFlagError("FEATURE_NOT_FOUND", "Unknown feature key", 404);
        if (typeof input.expectedRevision !== "string" || !/^[1-9]\d*$/.test(input.expectedRevision)
            || BigInt(input.expectedRevision) > 9223372036854775807n || typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 128
            || userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)
            || !unset && typeof input.enabled !== "boolean"
            || scope === "cluster" && !unset && typeof input.allowUserOverride !== "boolean"
            || scope === "user" && input.allowUserOverride !== undefined
            || unset && (input.enabled !== undefined || input.allowUserOverride !== undefined)) {
            throw new FeatureFlagError("FEATURE_INVALID", "Invalid feature setting, revision or request ID");
        }
        return this.call("cms_feature_mutate", [...this.actor(viewer), scope, userId ?? null, input.featureKey,
            input.enabled ?? null, input.allowUserOverride ?? null, unset, input.expectedRevision, input.requestId]);
    }
    changes(viewer: FeatureViewer, limit = 50): Promise<unknown[]> {
        return this.call("cms_feature_changes", [...this.actor(viewer), Math.max(1, Math.min(200, Math.trunc(limit) || 50))]);
    }
    users(viewer: FeatureViewer, query = ""): Promise<Array<FeatureOwner & { userId: number; email: string | null; displayName: string | null }>> {
        return this.call("cms_feature_users", [...this.actor(viewer), String(query).slice(0, 200)]);
    }
}
