export const SYSTEM_WAIT_KINDS = ["signal"] as const;
export type SystemWaitKind = (typeof SYSTEM_WAIT_KINDS)[number];

export const SYSTEM_WAIT_STATUSES = ["pending", "completed", "cancelled"] as const;
export type SystemWaitStatus = (typeof SYSTEM_WAIT_STATUSES)[number];

export type DurableJsonValue =
    | null
    | boolean
    | number
    | string
    | DurableJsonValue[]
    | { [key: string]: DurableJsonValue };

export interface SystemWaitRequest {
    waitKey: string;
    kind: SystemWaitKind;
    reason: string;
}

export interface SystemWaitSignal {
    type: "signal";
    waitKey: string;
    payload?: DurableJsonValue;
}

export interface SystemWaitCancellation {
    type: "cancel";
    waitKey: string;
    reason?: string;
}

export type SystemWaitManagementCommand = SystemWaitSignal | SystemWaitCancellation;

export interface StoredSystemWait {
    schemaVersion: 1;
    waitKey: string;
    kind: SystemWaitKind;
    status: SystemWaitStatus;
    reason: string;
    createdAt: string;
    updatedAt: string;
    result?: DurableJsonValue;
    cancellation?: {
        reason?: string;
    };
}

export const SYSTEM_WAIT_TOOL_CONTRACT = {
    name: "system_wait",
    description:
        "Suspend work on a durable platform-owned wait key until management sends a matching signal or cancellation.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            wait_key: {
                type: "string",
                description: "Stable idempotency key for this wait.",
            },
            kind: {
                type: "string",
                enum: [...SYSTEM_WAIT_KINDS],
            },
            reason: {
                type: "string",
                description: "Short operator-facing reason for the wait.",
            },
        },
        required: ["wait_key", "kind", "reason"],
    },
} as const;

export const SYSTEM_WAIT_MANAGEMENT_CONTRACT = {
    signal: {
        type: "object",
        additionalProperties: false,
        properties: {
            type: { const: "signal" },
            waitKey: { type: "string" },
            payload: {},
        },
        required: ["type", "waitKey"],
    },
    cancel: {
        type: "object",
        additionalProperties: false,
        properties: {
            type: { const: "cancel" },
            waitKey: { type: "string" },
            reason: { type: "string" },
        },
        required: ["type", "waitKey"],
    },
} as const;

