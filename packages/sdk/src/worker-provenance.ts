import type { WorkerProvenanceOptions } from "./types.js";

const PROVENANCE_LIMITS = {
    applicationVersion: 64,
    sourceCommit: 128,
    buildId: 128,
} as const;

function boundedValue(limit: number, ...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== "string") continue;
        const normalized = value
            .trim()
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ");
        if (normalized) return normalized.slice(0, limit);
    }
    return undefined;
}

export function resolveWorkerRuntimeProvenance(
    options: WorkerProvenanceOptions | undefined,
    sdkVersion: string,
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const applicationVersion = boundedValue(
        PROVENANCE_LIMITS.applicationVersion,
        options?.applicationVersion,
        env.PILOTSWARM_APPLICATION_VERSION,
    );
    const sourceCommit = boundedValue(
        PROVENANCE_LIMITS.sourceCommit,
        options?.sourceCommit,
        env.PILOTSWARM_SOURCE_COMMIT,
    );
    const buildId = boundedValue(
        PROVENANCE_LIMITS.buildId,
        options?.buildId,
        env.PILOTSWARM_BUILD_ID,
    );

    return {
        sdkVersion,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        ...(applicationVersion ? { applicationVersion } : {}),
        ...(sourceCommit ? { sourceCommit } : {}),
        ...(buildId ? { buildId } : {}),
    };
}
