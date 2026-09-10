export const JOB_GENERATOR_PROVIDER_API_VERSION =
    "pilotswarm.job-generator-provider/v1" as const;

const SOURCE_PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{0,127}$/;

export interface ProviderLimits {
    maxItemsPerCycle?: number;
}

export interface ProviderRequest {
    generatorId: string;
    definitionId: string;
    config: Record<string, unknown>;
    watermark: unknown;
    limits?: ProviderLimits;
}

export interface ProviderDiscovery {
    key: string;
    payload: Record<string, unknown>;
}

export interface ProviderResponse {
    discoveries: ProviderDiscovery[];
    watermark?: unknown;
}

export interface ProviderEvaluationContext {
    signal: AbortSignal;
}

export interface SourceProvider {
    readonly id: string;
    evaluate(
        request: ProviderRequest,
        context: ProviderEvaluationContext,
    ): Promise<ProviderResponse>;
    close?(): Promise<void>;
}

export interface ProviderFactoryContext {
    id: string;
    config: Readonly<Record<string, unknown>>;
    env: Readonly<NodeJS.ProcessEnv>;
    fetch: typeof fetch;
    logger: Pick<Console, "info" | "warn" | "error">;
}

export interface SourceProviderPlugin {
    readonly apiVersion: typeof JOB_GENERATOR_PROVIDER_API_VERSION;
    readonly id: string;
    createProvider(
        context: ProviderFactoryContext,
    ): SourceProvider | Promise<SourceProvider>;
}

export class ProviderValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProviderValidationError";
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(
    value: unknown,
    path: string,
    ancestors: Set<object>,
): void {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new ProviderValidationError(`${path} must contain finite numbers`);
        }
        return;
    }
    if (
        typeof value === "undefined"
        || typeof value === "bigint"
        || typeof value === "function"
        || typeof value === "symbol"
    ) {
        throw new ProviderValidationError(`${path} must contain only JSON values`);
    }
    if (typeof value !== "object") {
        throw new ProviderValidationError(`${path} must contain only JSON values`);
    }
    if (ancestors.has(value)) {
        throw new ProviderValidationError(`${path} must not contain circular references`);
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            value.forEach((entry, index) => {
                assertJsonValue(entry, `${path}[${index}]`, ancestors);
            });
            return;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new ProviderValidationError(
                `${path} must contain only plain JSON objects`,
            );
        }
        for (const [key, entry] of Object.entries(value)) {
            assertJsonValue(entry, `${path}.${key}`, ancestors);
        }
    } finally {
        ancestors.delete(value);
    }
}

export function normalizeProviderId(value: unknown): string {
    const id = String(value ?? "").trim();
    if (!SOURCE_PROVIDER_ID_RE.test(id)) {
        throw new ProviderValidationError(
            "provider id must start with a lowercase letter and contain only "
            + "lowercase letters, digits, '.', '_', or '-' (maximum 128 characters)",
        );
    }
    return id;
}

function requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ProviderValidationError(`${fieldName} must be a non-empty string`);
    }
    return value.trim();
}

export function parseProviderRequest(value: unknown): ProviderRequest {
    if (!isRecord(value)) {
        throw new ProviderValidationError("request body must be a JSON object");
    }
    if (!isRecord(value.config)) {
        throw new ProviderValidationError("config must be a JSON object");
    }
    if (
        Object.hasOwn(value, "limits")
        && value.limits !== undefined
        && !isRecord(value.limits)
    ) {
        throw new ProviderValidationError("limits must be a JSON object");
    }
    const limits = isRecord(value.limits)
        ? value.limits as ProviderLimits
        : undefined;
    if (
        limits?.maxItemsPerCycle !== undefined
        && (
            typeof limits.maxItemsPerCycle !== "number"
            || !Number.isInteger(limits.maxItemsPerCycle)
            || limits.maxItemsPerCycle <= 0
        )
    ) {
        throw new ProviderValidationError(
            "limits.maxItemsPerCycle must be a positive integer",
        );
    }
    return {
        generatorId: requiredString(value.generatorId, "generatorId"),
        definitionId: requiredString(value.definitionId, "definitionId"),
        config: value.config,
        watermark: value.watermark,
        ...(limits ? { limits } : {}),
    };
}

export function normalizeProviderResponse(
    value: unknown,
    providerId: string,
): ProviderResponse {
    if (!isRecord(value) || !Array.isArray(value.discoveries)) {
        throw new ProviderValidationError(
            `provider '${providerId}' response must contain discoveries[]`,
        );
    }
    return {
        discoveries: value.discoveries.map((entry) => {
            if (!isRecord(entry)) {
                throw new ProviderValidationError(
                    `provider '${providerId}' discovery must be an object`,
                );
            }
            const key = String(entry.key ?? "").trim();
            if (!key) {
                throw new ProviderValidationError(
                    `provider '${providerId}' discovery is missing a stable key`,
                );
            }
            if (!isRecord(entry.payload)) {
                throw new ProviderValidationError(
                    `provider '${providerId}' discovery payload must be an object`,
                );
            }
            assertJsonValue(entry.payload, `provider '${providerId}' payload`, new Set());
            return { key, payload: entry.payload };
        }),
        ...(Object.hasOwn(value, "watermark")
            ? (
                assertJsonValue(
                    value.watermark,
                    `provider '${providerId}' watermark`,
                    new Set(),
                ),
                { watermark: value.watermark }
            )
            : {}),
    };
}
