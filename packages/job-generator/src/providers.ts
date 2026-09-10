import type {
    JobDiscovery,
    JobGeneratorDefinitionRow,
    JobGeneratorRow,
    JobGeneratorSourceType,
} from "pilotswarm-sdk";

const SOURCE_PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{0,127}$/;
const MIN_JOB_GENERATOR_LEASE_SECONDS = 30;
const MAX_JOB_GENERATOR_LEASE_SECONDS = 3600;

export interface EvaluationResult {
    discoveries: JobDiscovery[];
    watermark?: unknown;
}

export interface EvaluationContext {
    generator: JobGeneratorRow;
    definition: JobGeneratorDefinitionRow;
    watermark: unknown;
    signal?: AbortSignal;
}

export interface SourceEvaluator {
    readonly type: JobGeneratorSourceType;
    evaluate(context: EvaluationContext): Promise<EvaluationResult>;
}

export type FetchLike = typeof fetch;

export function effectiveJobGeneratorLeaseSeconds(
    value: number,
    label = "JOBGEN_LEASE_SECONDS",
): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return Math.max(
        MIN_JOB_GENERATOR_LEASE_SECONDS,
        Math.min(value, MAX_JOB_GENERATOR_LEASE_SECONDS),
    );
}

interface HttpEvaluatorOptions {
    endpoint?: string;
    token?: string;
    fetch?: FetchLike;
    requestTimeoutMs?: number;
}

export interface RemoteSourceProviderDefinition {
    id: JobGeneratorSourceType;
    endpoint: string;
    tokenEnv?: string;
}

abstract class HttpSourceEvaluator implements SourceEvaluator {
    abstract readonly type: JobGeneratorSourceType;
    protected readonly endpoint?: string;
    protected readonly token?: string;
    protected readonly fetchImpl: FetchLike;
    private readonly requestTimeoutMs: number;

