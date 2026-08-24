/**
 * Provider budgets — the bridge between the config file and the database.
 *
 * See docs/proposals/providers-and-budgets.md. The model-providers file
 * defines TYPES: what an instance of each offers (backend, models,
 * capabilities). PROVIDERS are rows in the database, each a credential with
 * a budget policy, and a session's model reference names one of them:
 *
 *     azure-prod:gpt-5.4
 *     └ provider    └ model, offered by the provider's TYPE
 *
 * Two jobs live here. The first is the one-time deployment seed: a fresh
 * cluster has no providers at all, and the credentials already sitting in
 * the config file are the obvious thing to start from. The second is
 * resolving a reference to a real credential at turn time, for providers
 * the file has never heard of — anything an administrator or a user created
 * at runtime.
 */
import type { ModelProviderConfig, ModelProvidersFile, ProviderType, ResolvedProvider } from "./model-providers.js";
import { ModelProviderRegistry, resolveEnvValue } from "./model-providers.js";
import type { DefaultTuple, ProviderCredential, ProviderStore } from "./provider-store.js";

export type RuntimeModelResolutionSource =
    | "explicit"
    | "user_default"
    | "cluster_default"
    | "system_default"
    | "agent_override"
    | "first_available";

export interface RuntimeModelSelection extends DefaultTuple {
    provider: string;
    model: string;
    source: RuntimeModelResolutionSource;
}

export class ModelAmbiguousError extends Error {
    readonly code = "MODEL_AMBIGUOUS";

    constructor(readonly model: string, readonly candidates: string[]) {
        super(`Model "${model}" is ambiguous. Use one of: ${candidates.join(", ")}.`);
        this.name = "ModelAmbiguousError";
    }
}

export class ModelUnresolvedError extends Error {
    readonly code = "MODEL_UNRESOLVED";

    constructor(message: string) {
        super(message);
        this.name = "ModelUnresolvedError";
    }
}

export interface RuntimeModelDefaultCandidate {
    tuple: DefaultTuple;
    source: Exclude<RuntimeModelResolutionSource, "explicit" | "first_available">;
}

/**
 * The type catalog. Every entry survives, credentialed or not: a type is a
 * template, and whether anything can pay is a question about instances.
 */
export function loadProviderTypes(config: ModelProvidersFile): ModelProviderRegistry {
    return new ModelProviderRegistry(config, { keepUncredentialed: true });
}

/**
 * The deployment seed, derived from the config file.
 *
 * An entry with a resolvable credential becomes one shared provider named
 * after the entry — so `azure-openai:gpt-5.4` means the same thing before
 * and after this feature, and no deployment file has to change. An entry
 * with no credential seeds nothing: it stays a type people can instantiate
 * with a key of their own, which is exactly how GitHub Copilot is deployed
 * on a cluster that holds no shared Copilot key.
 */
export function bootstrapSeedFromConfig(config: ModelProvidersFile): {
    instances: Array<{ name: string; typeId: string; secretRef: Record<string, unknown>; baseUrl: string | null }>;
    defaults: DefaultTuple | null;
} {
    const instances = [];
    for (const p of config.providers ?? []) {
        const secretRef = configSecretRef(p);
        if (!secretRef) continue;
        instances.push({
            name: p.id,
            typeId: p.id,
            secretRef,
            baseUrl: p.baseUrl ?? null,
        });
    }
    // `defaultModel` is already `provider:model`, and after the seed above
    // its provider half names a real provider.
    const ref = config.defaultModel;
    const colon = ref ? ref.indexOf(":") : -1;
    const defaultProvider = ref && colon > 0 ? ref.slice(0, colon) : null;
    const defaults: DefaultTuple | null = defaultProvider
        && instances.some((instance) => instance.name === defaultProvider)
        ? { provider: defaultProvider, model: ref!, reasoning: null, context: null }
        : null;
    return { instances, defaults };
}

