/**
 * Message sender identity (security model): a structured, server-stamped
 * record of who sent a message into a session. Attached to the durable
 * message queue payload and the `user.message` CMS event; surfaced to the
 * agent only in multi-writer sessions.
 *
 * Identity fields (`provider`, `subject`, `display`, `relation`) are stamped
 * at the API edge from the validated auth context — never trusted from the
 * client body. `origin` is client-declared display metadata only.
 *
 * This is attribution and prioritization metadata, NOT an authorization
 * mechanism — a message only reaches the queue because the dispatcher
 * already authorized it.
 */
export interface MessageSender {
    kind: "user" | "agent" | "system";
    /** Identity key of a user sender ((provider, subject) from the users catalog). */
    provider?: string;
    subject?: string;
    /** Human-readable name for rendering and prompt attribution. */
    display?: string;
    /** Relation to the session's tree at send time. */
    relation?: "owner" | "collaborator" | "admin";
    /** kind=agent: the sending session id. */
    sessionId?: string;
    /** Which surface sent it (display metadata, client-declared). */
    origin?: "portal" | "tui" | "mcp" | "api";
}

const SENDER_KINDS = new Set(["user", "agent", "system"]);
const SENDER_RELATIONS = new Set(["owner", "collaborator", "admin"]);
const SENDER_ORIGINS = new Set(["portal", "tui", "mcp", "api"]);

function clampString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Validate and normalize a sender record. Returns undefined for anything
 * that isn't a well-formed sender, so junk never rides the durable payload.
 */
export function normalizeMessageSender(sender: unknown): MessageSender | undefined {
    if (!sender || typeof sender !== "object" || Array.isArray(sender)) return undefined;
    const raw = sender as Record<string, unknown>;
    const kind = typeof raw.kind === "string" && SENDER_KINDS.has(raw.kind) ? raw.kind as MessageSender["kind"] : null;
    if (!kind) return undefined;

    const normalized: MessageSender = { kind };
    const provider = clampString(raw.provider, 100);
    const subject = clampString(raw.subject, 200);
    if (provider) normalized.provider = provider;
    if (subject) normalized.subject = subject;
    const display = clampString(raw.display, 200);
    if (display) normalized.display = display;
    if (typeof raw.relation === "string" && SENDER_RELATIONS.has(raw.relation)) {
        normalized.relation = raw.relation as MessageSender["relation"];
    }
    const sessionId = clampString(raw.sessionId, 200);
    if (sessionId) normalized.sessionId = sessionId;
    if (typeof raw.origin === "string" && SENDER_ORIGINS.has(raw.origin)) {
        normalized.origin = raw.origin as MessageSender["origin"];
    }
    if (kind === "user" && (!normalized.provider || !normalized.subject)) return undefined;
    return normalized;
}

/** Stable identity key for distinct-writer tracking. */
export function messageSenderKey(sender: MessageSender | null | undefined): string | null {
    if (!sender) return null;
    if (sender.kind === "user" && sender.provider && sender.subject) {
        return `user:${sender.provider}/${sender.subject}`;
    }
    if (sender.kind === "agent" && sender.sessionId) return `agent:${sender.sessionId}`;
    return sender.kind === "system" ? "system" : null;
}

/** The `[FROM: …]` attribution line shown to the agent in multi-writer sessions. */
export function formatSenderAttribution(sender: MessageSender): string {
    const name = sender.display || sender.subject || "unknown";
    const relation = sender.relation || (sender.kind === "user" ? "collaborator" : sender.kind);
    return `[FROM: ${name} (${relation})]`;
}
