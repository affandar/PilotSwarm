const RECENT_CLIENT_MESSAGE_ID_LIMIT = 20;

export interface DurableStartTurn {
    prompt: string;
    bootstrap: boolean;
    requiredTool?: string;
    clientMessageIds: string[];
}

export interface DurableStartTurnRequest {
    prompt: string;
    bootstrap?: boolean;
    requiredTool?: string;
    clientMessageIds?: unknown;
}

export interface DurableStartInputFields {
    prompt: string;
    bootstrapPrompt: true;
    requiredTool?: string;
    recentClientMessageIds?: string[];
}

export interface DurableStartMessage {
    prompt: string;
    requiredTool?: string;
    clientMessageIds?: string[];
}

export type DurableStartDeliveryPlan<T extends Record<string, unknown>> =
    | {
        delivery: "start-input";
        startInput: T & DurableStartInputFields;
        message: null;
    }
    | {
        delivery: "message-event";
        startInput: T;
        message: DurableStartMessage;
    };

function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("durable start input must be an object");
    }
    return value as Record<string, unknown>;
}

function normalizePrompt(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new TypeError("prompt is required");
    }
    return value;
}

function normalizeRequiredTool(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new TypeError("requiredTool must be a non-empty string");
    }
    return value.trim();
}

export function normalizeStartClientMessageIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const raw of value) {
        if (typeof raw !== "string" || !raw || ids.includes(raw)) continue;
        ids.push(raw);
    }
    return ids.slice(-RECENT_CLIENT_MESSAGE_ID_LIMIT);
}

/**
 * Read the optional carried turn from either a new durable start input or an
 * older input that has none. Unknown fields are intentionally ignored.
 */
export function normalizeDurableStartTurn(value: unknown): DurableStartTurn | null {
    const input = requireRecord(value);
    if (input.prompt == null) return null;
    return {
        prompt: normalizePrompt(input.prompt),
        bootstrap: input.bootstrapPrompt === true,
        requiredTool: normalizeRequiredTool(input.requiredTool),
        clientMessageIds: normalizeStartClientMessageIds(input.recentClientMessageIds),
    };
}

/**
 * Build the client-side delivery plan without performing either durable
 * operation. Callers can adopt the start-input branch atomically with the
 * matching orchestration version while older handlers keep the event branch.
 */
export function prepareDurableStartInput<T extends Record<string, unknown>>(
    baseStartInput: T,
    request: DurableStartTurnRequest,
): DurableStartDeliveryPlan<T> {
    const prompt = normalizePrompt(request.prompt);
    const requiredTool = normalizeRequiredTool(request.requiredTool);
    const clientMessageIds = normalizeStartClientMessageIds(request.clientMessageIds);

    if (request.bootstrap === true) {
        if (Object.hasOwn(baseStartInput, "prompt")) {
            throw new TypeError("base start input already carries a prompt");
        }
        return {
            delivery: "start-input",
            startInput: {
                ...baseStartInput,
                prompt,
                bootstrapPrompt: true,
                ...(requiredTool ? { requiredTool } : {}),
                ...(clientMessageIds.length > 0 ? { recentClientMessageIds: clientMessageIds } : {}),
            },
            message: null,
        };
    }

    return {
        delivery: "message-event",
        startInput: baseStartInput,
        message: {
            prompt,
            ...(requiredTool ? { requiredTool } : {}),
            ...(clientMessageIds.length > 0 ? { clientMessageIds } : {}),
        },
    };
}
