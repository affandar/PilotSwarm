export function firstConfiguredModel(registry, candidates, modelPrefix) {
    if (!registry) return candidates[0];
    for (const candidate of candidates) {
        if (registry.normalize(candidate)) return candidate;
    }
    const configured = registry.allModels.find((model) => model.modelName.startsWith(modelPrefix));
    // Never substitute another family: multi-model tests must not pass on one model.
    // Keep the unavailable reference explicit so those prerequisites fail closed.
    return configured?.qualifiedName ?? candidates[0];
}
