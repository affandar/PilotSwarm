import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    JOB_GENERATOR_PROVIDER_API_VERSION,
    isRecord,
    normalizeProviderId,
    type ProviderFactoryContext,
    type SourceProvider,
    type SourceProviderPlugin,
} from "./contracts.js";

export interface ProviderPluginDefinition {
    id: string;
    module: string;
    exportName?: string;
    config: Record<string, unknown>;
}

export type ModuleImporter = (
    specifier: string,
) => Promise<Record<string, unknown>>;

function moduleSpecifier(value: string): string {
    if (value.startsWith("file:")) return value;
    if (path.isAbsolute(value) || value.startsWith(".")) {
        return pathToFileURL(path.resolve(value)).href;
    }
    return value;
}

export function parseProviderPluginDefinitions(
    raw: string | undefined,
): ProviderPluginDefinition[] {
    if (!raw?.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `JOBGEN_PROVIDER_PLUGINS_JSON must be valid JSON: ${
                error instanceof Error ? error.message : error
            }`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error("JOBGEN_PROVIDER_PLUGINS_JSON must be a JSON array");
    }
    const seen = new Set<string>();
    return parsed.map((value, index) => {
        if (!isRecord(value)) {
            throw new Error(`JOBGEN_PROVIDER_PLUGINS_JSON[${index}] must be an object`);
        }
        const id = normalizeProviderId(value.id);
        if (seen.has(id)) {
            throw new Error(`duplicate provider plugin id '${id}'`);
        }
        seen.add(id);
        const module = String(value.module ?? "").trim();
        if (!module) {
            throw new Error(
                `JOBGEN_PROVIDER_PLUGINS_JSON[${index}].module is required`,
            );
        }
        const exportName = value.exportName == null
            ? undefined
            : String(value.exportName).trim();
        if (exportName !== undefined && !exportName) {
            throw new Error(
                `JOBGEN_PROVIDER_PLUGINS_JSON[${index}].exportName must not be blank`,
            );
        }
        if (
            Object.hasOwn(value, "config")
            && value.config !== undefined
            && !isRecord(value.config)
        ) {
            throw new Error(
                `JOBGEN_PROVIDER_PLUGINS_JSON[${index}].config must be an object`,
            );
        }
        return {
            id,
            module,
            ...(exportName ? { exportName } : {}),
            config: isRecord(value.config) ? value.config : {},
        };
    });
}

function pluginFromModule(
    namespace: Record<string, unknown>,
    definition: ProviderPluginDefinition,
): SourceProviderPlugin {
    const candidate = definition.exportName
        ? namespace[definition.exportName]
        : namespace.default ?? namespace.providerPlugin;
    if (!isRecord(candidate)) {
        throw new Error(
            `provider plugin '${definition.id}' module does not export a plugin object`,
        );
    }
    if (candidate.apiVersion !== JOB_GENERATOR_PROVIDER_API_VERSION) {
        throw new Error(
            `provider plugin '${definition.id}' uses unsupported apiVersion '${
                String(candidate.apiVersion ?? "")
            }'`,
        );
    }
    const pluginId = normalizeProviderId(candidate.id);
    if (pluginId !== definition.id) {
        throw new Error(
            `provider plugin id '${pluginId}' does not match registration '${definition.id}'`,
        );
    }
    if (typeof candidate.createProvider !== "function") {
        throw new Error(
            `provider plugin '${definition.id}' must export createProvider(context)`,
        );
    }
    return candidate as unknown as SourceProviderPlugin;
}

export async function loadProviderPlugins(
    definitions: ProviderPluginDefinition[],
    options: {
        env?: NodeJS.ProcessEnv;
        fetch?: typeof fetch;
        logger?: Pick<Console, "info" | "warn" | "error">;
        importModule?: ModuleImporter;
    } = {},
): Promise<Map<string, SourceProvider>> {
    const providers = new Map<string, SourceProvider>();
    const ownedProviders: SourceProvider[] = [];
    const runtime = {
        env: options.env ?? process.env,
        fetch: options.fetch ?? fetch,
        logger: options.logger ?? console,
    };
    const importModule = options.importModule
        ?? (async (specifier: string) => await import(specifier) as Record<string, unknown>);

    try {
        for (const definition of definitions) {
            const namespace = await importModule(moduleSpecifier(definition.module));
            const plugin = pluginFromModule(namespace, definition);
            const context: ProviderFactoryContext = {
                id: definition.id,
                config: definition.config,
                ...runtime,
            };
            const provider = await plugin.createProvider(context);
            if (!provider || typeof provider !== "object") {
                throw new Error(
                    `provider plugin '${definition.id}' factory did not return a provider`,
                );
            }
            ownedProviders.push(provider);
            const providerId = normalizeProviderId(provider.id);
            if (providerId !== definition.id) {
                throw new Error(
                    `provider instance id '${providerId}' does not match registration '${definition.id}'`,
                );
            }
            if (typeof provider.evaluate !== "function") {
                throw new Error(
                    `provider plugin '${definition.id}' must implement evaluate(request, context)`,
                );
            }
            providers.set(providerId, provider);
        }
    } catch (error) {
        let cleanupTimeout: NodeJS.Timeout | undefined;
        await Promise.race([
            Promise.allSettled(
                ownedProviders.map(async (provider) => await provider.close?.()),
            ),
            new Promise<void>((resolve) => {
                cleanupTimeout = setTimeout(resolve, 10_000);
            }),
        ]);
        if (cleanupTimeout) clearTimeout(cleanupTimeout);
        throw error;
    }
    return providers;
}