/**
 * What the file says a type's credential is, as a reference rather than a
 * secret: `env:AZURE_KEY` is stored as written, so rotating the variable
 * rotates the credential and no key is ever copied into the database.
 * Returns null when the entry carries nothing usable.
 */
function configSecretRef(p: ModelProviderConfig): Record<string, unknown> | null {
    if (p.type === "github") {
        return p.githubToken && resolveEnvValue(p.githubToken)
            ? { kind: "githubToken", ref: p.githubToken, source: CONFIG_ORIGIN }
            : null;
    }
    return p.apiKey && resolveEnvValue(p.apiKey)
        ? {
            kind: "apiKey", ref: p.apiKey, source: CONFIG_ORIGIN,
            ...(p.apiVersion ? { apiVersion: p.apiVersion } : {}),
        }
        : null;
}

/**
 * The one origin allowed to store a POINTER to a secret rather than a secret.
 *
 * `env:AZURE_KEY` is an indirection into the worker's own environment, and
 * it is safe exactly once: when the deployment's own config file wrote it.
 * A credential that arrived in a request is a VALUE, never a pointer —
 * honouring `env:` there let anyone with an account name a variable and have
 * the worker send that variable's contents to a base URL of their choosing.
 * ProviderStore.createProvider is what keeps the two apart; this constant is
 * the marker it refuses to let a caller forge.
 */
export const CONFIG_ORIGIN = "config-file";

