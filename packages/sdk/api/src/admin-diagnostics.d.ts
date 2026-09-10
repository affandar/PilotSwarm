export function projectUserAccounting<T>(stats: T): T;
export function projectFleetAccounting<T>(stats: T): T;
export function projectAgentWorkerState<T>(row: T): T;
/** Omitted fields were not reported or could not be validated, never false. */
export interface FeatureWorkerDiagnostics {
    protocolVersion?: number;
    initialized?: boolean;
    supportedKeys?: string[];
    appliedRevisions?: Record<string, string>;
    lastCheckedAt?: string | null;
    lastLoadedAt?: string | null;
    nativeCapability?: "off" | "sync";
    hasRefreshError?: boolean;
}
export function projectFeatureWorkerState(state: unknown): FeatureWorkerDiagnostics | undefined;
export function projectWorker<T>(row: T): T;
