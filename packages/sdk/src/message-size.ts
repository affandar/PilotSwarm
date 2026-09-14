export const MAX_MESSAGE_BYTES = 12 * 1024;

export class MessageTooLargeError extends Error {
    readonly code = "MESSAGE_TOO_LARGE";
    readonly status = 413;
    readonly maxBytes = MAX_MESSAGE_BYTES;

    constructor(readonly actualBytes: number) {
        super(`Message requires ${actualBytes} serialized UTF-8 bytes; the inline message limit is ${MAX_MESSAGE_BYTES} bytes. Upload large content as an artifact and send a short reference.`);
        this.name = "MessageTooLargeError";
    }
}

export function serializeMessagePayload(payload: Record<string, unknown>): string {
    const serialized = JSON.stringify(payload);
    const actualBytes = Buffer.byteLength(serialized, "utf8");
    if (actualBytes > MAX_MESSAGE_BYTES) throw new MessageTooLargeError(actualBytes);
    return serialized;
}