import type { PermissionRequestResult } from "@github/copilot-sdk";

type PermissionRequestLike = {
    kind?: string;
    commands?: Array<{ identifier?: unknown }>;
    serverName?: unknown;
    toolName?: unknown;
};

type SessionApproval =
    | { kind: "commands"; commandIdentifiers: string[] }
    | { kind: "read" }
    | { kind: "write" }
    | { kind: "mcp"; serverName: string; toolName: string | null }
    | { kind: "mcp-sampling"; serverName: string }
    | { kind: "memory" }
    | { kind: "custom-tool"; toolName: string };

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function shellCommandIdentifiers(request: PermissionRequestLike): string[] {
    if (!Array.isArray(request.commands)) return [];
    return uniqueStrings(
        request.commands
            .map((command) => stringOrNull(command?.identifier))
            .filter((identifier): identifier is string => Boolean(identifier)),
    );
}

export function sessionApprovalForPermissionRequest(request?: PermissionRequestLike): SessionApproval | null {
    if (!request || typeof request !== "object") return null;

    switch (request.kind) {
        case "shell":
            return {
                kind: "commands",
                commandIdentifiers: shellCommandIdentifiers(request),
            };
        case "read":
            return { kind: "read" };
        case "write":
            return { kind: "write" };
        case "mcp": {
            const serverName = stringOrNull(request.serverName);
            if (!serverName) return null;
            return {
                kind: "mcp",
                serverName,
                toolName: stringOrNull(request.toolName),
            };
        }
        case "mcp-sampling": {
            const serverName = stringOrNull(request.serverName);
            return serverName ? { kind: "mcp-sampling", serverName } : null;
        }
        case "memory":
            return { kind: "memory" };
        case "custom-tool": {
            const toolName = stringOrNull(request.toolName);
            return toolName ? { kind: "custom-tool", toolName } : null;
        }
        default:
            return null;
    }
}

export function approvePermissionForSession(request?: PermissionRequestLike): PermissionRequestResult {
    const approval = sessionApprovalForPermissionRequest(request);
    if (!approval) return { kind: "approve-once" } as PermissionRequestResult;
    return {
        kind: "approve-for-session",
        approval,
    } as PermissionRequestResult;
}