    constructor(options: HttpEvaluatorOptions) {
        this.endpoint = options.endpoint?.trim() || undefined;
        this.token = options.token?.trim() || undefined;
        this.fetchImpl = options.fetch ?? fetch;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
        if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
            throw new Error("source provider request timeout must be a positive integer");
        }
    }

    async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
        if (!this.endpoint) throw new Error(`${this.constructor.name} endpoint is required`);
        return await this.withRequestTimeout(context, async (signal) => {
            const response = await this.fetchImpl(this.endpoint!, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
                },
                body: JSON.stringify(this.requestBody(context)),
                signal,
            });
            if (!response.ok) {
                throw new Error(`${this.type} evaluator request failed: HTTP ${response.status} ${await response.text()}`);
            }
            return this.parse(await response.json(), context.definition.sourceConfig);
        });
    }

    private async withRequestTimeout<T>(
        context: EvaluationContext,
        operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const timeoutController = new AbortController();
        const timeout = setTimeout(
            () => timeoutController.abort(),
            this.requestTimeoutMs,
        );
        timeout.unref();
        const signal = context.signal
            ? AbortSignal.any([context.signal, timeoutController.signal])
            : timeoutController.signal;
        try {
            return await operation(signal);
        } catch (error) {
            if (timeoutController.signal.aborted && !context.signal?.aborted) {
                throw new Error(
                    `${this.type} evaluator request timed out after ${this.requestTimeoutMs}ms`,
                    { cause: error },
                );
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    protected requestBody(context: EvaluationContext): Record<string, unknown> {
        return {
            generatorId: context.generator.generatorId,
            definitionId: context.definition.definitionId,
            config: context.definition.sourceConfig,
            watermark: context.watermark,
        };
    }

    protected abstract parse(body: unknown, config: Record<string, unknown>): EvaluationResult;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stableKey(value: unknown, label: string): string {
    const key = String(value ?? "").trim();
    if (!key) throw new Error(`${label} result is missing a stable key`);
    return key;
}

export function normalizeSourceProviderId(value: unknown): JobGeneratorSourceType {
    const id = String(value ?? "").trim();
    if (!SOURCE_PROVIDER_ID_RE.test(id)) {
        throw new Error(
            "source provider id must start with a lowercase letter and contain only "
            + "lowercase letters, digits, '.', '_', or '-' (maximum 128 characters)",
        );
    }
    return id;
}

function normalizeRemoteProviderEndpoint(value: unknown, providerId: string): string {
    const endpoint = String(value ?? "").trim();
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`remote source provider '${providerId}' endpoint must be an absolute URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(
            `remote source provider '${providerId}' endpoint must use http/https without embedded credentials`,
        );
    }
    return url.toString();
}

export function parseRemoteSourceProviderDefinitions(
    raw: string | undefined,
): RemoteSourceProviderDefinition[] {
    if (!raw?.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `JOBGEN_SOURCE_PROVIDERS_JSON must be valid JSON: ${error instanceof Error ? error.message : error}`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error("JOBGEN_SOURCE_PROVIDERS_JSON must be a JSON array");
    }
    const seen = new Set<string>();
    return parsed.map((value, index) => {
        const definition = record(value);
        const id = normalizeSourceProviderId(definition.id);
        if (seen.has(id)) {
            throw new Error(`JOBGEN_SOURCE_PROVIDERS_JSON contains duplicate provider id '${id}'`);
        }
        seen.add(id);
        const tokenEnv = definition.tokenEnv == null
            ? undefined
            : String(definition.tokenEnv).trim();
        if (tokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
            throw new Error(
                `JOBGEN_SOURCE_PROVIDERS_JSON[${index}].tokenEnv must be an environment variable name`,
            );
        }
        return {
            id,
            endpoint: normalizeRemoteProviderEndpoint(definition.endpoint, id),
            ...(tokenEnv ? { tokenEnv } : {}),
        };
    });
}

function parseNormalizedProviderResponse(body: unknown, providerId: string): EvaluationResult {
    const root = record(body);
    if (!Array.isArray(root.discoveries)) {
        throw new Error(`remote source provider '${providerId}' response must contain discoveries[]`);
    }
    return {
        discoveries: root.discoveries.map((value) => {
            const discovery = record(value);
            const payload = discovery.payload;
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new Error(
                    `remote source provider '${providerId}' discovery payload must be an object`,
                );
            }
            return {
                key: stableKey(discovery.key, `remote source provider '${providerId}'`),
                payload: payload as Record<string, unknown>,
            };
        }),
        ...(Object.hasOwn(root, "watermark") ? { watermark: root.watermark } : {}),
    };
}

export class RemoteSourceEvaluator extends HttpSourceEvaluator {
    readonly type: JobGeneratorSourceType;

    constructor(type: JobGeneratorSourceType, options: HttpEvaluatorOptions) {
        super(options);
        this.type = normalizeSourceProviderId(type);
    }

    protected override requestBody(context: EvaluationContext): Record<string, unknown> {
        const maxItemsPerCycle = Number(
            context.definition.guardrails?.maxItemsPerCycle ?? 0,
        );
        return {
            ...super.requestBody(context),
            limits: Number.isFinite(maxItemsPerCycle) && maxItemsPerCycle > 0
                ? { maxItemsPerCycle }
                : {},
        };
    }

    protected parse(body: unknown): EvaluationResult {
        return parseNormalizedProviderResponse(body, this.type);
    }
}

export function createEvaluatorsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: FetchLike,
): Map<JobGeneratorSourceType, SourceEvaluator> {
    const evaluators = new Map<JobGeneratorSourceType, SourceEvaluator>();
    const leaseSeconds = effectiveJobGeneratorLeaseSeconds(
        Number(env.JOBGEN_LEASE_SECONDS || 300),
    );
    const defaultRequestTimeoutMs = Math.min(
        90_000,
        Math.max(1, Math.floor(leaseSeconds * 1000 * 0.8)),
    );
    const requestTimeoutMs = Number(
        env.JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS || defaultRequestTimeoutMs,
    );
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new Error("JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS must be a positive integer");
    }
    if (requestTimeoutMs >= leaseSeconds * 1000) {
        throw new Error(
            "JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS must be shorter than JOBGEN_LEASE_SECONDS",
        );
    }
    const register = (evaluator: SourceEvaluator) => {
        if (evaluators.has(evaluator.type)) {
            throw new Error(`duplicate source provider registration for '${evaluator.type}'`);
        }
        evaluators.set(evaluator.type, evaluator);
    };
    const remoteDefinitions = parseRemoteSourceProviderDefinitions(
        env.JOBGEN_SOURCE_PROVIDERS_JSON,
    );
    const hasLegacyKustoConfiguration = [
        env.JOBGEN_KUSTO_ENDPOINT,
        env.JOBGEN_KUSTO_TOKEN,
    ].some((value) => value?.trim());
    if (
        hasLegacyKustoConfiguration
        && !remoteDefinitions.some((definition) => definition.id === "kusto")
    ) {
        throw new Error(
            "JOBGEN_KUSTO_* settings are no longer supported by JobGenerator core; "
            + "register provider 'kusto' through JOBGEN_SOURCE_PROVIDERS_JSON",
        );
    }
    const hasLegacyAdoWiqlConfiguration = [
        env.JOBGEN_ADO_WIQL_ENDPOINT,
        env.JOBGEN_ADO_WIQL_TOKEN,
        env.JOBGEN_ADO_WIQL_DIRECT,
    ].some((value) => value?.trim());
    if (
        hasLegacyAdoWiqlConfiguration
        && !remoteDefinitions.some((definition) => definition.id === "ado_wiql")
    ) {
        throw new Error(
            "JOBGEN_ADO_WIQL_* settings are no longer supported by JobGenerator core; "
            + "register provider 'ado_wiql' through JOBGEN_SOURCE_PROVIDERS_JSON",
        );
    }
    const hasLegacyIcmConfiguration = [
        env.JOBGEN_ICM_ENDPOINT,
        env.JOBGEN_ICM_TOKEN,
        env.JOBGEN_ICM_DIRECT,
    ].some((value) => value?.trim());
    if (
        hasLegacyIcmConfiguration
        && !remoteDefinitions.some((definition) => definition.id === "icm")
    ) {
        throw new Error(
            "JOBGEN_ICM_* settings are no longer supported; register provider 'icm' "
            + "through JOBGEN_SOURCE_PROVIDERS_JSON",
        );
    }
    for (const definition of remoteDefinitions) {
        const token = definition.tokenEnv ? env[definition.tokenEnv]?.trim() : undefined;
        if (definition.tokenEnv && !token) {
            throw new Error(
                `remote source provider '${definition.id}' requires token env ${definition.tokenEnv}`,
            );
        }
        register(new RemoteSourceEvaluator(definition.id, {
            endpoint: definition.endpoint,
            token,
            fetch: fetchImpl,
            requestTimeoutMs,
        }));
    }
    return evaluators;
}