const WAIT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const MAX_WAIT_KEY_LENGTH = 256;
const MAX_REASON_LENGTH = 2_000;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${label} is required`);
    if (normalized.length > maxLength) {
        throw new TypeError(`${label} must be at most ${maxLength} characters`);
    }
    return normalized;
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
    if (value == null) return undefined;
    return normalizeRequiredText(value, label, maxLength);
}

function normalizeTimestamp(value: unknown, label: string, fallback?: string): string {
    if (value == null && fallback) return fallback;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new TypeError(`${label} must be an ISO timestamp`);
    }
    return new Date(value).toISOString();
}

export function normalizeDurableJsonValue(
    value: unknown,
    label = "value",
    ancestors = new WeakSet<object>(),
): DurableJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError(`${label} numbers must be finite`);
        return value;
    }
    if (typeof value !== "object") {
        throw new TypeError(`${label} must contain only JSON-safe durable data`);
    }
    if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item, index) =>
                normalizeDurableJsonValue(item, `${label}[${index}]`, ancestors));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`${label} must not contain class instances`);
        }
        const normalized: Record<string, DurableJsonValue> = {};
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                throw new TypeError(`${label} must not contain symbol keys`);
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
                throw new TypeError(`${label}.${key} must be an enumerable data property`);
            }
            normalized[key] = normalizeDurableJsonValue(
                descriptor.value,
                `${label}.${key}`,
                ancestors,
            );
        }
        return normalized;
    } finally {
        ancestors.delete(value);
    }
}

export function normalizeSystemWaitKey(value: unknown): string {
    const waitKey = normalizeRequiredText(value, "waitKey", MAX_WAIT_KEY_LENGTH);
    if (!WAIT_KEY_PATTERN.test(waitKey)) {
        throw new TypeError("waitKey may contain only letters, numbers, '.', '_', ':', and '-'");
    }
    return waitKey;
}

export function normalizeSystemWaitKind(value: unknown): SystemWaitKind {
    if (typeof value !== "string" || !(SYSTEM_WAIT_KINDS as readonly string[]).includes(value)) {
        throw new TypeError(`unknown system wait kind: ${String(value)}`);
    }
    return value as SystemWaitKind;
}

export function normalizeSystemWaitRequest(value: unknown): SystemWaitRequest {
    const input = requireRecord(value, "system wait request");
    return {
        waitKey: normalizeSystemWaitKey(input.waitKey ?? input.wait_key),
        kind: normalizeSystemWaitKind(input.kind),
        reason: normalizeRequiredText(input.reason, "reason", MAX_REASON_LENGTH),
    };
}

export function normalizeSystemWaitCommand(value: unknown): SystemWaitManagementCommand {
    const input = requireRecord(value, "system wait command");
    const waitKey = normalizeSystemWaitKey(input.waitKey ?? input.wait_key);
    if (input.type === "signal") {
        return {
            type: "signal",
            waitKey,
            ...(Object.hasOwn(input, "payload")
                ? { payload: normalizeDurableJsonValue(input.payload, "payload") }
                : {}),
        };
    }
    if (input.type === "cancel") {
        const reason = normalizeOptionalText(input.reason, "reason", MAX_REASON_LENGTH);
        return { type: "cancel", waitKey, ...(reason ? { reason } : {}) };
    }
    throw new TypeError(`unknown system wait command: ${String(input.type)}`);
}

export function createStoredSystemWait(
    value: unknown,
    now = new Date(),
): StoredSystemWait {
    const request = normalizeSystemWaitRequest(value);
    const timestamp = now.toISOString();
    return {
        schemaVersion: 1,
        ...request,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

export function reuseStoredSystemWait(
    existing: StoredSystemWait,
    value: unknown,
): StoredSystemWait {
    const normalized = normalizeStoredSystemWait(existing);
    const request = normalizeSystemWaitRequest(value);
    if (normalized.waitKey !== request.waitKey) {
        throw new TypeError("existing system wait has a different waitKey");
    }
    if (normalized.kind !== request.kind || normalized.reason !== request.reason) {
        throw new TypeError(`system wait key "${request.waitKey}" already has a different contract`);
    }
    return normalized;
}

export function applySystemWaitCommand(
    stored: StoredSystemWait,
    value: unknown,
    now = new Date(),
): StoredSystemWait {
    const existing = normalizeStoredSystemWait(stored);
    const command = normalizeSystemWaitCommand(value);
    if (command.waitKey !== existing.waitKey) {
        throw new TypeError("system wait command waitKey does not match the stored wait");
    }
    if (existing.status !== "pending") return existing;
    const updatedAt = now.toISOString();
    if (command.type === "signal") {
        return {
            ...existing,
            status: "completed",
            updatedAt,
            ...(Object.hasOwn(command, "payload") ? { result: command.payload } : {}),
        };
    }
    return {
        ...existing,
        status: "cancelled",
        updatedAt,
        cancellation: command.reason ? { reason: command.reason } : {},
    };
}

export function normalizeStoredSystemWait(value: unknown): StoredSystemWait {
    const input = requireRecord(
        typeof value === "string" ? JSON.parse(value) : value,
        "stored system wait",
    );
    const statusValue = input.status ?? (input.cancelled === true ? "cancelled" : "pending");
    if (typeof statusValue !== "string" || !(SYSTEM_WAIT_STATUSES as readonly string[]).includes(statusValue)) {
        throw new TypeError(`unknown system wait status: ${String(statusValue)}`);
    }
    const createdAt = normalizeTimestamp(input.createdAt ?? input.created_at, "createdAt");
    const updatedAt = normalizeTimestamp(input.updatedAt ?? input.updated_at, "updatedAt", createdAt);
    const legacyCancellationReason = input.cancelReason ?? input.cancel_reason;
    const cancellationInput = input.cancellation == null
        ? undefined
        : requireRecord(input.cancellation, "cancellation");
    const cancellationReason = normalizeOptionalText(
        cancellationInput?.reason ?? legacyCancellationReason,
        "cancellation.reason",
        MAX_REASON_LENGTH,
    );
    const status = statusValue as SystemWaitStatus;
    return {
        schemaVersion: 1,
        waitKey: normalizeSystemWaitKey(input.waitKey ?? input.wait_key),
        kind: normalizeSystemWaitKind(input.kind ?? "signal"),
        status,
        reason: normalizeRequiredText(input.reason, "reason", MAX_REASON_LENGTH),
        createdAt,
        updatedAt,
        ...(Object.hasOwn(input, "result")
            ? { result: normalizeDurableJsonValue(input.result, "result") }
            : {}),
        ...(status === "cancelled"
            ? { cancellation: cancellationReason ? { reason: cancellationReason } : {} }
            : {}),
    };
}

export function serializeStoredSystemWait(value: StoredSystemWait): string {
    return JSON.stringify(normalizeStoredSystemWait(value));
}
