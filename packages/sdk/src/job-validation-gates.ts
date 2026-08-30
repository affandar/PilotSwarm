export interface ExternalOperationGateRecord {
    status: string;
    waitCompleted: boolean;
    provider: string;
    kind: string;
    evidence: unknown;
}

function applicableExternalOperationGates(
    gates: readonly unknown[],
    toState: string,
): Record<string, unknown>[] {
    return gates.filter((value): value is Record<string, unknown> => (
        Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as Record<string, unknown>).type === "external_operation"
        && (value as Record<string, unknown>).beforeState === toState
    ));
}

export function assertExternalOperationValidationGatesSatisfied(
    gates: readonly unknown[],
    toState: string,
    operations: readonly ExternalOperationGateRecord[],
): void {
    for (const gate of applicableExternalOperationGates(gates, toState)) {
        const kind = typeof gate.kind === "string" ? gate.kind.trim().toLowerCase() : "";
        const provider = typeof gate.provider === "string"
            ? gate.provider.trim().toLowerCase()
            : null;
        if (!kind) throw new Error(`External operation validation gate for ${toState} requires kind`);
        const operation = operations.find((candidate) => (
            candidate.kind === kind
            && (!provider || candidate.provider === provider)
            && candidate.status === "succeeded"
            && candidate.waitCompleted
            && (gate.requireEvidence === false || candidate.evidence !== null)
        ));
        if (!operation) {
            const gateName = typeof gate.name === "string" && gate.name.trim()
                ? gate.name.trim()
                : `${provider ? `${provider}/` : ""}${kind}`;
            throw new Error(
                `Job state transition to ${toState} requires completed external operation evidence: ${gateName}`,
            );
        }
    }
}