/** The secret itself, resolved at the moment of use. */
function secretValue(secretRef: Record<string, unknown> | null | undefined): string | undefined {
    if (!secretRef) return undefined;
    if (secretRef.source === CONFIG_ORIGIN && typeof secretRef.ref === "string" && secretRef.ref) {
        return resolveEnvValue(secretRef.ref);
    }
    const value = secretRef.value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Seed a fresh cluster, once. Safe to call at every boot: the claim is
 * atomic in the database, so several pods starting together seed exactly
 * once, and a provider an administrator later deleted stays deleted.
 */
export async function bootstrapProviders(
    store: ProviderStore,
    config: ModelProvidersFile,
): Promise<{ claimed: boolean; created: number }> {
    const { instances, defaults } = bootstrapSeedFromConfig(config);
    if (instances.length === 0 && !defaults) return { claimed: false, created: 0 };
    return store.bootstrap(instances, defaults);
}

/**
 * The catalog a worker actually runs against: one entry per PROVIDER, built
 * from the types in the file and the instances in the database.
 *
 * Every downstream path — normalize(), resolve(), getDescriptor(), the model
 * summary an agent sees — is keyed by `providerId:model`, and after this the
 * provider id IS the provider's name. So `carol-ghcp:claude-opus-5` resolves
 * for exactly the same reason `azure-prod:gpt-5.4` does, and nothing further
 * down has to learn what a provider instance is.
 *
 * This registry holds every provider, personal ones included, because a
 * worker runs turns for everybody. It is not an access decision and must
 * never be shown to anyone: what a person may spend from is decided by the
 * admission gate, which resolves the name in the SESSION OWNER'S namespace
 * and refuses before a credential is ever reached for.
 */
export function buildRuntimeRegistry(
    types: ModelProviderRegistry,
    instances: ProviderCredential[],
    defaultModel?: string | null,
): ModelProviderRegistry {
    const byType = new Map(types.allProviders.map((p) => [p.id, p]));
    const providers: ModelProviderConfig[] = [];
    for (const inst of instances) {
        const type = byType.get(inst.typeId);
        if (!type) continue;      // a type the file no longer describes
        const secret = secretValue(inst.secretRef);
        // A provider whose own credential does not resolve is DROPPED, never
        // quietly run on the type's. Inheriting it meant a personal provider
        // created with a shape this code did not read spent the CLUSTER's key
        // — under a name no administrator can put a limit on, because a
        // personal provider answers only to its owner. An uncappable budget
        // bypass, reached by getting a field name wrong.
        if (!secret) continue;
        const hasResolvableModel = type.models.some((entry) => {
            const modelName = typeof entry === "string" ? entry : entry.name;
            return Boolean(resolveProviderCredential(types, inst, modelName));
        });
        if (!hasResolvableModel) continue;
        providers.push({
            ...type,
            id: inst.name,
            ...(inst.baseUrl ? { baseUrl: inst.baseUrl } : {}),
            ...(type.type === "github" ? { githubToken: secret } : { apiKey: secret }),
        });
    }
    // An invalid default would throw out of the constructor and take the
    // worker with it; a missing one is only a missing convenience.
    const hasDefault = defaultModel
        && providers.some((p) => defaultModel.startsWith(`${p.id}:`));
    const effectiveDefault = hasDefault
        ? defaultModel!
        : firstRuntimeModel(types, instances, (instance) => instance.class === "shared")?.model;
    return new ModelProviderRegistry(
        { providers, ...(effectiveDefault ? { defaultModel: effectiveDefault } : {}) },
        { keepUncredentialed: true });
}

export function firstRuntimeModel(
    types: ModelProviderRegistry,
    instances: ProviderCredential[],
    eligible: (instance: ProviderCredential) => boolean,
): DefaultTuple | null {
    for (const instance of instances) {
        if (!eligible(instance)) continue;
        const type = types.allProviders.find((candidate) => candidate.id === instance.typeId);
        if (!type || type.models.length === 0) continue;
        const first = type.models[0];
        const modelName = typeof first === "string" ? first : first.name;
        if (!resolveProviderCredential(types, instance, modelName)) continue;
        const descriptor = types.getDescriptor(`${type.id}:${modelName}`);
        return {
            provider: instance.name,
            model: `${instance.name}:${modelName}`,
            reasoning: descriptor?.defaultReasoningEffort ?? null,
            context: descriptor?.defaultContextTier ?? null,
        };
    }
    return null;
}

export function resolveRuntimeModelSelection(
    types: ModelProviderRegistry,
    instances: ProviderCredential[],
    input: {
        requestedModel?: string | null;
        requestedReasoning?: string | null;
        requestedContext?: string | null;
        defaults?: RuntimeModelDefaultCandidate[];
        eligible: (instance: ProviderCredential) => boolean;
    },
): RuntimeModelSelection {
    const eligibleInstances = instances.filter(input.eligible);
    const byName = new Map(eligibleInstances.map((instance) => [instance.name, instance]));

    const resolve = (
        rawModel: string,
        reasoning: string | null | undefined,
        context: string | null | undefined,
        source: RuntimeModelResolutionSource,
    ): RuntimeModelSelection => {
        const requested = String(rawModel || "").trim();
        let instance: ProviderCredential | undefined;
        let modelName = "";
        if (requested.includes(":")) {
            const colon = requested.indexOf(":");
            instance = byName.get(requested.slice(0, colon));
            modelName = requested.slice(colon + 1);
        } else {
            const matches = eligibleInstances.filter((candidate) =>
                types.getDescriptor(`${candidate.typeId}:${requested}`));
            if (matches.length > 1) {
                throw new ModelAmbiguousError(
                    requested,
                    matches.map((candidate) => `${candidate.name}:${requested}`),
                );
            }
            instance = matches[0];
            modelName = requested;
        }
        if (!instance || !modelName) {
            throw new ModelUnresolvedError(`No usable provider serves model "${requested}".`);
        }
        const descriptor = types.getDescriptor(`${instance.typeId}:${modelName}`);
        if (!descriptor || !resolveProviderCredential(types, instance, modelName)) {
            throw new ModelUnresolvedError(`Provider "${instance.name}" cannot run model "${modelName}".`);
        }
        const resolvedReasoning = reasoning ?? descriptor.defaultReasoningEffort ?? null;
        if (resolvedReasoning && descriptor.supportedReasoningEfforts?.length
            && !descriptor.supportedReasoningEfforts.includes(resolvedReasoning as any)) {
            throw new ModelUnresolvedError(`Model ${instance.name}:${modelName} does not support reasoning effort '${resolvedReasoning}'.`);
        }
        const resolvedContext = context ?? descriptor.defaultContextTier ?? null;
        if (resolvedContext && descriptor.supportedContextTiers?.length
            && !descriptor.supportedContextTiers.includes(resolvedContext as any)) {
            throw new ModelUnresolvedError(`Model ${instance.name}:${modelName} does not support context tier '${resolvedContext}'.`);
        }
        return {
            provider: instance.name,
            model: `${instance.name}:${modelName}`,
            reasoning: resolvedReasoning,
            context: resolvedContext,
            source,
        };
    };

    const requested = String(input.requestedModel || "").trim();
    if (requested) {
        return resolve(requested, input.requestedReasoning, input.requestedContext, "explicit");
    }
    for (const candidate of input.defaults ?? []) {
        if (!candidate.tuple.provider && !candidate.tuple.model) continue;
        if (!candidate.tuple.provider || !candidate.tuple.model) {
            throw new ModelUnresolvedError(`Configured ${candidate.source.replaceAll("_", " ")} is incomplete.`);
        }
        return resolve(
            candidate.tuple.model,
            input.requestedReasoning ?? candidate.tuple.reasoning,
            input.requestedContext ?? candidate.tuple.context,
            candidate.source,
        );
    }
    const fallback = firstRuntimeModel(types, eligibleInstances, () => true);
    if (!fallback?.model) throw new ModelUnresolvedError("No usable model provider is available.");
    return resolve(
        fallback.model,
        input.requestedReasoning ?? fallback.reasoning,
        input.requestedContext ?? fallback.context,
        "first_available",
    );
}

/**
 * Turn an admitted provider into the credential block the SDK client wants.
 *
 * This is the path for providers the config file does not describe: one an
 * administrator added at runtime, or a personal one somebody created with
 * their own key. The TYPE still comes from the file (it says which backend
 * and which models); only the credential and endpoint come from the row.
 *
 * Returns null when the type is unknown — a provider whose template was
 * removed from the config can no longer be run, and saying so is better
 * than guessing an adapter.
 */
export function resolveProviderCredential(
    types: ModelProviderRegistry,
    credential: ProviderCredential,
    modelName: string,
): ResolvedProvider | null {
    const type = types.allProviders.find((p) => p.id === credential.typeId);
    if (!type) return null;

    if (type.type === "github") {
        const token = secretValue(credential.secretRef);
        if (!token) return null;
        return {
            providerId: credential.name,
            type: "github",
            modelName,
            ...(token ? { githubToken: token } : {}),
        };
    }

    const apiKey = secretValue(credential.secretRef);
    const baseUrl = credential.baseUrl ?? type.baseUrl;
    if (!baseUrl || !apiKey) return null;

    // `openai-proxy` is a PilotSwarm-only value the SDK does not know; it
    // has always been mapped to `openai` at the point of use.
    const sdkType: Exclude<ProviderType, "openai-proxy"> =
        type.type === "openai-proxy" ? "openai" : type.type;
    const apiVersion = typeof credential.secretRef?.apiVersion === "string"
        ? credential.secretRef.apiVersion
        : type.apiVersion;

    return {
        providerId: credential.name,
        type: type.type,
        modelName,
        sdkProvider: {
            type: sdkType,
            baseUrl: sdkType === "azure" ? `${baseUrl.replace(/\/$/, "")}/deployments/${modelName}` : baseUrl,
            apiKey,
            ...(sdkType === "azure" ? { azure: { apiVersion: apiVersion ?? "2024-10-21" } } : {}),
        },
    } as ResolvedProvider;
}
