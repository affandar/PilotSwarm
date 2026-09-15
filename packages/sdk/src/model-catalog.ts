/**
 * Stable wire shape returned by the viewer-scoped runtime model catalog.
 *
 * Provider identifiers are intentionally opaque. Core identity fields are
 * required; capability metadata remains open-ended so deployments and
 * providers can add values without an SDK allowlist.
 */
export interface RuntimeModel {
    catalogKind?: "provider_type" | "runtime_provider";
    qualifiedName: string;
    modelName: string;
    providerId: string;
    providerType: string;
    description?: string;
    cost?: string;
    credentialAvailable?: boolean;
    supportedReasoningEfforts: string[];
    defaultReasoningEffort?: string;
    supportedContextTiers: string[];
    defaultContextTier?: string;
    contextWindowSizes?: Record<string, number>;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}

function optionalCost(value: unknown): string | undefined {
    if (typeof value === "string") return optionalString(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const normalized = optionalString(entry);
        return normalized ? [normalized] : [];
    });
}

function numberMap(value: unknown): Record<string, number> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter(
        (entry): entry is [string, number] => (
            typeof entry[1] === "number" && Number.isFinite(entry[1])
        ),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Validate and normalize a runtime model catalog response received over the
 * Web API.
 */
export function normalizeRuntimeModels(value: unknown): RuntimeModel[] {
    if (!Array.isArray(value)) {
        throw new Error("PilotSwarm returned an invalid runtime model catalog");
    }

    return value.map((candidate, index) => {
        const model = record(candidate, `Runtime model catalog entry ${index}`);
        const qualifiedName = optionalString(model.qualifiedName);
        const modelName = optionalString(model.modelName);
        const providerId = optionalString(model.providerId);
        const providerType = optionalString(model.providerType);
        if (!qualifiedName || !modelName || !providerId || !providerType) {
            const missing = [
                !qualifiedName && "qualifiedName",
                !modelName && "modelName",
                !providerId && "providerId",
                !providerType && "providerType",
            ].filter(Boolean).join(", ");
            throw new Error(
                `Runtime model catalog entry ${index} must have ${missing}`,
            );
        }

        const catalogKind = (
            model.catalogKind === "provider_type"
            || model.catalogKind === "runtime_provider"
        ) ? model.catalogKind : undefined;
        const description = optionalString(model.description);
        const cost = optionalCost(model.cost);
        const credentialAvailable = typeof model.credentialAvailable === "boolean"
            ? model.credentialAvailable
            : undefined;
        const defaultReasoningEffort = optionalString(model.defaultReasoningEffort);
        const defaultContextTier = optionalString(model.defaultContextTier);
        const contextWindowSizes = numberMap(model.contextWindowSizes);
        const {
            catalogKind: _catalogKind,
            qualifiedName: _qualifiedName,
            modelName: _modelName,
            providerId: _providerId,
            providerType: _providerType,
            description: _description,
            cost: _cost,
            credentialAvailable: _credentialAvailable,
            supportedReasoningEfforts: _supportedReasoningEfforts,
            defaultReasoningEffort: _defaultReasoningEffort,
            supportedContextTiers: _supportedContextTiers,
            defaultContextTier: _defaultContextTier,
            contextWindowSizes: _contextWindowSizes,
            ...futureFields
        } = model;

        const normalized: RuntimeModel = {
            ...futureFields,
            ...(catalogKind ? { catalogKind } : {}),
            qualifiedName,
            modelName,
            providerId,
            providerType,
            ...(description ? { description } : {}),
            ...(cost ? { cost } : {}),
            ...(credentialAvailable !== undefined ? { credentialAvailable } : {}),
            supportedReasoningEfforts: stringArray(model.supportedReasoningEfforts),
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            supportedContextTiers: stringArray(model.supportedContextTiers),
            ...(defaultContextTier ? { defaultContextTier } : {}),
            ...(contextWindowSizes ? { contextWindowSizes } : {}),
        };
        return normalized;
    });
}
