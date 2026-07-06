/** Shared MCP tool-response helpers — same content shape the existing tool
 * files emit inline; new tool modules use these to cut boilerplate. */

export interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
}

export function jsonResult(payload: unknown): ToolResult {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    };
}

export function errorResult(message: string, extra?: Record<string, unknown>): ToolResult {
    const text = extra
        ? JSON.stringify({ error: message, ...extra })
        : `Error: ${message}`;
    return {
        content: [{ type: "text" as const, text }],
        isError: true,
    };
}

/**
 * Map a thrown error to a tool error result. Recognizes the Web API's 403
 * (admin-gated operation hit without the admin role) and shapes it into
 * actionable text instead of a bare status line.
 */
export function errorToResult(err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    if (status === 403 || /\b403\b|forbidden/i.test(message)) {
        return errorResult(
            "forbidden: this operation requires the deployment's admin role. "
            + "The MCP server's credential (PILOTSWARM_API_TOKEN or cached login) does not carry it.",
            { status: 403 },
        );
    }
    return errorResult(message);
}

/** Wrap a tool handler with the standard try/catch → errorToResult mapping. */
export function withToolErrors<A extends unknown[]>(
    fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
    return async (...args: A) => {
        try {
            return await fn(...args);
        } catch (err: unknown) {
            return errorToResult(err);
        }
    };
}
