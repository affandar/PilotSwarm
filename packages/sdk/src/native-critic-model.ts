export interface NativeCriticModelSelection {
    /** Raw SDK model name; provider-qualified model IDs are not accepted. */
    parentModel: string;
    parentProviderId?: string;
    parentProviderType?: string;
    /** Omitted only for a standalone client using its own GitHub token catalog. */
    permittedModels?: ReadonlyArray<{
        providerId: string;
        modelName: string;
        providerType: string;
        cost?: "low" | "medium" | "high";
    }>;
    availableModels: ReadonlyArray<{ id: string; policy?: { state?: string } }>;
}

type Family = "gpt" | "claude";
const familyOf = (id: string): Family | undefined => {
    if (typeof id !== "string" || !/^(gpt|claude)-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) return undefined;
    return id.startsWith("gpt-") ? "gpt" : "claude";
};

function tier(id: string): number {
    if (/(?:^|-)(?:mini|nano|haiku|luna|flash)(?:-|$)/.test(id)) return 2;
    if (/(?:^|-)(?:opus|astra|pro)(?:-|$)/.test(id)) return 1;
    return 0;
}

function version(id: string): number[] {
    // Accept both claude-sonnet-4.6 and claude-3-5-sonnet. A YYYYMMDD
    // release suffix is deliberately not a minor/patch version component.
    const match = id.match(/(?:^|-)(\d{1,3})(?:[.-](\d{1,3}))?(?:[.-](\d{1,3}))?(?=-|$)/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : [0, 0, 0];
}

const costRank = (cost: unknown): number => cost === "low" ? 0 : cost === "medium" ? 1 : cost === "high" ? 2 : 3;

/**
 * Pick an opposite-family critic only from the caller's actual catalog.
 * Registry sessions additionally require the same exact GitHub provider ID.
 * No candidate is guessed from a known model name or another account's catalog.
 *
 * Ranking: balanced models (Sonnet, GPT Terra/Sol and unspecialized variants)
 * precede premium models (Opus/Astra/Pro), then small models
 * (Mini/Nano/Haiku/Luna/Flash). Within a tier, prefer the newest numeric version,
 * then lower declared cost (unknown last), then lexical model ID. Tier ranking
 * deliberately wins over both generation and cost so a new small model does
 * not replace a balanced critic. Returned IDs are always raw SDK names.
 */
export function selectNativeCriticModel(options: NativeCriticModelSelection): string | undefined {
    const parentFamily = familyOf(options.parentModel);
    if (!parentFamily || !Array.isArray(options.availableModels)) return undefined;
    const registryMode = options.permittedModels !== undefined;
    if (registryMode) {
        if (!Array.isArray(options.permittedModels) || !options.parentProviderId || options.parentProviderType !== "github") return undefined;
    } else if (options.parentProviderType !== undefined && options.parentProviderType !== "github"
        || options.parentProviderId !== undefined && options.parentProviderType !== "github") return undefined;

    const available = new Set<string>();
    const blocked = new Set<string>();
    for (const model of options.availableModels) {
        if (!model || familyOf(model.id) === undefined) continue;
        // Catalogs without policy metadata remain usable. If metadata is
        // supplied, only an explicit enabled state admits the model.
        if (model.policy !== undefined && model.policy?.state !== "enabled") blocked.add(model.id);
        else available.add(model.id);
    }
    for (const id of blocked) available.delete(id);

    const permitted = new Map<string, number>();
    if (registryMode) {
        for (const model of options.permittedModels!) {
            if (!model || model.providerId !== options.parentProviderId || model.providerType !== "github") continue;
            // Duplicate descriptors cannot make input order affect selection.
            // Retain the most conservative declared cost for the same identity.
            permitted.set(model.modelName, Math.max(permitted.get(model.modelName) ?? -1, costRank(model.cost)));
        }
    }
    const candidates = [...available].filter(id => familyOf(id) !== parentFamily && id !== options.parentModel
        && (!registryMode || permitted.has(id)));
    candidates.sort((a, b) => {
        const tierDifference = tier(a) - tier(b);
        if (tierDifference) return tierDifference;
        const aVersion = version(a), bVersion = version(b);
        for (let index = 0; index < aVersion.length; index++) {
            if (aVersion[index] !== bVersion[index]) return bVersion[index] - aVersion[index];
        }
        const costDifference = (permitted.get(a) ?? 3) - (permitted.get(b) ?? 3);
        return costDifference || (a < b ? -1 : a > b ? 1 : 0);
    });
    return candidates[0];
}
