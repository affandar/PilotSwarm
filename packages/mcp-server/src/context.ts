import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PgFactStore,
    createFactStoreForUrl,
    loadModelProviders,
    ModelProviderRegistry,
    loadSkills,
} from "pilotswarm-sdk";

export interface ServerContext {
    client: PilotSwarmClient;
    mgmt: PilotSwarmManagementClient;
    facts: PgFactStore;
    models: ModelProviderRegistry | null;
    skills: Array<{ name: string; description: string; prompt: string }>;
}

export interface CreateContextOptions {
    store: string;
    modelProvidersPath?: string;
    pluginDirs?: string[];
}

export async function createContext(opts: CreateContextOptions): Promise<ServerContext> {
    const client = new PilotSwarmClient({ store: opts.store });
    await client.start();

    const mgmt = new PilotSwarmManagementClient({ store: opts.store });
    await mgmt.start();

    const facts = (await createFactStoreForUrl(opts.store)) as PgFactStore;
    await facts.initialize();

    const models = loadModelProviders(opts.modelProvidersPath ?? undefined) ?? null;

    let skills: Array<{ name: string; description: string; prompt: string }> = [];
    if (opts.pluginDirs) {
        for (const dir of opts.pluginDirs) {
            try {
                const loaded = await loadSkills(dir + "/skills");
                skills.push(...loaded.map(s => ({ name: s.name, description: s.description, prompt: s.prompt })));
            } catch {
                // Directory may not have skills — skip
            }
        }
    }

    return { client, mgmt, facts, models, skills };
}
