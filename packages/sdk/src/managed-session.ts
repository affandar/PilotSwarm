import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { ToolFactsAccessor } from "./tool-facts-accessor.js";
import { normalizeCanvasResponseContract as normalizeCanvasContractShared } from "./canvas-app-manifest.js";
// One list gates BOTH halves of every manager tool: the declaration in the
// manager bundle and the per-turn handler below.
import { holdsManagerBundle } from "./agent-manager-tools.js";
// Same arrangement for the provider budget tools: holdsProviderTools() gates
// the declarations in systemToolDefs() and the handlers in runTurn().
import { holdsProviderTools, providerToolDefs, providerToolsUnavailable } from "./provider-tools.js";
import type { CycleReport, TurnAction, TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";
import type { ReasoningEffort } from "./model-providers.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingActions: TurnAction[];
    queuedActions: TurnAction[];
    cycleReport?: CycleReport;
    session: CopilotSession | null;
    waitThreshold: number;
}

const DEFAULT_WAIT_TOOL_DESCRIPTION ="The ONLY way to wait, pause, delay, or pause-before-retry inside a turn: a durable timer that survives " +
    "restarts and may resume on a different worker (set preserveWorkerAffinity=true for node-local work). " +
    "NEVER use bash sleep, setTimeout, setInterval, or any other external timing mechanism. " +
    "Do NOT keep burning tokens in an in-turn polling loop; after one brief immediate re-check at most, yield with a durable timer. " +
    "For recurring or periodic schedules, use the cron tool instead (cron_at for wall-clock schedules); if it is " +
    "genuinely ambiguous whether the task should become an ongoing monitor, clarify first.";

/**
 * show_artifact — the declaration AND the per-turn handler both build from this
 * one spec.
 *
 * Every other system tool here carries a "keep in sync with systemToolDefs()"
 * comment because the schema is written twice: once as a declaration stub (what
 * the LLM is shown at session-create time) and once as the real handler in
 * runTurn(). A tool that exists in only one of those two places is broken in a
 * particularly quiet way — a handler with no declaration is invisible to the
 * model, and a declaration with no handler returns "stub". Sharing the object
 * removes the drift instead of commenting about it.
 */
const SHOW_ARTIFACT_TOOL_SPEC = {
    description:
        "Display one of this session's artifacts in the user's portal: the right-hand panel switches to Files "
        + "and opens that file in its preview, live, while they are watching. "
        + "HTML renders as a real rendered page (charts, tables, layout, its own scripts), not as source. "
        + "Markdown, diffs, CSV, images and source files each get their matching viewer. "
        + "Use it the moment you finish building or updating something visual, and when the user asks to see, show, open, or look at a file. "
        + "The artifact must already exist on this session — write it first, then show it. "
        + "This does NOT end your turn and does not replace explaining your work: keep writing your normal reply. "
        + "Returns a shareable deep link that reopens this exact preview, so include that link in your reply for anyone reading later.",
    parameters: {
        type: "object",
        properties: {
            filename: {
                type: "string",
                description: "Artifact filename on this session, exactly as it was written (e.g. 'outage-graph.html').",
            },
            fullscreen: {
                type: "boolean",
                description:
                    "Open the preview full screen instead of beside the chat. Default false. "
                    + "Use true for dashboards and wide documents that need the room; leave false when the user should keep reading the conversation alongside it.",
            },
            note: {
                type: "string",
                description: "Optional one-line caption describing what the user is being shown.",
            },
        },
        required: ["filename"],
    },
    handler: async () => "stub",
} as const;

/**
 * The canvas tools — declaration AND per-turn handler both build from these
 * specs, the same drift-proofing SHOW_ARTIFACT_TOOL_SPEC uses.
 *
 * Every session has them, root and sub-agent alike, and every session draws
 * only its OWN canvases — up to five slots (canvas.html, canvas2..canvas5),
 * each with a rev and an agent-chosen name. The parent's canvases and a
 * child's are fully independent surfaces.
 */
/**
 * The canvas response contract, normalized to its canonical shape or refused.
 *
 * The contract is the SECURITY boundary for interactive canvases: the browser
 * accepts a postMessage from the canvas iframe only when it names a declared
 * action and matches its field types exactly, and accepts NOTHING when no
 * contract was drawn. Keeping the grammar tiny — flat actions, primitive
 * fields, hard caps — is what keeps the browser-side validator simple enough
 * to trust.
 */
// The contract grammar and the CANVAS-APP-MANIFEST extractor live together in
// canvas-app-manifest.ts: a manifest's embedded contract passes through the
// SAME normalizer this module applies to the tool argument. Re-exported so
// existing importers (tests included) keep their path.
export { normalizeCanvasResponseContract } from "./canvas-app-manifest.js";

const DRAW_CANVAS_TOOL_SPEC = {
    description:
        "Replace one of this session's canvases (persistent visual surfaces rendered live in the portal; slot 1-5, "
        + "default 1) with a complete self-contained HTML document. Draw when the user asks for something visual or a "
        + "graphic would greatly clarify an outcome — most replies need no drawing, and drawing switches the user's view. "
        + "Layout change = draw_canvas; content change = update_canvas(patch) (far cheaper). Exactly one source: inline "
        + "html (empty string clears), or fromArtifact to render a stored app server-side without the bytes entering your "
        + "context. Do not paste canvas links in replies. Before an interactive or shared canvas, load_skill(\"canvas-apps\"); "
        + "for layout, charts and the sandbox rules, load_skill(\"html-visuals\").",
    parameters: {
        type: "object",
        properties: {
            html: {
                type: "string",
                description: "The complete HTML document to display. Empty string clears the canvas.",
            },
            note: {
                type: "string",
                description: "Optional one-line caption for this revision (shown in the canvas header and activity feed).",
            },
            slot: {
                type: "number",
                description: "Which canvas to draw, 1-5. Default 1. Slots are independent surfaces with their own revisions.",
            },
            name: {
                type: "string",
                description: "Friendly name for this canvas, shown beside its revision (e.g. 'Poker table', 'Metrics'). Max 60 chars; omitting it keeps the current name.",
            },
            fromArtifact: {
                type: "object",
                description:
                    "Render a stored HTML artifact onto the canvas SERVER-SIDE (never read_artifact + re-paste). "
                    + "Mutually exclusive with html. The result returns the app's interface card (manifest summary + "
                    + "effective responseContract).",
                properties: {
                    sessionId: { type: "string", description: "Session that owns the source artifact. Defaults to this session." },
                    filename: { type: "string", description: "Source artifact filename, e.g. 'app-release-signoff.html' (artifact names are flat: no directories)." },
                    expectedSha256: { type: "string", description: "Optional precondition: fail with SHA_MISMATCH (no draw) if the source bytes hash differently." },
                },
                required: ["filename"],
            },
            responseContract: {
                type: "object",
                description:
                    "Optional: makes the canvas interactive. Shape {\"actions\":{\"<name>\":{\"<field>\":\"string\"|\"number\"|"
                    + "\"boolean\"|\"json\"}}} (\"?\" suffix = optional). Page controls post parent.postMessage({type:'canvas-action', "
                    + "action, data}, '*'); conforming posts reach you as '[canvas-action] {...}' user messages. A fromArtifact "
                    + "draw uses the embedded CANVAS-APP-MANIFEST contract unless you override it. Omit for display-only. "
                    + "Full protocol: load_skill(\"canvas-apps\").",
            },
            session_id: {
                type: "string",
                description: "Target an ANCESTOR session's canvas (your parent, grandparent, or the root) instead of your own. Sub-agents use this to draw on the parent's shared dashboard. Siblings, children, and unrelated sessions are refused.",
            },
        },
        required: [],
    },
    handler: async () => "stub",
} as const;

const UPDATE_CANVAS_TOOL_SPEC = {
    description:
        "Send a data tick to a canvas page WITHOUT replacing the document (slot 1-5, default 1): content changed, "
        + "layout did not. Exactly one of data (REPLACE the whole state — first tick after a draw, wholesale refresh) or "
        + "patch (RFC 7386 merge patch — ONLY the changed subtree; null deletes a key; tens of tokens). The page's "
        + "applyData(state) always gets the complete merged state. Ticks never steal the screen but DO mark the canvas "
        + "unseen. Cap 32 KB merged; ≥100 ms between ticks per slot. For state several PEOPLE write, use canvas_kv instead.",
    parameters: {
        type: "object",
        properties: {
            data: {
                type: "object",
                description: "REPLACE the whole state (exclusive with patch). The complete payload for the page's applyData().",
            },
            patch: {
                type: "object",
                description: "RFC 7386 merge patch (exclusive with data). Only the changed subtree; null deletes a key; merged into the current state server-side.",
            },
            note: {
                type: "string",
                description: "Optional one-line caption for the activity feed.",
            },
            slot: {
                type: "number",
                description: "Which canvas to tick, 1-5. Default 1.",
            },
            session_id: {
                type: "string",
                description: "Target an ANCESTOR session's canvas (your parent, grandparent, or the root) instead of your own. Sub-agents use this to keep a shared dashboard on the parent live. Siblings, children, and unrelated sessions are refused.",
            },
        },
        required: [],
    },
    handler: async () => "stub",
} as const;

const SHOW_CANVAS_TOOL_SPEC = {
    description:
        "Turn the user's view to an ALREADY-DRAWN canvas (slot 1-5, default 1) without redrawing: no bytes, no new "
        + "revision, nothing is marked unseen. Use when the conversation returns to something you drew earlier. "
        + "Respects a dismissal the same way draws do.",
    parameters: {
        type: "object",
        properties: {
            slot: { type: "number", description: "Which canvas to present, 1-5. Default 1." },
            session_id: {
                type: "string",
                description: "Target an ANCESTOR session's canvas (your parent, grandparent, or the root) instead of your own. Sub-agents use this to keep a shared dashboard on the parent live. Siblings, children, and unrelated sessions are refused.",
            },
        },
        required: [],
    },
    handler: async () => "stub",
} as const;

const READ_CANVAS_TOOL_SPEC = {
    description:
        "Read one of this session's canvases back as HTML, paged (slot 1-5, default 1). "
        + "Use it before iterating on an existing drawing, and after context regeneration — the canvas survives even "
        + "when your memory of drawing it does not. "
        + "Read selectively: page with offset/maxBytes rather than round-tripping a large document every turn.",
    parameters: {
        type: "object",
        properties: {
            offset: { type: "number", description: "Character offset to start reading from (default 0)." },
            slot: { type: "number", description: "Which canvas to read, 1-5. Default 1." },
            maxBytes: { type: "number", description: "Maximum characters to return (default 65536, cap 262144)." },
            manifestOnly: {
                type: "boolean",
                description: "Only the interface card (manifest summary + armed responseContract), no bytes — the cheap way to re-learn an interactive canvas.",
            },
            include_data: {
                type: "boolean",
                description: "Also return the current tick state (`live`: merged data, seq, writer; up to 32 KB). Use to resync before patching.",
            },
            session_id: {
                type: "string",
                description: "Target an ANCESTOR session's canvas (your parent, grandparent, or the root) instead of your own. Sub-agents use this to keep a shared dashboard on the parent live. Siblings, children, and unrelated sessions are refused.",
            },
        },
    },
    handler: async () => "stub",
} as const;

const CANVAS_KV_TOOL_SPEC = {
    description:
        "The canvas KV store: durable per-key shared state for an interactive canvas app (slot 1-5, default 1). "
        + "Every permitted viewer and you write it; every viewer sees each change live (~50 ms) with NO redraw and NO turn. "
        + "Use it for app state (app/<item>), requests from the page (req/<id>: read on wake, land each in done|failed), "
        + "and notes to the page (evt/<n>). One key per item — never a list in one key. "
        + "get/list read; put/delete write (put accepts ifMatch: 0 = create only, N = current rev must be N). "
        + "Values are ≤16 KB; 1000 keys and 2 MB per canvas. Load the canvas-apps skill (load_skill) for the protocol.",
    parameters: {
        type: "object",
        properties: {
            op: { type: "string", enum: ["get", "put", "list", "delete"], description: "get one key · list a prefix · put a value · delete a key." },
            key: { type: "string", description: "Key for get/put/delete, e.g. app/item/5502432 or req/7f3a. Letters, digits, . _ / - only." },
            value: { description: "put: the value to store (any JSON). The page reads it back as-is." },
            prefix: { type: "string", description: "list: key prefix, e.g. req/ or app/. Omit for everything." },
            limit: { type: "number", description: "list: page size (≤200)." },
            after: { type: "string", description: "list: cursor — the last key of the previous page." },
            ifMatch: { type: "number", description: "put/delete: compare-and-swap. 0 = the key must not exist (claim); N = the current rev must be N." },
            slot: { type: "number", description: "Which canvas, 1-5. Default 1." },
            session_id: { type: "string", description: "Target an ANCESTOR session's canvas (parent, grandparent, root). Siblings, children, unrelated sessions are refused." },
        },
        required: ["op"],
    },
    handler: async () => "stub",
} as const;

const PUBLISH_CANVAS_APP_TOOL_SPEC = {
    description:
        "Publish the canvas on a slot as a reusable app that EVERY session in the deployment can find and draw. "
        + "Copies the document to a pinned artifact app-<name>.html and writes the catalog card (shared fact apps/<name>) "
        + "from the document's CANVAS-APP-MANIFEST — which MUST carry an `interface` block (keys, requests, events) so "
        + "another agent can drive the app from the card alone. Call it when the user says to share the app with the "
        + "team. Publishing is a disclosure: publish the SHELL, never a page with data baked in.",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "Catalog slug, e.g. release-signoff. Lowercase letters, digits, dashes. Republishing the same name replaces the card." },
            description: { type: "string", description: "The text the catalog RANKS on. Say WHEN to use the app: 'Use when several approvers sign off a release train together.' Not the mechanics." },
            tags: { type: "array", items: { type: "string" }, description: "Optional catalog tags, e.g. [\"review\", \"release\"]." },
            slot: { type: "number", description: "Which canvas to publish, 1-5. Default 1." },
            session_id: { type: "string", description: "Publish an ANCESTOR session's canvas instead of your own." },
        },
        required: ["name", "description"],
    },
    handler: async () => "stub",
} as const;

const FIND_CANVAS_APP_TOOL_SPEC = {
    description:
        "Search the deployment's catalog of published canvas apps. LOOK BEFORE BUILDING: when the user asks for an app "
        + "(a board, a poll, a sign-off sheet, a review workbench), search first and offer an existing one. Returns ranked "
        + "cards {key, name, description, tags, kv, source}. Then read_facts(key_pattern=\"apps/<name>\", scope=\"shared\") "
        + "for the full card — its `interface` tells you the KV keys and req/* ops the app speaks — and "
        + "draw_canvas({fromArtifact: card.source}) to put it on screen.",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "The situation, in words: 'review a pull request diff', 'team availability', 'release sign-off'." },
            limit: { type: "number", description: "Max results (default 8, cap 20)." },
        },
        required: ["query"],
    },
    handler: async () => "stub",
} as const;

const LOAD_SKILL_TOOL_SPEC = {
    description:
        "Load a skill's full instructions on demand. The system prompt lists the available skills by name with a "
        + "one-line description; call this with a name when the task at hand matches one (e.g. canvas-apps before building "
        + "an interactive canvas, html-visuals before a dashboard). The body is returned once as this tool's result — "
        + "do not call it again for the same skill in one session.",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "Skill name exactly as listed in the system prompt's skills index." },
        },
        required: ["name"],
    },
    handler: async () => "stub",
} as const;

const CHILD_SESSION_RESULT_SCHEMA = {
    type: "object",
    additionalProperties: true,
    properties: {
        verdict: {
            type: "string",
            enum: ["success", "partial", "blocked", "failed", "cancelled", "timed_out"],
            description: "Outcome verdict.",
        },
        summary: { type: "string", description: "Compact outcome summary." },
        factsWritten: {
            type: "array",
            description: "Facts produced by the child. Prefer objects with a key; string keys are accepted for compatibility.",
            items: {
                oneOf: [
                    { type: "string" },
                    { type: "object", required: ["key"], properties: { key: { type: "string" } }, additionalProperties: true },
                ],
            },
        },
        artifactsWritten: {
            type: "array",
            description: "Artifacts produced by the child. Prefer objects with a path; string paths are accepted for compatibility.",
            items: {
                oneOf: [
                    { type: "string" },
                    { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: true },
                ],
            },
        },
        blockers: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } },
    },
} as const;

function hasAssistantToolCalls(message: any): boolean {
    return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

// Invisible characters a model emits when it is asked to say nothing but the
// turn still demands a final answer. JS `trim()` does NOT remove these: they are
// Unicode format characters (Cf), not White_Space, so `"\u200b".trim()` is still
// one character long and every "blank" filter keyed on trim() lets them through.
//
// Observed: an agent on a fast monitoring cron was told to "end the turn
// silently" on a quiet cycle. Having no way to emit nothing, it produced a
// zero-width space each cycle — a real assistant.message the SDK dutifully
// recorded and every UI dutifully rendered as an empty "Agent:" line, once a
// minute, forever.
const INVISIBLE_CONTENT_CHARS = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** Strip invisible/zero-width characters, then whitespace. */
export function stripInvisibleContent(value: string): string {
    return value.replace(INVISIBLE_CONTENT_CHARS, "").trim();
}

function isBlankAssistantContent(content: unknown): boolean {
    if (content == null) return true;
    if (typeof content === "string") return stripInvisibleContent(content).length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return false;
}

function sanitizeMessageContent(message: any): number {
    if (!message || typeof message !== "object") return 0;
    if (message.content == null) {
        message.content = "";
        return 1;
    }
    if (!Array.isArray(message.content)) return 0;

    let normalized = 0;
    const parts = message.content.filter((part: any) => part != null);
    if (parts.length !== message.content.length) normalized += 1;
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(part, "text") && part.text == null) {
            part.text = "";
            normalized += 1;
        }
    }
    if (normalized > 0) message.content = parts;
    return normalized;
}

/**
 * Response-only message fields that carry no information when null.
 *
 * OpenAI and Azure emit these and accept them coming back. Strict
 * OpenAI-compatible endpoints do not — they validate the request schema and
 * reject unknown keys outright instead of ignoring them. Fireworks answers
 * `400 Extra inputs are not permitted, field: 'messages[N].refusal', value:
 * None`, and only once the conversation is long enough for a message carrying
 * one to re-enter the replayed history. So the provider looks healthy for
 * several turns and then fails, which makes it easy to misread as flakiness.
 *
 * The same class of bug is well documented against other clients for
 * `stream_options`, `promptCacheKey`, `service_tier`, and replayed
 * `tool_calls[].call_id`. Stripping is safe precisely because it is limited to
 * null values: a null `refusal` says nothing that omitting it does not.
 */
const NULL_ONLY_RESPONSE_FIELDS = ["refusal", "annotations", "audio", "function_call"] as const;

function stripNullResponseOnlyFields(message: any): number {
    if (!message || typeof message !== "object") return 0;
    let stripped = 0;
    for (const field of NULL_ONLY_RESPONSE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(message, field) && message[field] == null) {
            delete message[field];
            stripped += 1;
        }
    }
    return stripped;
}

function sanitizeCopilotMessagesForReplay(messages: any): number {
    if (!Array.isArray(messages)) return 0;
    let normalized = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== "object") continue;
        if (message.role === "assistant" && !hasAssistantToolCalls(message) && isBlankAssistantContent(message.content)) {
            messages.splice(index, 1);
            normalized += 1;
            continue;
        }

        // Azure OpenAI rejects assistant tool-call messages when content is
        // null. The Copilot runtime may persist tool-only assistant turns in
        // that shape, so coerce them to the semantically-equivalent empty
        // string before sending the next turn.
        normalized += sanitizeMessageContent(message);
        normalized += stripNullResponseOnlyFields(message);
    }
    return normalized;
}

function normalizeCopilotSessionMessageHistory(session: any): number {
    let normalized = 0;
    normalized += sanitizeCopilotMessagesForReplay(session?._chatMessages);
    normalized += sanitizeCopilotMessagesForReplay(session?._systemContextMessages);
    return normalized;
}

function isEmptyAssistantTranscriptEvent(eventType: string, eventData: unknown): boolean {
    if (eventType !== "assistant.message") return false;
    if (!eventData || typeof eventData !== "object") return true;
    const data = eventData as Record<string, unknown>;
    const content = data.content ?? data.text ?? data.message;
    if (!isBlankAssistantContent(content)) return false;
    return !hasAssistantToolCalls(data) && data.toolCalls == null && data.reasoning == null;
}

function extractAssistantMessageContent(event: any): string | undefined {
    const content = event?.data?.content ?? event?.data?.text ?? event?.data?.message;
    // Same trap as isBlankAssistantContent: a zero-width-space "silent" reply is
    // not a response, and must not become the session's latest_response.
    return typeof content === "string" && stripInvisibleContent(content) ? content : undefined;
}

function acknowledgeTurnBoundary(action: string): string {
    return `[SYSTEM: ${action} acknowledged. The runtime will suspend at the end of this turn. ` +
        `Finish any remaining tool results for the current step, then stop.]`;
}

const TERMINAL_TURN_BOUNDARY_ACTIONS = new Set(["completed", "wait", "input_required", "wait_for_agents", "list_sessions", "check_agents"]);

function hasTerminalTurnBoundary(turnState: TurnState): boolean {
    return turnState.pendingActions.some((action) => TERMINAL_TURN_BOUNDARY_ACTIONS.has(action.type));
}

function blockedAfterTurnBoundary(toolName: string): string {
    return `[SYSTEM: ${toolName} was not executed because a previous control tool already scheduled this turn to suspend. ` +
        `Stop now; the runtime will resume with the control-tool result.]`;
}

function splitQualifiedModel(model: string | undefined): { provider: string; model: string } {
    const configured = String(model || "").trim();
    if (!configured) return { provider: "(default)", model: "(default)" };
    const separator = configured.indexOf(":");
    if (separator <= 0) return { provider: "(unqualified)", model: configured };
    return {
        provider: configured.slice(0, separator),
        model: configured.slice(separator + 1),
    };
}

function formatCurrentModelConfig(config: ManagedSessionConfig): string {
    const configured = String(config.model || "").trim() || "(default)";
    const { provider, model } = splitQualifiedModel(config.model);
    const reasoningEffort = config.reasoningEffort ?? "(default)";
    return [
        "Current session configured model (this turn):",
        `- provider: ${provider}`,
        `- model: ${model}`,
        `- qualified_model: ${configured}`,
        `- reasoning_effort: ${reasoningEffort}`,
    ].join("\n");
}

// ── Tool-call-as-text guard ──────────────────────────────────────
// Some models (observed on claude-opus-4.8, especially on repetitive keepalive
// cron cycles) intermittently emit a tool call as literal
// `<invoke name="...">`/`<parameter>` text inside the assistant message instead
// of a real tool_use block. That text is never executed, so a consequential
// call (store_fact, complete_agent, an ADO write, etc.) would be silently
// dropped while the transcript implies it happened. We detect the malformed
// text and re-prompt the model — bounded — to actually invoke the tool.
const MAX_TEXT_TOOL_CALL_CORRECTIONS = 2;
const MAX_REQUIRED_TOOL_CORRECTIONS = 1;
const TEXT_TOOL_CALL_INVOKE_RE = /<(?:antml:)?invoke\s+name\s*=\s*"([^"]+)"/i;
const TEXT_TOOL_CALL_STRUCTURE_RE = /<\/(?:antml:)?invoke\s*>|<(?:antml:)?parameter\b/i;
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

// Zombie-turn protection. The Copilot CLI subprocess signals turn completion
// only via events; if it dies mid-turn (e.g. V8 heap OOM), session.idle never
// arrives, runTurn awaits forever, and the durable runTurn activity stays
// in-flight permanently while the session's queue backs up. Two guards settle
// the turn instead. Both are per-turn and worker-side only — no orchestration
// change. An explicit 0 disables either guard.
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
// The inactivity settle is phrased to match isCopilotConnectionClosedError()
// (orchestration/utils.ts) so the existing connection-closed recovery runs:
// release affinity, delayed retry on a fresh subprocess, bounded by
// COPILOT_CONNECTION_CLOSED_MAX_RETRIES with a lossy-handoff fallback.
export const TURN_INACTIVITY_ERROR_MARKER = "connection is closed or the subprocess is wedged";

/**
 * Detect a tool call the model emitted as literal text instead of a real
 * tool_use block. Requires both the `<invoke name="...">` opener and a closing
 * `</invoke>` or a `<parameter>` tag so prose that merely mentions the word
 * "invoke" does not trip the guard. Returns the tool name, or null.
 */
function detectTextEmittedToolCall(content: unknown): { toolName: string; rawContent: string } | null {
    if (typeof content !== "string" || content.length === 0) return null;
    const withoutExamples = content.replace(FENCED_CODE_BLOCK_RE, "");
    const nameMatch = withoutExamples.match(TEXT_TOOL_CALL_INVOKE_RE);
    if (!nameMatch) return null;
    if (!TEXT_TOOL_CALL_STRUCTURE_RE.test(withoutExamples)) return null;

    const beforeInvoke = withoutExamples.slice(0, nameMatch.index ?? 0).trim();
    const afterClose = withoutExamples.replace(/[\s\S]*<\/(?:antml:)?invoke\s*>/i, "").trim();
    if (afterClose) return null;

    // Allow the common one-token junk prefix observed from claude-opus-4.8
    // (for example "court\n<invoke ...>") but do not flag explanatory prose,
    // markdown docs, or examples that happen to contain Anthropic XML syntax.
    if (beforeInvoke && beforeInvoke.split(/\s+/).length > 1) return null;

    return { toolName: (nameMatch[1] || "").trim() || "the requested tool", rawContent: content };
}

function buildTextEmittedToolCallCorrection(toolName: string): string {
    const named = toolName && toolName !== "the requested tool" ? `the "${toolName}" tool` : "the intended tool";
    return `[SYSTEM: Tool-call protocol error. Your previous message contained a tool call written as literal text ` +
        `(for example \`<invoke name="${toolName}">\` with <parameter> tags). Text formatted like that is NOT executed — ` +
        `the tool did not run and produced no result, so anything you implied there has NOT actually happened. ` +
        `Come to your senses and actually invoke ${named} now using the real tool-calling mechanism, not text. ` +
        `Do not write <invoke> or <parameter> tags as message content. ` +
        `If you did not actually need a tool this turn, reply with plain prose only and no tool-call markup.]`;
}

function buildRequiredToolCorrection(toolName: string): string {
    return `[SYSTEM: Required-tool contract violation. Your previous response did not invoke the "${toolName}" tool. ` +
        `Claims, estimates, and remembered results do not satisfy this request. Invoke "${toolName}" now using the real ` +
        `tool-calling mechanism, then answer only from its result.]`;
}

function hasInvokedTool(events: CapturedEvent[], requiredTool: string): boolean {
    return events.some((event) => {
        if (event.eventType !== "tool.execution_start" && event.eventType !== "tool.execution_complete") return false;
        const data = event.data as any;
        const toolName = typeof data?.toolName === "string"
            ? data.toolName
            : typeof data?.name === "string"
                ? data.name
                : "";
        return toolName.trim() === requiredTool;
    });
}

function failureToolResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? "Tool failed");
    return {
        textResultForLlm: `Tool failed: ${message}`,
        resultType: "failure",
        error: message,
        toolTelemetry: {},
    };
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
    const effort = String(value || "").trim().toLowerCase();
    return effort === "none" || effort === "minimal" || effort === "low" || effort === "medium"
        || effort === "high" || effort === "xhigh" || effort === "max"
        ? effort
        : undefined;
}

function isBenignPostCompletionQueryError(eventData: any): boolean {
    if (!eventData || typeof eventData !== "object") return false;
    return eventData.errorType === "query"
        && String(eventData.message || "").includes("Cannot read properties of null (reading 'length')");
}

/**
 * ManagedSession — wraps a CopilotSession and provides the interface
 * that the orchestration calls into (via SessionProxy).
 *
 * Key design decisions:
 *  1. Uses send() + on() internally, never sendAndWait().
 *  2. runTurn() returns a TurnResult to the orchestration — the orchestration
 *     decides what to do with wait/input_required/completed.
 *  3. The session stays alive in memory across runTurn() calls.
 *  4. Abort is cooperative — the orchestration cancels via race, which
 *     triggers abort() on this session.
 *
 * @internal
 */
export class ManagedSession {
    readonly sessionId: string;
    private copilotSession: CopilotSession;
    private config: ManagedSessionConfig;
    /** Skills the `load_skill` tool may return, by reference from the worker. */
    private skillCatalog: Array<{ name: string; description: string; prompt: string }> = [];
    // `invocation.facts` for worker-registered tools; set by SessionManager
    // right after construction (it owns the fact store). Null on a worker
    // without one — tools must check.
    private factsAccessor: ToolFactsAccessor | null = null;
    setFactsAccessor(accessor: ToolFactsAccessor | null): void {
        this.factsAccessor = accessor;
    }

    setSkillCatalog(list: Array<{ name: string; description: string; prompt: string }>): void {
        this.skillCatalog = Array.isArray(list) ? list : [];
    }
    /** Set for the duration of runTurn(); read by the lock-bypassing stop path. */
    private activeTurn: { turnIndex: number; startedAt: number } | null = null;
    /** Set only by requestStop(); classifies the turn unwind as "stopped". */
    private stopRequest: { reason: string; requestedAt: number } | null = null;
    /** Resolver for the current turn's completion promise — hang escalation hook. */
    private settleTurnResolver: (() => void) | null = null;

    constructor(
        sessionId: string,
        copilotSession: CopilotSession,
        config: ManagedSessionConfig,
    ) {
        this.sessionId = sessionId;
        this.copilotSession = copilotSession;
        this.config = config;
    }

    /**
     * System tool definitions for session creation.
     * These are registered at createSession time so the LLM sees them.
     * Handlers are placeholder stubs — real handlers are set per-turn in runTurn().
     *
     * `agentIdentity` selects the bundles only some agents carry. A tool
     * declaration is resident context on every turn of every session that
     * carries it, so the ten provider budget tools go to the two Token
     * Manager agents and nobody else. Omitting it declares the tools every
     * session gets.
     */
    static systemToolDefs(opts?: { agentIdentity?: string | null }): Tool<any>[] {
        const waitTool = defineTool("wait", {
            // Defensive override: the Copilot SDK ships built-in tools named
            // `wait` in some configurations (e.g. the desktop-automation MCP
            // server). PilotSwarm's `wait` is the durable-timer version and
            // must always win in our worker.
            overridesBuiltInTool: true,
            description: DEFAULT_WAIT_TOOL_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                    preserveWorkerAffinity: {
                        type: "boolean",
                        description:
                            "Set true when the work you are waiting on is tied to this worker's local state " +
                            "(for example a local process, file, or socket) and you want PilotSwarm to " +
                            "preserve the current worker affinity across a durable wait.",
                    },
                    material: {
                        type: "boolean",
                        description:
                            "Only when you have a PARENT session: set true if this wait carries a finding the parent " +
                            "must see now (a blocker, an escalation, a result it is waiting on). A plain wait is a " +
                            "heartbeat and does not wake the parent; it hears from you at your next completion or its " +
                            "own next schedule.",
                    },
                },
                required: ["seconds"],
            },
            handler: async () => "stub",
        });

        const waitOnWorkerTool = defineTool("wait_on_worker", {
            description:
                "Durably wait while preserving the current worker affinity when possible. " +
                "Use this when the thing you are waiting on is tied to worker-local state " +
                "(for example a local process, file, socket, or in-memory store on this worker). " +
                "This is equivalent to wait(..., preserveWorkerAffinity=true), but more reliable " +
                "because you do not need to set the flag yourself.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting on worker-local state" },
                },
                required: ["seconds"],
            },
            handler: async () => "stub",
        });

        const cronTool = defineTool("cron", {
            description:
                "Declare a recurring durable schedule owned by the orchestration. " +
                "Use this for independent periodic monitoring, external polling, and scheduled digests so you do NOT need to call wait() at the end of every turn. " +
                "Do not use cron solely to poll sub-agent status; qualifying child updates wake the parent according to contract.wakeOn. " +
                "Use this when you should keep pursuing a goal autonomously until it is done. " +
                "If it is genuinely ambiguous whether the task should become an ongoing recurring workflow, clarify that intent before setting cron. " +
                "Set or update the schedule with seconds + reason. Cancel it with action='cancel'. " +
                "Minimum interval is 15 seconds.",
            parameters: {
                type: "object",
                properties: {
                    seconds: {
                        type: "number",
                        description: "Interval between recurring wake-ups in seconds (minimum 15).",
                    },
                    reason: {
                        type: "string",
                        description: "What to do on each wake-up. Required when setting a schedule.",
                    },
                    action: {
                        type: "string",
                        enum: ["cancel"],
                        description: "Use action='cancel' to clear the active recurring schedule.",
                    },
                },
            },
            handler: async () => "stub",
        });

        const cronAtTool = defineTool("cron_at", {
            description:
                "Declare a recurring wall-clock schedule owned by the orchestration. " +
                "Use this for calendar-anchored work like 'run nightly at 02:00 UTC' or 'fire Mondays at 09:00 America/New_York'. " +
                "Do NOT implement wall-clock schedules by polling every N minutes with cron(seconds=...) and checking the clock - that wastes tokens and turns. " +
                "For fixed-interval work like 'every 60 seconds', keep using cron(seconds, reason). " +
                "Recurrence is inferred from the fields you provide: minute (hourly), minute+hour (daily), minute+hour+day_of_week (weekly), minute+hour+day_of_month (monthly). " +
                "Pass max_fires=1 for a single one-shot scheduled-at-time action. " +
                "Cancel with action='cancel'.",
            parameters: {
                type: "object",
                properties: {
                    minute: { type: "number", description: "Wall-clock minute 0-59. Required when setting a schedule." },
                    hour: { type: "number", description: "Wall-clock hour 0-23. Omit for hourly recurrence." },
                    day_of_week: { type: "number", description: "0-6 with Sunday=0. Weekly recurrence; requires hour. Cannot combine with day_of_month." },
                    day_of_month: { type: "number", description: "1-31. Monthly recurrence; requires hour. Months without that day are skipped (no 'last day' semantics in v1)." },
                    tz: { type: "string", description: "IANA timezone (required). Examples: 'UTC', 'America/Los_Angeles'." },
                    max_fires: { type: "number", description: "Optional positive integer cap on total fires. Use 1 for a one-shot scheduled action." },
                    reason: { type: "string", description: "What to do on each wake-up. Required when setting a schedule." },
                    action: { type: "string", enum: ["cancel"], description: "Use action='cancel' to clear the active recurring schedule (works for either cron or cron_at)." },
                },
            },
            handler: async () => "stub",
        });

        const askUserTool = defineTool("ask_user", {
            // Defensive override: the Copilot SDK exposes an `ask_user` MCP
            // prompt and may surface it as a built-in tool in some configs.
            // PilotSwarm's `ask_user` routes through the durable orchestration
            // (so the request survives worker restarts) and must always win.
            overridesBuiltInTool: true,
            description:
                "Ask the user a question and wait for their response. " +
                "Use this when you need clarification or user input before proceeding.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The question to ask the user" },
                    choices: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of choices for the user",
                    },
                    allowFreeform: {
                        type: "boolean",
                        description: "Whether to allow freeform text input (default: true)",
                    },
                },
                required: ["question"],
            },
            handler: async () => "stub",
        });

        const reportCycleTool = defineTool("report_cycle", {
            description:
                "Report the outcome of the current recurring cron/cron_at watcher cycle when something material happened. " +
                "Use status='material' when the parent should be notified, and status='blocked' when the cycle found a blocker or failure that needs parent attention. " +
                "On an uneventful cycle, prefer NOT calling this tool at all — just end the turn silently; status='quiet' is accepted but unnecessary. " +
                "This tool does not end the turn; after calling it, finish normally. It is ignored outside recurring watcher cycles.",
            parameters: {
                type: "object",
                properties: {
                    status: { type: "string", enum: ["quiet", "material", "blocked"], description: "Whether this recurring cycle was quiet or should wake the parent." },
                    summary: { type: "string", description: "Optional concise machine-readable summary of the cycle outcome." },
                    deltas: { type: "array", items: { type: "string" }, description: "Optional concrete changes found this cycle." },
                },
                required: ["status"],
            },
            handler: async () => "stub",
        });

        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's exact qualified name (provider:model), description, and cost tier. " +
                "Also returns this session's current configured provider, model, and reasoning effort for the current turn. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
                "Models may also list supported reasoning efforts; pass spawn_agent(reasoning_effort=...) only with one of those listed values. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        const setSessionModelTool = defineTool("set_session_model", {
            description:
                "Switch this session's model for the next turn boundary. " +
                "Call list_available_models first and pass an exact provider:model value returned there. " +
                "This ends the current turn. After it succeeds, stop; the runtime will continue on the selected model.",
            parameters: {
                type: "object",
                properties: {
                    model: { type: "string", description: "Exact provider:model value from list_available_models." },
                    reasoning_effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Optional reasoning effort supported by the selected model." },
                },
                required: ["model"],
            },
            handler: async () => "stub",
        });

        // Declaration stubs for the regeneration tools. Real per-turn handlers
        // (with controlBridge wiring) are set in runTurn()'s systemToolsForTurn;
        // these mirror their schemas so the declarations reach the CLI server via
        // sessionConfig.tools — without them the LLM never sees the tools.
        const regenerateContextTool = defineTool("regenerate_context", {
            description:
                "Regenerate YOUR OWN context: your transcript is archived, distilled into a resume "
                + "package, and your working memory is rebuilt fresh from it at the next turn boundary. "
                + "Durable state (facts, artifacts, children, schedule, chat history) is untouched; "
                + "workspace files are dropped (the package maps how to recreate them). Use when "
                + "context_health reads degraded, or you notice yourself losing track of earlier work. "
                + "Rate-limited (once per epoch, 6h cooldown). Finish the current step FIRST — this ends the turn.",
            parameters: {
                type: "object",
                properties: {
                    handoff: {
                        type: "string",
                        description:
                            "Your own statement of what matters right now: mission, in-flight work, "
                            + "commitments, pitfalls. This is a HINT to the distiller (cross-checked "
                            + "against the transcript), max 4000 chars.",
                    },
                    instructions: {
                        type: "string",
                        description:
                            "Optional distilling instructions — HOW to distill (e.g. 'preserve every SQL "
                            + "snippet verbatim', 'drop the debugging tangents'). Max 4000 chars.",
                    },
                },
                required: ["handoff"],
            },
            handler: async () => "stub",
        });

        const regenerateAgentTool = defineTool("regenerate_agent", {
            description:
                "Regenerate a DIRECT child agent's context in place (its transcript is archived, "
                + "distilled, and rebuilt) while it keeps its identity, queue, facts, and its link to you. "
                + "Prefer this over killing and respawning a degraded long-running child. Applies at the "
                + "child's next turn boundary; per-child rate limits apply.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The child session id (raw UUID or session-<uuid>)." },
                    handoff: { type: "string", description: "Optional hint to the child's distiller about what the child should stay focused on (max 4000 chars)." },
                    instructions: { type: "string", description: "Optional distilling instructions — HOW to distill the child's transcript (max 4000 chars)." },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        const sendSessionMessageTool = defineTool("send_session_message", {
            description:
                "Send an auditable asynchronous request to another PilotSwarm session. Use list_sessions first to find the target session id. " +
                "Set expects_response=true when you need an answer back. The target must answer with reply_session_message; its normal chat transcript is not the response channel.",
            parameters: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "Target session id." },
                    subject: { type: "string", description: "Short request subject." },
                    body: { type: "string", description: "Request body, concise and self-contained." },
                    reason: { type: "string", enum: ["help", "guidance", "fact-request", "status-request", "handoff"], description: "Optional request reason." },
                    expects_response: { type: "boolean", description: "Whether a response is expected." },
                    expires_at: { type: "string", description: "Optional ISO timestamp after which the request is stale." },
                },
                required: ["session_id", "subject", "body"],
            },
            handler: async () => "stub",
        });

        const replySessionMessageTool = defineTool("reply_session_message", {
            description:
                "Reply to a cross-session request previously received from another PilotSwarm session. " +
                "Use this whenever a [SESSION_MESSAGE ... expects_response=true] prompt asks you for an answer. " +
                "Do not only write the answer in your own chat; the sender receives it only if this tool is called.",
            parameters: {
                type: "object",
                properties: {
                    request_id: { type: "string", description: "Request id being answered." },
                    session_id: { type: "string", description: "Session id that should receive the reply." },
                    verdict: { type: "string", enum: ["answered", "declined", "blocked", "stale"], description: "Reply outcome." },
                    body: { type: "string", description: "Reply body." },
                },
                required: ["request_id", "session_id", "body"],
            },
            handler: async () => "stub",
        });

        const showArtifactTool = defineTool("show_artifact", SHOW_ARTIFACT_TOOL_SPEC);
        const drawCanvasTool = defineTool("draw_canvas", DRAW_CANVAS_TOOL_SPEC);
        const updateCanvasTool = defineTool("update_canvas", UPDATE_CANVAS_TOOL_SPEC);
        const readCanvasTool = defineTool("read_canvas", READ_CANVAS_TOOL_SPEC);
        const showCanvasTool = defineTool("show_canvas", SHOW_CANVAS_TOOL_SPEC);
        const canvasKvTool = defineTool("canvas_kv", CANVAS_KV_TOOL_SPEC);
        const publishCanvasAppTool = defineTool("publish_canvas_app", PUBLISH_CANVAS_APP_TOOL_SPEC);
        const findCanvasAppTool = defineTool("find_canvas_app", FIND_CANVAS_APP_TOOL_SPEC);
        const loadSkillTool = defineTool("load_skill", LOAD_SKILL_TOOL_SPEC);

        return [waitTool, waitOnWorkerTool, cronTool, cronAtTool, askUserTool, reportCycleTool, listModelsTool, setSessionModelTool, regenerateContextTool, regenerateAgentTool, sendSessionMessageTool, replySessionMessageTool, showArtifactTool, drawCanvasTool, updateCanvasTool, readCanvasTool, showCanvasTool, canvasKvTool, publishCanvasAppTool, findCanvasAppTool, loadSkillTool,
            ...(holdsProviderTools(opts?.agentIdentity) ? providerToolDefs() : [])];
    }

    /**
     * Sub-agent tool definitions.
     * These are the LLM-visible tools for spawning and managing sub-agents.
     * Like wait/ask_user, handlers are stubs — real handlers set per-turn in runTurn().
     */
    static subAgentToolDefs(): Tool<any>[] {
        const spawnAgentTool = defineTool("spawn_agent", {
            description:
                "Spawn an autonomous sub-agent to work on a task in parallel. " +
                "The sub-agent is a full Copilot session with its own conversation and tools. " +
                "Returns an agent ID you can use to check status, send messages, or wait for completion. " +
                "If the user explicitly asks you to use sub-agents, delegation, fan-out, or parallel processing, you should comply within runtime limits instead of collapsing the work into a direct answer. " +
                "If the user did not explicitly ask for delegation, use your judgment about whether parallel work is actually helpful. " +
                "Each agent adds cost, so avoid unnecessary fan-out when delegation was not requested. " +
                "For KNOWN user-creatable agents, pass agent_name. The agent's prompt, tools, and task load automatically. " +
                "You MAY spawn multiple concurrent instances of the same agent_name (e.g. one per bug or per shard); they each get their own conversation. The only caps are the global maximum concurrent sub-agents and the maximum nesting depth. " +
                "Sub-agents do NOT auto-terminate when they finish their task \u2014 they stay alive idle, ready for follow-up via message_agent. YOU are responsible for closing each child with complete_agent (graceful), cancel_agent (interrupt), or delete_agent (forceful) when you no longer need it. " +
                "Worker-managed system agents are NOT valid spawn_agent targets; if one is missing, the workers likely need to be restarted. " +
                "For CUSTOM agents (ad-hoc tasks), pass task instead. " +
                "Call ps_list_agents to see all available named agents you CAN spawn. " +
                "By default, sub-agents inherit the parent's model. " +
                "If you want to override the model, call list_available_models first and use only an exact provider:model value returned there. " +
                "If you want to override reasoning power, also use only a reasoning_effort value listed for that model. " +
                "Never invent, guess, or shorten model names.",
            parameters: {
                type: "object",
                properties: {
                    agent_name: {
                        type: "string",
                        description: "Name of a known user-creatable agent to spawn (from ps_list_agents). The agent's system message, tools, and initial prompt are loaded automatically. Do NOT also pass task or system_message. Worker-managed system agents are not valid here.",
                    },
                    task: {
                        type: "string",
                        description: "For custom agents only: a clear description of what the sub-agent should do. This becomes the agent's first prompt. Do NOT use this for known agents — use agent_name instead.",
                    },
                    model: {
                        type: "string",
                        description: "Optional exact provider:model override from list_available_models (e.g. 'anthropic:claude-sonnet-4-6'). Do not invent or shorten model names. If omitted, inherits parent's model.",
                    },
                    reasoning_effort: {
                        type: "string",
                        enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                        description: "Optional reasoning effort override for the sub-agent. Call list_available_models first and use only a reasoning value listed for the selected model. If omitted, inherits the parent's reasoning effort.",
                    },
                    system_message: {
                        type: "string",
                        description: "Optional custom system message for the sub-agent. If omitted, inherits the parent's system message.",
                    },
                    tool_names: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of tool names the sub-agent should have access to. If omitted, inherits the parent's tools.",
                    },
                    title: {
                        type: "string",
                        description: "Optional session title for the spawned sub-agent. Omit it to let the agent definition or later title summarization decide the name.",
                    },
                    contract: {
                        type: "object",
                        description: "Optional named argument on spawn_agent; no separate contract tool exists. Example: contract={purpose:'Market scan',successCriteria:['answer with source-backed summary'],expectedFacts:[{key:'result/market-scan',required:true}],expectedArtifacts:[],validationMode:'warn',wakeOn:'material_change'}. Set wakeOn to 'any' for every update or 'material_change' (default) to suppress no-op heartbeats. For finite delegated work, use 'material_change': an ordinary final reply leaves the child alive and idle, so validate its outputs and then call complete_agent. Reserve 'completion' for actual terminal lifecycle outcomes such as explicit completion, cancellation, failure, or a blocked verdict. Qualifying updates wake the parent automatically; no parent polling timer is required.",
                    },
                },
            },
            handler: async () => "stub",
        });

        const messageAgentTool = defineTool("message_agent", {
            description:
                "Send a message to a running sub-agent. " +
                "The message is enqueued as a prompt for the sub-agent's next turn.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    message: { type: "string", description: "The message to send to the sub-agent" },
                    contract_patch: { type: "object", description: "Optional structured patch to the child contract for follow-up work. Use 'wakeOn' here to update the parent wake policy for this child mid-flight (e.g. quiet a chatty watcher with wakeOn='material_change' or wake it up with 'any')." },
                },
                required: ["agent_id", "message"],
            },
            handler: async () => "stub",
        });

        const checkAgentsTool = defineTool("check_agents", {
            description:
                "Check the current status and latest output of your RUNNING sub-agents (spawned with spawn_agent). " +
                "Returns each sub-agent's ID, task, status (running/completed/failed), and result — in full for children that changed since your last call, one roster line for the rest (pass full=true for everything; Output is capped at 1,000 chars, use read_agent_events for a complete result). " +
                "This is an on-demand snapshot, not a scheduling primitive; do not schedule wait or cron solely to call check_agents. " +
                "This is NOT the same as ps_list_agents — ps_list_agents shows available agent blueprints, check_agents shows your live sub-agent instances.",
            parameters: {
                type: "object",
                properties: {
                    full: {
                        type: "boolean",
                        description: "Return every child in full. Default (false): children unchanged since your last check_agents call are one roster line each.",
                    },
                },
            },
            handler: async () => "stub",
        });

        const waitForAgentsTool = defineTool("wait_for_agents", {
            description:
                "Block until one or more sub-agents complete. " +
                "Returns the final results of the completed agents. " +
                "If no agent_ids are specified, waits for ALL active sub-agents.",
            parameters: {
                type: "object",
                properties: {
                    agent_ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of specific agent IDs to wait for. If omitted, waits for all.",
                    },
                },
            },
            handler: async () => "stub",
        });

        const listSessionsTool = defineTool("list_sessions", {
            description:
                "List all active sessions in the system. " +
                "Returns each session's ID, title, owner, status, parent, and iteration count. " +
                "Use this to discover other running sessions or find sibling agents. " +
                "Leave owner filters unset for normal discovery and system-session checks; only set them when the user explicitly asks to scope by owner, user, system, or unowned sessions.",
            parameters: {
                type: "object",
                properties: {
                    include_system: {
                        type: "boolean",
                        description: "Include system sessions. Default false.",
                    },
                    owner_query: {
                        type: "string",
                        description: "Optional substring match across owner display name, email, subject, or provider. Not for session titles or agent names.",
                    },
                    owner_kind: {
                        type: "string",
                        enum: ["user", "system", "unowned"],
                        description: "Optional owner bucket filter. Use only when explicitly requested.",
                    },
                    query: { type: "string", description: "Optional text search over title, agent id, owner, and summary fields." },
                    session_id: { type: "string", description: "Optional exact session id lookup." },
                    agent_id: { type: "string", description: "Optional exact named-agent id filter." },
                    state: { type: "string", description: "Optional lifecycle state filter." },
                    parent_session_id: { type: "string", description: "Optional direct parent session id filter." },
                    group_id: { type: "string", description: "Optional group id filter. Groups are each viewer's private organization and in-session listings carry no viewer placement, so sessions typically show no group here; the literal string 'null' matches sessions without a visible group." },
                    include_children: { type: "boolean", description: "Include child sessions. Default false." },
                    updated_since: { type: "string", description: "Optional ISO timestamp; include sessions updated since this time." },
                    limit: { type: "number", description: "Maximum rows to return. Default 50, max 100." },
                },
            },
            handler: async () => "stub",
        });

        return [spawnAgentTool, messageAgentTool, checkAgentsTool, waitForAgentsTool, listSessionsTool,
            ...ManagedSession._childManagementToolDefs()];
    }

    /**
     * Child management tool definitions (complete, cancel, delete).
     * Separated for clarity but included in subAgentToolDefs().
     */
    static _childManagementToolDefs(): Tool<any>[] {
        const completeAgentTool = defineTool("complete_agent", {
            description:
                "Gracefully complete a running sub-agent. " +
                "Sends a /done command to the sub-agent, causing it to finish and send its final result back. " +
                "Use this when a sub-agent has accomplished its task and should stop.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    result: {
                        ...CHILD_SESSION_RESULT_SCHEMA,
                        description: "Optional structured completion result. Declare produced facts in factsWritten and artifacts in artifactsWritten so child contracts can validate references.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        const cancelAgentTool = defineTool("cancel_agent", {
            description:
                "Gracefully cancel a running sub-agent. " +
                "Sends a cancel signal to the sub-agent so it can cascade cancellation to its own descendants and stop cleanly. " +
                "Optionally provide a reason for the cancellation.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for cancellation" },
                    partial_result: {
                        ...CHILD_SESSION_RESULT_SCHEMA,
                        description: "Optional structured partial result. Declare produced facts in factsWritten and artifacts in artifactsWritten so child contracts can validate references.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        const deleteAgentTool = defineTool("delete_agent", {
            description:
                "Gracefully delete a sub-agent entirely. " +
                "The sub-agent first follows the cancellation route for any live descendants, then deletes itself when the subtree is terminal. " +
                "ONLY works for sub-agents spawned and tracked by THIS current session via spawn_agent. " +
                "Use this only to clean up your own spawned sub-agents you no longer need.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for deletion" },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        return [completeAgentTool, cancelAgentTool, deleteAgentTool];
    }

    /**
     * Run one LLM turn.
     *
     * The wait tool is injected automatically. If the LLM calls wait()
     * with seconds > waitThreshold, we abort the session and return
     * a "wait" result so the orchestration can schedule a durable timer.
     *
     * Similarly, if onUserInputRequest fires, we abort and return
     * "input_required" so the orchestration can wait for the user's answer.
     *
     * Stop classification: a user stop (requestStop → abort) reclassifies the
     * unwind as `{ type: "stopped" }` regardless of how the inner turn settled
     * — checked BEFORE pendingActions so a stop that races a wait()/ask_user
     * control-tool abort wins instead of being swallowed into a durable timer,
     * and applied to error unwinds so a forced settle/disconnect is not
     * misclassified as a retryable error.
     */
    async runTurn(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        this.activeTurn = { turnIndex: opts?.turnIndex ?? -1, startedAt: Date.now() };
        try {
            const result = await this._runTurnInner(prompt, opts);
            if (this.stopRequest) {
                return {
                    type: "stopped",
                    reason: this.stopRequest.reason,
                    ...((result as any)?.events ? { events: (result as any).events } : {}),
                };
            }
            return result;
        } catch (err) {
            if (this.stopRequest) {
                return { type: "stopped", reason: this.stopRequest.reason };
            }
            throw err;
        } finally {
            this.activeTurn = null;
            this.stopRequest = null;
            this.settleTurnResolver = null;
        }
    }

    /** The in-flight turn, if any. Read by the lock-bypassing stop path. */
    getActiveTurn(): { turnIndex: number; startedAt: number } | null {
        return this.activeTurn;
    }

    /**
     * Mark the in-flight turn as user-stopped so its unwind classifies as
     * `stopped`. Returns the active turn info, or null when no turn is
     * running. Does NOT abort by itself — callers pair this with abort().
     */
    requestStop(reason: string): { turnIndex: number } | null {
        if (!this.activeTurn) return null;
        this.stopRequest = { reason, requestedAt: Date.now() };
        return { turnIndex: this.activeTurn.turnIndex };
    }

    /**
     * Hang escalation: resolve the current turn's completion promise directly.
     * runTurn() settles only on the SDK's `session.idle` event; if a wedged
     * stream never fires it, this forces the unwind without depending on any
     * further SDK behavior. Pair with requestStop() so the unwind classifies
     * as `stopped`. Returns false when no turn is in flight.
     */
    forceSettleTurn(reason: string): boolean {
        if (!this.activeTurn) return false;
        if (!this.stopRequest) this.stopRequest = { reason, requestedAt: Date.now() };
        try { this.settleTurnResolver?.(); } catch {}
        return true;
    }

    private async _runTurnInner(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        const turnState: TurnState = {
            pendingActions: [],
            queuedActions: [],
            session: this.copilotSession,
            waitThreshold: this.config.waitThreshold ?? 30,
        };
        const controlBridge = opts?.controlToolBridge;

        // Build system tools (wait tool + ask_user tool)
        const waitTool = defineTool("wait", {
            // Keep in sync with systemToolDefs() — defensive override.
            overridesBuiltInTool: true,
            description: DEFAULT_WAIT_TOOL_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                    preserveWorkerAffinity: {
                        type: "boolean",
                        description:
                            "Set true when the work you are waiting on is tied to this worker's local state " +
                            "(for example a local process, file, or socket) and you want PilotSwarm to " +
                            "preserve the current worker affinity across a durable wait.",
                    },
                    material: {
                        type: "boolean",
                        description:
                            "Only when you have a PARENT session: set true if this wait carries a finding the parent " +
                            "must see now (a blocker, an escalation, a result it is waiting on). A plain wait is a " +
                            "heartbeat and does not wake the parent; it hears from you at your next completion or its " +
                            "own next schedule.",
                    },
                },
                required: ["seconds"],
            },
            handler: async (args: { seconds: number; reason?: string; preserveWorkerAffinity?: boolean; material?: boolean }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait");
                const reason = args.reason ?? "unspecified";
                if (args.seconds <= turnState.waitThreshold) {
                    await new Promise(r => setTimeout(r, args.seconds * 1000));
                    return `Waited for ${args.seconds} seconds. The wait is complete, you may continue.`;
                }
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.wait_started",
                            data: {
                                seconds: args.seconds,
                                reason,
                                preserveWorkerAffinity: args.preserveWorkerAffinity ?? false,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "wait",
                    seconds: args.seconds,
                    reason,
                    preserveWorkerAffinity: args.preserveWorkerAffinity ?? false,
                    ...(args.material === true ? { material: true } : {}),
                });
                return acknowledgeTurnBoundary("wait");
            },
        });

        const reportCycleTool = defineTool("report_cycle", {
            description:
                "Report the outcome of the current recurring cron/cron_at watcher cycle when something material happened. " +
                "Use status='material' when the parent should be notified, and status='blocked' when the cycle found a blocker or failure that needs parent attention. " +
                "On an uneventful cycle, prefer NOT calling this tool at all — just end the turn silently; status='quiet' is accepted but unnecessary. " +
                "This tool does not end the turn; after calling it, finish normally. It is ignored outside recurring watcher cycles.",
            parameters: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["quiet", "material", "blocked"],
                        description: "Whether this recurring cycle was quiet or should wake the parent.",
                    },
                    summary: {
                        type: "string",
                        description: "Optional concise machine-readable summary of the cycle outcome.",
                    },
                    deltas: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional concrete changes found this cycle.",
                    },
                },
                required: ["status"],
            },
            handler: async (args: { status: "quiet" | "material" | "blocked"; summary?: string; deltas?: string[] }) => {
                if (!opts?.cycleOrigin) {
                    return JSON.stringify({ ok: true, ignored: true, reason: "not_a_recurring_cycle" });
                }
                const status = args.status;
                if (status !== "quiet" && status !== "material" && status !== "blocked") {
                    return "Error: report_cycle status must be one of quiet, material, or blocked.";
                }
                turnState.cycleReport = {
                    status,
                    ...(typeof args.summary === "string" && args.summary.trim() ? { summary: args.summary.trim() } : {}),
                    ...(Array.isArray(args.deltas) ? { deltas: args.deltas.filter((delta) => typeof delta === "string" && delta.trim()).map((delta) => delta.trim()) } : {}),
                };
                return JSON.stringify({ ok: true, status });
            },
        });

        const waitOnWorkerTool = defineTool("wait_on_worker", {
            description:
                "Durably wait while preserving the current worker affinity when possible. " +
                "Use this when the thing you are waiting on is tied to worker-local state " +
                "(for example a local process, file, socket, or in-memory store on this worker). " +
                "This is equivalent to wait(..., preserveWorkerAffinity=true), but more reliable " +
                "because you do not need to set the flag yourself.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting on worker-local state" },
                },
                required: ["seconds"],
            },
            handler: async (args: { seconds: number; reason?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait_on_worker");
                const reason = args.reason ?? "unspecified";
                if (args.seconds <= turnState.waitThreshold) {
                    await new Promise(r => setTimeout(r, args.seconds * 1000));
                    return `Waited for ${args.seconds} seconds on the current worker. The wait is complete, you may continue.`;
                }
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.wait_started",
                            data: {
                                seconds: args.seconds,
                                reason,
                                preserveWorkerAffinity: true,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "wait",
                    seconds: args.seconds,
                    reason,
                    preserveWorkerAffinity: true,
                });
                return acknowledgeTurnBoundary("wait_on_worker");
            },
        });

        const cronTool = defineTool("cron", {
            description:
                "Declare a recurring durable schedule owned by the orchestration. " +
                "Use this for independent periodic monitoring, external polling, and scheduled digests so you do NOT need to call wait() at the end of every turn. " +
                "Do not use cron solely to poll sub-agent status; qualifying child updates wake the parent according to contract.wakeOn. " +
                "Use this when you should keep pursuing a goal autonomously until it is done. " +
                "If it is genuinely ambiguous whether the task should become an ongoing recurring workflow, clarify that intent before setting cron. " +
                "Set or update the schedule with seconds + reason. Cancel it with action='cancel'. " +
                "Minimum interval is 15 seconds.",
            parameters: {
                type: "object",
                properties: {
                    seconds: {
                        type: "number",
                        description: "Interval between recurring wake-ups in seconds (minimum 15).",
                    },
                    reason: {
                        type: "string",
                        description: "What to do on each wake-up. Required when setting a schedule.",
                    },
                    action: {
                        type: "string",
                        enum: ["cancel"],
                        description: "Use action='cancel' to clear the active recurring schedule.",
                    },
                },
            },
            handler: async (args: { seconds?: number; reason?: string; action?: "cancel" }) => {
                if (args.action === "cancel") {
                    turnState.queuedActions.push({
                        type: "cron",
                        action: "cancel",
                    });
                    return JSON.stringify({ status: "cancelled" });
                }

                const intervalSeconds = Number(args.seconds);
                if (!Number.isFinite(intervalSeconds)) {
                    return "Error: cron requires seconds or action='cancel'.";
                }
                if (intervalSeconds < 15) {
                    return "Error: cron interval must be at least 15 seconds.";
                }

                const reason = typeof args.reason === "string" ? args.reason.trim() : "";
                if (!reason) {
                    return "Error: cron reason is required when setting a schedule.";
                }

                turnState.queuedActions.push({
                    type: "cron",
                    action: "set",
                    intervalSeconds,
                    reason,
                });
                return JSON.stringify({ status: "scheduled", interval: intervalSeconds, reason });
            },
        });

        const cronAtTool = defineTool("cron_at", {
            description:
                "Declare a recurring wall-clock schedule owned by the orchestration. " +
                "Use this for calendar-anchored work like 'run nightly at 02:00 UTC' or 'fire Mondays at 09:00 America/New_York'. " +
                "Do NOT implement wall-clock schedules by polling every N minutes with cron(seconds=...) and checking the clock - that wastes tokens and turns. " +
                "For fixed-interval work like 'every 60 seconds', keep using cron(seconds, reason). " +
                "Pass max_fires=1 for a single one-shot scheduled-at-time action. " +
                "Cancel with action='cancel'.",
            parameters: {
                type: "object",
                properties: {
                    minute: { type: "number", description: "Wall-clock minute 0-59. Required when setting a schedule." },
                    hour: { type: "number", description: "Wall-clock hour 0-23. Omit for hourly recurrence." },
                    day_of_week: { type: "number", description: "0-6 with Sunday=0. Weekly recurrence; requires hour. Cannot combine with day_of_month." },
                    day_of_month: { type: "number", description: "1-31. Monthly recurrence; requires hour. Months without that day are skipped (no 'last day' semantics in v1)." },
                    tz: { type: "string", description: "IANA timezone (required). Examples: 'UTC', 'America/Los_Angeles'." },
                    max_fires: { type: "number", description: "Optional positive integer cap on total fires. Use 1 for a one-shot scheduled action." },
                    reason: { type: "string", description: "What to do on each wake-up. Required when setting a schedule." },
                    action: { type: "string", enum: ["cancel"], description: "Use action='cancel' to clear the active recurring schedule (works for either cron or cron_at)." },
                },
            },
            handler: async (args: {
                minute?: number;
                hour?: number;
                day_of_week?: number;
                day_of_month?: number;
                tz?: string;
                max_fires?: number;
                reason?: string;
                action?: "cancel";
            }) => {
                if (args.action === "cancel") {
                    turnState.queuedActions.push({ type: "cron_at", action: "cancel" });
                    // Also surface cron cancellation so a single 'cancel' call clears whichever
                    // schedule kind is active. The orchestration treats this as idempotent.
                    turnState.queuedActions.push({ type: "cron", action: "cancel" });
                    return JSON.stringify({ status: "cancelled" });
                }
                const { normalizeCronAtInput, computeCronAtNextFire } = await import("./cron-at.js");
                const normalized = normalizeCronAtInput({
                    minute: args.minute,
                    hour: args.hour,
                    day_of_week: args.day_of_week,
                    day_of_month: args.day_of_month,
                    tz: args.tz,
                    max_fires: args.max_fires,
                    reason: args.reason,
                });
                if (!normalized.ok) {
                    return `Error: ${normalized.error}`;
                }
                const schedule = normalized.schedule;
                // Precompute the nextFireAt as a best-effort answer for the LLM. The orchestration
                // will recompute (and record) the authoritative next-fire via a durable activity.
                let preview: { nextFireAtMs?: number; localTime?: string } = {};
                try {
                    const r = computeCronAtNextFire(schedule, Date.now());
                    preview = { nextFireAtMs: r.nextFireAtMs, localTime: r.localTime };
                } catch {
                    // ignore; orchestration will compute the authoritative result
                }
                turnState.queuedActions.push({
                    type: "cron_at",
                    action: "set",
                    schedule,
                });
                return JSON.stringify({
                    status: "scheduled",
                    kind: "wall-clock",
                    nextFireAt: preview.nextFireAtMs ? new Date(preview.nextFireAtMs).toISOString() : undefined,
                    localTime: preview.localTime,
                    tz: schedule.tz,
                    reason: schedule.reason,
                    ...(schedule.maxFires !== undefined ? { maxFires: schedule.maxFires } : {}),
                });
            },
        });

        const askUserTool = defineTool("ask_user", {
            // Keep in sync with systemToolDefs() — defensive override.
            overridesBuiltInTool: true,
            description:
                "Ask the user a question and wait for their response. " +
                "Use this when you need clarification or user input before proceeding.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The question to ask the user" },
                    choices: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of choices for the user",
                    },
                    allowFreeform: {
                        type: "boolean",
                        description: "Whether to allow freeform text input (default: true)",
                    },
                },
                required: ["question"],
            },
            handler: async (args: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("ask_user");
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.input_required_started",
                            data: {
                                question: args.question,
                                choices: args.choices,
                                allowFreeform: args.allowFreeform ?? true,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "input_required",
                    question: args.question,
                    choices: args.choices,
                    allowFreeform: args.allowFreeform ?? true,
                });
                return acknowledgeTurnBoundary("ask_user");
            },
        });

        // show_artifact — schema comes from the shared spec so the declaration
        // the LLM sees and the handler that runs cannot drift apart.
        //
        // This is a pure presentation signal: it records a durable event and
        // returns. It does NOT end the turn (the agent should keep talking) and
        // it deliberately does not verify the artifact exists — the worker's
        // artifact store is not reachable from here, and a portal that receives
        // a name it cannot find simply leaves the preview where it was. Naming
        // a file that was never written costs the agent one wasted event, not a
        // broken session.
        const showArtifactTool = defineTool("show_artifact", {
            ...SHOW_ARTIFACT_TOOL_SPEC,
            handler: async (args: { filename?: string; fullscreen?: boolean; note?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("show_artifact");
                const filename = String(args?.filename || "").trim();
                if (!filename) return "Error: show_artifact requires a filename.";
                if (!opts?.onEvent) {
                    return "Error: show_artifact is unavailable in this session (no event channel).";
                }
                const fullscreen = args?.fullscreen === true;
                try {
                    opts.onEvent({
                        eventType: "session.artifact_presented",
                        data: {
                            filename,
                            fullscreen,
                            ...(args?.note ? { note: String(args.note) } : {}),
                        },
                    });
                } catch {
                    return `Error: could not present ${filename}.`;
                }
                // artifact:// is the portal's own link scheme — the transcript
                // renderer turns it into a button that reopens this preview, so
                // the reply stays useful long after the live push is gone.
                return JSON.stringify({
                    shown: true,
                    filename,
                    fullscreen,
                    // this.sessionId, not the durableSessionId const declared
                    // further down runTurn — a closure over a not-yet-evaluated
                    // const is a temporal-dead-zone trap waiting for someone to
                    // move this block.
                    link: `artifact://${this.sessionId}/${filename}`,
                    note: "The user's portal is now previewing this file. Include the link in your reply so it can be reopened later.",
                });
            },
        });

        // Canvas tools — root sessions only, and the gate is the bridge: the
        // methods exist on controlBridge only when session-proxy saw no
        // parentSessionId. Handlers guard on that presence, and the per-turn
        // tool list (systemToolsForTurn) includes these tools under the same
        // predicate, so a child neither sees nor can run them.
        const drawCanvasTool = defineTool("draw_canvas", {
            ...DRAW_CANVAS_TOOL_SPEC,
            handler: async (args: { html?: string; fromArtifact?: { sessionId?: string; filename?: string; expectedSha256?: string }; note?: string; responseContract?: unknown; slot?: number; name?: string; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("draw_canvas");
                if (typeof (controlBridge as any)?.drawCanvas !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                if (args?.html !== undefined && typeof args.html !== "string") {
                    return "Error: html must be a string (the complete document; empty string clears).";
                }
                const hasHtml = typeof args?.html === "string";
                const fromArtifact = args?.fromArtifact && typeof args.fromArtifact === "object" ? args.fromArtifact : null;
                if (hasHtml === Boolean(fromArtifact)) {
                    return "Error: pass exactly one source — html (inline document; empty string clears) OR fromArtifact ({filename, sessionId?}).";
                }
                if (fromArtifact && !String(fromArtifact.filename || "").trim()) {
                    return "Error: fromArtifact.filename is required.";
                }
                const html = hasHtml ? String(args?.html ?? "") : undefined;
                // The store caps TEXT artifacts at 1 MiB (TEXT_ARTIFACT_MAX_BYTES);
                // refuse short of it so the failure is a clear message, not a
                // store error surfacing raw. fromArtifact sizes are checked in
                // the bridge, where the bytes first exist.
                if (html !== undefined) {
                    const inlineBytes = Buffer.byteLength(html, "utf8");
                    if (inlineBytes > 900_000) {
                        return `Error: canvas document is ${inlineBytes} bytes; keep it under 900 KB. `
                            + "Aggregate the data and avoid embedded raster images (see the html-visuals skill).";
                    }
                }
                const note = args?.note ? String(args.note) : undefined;
                // A cleared canvas accepts nothing, so a contract on an empty
                // draw is dropped rather than armed against a blank page.
                const contractResult = html === "" ? {} : normalizeCanvasContractShared(args?.responseContract);
                if (contractResult.error) return `Error: invalid responseContract: ${contractResult.error}`;
                const result = await (controlBridge as any).drawCanvas({
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                    ...(args?.name !== undefined ? { name: String(args.name) } : {}),
                    ...(html !== undefined ? { html } : {}),
                    ...(fromArtifact ? { fromArtifact: {
                        ...(fromArtifact.sessionId ? { sessionId: String(fromArtifact.sessionId) } : {}),
                        filename: String(fromArtifact.filename),
                        ...(fromArtifact.expectedSha256 ? { expectedSha256: String(fromArtifact.expectedSha256) } : {}),
                    } } : {}),
                    note,
                    responseContract: contractResult.contract,
                });
                if (result?.error) return `Error: could not draw the canvas: ${result.error}`;
                // No emit here, deliberately. The bridge committed the bytes
                // and then the durable canvas_updated event, awaited and in
                // that order; the persisted event is ALSO the live path (the
                // same delivery show_artifact rides). A second in-memory emit
                // would only risk the event landing twice in transcripts.
                // session-proxy's generic persister additionally lists
                // canvas_updated as already-persisted, so no path can
                // double-insert it.
                return JSON.stringify({
                    drawn: true,
                    rev: result.rev,
                    ...(result.slot ? { slot: result.slot } : {}),
                    ...(result.name !== undefined ? { name: result.name } : {}),
                    sizeBytes: result.sizeBytes,
                    // The interface card: manifest summary + the EFFECTIVE
                    // contract (post-precedence, post-normalization — what the
                    // browser will actually enforce). This is how the agent
                    // learns a stored app's I/O without reading the file.
                    ...(result.source ? { source: result.source } : {}),
                    ...(result.app ? { app: result.app } : {}),
                    ...(result.responseContract ? { responseContract: result.responseContract } : {}),
                    ...(result.manifestWarning ? { manifestWarning: result.manifestWarning } : {}),
                    ...(result.sizeBytes > 524_288
                        ? { warning: "Canvas over 512 KB — consider aggregating; large documents cost output tokens on every redraw." }
                        : {}),
                    // Named `reminder`, not `note`: the tool's `note` ARGUMENT
                    // is the revision caption, and echoing a different string
                    // under the same name read as the caption being replaced.
                    reminder: "The canvas updated live on the user's screen. Do not paste canvas links into your reply.",
                });
            },
        });

        const updateCanvasTool = defineTool("update_canvas", {
            ...UPDATE_CANVAS_TOOL_SPEC,
            handler: async (args: { data?: unknown; patch?: unknown; note?: string; slot?: number; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("update_canvas");
                if (typeof (controlBridge as any)?.updateCanvas !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const hasData = args?.data !== undefined;
                const hasPatch = args?.patch !== undefined;
                if (hasData === hasPatch) {
                    return "Error: pass exactly one of data (replace the whole state) or patch (RFC 7386 merge patch — only the changed subtree; null deletes a key).";
                }
                const body = hasData ? args.data : args.patch;
                const label = hasData ? "data" : "patch";
                if (Array.isArray(body)) {
                    return `Error: ${label} must be a JSON object, not an array — wrap it: { items: [...] }.`;
                }
                if (!body || typeof body !== "object") {
                    return `Error: ${label} must be a JSON object.`;
                }
                const serialized = JSON.stringify(body);
                const sizeBytes = Buffer.byteLength(serialized, "utf8");
                // The bridge enforces the real cap on the MERGED state; this
                // is the cheap early refusal for an oversized message body.
                if (sizeBytes > 32_768) {
                    return `Error: ${label} tick is ${sizeBytes} bytes serialized; the cap is 32768. Aggregate before sending, or redraw if the shape truly grew.`;
                }
                const note = args?.note ? String(args.note) : undefined;
                const result = await (controlBridge as any).updateCanvas({
                    ...(hasData ? { data: body } : { patch: body }),
                    note,
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                });
                if (result?.error) return `Error: could not update the canvas: ${result.error}`;
                return JSON.stringify({
                    updated: true,
                    mode: result.mode ?? label,
                    ...(result.dataRev !== undefined ? { dataRev: result.dataRev } : {}),
                    ...(result.seq !== undefined ? { seq: result.seq } : {}),
                    // The MERGED size — what the whole state weighs after this
                    // tick, not the size of the message body.
                    sizeBytes: result.sizeBytes ?? sizeBytes,
                    reminder: "The page received the tick live; it patches itself in place. No chat mention needed.",
                });
            },
        });

        const showCanvasTool = defineTool("show_canvas", {
            ...SHOW_CANVAS_TOOL_SPEC,
            handler: async (args: { slot?: number; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("show_canvas");
                if (typeof (controlBridge as any)?.showCanvas !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const result = await (controlBridge as any).showCanvas({
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                });
                if (result?.error) return `Error: could not present the canvas: ${result.error}`;
                return JSON.stringify({ presented: true, slot: result.slot, rev: result.rev,
                    reminder: "The user's view turns to that canvas (unless they dismissed it). Nothing was redrawn." });
            },
        });
        const readCanvasTool = defineTool("read_canvas", {
            ...READ_CANVAS_TOOL_SPEC,
            handler: async (args: { offset?: number; maxBytes?: number; manifestOnly?: boolean; include_data?: boolean; slot?: number; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("read_canvas");
                if (typeof (controlBridge as any)?.readCanvas !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const result = await (controlBridge as any).readCanvas({
                    offset: args?.offset,
                    maxBytes: args?.maxBytes,
                    manifestOnly: Boolean(args?.manifestOnly),
                    includeData: Boolean(args?.include_data),
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                });
                if (result?.error) return `Error: could not read the canvas: ${result.error}`;
                if (!result?.exists) return "No canvas has been drawn on this session yet.";
                return JSON.stringify(result);
            },
        });
        const canvasKvTool = defineTool("canvas_kv", {
            ...CANVAS_KV_TOOL_SPEC,
            handler: async (args: { op?: string; key?: string; value?: unknown; prefix?: string; limit?: number; after?: string; ifMatch?: number; slot?: number; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("canvas_kv");
                if (typeof (controlBridge as any)?.canvasKv !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const op = String(args?.op ?? "");
                if (!["get", "put", "list", "delete"].includes(op)) return "Error: op must be get, put, list or delete.";
                const result = await (controlBridge as any).canvasKv({
                    op,
                    ...(args?.key !== undefined ? { key: String(args.key) } : {}),
                    ...(args?.value !== undefined ? { value: args.value } : {}),
                    ...(args?.prefix !== undefined ? { prefix: String(args.prefix) } : {}),
                    ...(args?.limit !== undefined ? { limit: args.limit } : {}),
                    ...(args?.after !== undefined ? { after: String(args.after) } : {}),
                    ...(args?.ifMatch !== undefined ? { ifMatch: args.ifMatch } : {}),
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                });
                if (result?.error) return `Error: canvas_kv ${op} failed: ${result.error}`;
                return JSON.stringify(result);
            },
        });
        const publishCanvasAppTool = defineTool("publish_canvas_app", {
            ...PUBLISH_CANVAS_APP_TOOL_SPEC,
            handler: async (args: { name?: string; description?: string; tags?: string[]; slot?: number; session_id?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("publish_canvas_app");
                if (typeof (controlBridge as any)?.publishCanvasApp !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const result = await (controlBridge as any).publishCanvasApp({
                    name: args?.name, description: args?.description,
                    ...(Array.isArray(args?.tags) ? { tags: args.tags } : {}),
                    ...(args?.slot !== undefined ? { slot: args.slot } : {}),
                    ...(args?.session_id !== undefined ? { session_id: String(args.session_id) } : {}),
                });
                if (result?.error) return `Error: could not publish the app: ${result.error}`;
                return JSON.stringify(result);
            },
        });
        const findCanvasAppTool = defineTool("find_canvas_app", {
            ...FIND_CANVAS_APP_TOOL_SPEC,
            handler: async (args: { query?: string; limit?: number }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("find_canvas_app");
                if (typeof (controlBridge as any)?.findCanvasApp !== "function") {
                    return "Error: the canvas bridge is unavailable on this session.";
                }
                const result = await (controlBridge as any).findCanvasApp({ query: args?.query, limit: args?.limit });
                if (result?.error) return `Error: could not search the app catalog: ${result.error}`;
                if (!result?.count) return JSON.stringify({ count: 0, apps: [], note: "No published app matches. Build one, and publish_canvas_app it when the user wants it shared." });
                return JSON.stringify(result);
            },
        });
        const loadSkillTool = defineTool("load_skill", {
            ...LOAD_SKILL_TOOL_SPEC,
            handler: async (args: { name?: string }) => {
                const name = String(args?.name ?? "").trim();
                if (!name) return "Error: name is required.";
                const catalog = this.skillCatalog;
                const skill = catalog.find((s) => s.name === name)
                    ?? catalog.find((s) => s.name.toLowerCase() === name.toLowerCase());
                if (!skill) {
                    const names = catalog.map((s) => s.name).sort().join(", ");
                    return `Error: no skill named ${JSON.stringify(name)}. Available: ${names || "(none)"}.`;
                }
                return `[SKILL: ${skill.name}]\n${skill.description ? `${skill.description}\n\n` : ""}${skill.prompt}`;
            },
        });

        // list_available_models — returns data inline (no abort/continuation needed)
        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's exact qualified name (provider:model), description, and cost tier. " +
                "Also returns this session's current configured provider, model, and reasoning effort for the current turn. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
                "Models may also list supported reasoning efforts; pass spawn_agent(reasoning_effort=...) only with one of those listed values. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                return [
                    formatCurrentModelConfig(this.config),
                    opts?.modelSummary || "No model providers configured.",
                ].join("\n\n");
            },
        });

        const regenerateContextTool = defineTool("regenerate_context", {
            description:
                "Regenerate YOUR OWN context: your transcript is archived, distilled into a resume "
                + "package, and your working memory is rebuilt fresh from it at the next turn boundary. "
                + "Durable state (facts, artifacts, children, schedule, chat history) is untouched; "
                + "workspace files are dropped (the package maps how to recreate them). Use when "
                + "context_health reads degraded, or you notice yourself losing track of earlier work. "
                + "Rate-limited (once per epoch, 6h cooldown). Finish the current step FIRST — this ends the turn.",
            parameters: {
                type: "object",
                properties: {
                    handoff: {
                        type: "string",
                        description:
                            "Your own statement of what matters right now: mission, in-flight work, "
                            + "commitments, pitfalls. This is a HINT to the distiller (cross-checked "
                            + "against the transcript), max 4000 chars.",
                    },
                    instructions: {
                        type: "string",
                        description:
                            "Optional distilling instructions — HOW to distill (e.g. 'preserve every SQL "
                            + "snippet verbatim', 'drop the debugging tangents'). Max 4000 chars.",
                    },
                },
                required: ["handoff"],
            },
            handler: async (args: { handoff: string; instructions?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("regenerate_context");
                if (!controlBridge?.regenerateContext) return "Error: regenerate_context is unavailable in this session.";
                const result = await controlBridge.regenerateContext({
                    handoff: String(args.handoff ?? ""),
                    ...(args.instructions ? { instructions: String(args.instructions) } : {}),
                });
                if (/regeneration accepted/i.test(String(result))) {
                    turnState.pendingActions.push({
                        type: "completed",
                        content: "Context regeneration requested. The runtime rebuilds this session's context at the boundary.",
                    });
                    return `${result}\n${acknowledgeTurnBoundary("regenerate_context")}`;
                }
                return result;
            },
        });
        const regenerateAgentTool = defineTool("regenerate_agent", {
            description:
                "Regenerate a DIRECT child agent's context in place (its transcript is archived, "
                + "distilled, and rebuilt) while it keeps its identity, queue, facts, and its link to you. "
                + "Prefer this over killing and respawning a degraded long-running child. Applies at the "
                + "child's next turn boundary; per-child rate limits apply.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The child session id (raw UUID or session-<uuid>)." },
                    handoff: { type: "string", description: "Optional hint to the child's distiller about what the child should stay focused on (max 4000 chars)." },
                    instructions: { type: "string", description: "Optional distilling instructions — HOW to distill the child's transcript (max 4000 chars)." },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; handoff?: string; instructions?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("regenerate_agent");
                if (!controlBridge?.regenerateAgent) return "Error: regenerate_agent is unavailable in this session.";
                return await controlBridge.regenerateAgent({
                    agent_id: String(args.agent_id ?? ""),
                    ...(args.handoff ? { handoff: String(args.handoff) } : {}),
                    ...(args.instructions ? { instructions: String(args.instructions) } : {}),
                });
            },
        });
        const setSessionModelTool = defineTool("set_session_model", {
            description:
                "Switch this session's model for the next turn boundary. " +
                "Call list_available_models first and pass an exact provider:model value returned there. " +
                "This ends the current turn. After it succeeds, stop; the runtime will continue on the selected model.",
            parameters: {
                type: "object",
                properties: {
                    model: { type: "string", description: "Exact provider:model value from list_available_models." },
                    reasoning_effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Optional reasoning effort supported by the selected model." },
                },
                required: ["model"],
            },
            handler: async (args: { model: string; reasoning_effort?: ReasoningEffort }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("set_session_model");
                const model = String(args.model || "").trim();
                if (!model) return "Error: model is required.";
                const reasoningEffort = args.reasoning_effort ? normalizeReasoningEffort(args.reasoning_effort) : undefined;
                if (args.reasoning_effort && !reasoningEffort) {
                    return "Error: reasoning_effort must be one of none, minimal, low, medium, high, xhigh, max.";
                }
                if (!controlBridge) return "Error: set_session_model is unavailable in this session.";
                const result = await controlBridge.setSessionModel({ model, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
                if (/model switch accepted/i.test(String(result))) {
                    turnState.pendingActions.push({
                        type: "completed",
                        content: "Model switch requested. Continuing on the selected model.",
                    });
                    return `${result}\n${acknowledgeTurnBoundary("set_session_model")}`;
                }
                if (/set_session_model failed/i.test(String(result)) || !/model switch accepted/i.test(String(result))) {
                    turnState.pendingActions.push({
                        type: "completed",
                        content: "Model switch failed. Continuing on the unchanged model.",
                    });
                    return `${result}\n${acknowledgeTurnBoundary("set_session_model")}`;
                }
                return result;
            },
        });

        const sendSessionMessageTool = defineTool("send_session_message", {
            description:
                "Send an auditable asynchronous request to another PilotSwarm session. Use list_sessions first to find the target session id. " +
                "Keep the body concise and include relevant fact/artifact links instead of transcripts. " +
                "Set expects_response=true when you need an answer back. The target must answer with reply_session_message; its normal chat transcript is not the response channel.",
            parameters: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "Target session id." },
                    subject: { type: "string", description: "Short request subject." },
                    body: { type: "string", description: "Request body, concise and self-contained." },
                    reason: { type: "string", enum: ["help", "guidance", "fact-request", "status-request", "handoff"], description: "Optional request reason." },
                    expects_response: { type: "boolean", description: "Whether a response is expected." },
                    expires_at: { type: "string", description: "Optional ISO timestamp after which the request is stale." },
                },
                required: ["session_id", "subject", "body"],
            },
            handler: async (args: { session_id: string; subject: string; body: string; reason?: string; expects_response?: boolean; expires_at?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("send_session_message");
                if (!controlBridge) return "Error: send_session_message is unavailable in this session.";
                return await controlBridge.sendSessionMessage(args);
            },
        });

        const replySessionMessageTool = defineTool("reply_session_message", {
            description:
                "Reply to a cross-session request previously received from another PilotSwarm session. " +
                "Use this whenever a [SESSION_MESSAGE ... expects_response=true] prompt asks you for an answer. " +
                "Do not only write the answer in your own chat; the sender receives it only if this tool is called.",
            parameters: {
                type: "object",
                properties: {
                    request_id: { type: "string", description: "Request id being answered." },
                    session_id: { type: "string", description: "Session id that should receive the reply." },
                    verdict: { type: "string", enum: ["answered", "declined", "blocked", "stale"], description: "Reply outcome." },
                    body: { type: "string", description: "Reply body." },
                },
                required: ["request_id", "session_id", "body"],
            },
            handler: async (args: { request_id: string; session_id: string; body: string; verdict?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("reply_session_message");
                if (!controlBridge) return "Error: reply_session_message is unavailable in this session.";
                return await controlBridge.replySessionMessage(args);
            },
        });

        // Build sub-agent tools
        const spawnAgentTool = defineTool("spawn_agent", {
            description:
                "Spawn a sub-agent. For KNOWN user-creatable agents, pass agent_name ONLY. " +
                "The agent's system message, tools, and initial prompt are loaded automatically from agent_name. " +
                "Do NOT pass task or system_message when using agent_name. " +
                "Calling spawn_agent does NOT finish your turn. After it succeeds, continue executing the rest of your workflow in the SAME turn unless you intentionally call wait, wait_for_agents, ask_user, or give your final answer. " +
                "Call ps_list_agents to see all available named agents you CAN spawn. " +
                "Worker-managed system agents are not valid spawn_agent targets; if one is missing, the workers likely need to be restarted. " +
                "For CUSTOM agents (ad-hoc tasks), pass task instead — no agent_name is needed. " +
                "Any task you can describe can be spawned as a custom agent; you do not need a skill or pre-configured definition. " +
                "If you want a different model, call list_available_models first and use only an exact provider:model value from that list. " +
                "If you want different reasoning power, also use only a reasoning_effort value listed for that model. " +
                "Never invent, guess, or shorten model names.",
            parameters: {
                type: "object",
                properties: {
                    agent_name: {
                        type: "string",
                        description: "Name of a known user-creatable agent to spawn (from ps_list_agents). The agent's prompt, tools, and task load automatically. Do NOT also pass task or system_message. Worker-managed system agents are not valid here.",
                    },
                    task: {
                        type: "string",
                        description: "For custom agents only: a clear description of what the sub-agent should do. Any task can be spawned — no pre-configured agent or skill is required.",
                    },
                    model: {
                        type: "string",
                        description: "Optional exact provider:model override from list_available_models. Do not invent or shorten model names.",
                    },
                    reasoning_effort: {
                        type: "string",
                        enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                        description: "Optional reasoning effort override from list_available_models for the selected model. If omitted, inherits the parent's reasoning effort.",
                    },
                    system_message: {
                        type: "string",
                        description: "Optional custom system message. Only for custom agents.",
                    },
                    tool_names: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tool names list. Only for custom agents.",
                    },
                    title: {
                        type: "string",
                        description: "Optional session title for the spawned sub-agent. Omit it to let the agent definition or later title summarization decide the name.",
                    },
                    contract: {
                        type: "object",
                        description: "Optional named argument on spawn_agent; no separate contract tool exists. Example: contract={purpose:'Market scan',successCriteria:['answer with source-backed summary'],expectedFacts:[{key:'result/market-scan',required:true}],expectedArtifacts:[],validationMode:'warn',wakeOn:'material_change'}. Set wakeOn to 'any' for every update or 'material_change' (default) to suppress no-op heartbeats. For finite delegated work, use 'material_change': an ordinary final reply leaves the child alive and idle, so validate its outputs and then call complete_agent. Reserve 'completion' for actual terminal lifecycle outcomes such as explicit completion, cancellation, failure, or a blocked verdict. Qualifying updates wake the parent automatically; no parent polling timer is required.",
                    },
                },
            },
            handler: async (args: { agent_name?: string; task?: string; model?: string; reasoning_effort?: ReasoningEffort; system_message?: string; tool_names?: string[]; title?: string; contract?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("spawn_agent");
                if (!args.agent_name && !args.task) {
                    return "Error: either agent_name or task is required.";
                }
                const reasoningEffort = args.reasoning_effort ? normalizeReasoningEffort(args.reasoning_effort) : undefined;
                if (args.reasoning_effort && !reasoningEffort) {
                    return "Error: reasoning_effort must be one of none, minimal, low, medium, high, xhigh, max.";
                }
                if (controlBridge) {
                    return await controlBridge.spawnAgent({ ...args, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
                }
                turnState.pendingActions.push({
                    type: "spawn_agent",
                    task: args.task || "",
                    model: args.model,
                    reasoningEffort,
                    systemMessage: args.system_message,
                    toolNames: args.tool_names,
                    agentName: args.agent_name,
                    title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined,
                    contract: args.contract,
                });
                return acknowledgeTurnBoundary("spawn_agent");
            },
        });

        const messageAgentTool = defineTool("message_agent", {
            description:
                "Send a message to a running sub-agent. " +
                "The message is enqueued as a prompt for the sub-agent's next turn. " +
                "Calling message_agent does NOT finish your turn. After it succeeds, continue with the remaining workflow in the SAME turn unless you intentionally call wait, wait_for_agents, ask_user, or give your final answer.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    message: { type: "string", description: "The message to send to the sub-agent" },
                    contract_patch: { type: "object", description: "Optional structured patch to the child contract for follow-up work. Use 'wakeOn' here to update the parent wake policy for this child mid-flight (e.g. quiet a chatty watcher with wakeOn='material_change' or wake it up with 'any')." },
                },
                required: ["agent_id", "message"],
            },
            handler: async (args: { agent_id: string; message: string; contract_patch?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("message_agent");
                if (controlBridge) {
                    return await controlBridge.messageAgent(args);
                }
                turnState.pendingActions.push({
                    type: "message_agent",
                    agentId: args.agent_id,
                    message: args.message,
                    contractPatch: args.contract_patch,
                });
                return acknowledgeTurnBoundary("message_agent");
            },
        });

        const checkAgentsTool = defineTool("check_agents", {
            description:
                "Check the current status and latest output of your RUNNING sub-agents (spawned with spawn_agent). " +
                "Returns each sub-agent's ID, task, status (running/completed/failed), and result — in full for children that changed since your last call, one roster line for the rest (pass full=true for everything; Output is capped at 1,000 chars, use read_agent_events for a complete result). " +
                "This is an on-demand snapshot, not a scheduling primitive; do not schedule wait or cron solely to call check_agents. " +
                "This is NOT the same as ps_list_agents — ps_list_agents shows available agent blueprints, check_agents shows your live sub-agent instances.",
            parameters: {
                type: "object",
                properties: {
                    full: {
                        type: "boolean",
                        description: "Return every child in full. Default (false): children unchanged since your last check_agents call are one roster line each.",
                    },
                },
            },
            handler: async (args?: { full?: boolean }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("check_agents");
                if (controlBridge) {
                    return await controlBridge.checkAgents({ full: args?.full === true });
                }
                turnState.pendingActions.push({ type: "check_agents" });
                return acknowledgeTurnBoundary("check_agents");
            },
        });

        const waitForAgentsTool = defineTool("wait_for_agents", {
            description:
                "Block until one or more sub-agents complete. " +
                "Returns the final results of the completed agents. " +
                "If no agent_ids are specified, waits for ALL active sub-agents.",
            parameters: {
                type: "object",
                properties: {
                    agent_ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of specific agent IDs to wait for. If omitted, waits for all.",
                    },
                },
            },
            handler: async (args: { agent_ids?: string[] }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait_for_agents");
                if (controlBridge) {
                    const resolvedAgentIds = await controlBridge.resolveWaitForAgents(args.agent_ids);
                    const normalizedAgentIds = Array.isArray(resolvedAgentIds)
                        ? resolvedAgentIds
                        : (args.agent_ids ?? []);
                    turnState.pendingActions.push({
                        type: "wait_for_agents",
                        agentIds: normalizedAgentIds,
                    });
                    return `[SYSTEM: wait_for_agents acknowledged for ${normalizedAgentIds.length} agent(s). ` +
                        `Continue any remaining work in this SAME turn. Once your current turn naturally ends, ` +
                        `the runtime will suspend until those agents complete.]`;
                }
                turnState.pendingActions.push({
                    type: "wait_for_agents",
                    agentIds: args.agent_ids ?? [],
                });
                return acknowledgeTurnBoundary("wait_for_agents");
            },
        });

        const listSessionsTool = defineTool("list_sessions", {
            description:
                "List all active sessions in the system. " +
                "Returns each session's ID, title, owner, status, parent, and iteration count. " +
                "Use this to discover other running sessions or find sibling agents. " +
                "Leave owner filters unset for normal discovery and system-session checks; only set them when the user explicitly asks to scope by owner, user, system, or unowned sessions.",
            parameters: {
                type: "object",
                properties: {
                    include_system: {
                        type: "boolean",
                        description: "Include system sessions. Default false.",
                    },
                    owner_query: {
                        type: "string",
                        description: "Optional substring match across owner display name, email, subject, or provider. Not for session titles or agent names.",
                    },
                    owner_kind: {
                        type: "string",
                        enum: ["user", "system", "unowned"],
                        description: "Optional owner bucket filter. Use only when explicitly requested.",
                    },
                    query: { type: "string", description: "Optional text search over title, agent id, owner, and summary fields." },
                    session_id: { type: "string", description: "Optional exact session id lookup." },
                    agent_id: { type: "string", description: "Optional exact named-agent id filter." },
                    state: { type: "string", description: "Optional lifecycle state filter." },
                    parent_session_id: { type: "string", description: "Optional direct parent session id filter." },
                    group_id: { type: "string", description: "Optional group id filter. Groups are each viewer's private organization and in-session listings carry no viewer placement, so sessions typically show no group here; the literal string 'null' matches sessions without a visible group." },
                    include_children: { type: "boolean", description: "Include child sessions. Default false." },
                    updated_since: { type: "string", description: "Optional ISO timestamp; include sessions updated since this time." },
                    limit: { type: "number", description: "Maximum rows to return. Default 50, max 100." },
                },
            },
            handler: async (args: {
                include_system?: boolean;
                owner_query?: string;
                owner_kind?: string;
                query?: string;
                session_id?: string;
                agent_id?: string;
                state?: string;
                parent_session_id?: string;
                group_id?: string;
                include_children?: boolean;
                updated_since?: string;
                limit?: number;
            }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("list_sessions");
                if (controlBridge) {
                    return await controlBridge.listSessions(args);
                }
                turnState.pendingActions.push({
                    type: "list_sessions",
                    includeSystem: args.include_system,
                    ownerQuery: args.owner_query,
                    ownerKind: args.owner_kind,
                    query: args.query,
                    sessionId: args.session_id,
                    agentId: args.agent_id,
                    state: args.state,
                    parentSessionId: args.parent_session_id,
                    groupId: args.group_id,
                    includeChildren: args.include_children,
                    updatedSince: args.updated_since,
                    limit: args.limit,
                });
                return acknowledgeTurnBoundary("list_sessions");
            },
        });

        const completeAgentTool = defineTool("complete_agent", {
            description:
                "Gracefully complete a running sub-agent. " +
                "Sends a /done command to the sub-agent, causing it to finish and send its final result back. " +
                "Sub-agents do NOT auto-terminate after their final reply, so it is YOUR responsibility to call this (or cancel_agent / delete_agent) when you no longer need a child \u2014 otherwise it stays idle and counts against your sub-agent budget.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    result: {
                        ...CHILD_SESSION_RESULT_SCHEMA,
                        description: "Optional structured completion result. Declare produced facts in factsWritten and artifacts in artifactsWritten so child contracts can validate references.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; result?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("complete_agent");
                if (controlBridge) {
                    return await controlBridge.completeAgent(args);
                }
                turnState.pendingActions.push({ type: "complete_agent", agentId: args.agent_id, result: args.result });
                return acknowledgeTurnBoundary("complete_agent");
            },
        });

        const cancelAgentTool = defineTool("cancel_agent", {
            description:
                "Gracefully cancel a running sub-agent. " +
                "Sends a cancel signal to the sub-agent so it can cascade cancellation to its own descendants and stop cleanly. " +
                "Optionally provide a reason for the cancellation.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for cancellation" },
                    partial_result: {
                        ...CHILD_SESSION_RESULT_SCHEMA,
                        description: "Optional structured partial result. Declare produced facts in factsWritten and artifacts in artifactsWritten so child contracts can validate references.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; reason?: string; partial_result?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("cancel_agent");
                if (controlBridge) {
                    return await controlBridge.cancelAgent(args);
                }
                turnState.pendingActions.push({ type: "cancel_agent", agentId: args.agent_id, reason: args.reason, partialResult: args.partial_result });
                return acknowledgeTurnBoundary("cancel_agent");
            },
        });

        const deleteAgentTool = defineTool("delete_agent", {
            description:
                "Gracefully delete a sub-agent entirely. " +
                "The sub-agent first follows the cancellation route for any live descendants, then deletes itself when the subtree is terminal. " +
                "Use this to clean up sub-agents you no longer need.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for deletion" },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; reason?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("delete_agent");
                if (controlBridge) {
                    return await controlBridge.deleteAgent(args);
                }
                turnState.pendingActions.push({ type: "delete_agent", agentId: args.agent_id, reason: args.reason });
                return acknowledgeTurnBoundary("delete_agent");
            },
        });

        const SYSTEM_TOOL_NAMES = new Set([
    "update_canvas","wait", "wait_on_worker", "cron", "cron_at", "ask_user", "report_cycle", "list_available_models", "set_session_model", "send_session_message", "reply_session_message", "show_artifact", "draw_canvas", "read_canvas", "show_canvas", "canvas_kv", "publish_canvas_app", "find_canvas_app", "load_skill", "spawn_agent", "message_agent", "check_agents", "wait_for_agents", "list_sessions", "complete_agent", "cancel_agent", "delete_agent"]);

        // Merge user tools with system tools
        const userTools = this.config.tools ?? [];

        // Wrap user tool handlers to augment invocation with the PilotSwarm
        // durable session ID. The Copilot SDK's invocation.sessionId is an
        // internal SDK session ID — we add durableSessionId so tool handlers
        // can identify which durable session is calling without closures.
        // Both IDs are available: invocation.sessionId (SDK) and
        // invocation.durableSessionId (PilotSwarm).
        const durableSessionId = this.sessionId;
        const wrappedUserTools = userTools
            .filter(t => {
                const name = (t as any).name;
                return !SYSTEM_TOOL_NAMES.has(name);
            })
            .map(t => ({
                ...t,
                handler: async (args: any, invocation: any) => {
                    if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary((t as any).name ?? "tool");
                    const augmented = {
                        ...invocation,
                        durableSessionId,
                        ...(this.factsAccessor ? { facts: this.factsAccessor } : {}),
                    };
                    try {
                        return await (t as any).handler(args, augmented);
                    } catch (error) {
                        return failureToolResult(error);
                    }
                },
            }));

        const isReadOnlyTuner = this.config.agentIdentity === "agent-tuner";
        // Service sessions (tree-scoped machinery, e.g. the regen distiller)
        // get NO system or sub-agent tools: their toolset is exactly their
        // user tools (the transcript pager). Their system message also forbids
        // side effects, but hard exclusion beats instructions — defense in
        // depth on top of the pager's CMS-column call-time gate. Generalize to
        // a config.serviceKind check if a second service kind ever appears.
        const isServiceSession = this.config.agentIdentity === "regen-distiller";
        // The manager tools are DECLARED only in the manager bundle, but a
        // registered handler is a capability even when the model cannot see
        // the schema. Gate both halves on the same list so there is no tool
        // that exists-but-is-hidden in an ordinary session.
        const isManagerSession = holdsManagerBundle(this.config.agentIdentity);
        const mutatingSystemToolNames = new Set(["send_session_message", "reply_session_message", "draw_canvas", "show_canvas", "canvas_kv", "publish_canvas_app",
    "update_canvas"]);
        const systemToolsForTurn: Tool<any>[] = isServiceSession ? [] : [
            waitTool,
            waitOnWorkerTool,
            cronTool,
            cronAtTool,
            askUserTool,
            reportCycleTool,
            listModelsTool,
            setSessionModelTool,
            regenerateContextTool,
            regenerateAgentTool,
            sendSessionMessageTool,
            replySessionMessageTool,
            showArtifactTool,
            // ALWAYS registered, root or child — the root gate lives in the
            // handlers (bridge capability + the bridge's own catalog check)
            // and in the DECLARATION chokepoint (session-manager filters the
            // canvas tools off child sessions via the catalog row). A tool
            // that is declared but has no handler hangs the turn: the CLI
            // drops a call with no registered handler on the floor, no error,
            // no response. Registering a guarded handler everywhere means the
            // worst residual case (stale declarations, direct mode without a
            // bridge) is a clean refusal, never a hang.
            drawCanvasTool,
            updateCanvasTool,
            readCanvasTool,
            showCanvasTool,
            canvasKvTool,
            publishCanvasAppTool,
            findCanvasAppTool,
            loadSkillTool,
        ].filter((tool: any) => !isReadOnlyTuner || !mutatingSystemToolNames.has(tool.name));

        // The provider budget tools' REAL handlers are built from the catalog
        // by the host (createProviderTools) and reach this turn as user tools,
        // because they need a database this class cannot see. What is added
        // here is the residual case: a session that got the declarations but
        // no handler for them. Left unregistered, such a call is dropped by
        // the CLI with no response and the turn hangs; a refusal answers it.
        const wiredToolNames = new Set(userTools.map((tool: any) => tool.name));
        const providerToolsForTurn: Tool<any>[] = (!isServiceSession && holdsProviderTools(this.config.agentIdentity))
            ? providerToolsUnavailable("provider budgets are not wired into this session")
                .filter((tool: any) => !wiredToolNames.has(tool.name))
            : [];

        const subAgentToolsForTurn = isServiceSession
            ? []
            : isReadOnlyTuner
                ? [checkAgentsTool, listSessionsTool]
                : [
                    spawnAgentTool,
                    messageAgentTool,
                    checkAgentsTool,
                    waitForAgentsTool,
                    listSessionsTool,
                    completeAgentTool,
                    cancelAgentTool,
                    deleteAgentTool,
                ];

        // create_agent_session: DECLARED in the manager bundle (which is
        // identity-gated), REAL handler wired here, where the control bridge
        // exists. Appended last so it replaces the bundle's stub in the
        // handler map. Only a manager agent declares it, so a session without
        // the declaration never sees the tool even though the handler is
        // present.
        const createAgentSessionForTurn: Tool<any>[] = (!isServiceSession && isManagerSession && controlBridge?.createAgentSession)
            ? [defineTool("create_agent_session", {
                description: "Create a TOP-LEVEL session running an agent (see the declaration in the manager bundle).",
                parameters: {
                    type: "object",
                    properties: {
                        agent_name: { type: "string" },
                        prompt: { type: "string" },
                        title: { type: "string" },
                        model: { type: "string" },
                        reasoning_effort: {
                            type: "string",
                            enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                        },
                        test_of: { type: "string" },
                        key: { type: "string" },
                    },
                    required: ["agent_name"],
                },
                handler: async (args: {
                    agent_name: string;
                    prompt?: string;
                    title?: string;
                    model?: string;
                    reasoning_effort?: ReasoningEffort;
                    test_of?: string;
                    key?: string;
                }) => {
                    if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("create_agent_session");
                    const reasoningEffort = args.reasoning_effort ? normalizeReasoningEffort(args.reasoning_effort) : undefined;
                    if (args.reasoning_effort && !reasoningEffort) {
                        return "Error: reasoning_effort must be one of none, minimal, low, medium, high, xhigh, max.";
                    }
                    return await controlBridge.createAgentSession!({
                        ...args,
                        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
                    });
                },
            })]
            : [];

        const messageAgentSessionForTurn: Tool<any>[] = (!isServiceSession && isManagerSession && controlBridge?.messageAgentSession)
            ? [defineTool("message_agent_session", {
                description: "Send a message to a session as its user (see the declaration in the manager bundle).",
                parameters: {
                    type: "object",
                    properties: {
                        session_id: { type: "string" },
                        message: { type: "string" },
                    },
                    required: ["session_id", "message"],
                },
                handler: async (args: { session_id: string; message: string }) => {
                    if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("message_agent_session");
                    return await controlBridge.messageAgentSession!(args);
                },
            })]
            : [];

        const manageAgentSessionForTurn: Tool<any>[] = (!isServiceSession && isManagerSession && controlBridge?.manageAgentSession)
            ? [defineTool("manage_agent_session", {
                description: "Complete, cancel or delete a session (see the declaration in the manager bundle).",
                parameters: {
                    type: "object",
                    properties: {
                        session_id: { type: "string" },
                        action: { type: "string", enum: ["complete", "cancel", "delete"] },
                        reason: { type: "string" },
                    },
                    required: ["session_id", "action"],
                },
                handler: async (args: { session_id: string; action: string; reason?: string }) => {
                    if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("manage_agent_session");
                    return await controlBridge.manageAgentSession!(args);
                },
            })]
            : [];

        const allTools: Tool<any>[] = [
            ...wrappedUserTools,
            ...systemToolsForTurn,
            ...providerToolsForTurn,
            ...subAgentToolsForTurn,
            ...createAgentSessionForTurn,
            ...messageAgentSessionForTurn,
            ...manageAgentSessionForTurn,
        ];

        if (opts?.requiredTool && !allTools.some((tool: any) => tool.name === opts.requiredTool)) {
            return {
                type: "error",
                message: `Required tool "${opts.requiredTool}" is not available in this session.`,
                retryable: false,
                events: [],
            } as any;
        }

        // Re-register tools for this turn (may have changed). Tool
        // *declarations* reach the CLI server via sessionConfig.tools at
        // create/resume; this call only refreshes the client-side handler map
        // so per-turn closures dispatch correctly. copilot-sdk 1.0.6 removed
        // registerTools from the public types (it was always @internal) but
        // ships it unchanged in dist/session.js — cast until a public
        // handler-refresh API exists.
        (this.copilotSession as any).registerTools(allTools);

        // Collect the final assistant content and all events via on()
        let finalContent: string | undefined;
        const collectedEvents: CapturedEvent[] = [];
        const unsubscribers: (() => void)[] = [];
        const toolEventMetadataByKey = new Map<string, { toolName?: string; arguments?: unknown }>();
        let currentReasoning = "";
        let lastPublishedReasoning = "";
        let lastReasoningPublishAt = 0;
        let deferredSessionError: CapturedEvent | null = null;
        const textEmittedToolCallRef: { current: { toolName: string; rawContent: string } | null } = { current: null };

        // Streaming progress + turn timing state.
        // Token-level deltas (`assistant.message_delta`,
        // `assistant.streaming_delta`, `assistant.reasoning_delta`) stay
        // ephemeral — see EPHEMERAL_TYPES in session-proxy.ts. We collapse
        // them into a coarse `assistant.streaming_progress` heartbeat so the
        // activity pane has a live signal during long generations without
        // flooding CMS. Also augment `assistant.turn_end` with `durationMs`
        // computed from the matching `assistant.turn_start` so the activity
        // formatter can render "[turn end] 4m 12s, 1843 chars".
        let turnStartedAtMs: number | null = null;
        let streamingDeltaCount = 0;
        let streamingDeltaChars = 0;
        // Note: we used to emit a synthetic `assistant.streaming_progress`
        // heartbeat into CMS for the activity pane. The user found those
        // rows noisy compared to the actual reasoning snapshots, so the
        // synthetic emission was removed. The counters are still tracked
        // so we can stamp `assistant.turn_end.data.streamingChars` /
        // `streamingDeltas` for post-hoc analysis.
        const flushStreamingProgress = (_force: boolean) => {
            // Intentionally a no-op. Kept as a hook so existing call sites
            // (turn_end / session.idle / per-delta) compile without churn,
            // and so re-enabling a heartbeat is a one-line change.
        };

        function getToolEventKey(eventData: any): string | null {
            if (!eventData || typeof eventData !== "object") return null;
            if (typeof eventData.toolCallId === "string" && eventData.toolCallId.trim()) {
                return `tool:${eventData.toolCallId}`;
            }
            if (typeof eventData.requestId === "string" && eventData.requestId.trim()) {
                return `request:${eventData.requestId}`;
            }
            return null;
        }

        function extractReasoningText(payload: any): string {
            if (typeof payload === "string") return payload;
            if (!payload || typeof payload !== "object") return "";
            return String(
                payload.deltaContent
                ?? payload.content
                ?? payload.text
                ?? payload.message
                ?? payload.delta
                ?? payload.reasoning
                ?? "",
            );
        }

        function mergeReasoningText(existing: string, incoming: string): string {
            const next = String(incoming || "");
            if (!next) return existing;
            if (!existing) return next;
            if (next.startsWith(existing)) return next;
            if (existing.endsWith(next)) return existing;
            return `${existing}${next}`;
        }

        function publishReasoningSnapshot(eventType: string, force = false) {
            const content = currentReasoning.trim();
            if (!content || content === lastPublishedReasoning) return;

            const now = Date.now();
            const lengthDelta = Math.abs(content.length - lastPublishedReasoning.length);
            // Streaming makes reasoning_delta arrive constantly. Be aggressive
            // about throttling synthetic snapshots: only emit on force (turn
            // boundary), or when the content has grown by >=200 chars and
            // 5s have elapsed since the last publish.
            if (!force && (lengthDelta < 200 || now - lastReasoningPublishAt < 5000)) return;

            const captured: CapturedEvent = {
                eventType: "assistant.reasoning",
                data: {
                    content,
                    synthetic: true,
                    sourceEventType: eventType,
                },
            };
            collectedEvents.push(captured);
            lastPublishedReasoning = content;
            lastReasoningPublishAt = now;
            // Only forward to CMS on force (turn boundaries). Mid-stream
            // synthetic snapshots stay in-memory for the runTurn() return
            // value; they are noise in the activity pane.
            if (force && opts?.onEvent) {
                try { opts.onEvent(captured); } catch {}
            }
        }

        // Fed by the catch-all handler below; read by the inactivity watchdog.
        // A live turn emits a steady event stream (streaming deltas, tool
        // executions, usage updates); a dead subprocess emits nothing.
        let lastEventAt = Date.now();

        const turnComplete = new Promise<void>((resolve, reject) => {
            // Hang-escalation hook: forceSettleTurn() resolves this promise when
            // the SDK never fires session.idle (see stop-turn plan, edge E3).
            this.settleTurnResolver = resolve;
            // Catch-all event handler — captures every event and fires onEvent immediately.
            unsubscribers.push(
                this.copilotSession.on((event: any) => {
                    lastEventAt = Date.now();
                    const eventType = event.type ?? event.eventType ?? "unknown";
                    const rawEventData = event.data ?? event;
                    let eventData = rawEventData;

                    if (typeof rawEventData === "object" && rawEventData !== null) {
                        eventData = { ...rawEventData };

                        const toolEventKey = getToolEventKey(eventData);
                        const toolName = typeof eventData.toolName === "string" && eventData.toolName.trim()
                            ? eventData.toolName
                            : typeof eventData.name === "string" && eventData.name.trim()
                                ? eventData.name
                                : undefined;
                        const toolArguments = eventData.arguments ?? eventData.args;

                        if (toolEventKey && (toolName || toolArguments !== undefined)) {
                            const previous = toolEventMetadataByKey.get(toolEventKey) || {};
                            toolEventMetadataByKey.set(toolEventKey, {
                                toolName: toolName ?? previous.toolName,
                                arguments: toolArguments !== undefined ? toolArguments : previous.arguments,
                            });
                        }

                        if (toolEventKey) {
                            const metadata = toolEventMetadataByKey.get(toolEventKey);
                            if (metadata?.toolName && !eventData.toolName && !eventData.name) {
                                eventData.toolName = metadata.toolName;
                            }
                            if (metadata?.arguments !== undefined && eventData.arguments == null && eventData.args == null) {
                                eventData.arguments = metadata.arguments;
                            }
                        }

                        if (
                            eventType === "tool.execution_start"
                            || eventType === "tool.execution_complete"
                            || eventType === "tool.execution_partial_result"
                            || eventType.startsWith("external_tool.")
                        ) {
                            eventData.durableSessionId = durableSessionId;
                        }
                    }

                    const captured: CapturedEvent = { eventType, data: eventData };
                    if (eventType === "session.error" && isBenignPostCompletionQueryError(eventData)) {
                        deferredSessionError = captured;
                        return;
                    }
                    if (isEmptyAssistantTranscriptEvent(eventType, eventData)) {
                        return;
                    }

                    if (eventType === "assistant.message") {
                        const content = extractAssistantMessageContent({ data: eventData });
                        const textToolCall = detectTextEmittedToolCall(content);
                        if (textToolCall) {
                            textEmittedToolCallRef.current = textToolCall;
                            return;
                        }
                        // A required-tool answer is provisional until the
                        // corresponding execution event has happened. Keep an
                        // unsupported answer in the live Copilot conversation
                        // so the correction has context, but do not expose it
                        // through onEvent or the durable CMS transcript.
                        if (opts?.requiredTool && !hasInvokedTool(collectedEvents, opts.requiredTool)) {
                            return;
                        }
                        finalContent = content ?? finalContent;
                        publishReasoningSnapshot("assistant.message", true);
                    }

                    // Track turn boundaries so we can stamp turn_end with a
                    // durationMs and the streaming counters.
                    if (eventType === "assistant.turn_start") {
                        turnStartedAtMs = Date.now();
                        streamingDeltaCount = 0;
                        streamingDeltaChars = 0;
                    } else if (eventType === "assistant.turn_end") {
                        flushStreamingProgress(true);
                        if (turnStartedAtMs && eventData && typeof eventData === "object") {
                            (eventData as Record<string, unknown>).durationMs = Date.now() - turnStartedAtMs;
                            (eventData as Record<string, unknown>).streamingDeltas = streamingDeltaCount;
                            (eventData as Record<string, unknown>).streamingChars = streamingDeltaChars;
                        }
                        turnStartedAtMs = null;
                    } else if (eventType === "assistant.message_delta" || eventType === "assistant.streaming_delta") {
                        // A model that skipped the required tool may stream a
                        // complete-looking answer before we can issue the
                        // correction. Treat those deltas like its provisional
                        // assistant.message: do not expose them to live event
                        // consumers. Once the tool starts, the grounded answer
                        // streams normally.
                        if (opts?.requiredTool && !hasInvokedTool(collectedEvents, opts.requiredTool)) {
                            return;
                        }
                        streamingDeltaCount += 1;
                        const deltaText = (eventData && typeof eventData === "object")
                            ? ((eventData as any).deltaContent ?? (eventData as any).delta ?? (eventData as any).content ?? "")
                            : "";
                        if (typeof deltaText === "string") streamingDeltaChars += deltaText.length;
                        // Don't record the delta itself in collectedEvents —
                        // it's pure noise for replay. Only emit the throttled
                        // synthetic when we actually received text; some
                        // deltas carry no content and would render as
                        // "[streaming] 4s · 0 chars".
                        if (streamingDeltaChars > 0) flushStreamingProgress(false);
                        if (opts?.onEvent) {
                            // Forward the raw delta too in case onDelta-style
                            // consumers want it; they're already filtered out
                            // of CMS persistence by EPHEMERAL_TYPES.
                            try { opts.onEvent(captured); } catch {}
                        }
                        return;
                    }

                    // Dedup real `assistant.reasoning` events from the SDK.
                    // With streaming enabled the SDK can re-emit the same
                    // reasoning snapshot multiple times in a burst, which
                    // would otherwise flood CMS and the activity pane with
                    // visually-identical lines. Drop the event if its content
                    // matches the last reasoning snapshot we already
                    // persisted.
                    if (eventType === "assistant.reasoning") {
                        const content = String(extractReasoningText(eventData) || "").trim();
                        if (content && content === lastPublishedReasoning) {
                            return;
                        }
                        if (content) {
                            lastPublishedReasoning = content;
                            lastReasoningPublishAt = Date.now();
                        }
                    }

                    collectedEvents.push(captured);
                    // Fire immediately so callers can write to CMS in real-time
                    if (opts?.onEvent) {
                        try { opts.onEvent(captured); } catch {}
                    }
                }),
            );

            unsubscribers.push(
                this.copilotSession.on("assistant.reasoning", (event: any) => {
                    currentReasoning = String(extractReasoningText(event?.data ?? event) || "").trim();
                    if (currentReasoning) {
                        lastPublishedReasoning = currentReasoning;
                        lastReasoningPublishAt = Date.now();
                    }
                }),
            );

            for (const eventType of ["assistant.reasoning_delta", "reasoning_delta"] as const) {
                unsubscribers.push(
                    (this.copilotSession as any).on(eventType, (event: any) => {
                        currentReasoning = mergeReasoningText(
                            currentReasoning,
                            extractReasoningText(event?.data ?? event),
                        );
                        publishReasoningSnapshot(eventType);
                    }),
                );
            }

            // Stream deltas to the caller if requested
            if (opts?.onDelta) {
                unsubscribers.push(
                    this.copilotSession.on("assistant.message_delta", (event: any) => {
                        if (opts.requiredTool && !hasInvokedTool(collectedEvents, opts.requiredTool)) return;
                        if (event.data?.deltaContent) {
                            opts.onDelta!(event.data.deltaContent);
                        }
                    }),
                );
            }

            // Notify caller of tool execution starts
            if (opts?.onToolStart) {
                unsubscribers.push(
                    this.copilotSession.on("tool.execution_start", (event: any) => {
                        opts.onToolStart!(event.data?.toolName ?? "unknown", event.data?.toolArgs);
                    }),
                );
            }

            // session.idle = turn finished (normal completion or post-abort)
            unsubscribers.push(
                this.copilotSession.on("session.idle", () => {
                    flushStreamingProgress(true);
                    publishReasoningSnapshot("session.idle", true);
                    resolve();
                }),
            );
        });

        // Wall-clock turn cap — the blunt backstop. On by default (see
        // DEFAULT_TURN_TIMEOUT_MS); an explicit turnTimeoutMs of 0 disables it.
        const TURN_TIMEOUT = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
        let turnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = TURN_TIMEOUT > 0
            ? new Promise<void>((_, reject) => {
                turnTimeoutTimer = setTimeout(() => reject(new Error("Turn timed out")), TURN_TIMEOUT);
                (turnTimeoutTimer as any).unref?.();
            })
            : null;

        // Inactivity watchdog — the sharp detector for a dead CLI subprocess.
        // Re-arms from lastEventAt so any event resets it; fires only on total
        // silence. The threshold must exceed the longest legitimate quiet gap
        // (a non-streaming external tool call), hence minutes, not seconds.
        const INACTIVITY_TIMEOUT = this.config.turnInactivityTimeoutMs ?? DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
        const inactivityPromise = INACTIVITY_TIMEOUT > 0
            ? new Promise<void>((_, reject) => {
                const arm = (delayMs: number) => {
                    inactivityTimer = setTimeout(() => {
                        const idleMs = Date.now() - lastEventAt;
                        if (idleMs >= INACTIVITY_TIMEOUT) {
                            reject(new Error(
                                `No events from the Copilot CLI subprocess for ${Math.round(idleMs / 1000)}s — `
                                + `${TURN_INACTIVITY_ERROR_MARKER}; treating the turn as lost.`,
                            ));
                            return;
                        }
                        arm(INACTIVITY_TIMEOUT - idleMs);
                    }, delayMs);
                    (inactivityTimer as any).unref?.();
                };
                arm(INACTIVITY_TIMEOUT);
            })
            : null;

        // Both guards also race the correction-loop idle waits below. Mark
        // their rejections as handled so the loser of a race never surfaces
        // as an unhandled rejection before the finally-block clears its timer.
        const guards: Promise<void>[] = [timeoutPromise, inactivityPromise]
            .filter((p): p is Promise<void> => p !== null);
        for (const guard of guards) guard.catch(() => {});

        // Re-armable idle waiter used by the tool-call-as-text guard to wait for
        // the model's response to a mid-turn correction without tearing down the
        // event subscriptions set up above.
        const waitForNextIdle = (): Promise<void> => new Promise<void>((resolve) => {
            const unsub = this.copilotSession.on("session.idle", () => {
                flushStreamingProgress(true);
                publishReasoningSnapshot("session.idle", true);
                unsub();
                resolve();
            });
            unsubscribers.push(unsub);
        });

        const effectivePrompt = opts?.requiredTool
            ? [
                `[SYSTEM: For this request, you MUST invoke the tool "${opts.requiredTool}" before giving your answer.`,
                `Do not answer from memory, estimation, or mental math.`,
                `If the tool is available, calling it is mandatory for this turn.]`,
                "",
                prompt,
            ].join("\n")
            : prompt;

        try {
            normalizeCopilotSessionMessageHistory(this.copilotSession as any);

            // Fire the prompt — non-blocking. Image attachments arrive as
            // ready-to-send base64 blobs (fetched + vision-gated by the runTurn
            // activity host); the Copilot runtime packs them into the
            // provider-specific multimodal content.
            await this.copilotSession.send({
                prompt: effectivePrompt,
                ...(effectivePrompt !== prompt ? { displayPrompt: prompt } : {}),
                ...(opts?.requiredTool ? { requiredTool: opts.requiredTool } : {}),
                ...(opts?.attachments && opts.attachments.length > 0
                    ? {
                        attachments: opts.attachments.map((a) => ({
                            type: "blob" as const,
                            data: a.data,
                            mimeType: a.mimeType,
                            ...(a.displayName ? { displayName: a.displayName } : {}),
                        })),
                    }
                    : {}),
            });

            // Wait for session.idle, or a guard rejection (wall-clock cap /
            // inactivity watchdog) when enabled.
            if (guards.length > 0) {
                await Promise.race([turnComplete, ...guards]);
            } else {
                await turnComplete;
            }

            // ── Guard: tool call emitted as text instead of executed ──────────
            // If the model typed a tool call as `<invoke .../>` text rather than
            // calling it, that call did not run. Re-prompt it (bounded) to
            // actually invoke the tool so a consequential call is never silently
            // dropped. If a control tool already scheduled a turn boundary, we
            // still return an error rather than accepting a transcript that
            // implied another unexecuted tool side effect.
            let textToolCallCorrections = 0;
            while (
                textToolCallCorrections < MAX_TEXT_TOOL_CALL_CORRECTIONS &&
                !hasTerminalTurnBoundary(turnState) &&
                textEmittedToolCallRef.current
            ) {
                const offendingTool = textEmittedToolCallRef.current.toolName;
                const rawContent = textEmittedToolCallRef.current.rawContent;
                textEmittedToolCallRef.current = null;
                textToolCallCorrections++;
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.tool_call_as_text",
                    data: { toolName: offendingTool, rawContent, attempt: textToolCallCorrections, sessionId: this.sessionId },
                };
                collectedEvents.push(diagnostic);
                if (opts?.onEvent) { try { opts.onEvent(diagnostic); } catch {} }

                finalContent = undefined;
                const nextIdle = waitForNextIdle();
                await this.copilotSession.send({ prompt: buildTextEmittedToolCallCorrection(offendingTool) });
                if (guards.length > 0) {
                    await Promise.race([nextIdle, ...guards]);
                } else {
                    await nextIdle;
                }
            }

            if (textEmittedToolCallRef.current) {
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.tool_call_as_text",
                    data: { toolName: textEmittedToolCallRef.current.toolName, rawContent: textEmittedToolCallRef.current.rawContent, final: true, sessionId: this.sessionId },
                };
                collectedEvents.push(diagnostic);
                if (opts?.onEvent) { try { opts.onEvent(diagnostic); } catch {} }
                const message = buildTextEmittedToolCallCorrection(textEmittedToolCallRef.current.toolName);
                return {
                    type: "error",
                    message,
                    events: collectedEvents,
                } as any;
            }

            let requiredToolCorrections = 0;
            while (
                opts?.requiredTool &&
                !hasTerminalTurnBoundary(turnState) &&
                !hasInvokedTool(collectedEvents, opts.requiredTool) &&
                requiredToolCorrections < MAX_REQUIRED_TOOL_CORRECTIONS
            ) {
                requiredToolCorrections++;
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.required_tool_not_invoked",
                    data: {
                        toolName: opts.requiredTool,
                        attempt: requiredToolCorrections,
                        sessionId: this.sessionId,
                    },
                };
                collectedEvents.push(diagnostic);
                if (opts.onEvent) { try { opts.onEvent(diagnostic); } catch {} }

                finalContent = undefined;
                const nextIdle = waitForNextIdle();
                await this.copilotSession.send({
                    prompt: buildRequiredToolCorrection(opts.requiredTool),
                    requiredTool: opts.requiredTool,
                } as any);
                if (guards.length > 0) {
                    await Promise.race([nextIdle, ...guards]);
                } else {
                    await nextIdle;
                }
            }

            if (opts?.requiredTool && !hasInvokedTool(collectedEvents, opts.requiredTool)) {
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.required_tool_not_invoked",
                    data: { toolName: opts.requiredTool, final: true, sessionId: this.sessionId },
                };
                collectedEvents.push(diagnostic);
                if (opts.onEvent) { try { opts.onEvent(diagnostic); } catch {} }
                return {
                    type: "error",
                    message: `Required tool "${opts.requiredTool}" was not invoked after ${requiredToolCorrections + 1} attempts.`,
                    retryable: false,
                    events: collectedEvents,
                } as any;
            }
        } catch (err: any) {
            const errMsg = err.message ?? String(err);
            // Inactivity watchdog — the CLI subprocess is presumed dead or
            // wedged. Settle as a retryable transport-loss error: the message
            // matches isCopilotConnectionClosedError(), so the orchestration
            // retries on a fresh subprocess and lossy-hands-off after bounded
            // attempts. This is the zombie-turn fix — the activity must settle.
            if (errMsg.includes(TURN_INACTIVITY_ERROR_MARKER)) {
                try { await this.copilotSession.abort(); } catch {}
                return {
                    type: "error",
                    message: errMsg,
                    events: collectedEvents,
                } as any;
            }
            // Timeout — kill it
            if (errMsg.includes("timed out")) {
                try { await this.copilotSession.abort(); } catch {}
                return {
                    type: "error",
                    message: "Copilot was taking too long to process and was killed.",
                };
            }
            // Other send() errors — check if any handler aborted first
            if (turnState.pendingActions.length === 0) {
                return { type: "error", message: errMsg };
            }
        } finally {
            // Clear guard timers so a settled turn leaves nothing armed.
            if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer);
            if (inactivityTimer) clearTimeout(inactivityTimer);
            // Always clean up subscriptions
            for (const unsub of unsubscribers) unsub();
        }

        // Check what ended the turn
        if (turnState.pendingActions.length > 0) {
            const [firstAction, ...remainingActions] = turnState.pendingActions;
            const combinedQueuedActions = [...turnState.queuedActions, ...remainingActions];
            const queuedActions = combinedQueuedActions.length > 0 ? combinedQueuedActions : undefined;

            switch (firstAction.type) {
                case "completed":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                case "input_required":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                case "wait":
                    return { ...firstAction, content: finalContent, events: collectedEvents, queuedActions };
                case "cron":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                case "spawn_agent":
                    return { ...firstAction, content: finalContent, events: collectedEvents, queuedActions };
                case "message_agent":
                case "check_agents":
                case "wait_for_agents":
                case "list_sessions":
                case "complete_agent":
                case "cancel_agent":
                case "delete_agent":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                default:
                    break;
            }
        }

        const completedQueuedActions = turnState.queuedActions.length > 0 ? turnState.queuedActions : undefined;

        if (deferredSessionError && !finalContent) {
            collectedEvents.push(deferredSessionError);
            if (opts?.onEvent) {
                try { opts.onEvent(deferredSessionError); } catch {}
            }
        }

        // Check if the SDK emitted a session.error — if so, treat as an error
        // even though session.idle fired (the SDK fires idle after retries exhaust).
        const sessionError = collectedEvents.find(e => e.eventType === "session.error");
        if (sessionError && !finalContent) {
            const errData: any = sessionError.data ?? {};
            const errMsg = errData.message ?? errData.stack ?? "Unknown session error";
            return {
                type: "error",
                message: `Execution failed: ${errMsg}`,
                events: collectedEvents,
            } as any;
        }

        return {
            type: "completed",
            content: finalContent ?? "(no response)",
            events: collectedEvents,
            ...(turnState.cycleReport ? { cycleReport: turnState.cycleReport } : {}),
            queuedActions: completedQueuedActions,
        };
    }

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    abort(): void {
        void Promise.resolve(this.copilotSession.abort()).catch(() => {});
    }

    /**
     * Destroy the session — release resources, flush to disk.
     */
    async destroy(): Promise<void> {
        await this.copilotSession.disconnect();
    }

    /**
     * Get conversation messages from the underlying session.
     * copilot-sdk 1.0.6 renamed getMessages() → getEvents() (same
     * "session.getMessages" RPC underneath); keep our wrapper name stable.
     */
    async getMessages(): Promise<unknown[]> {
        return this.copilotSession.getEvents();
    }

    /**
     * Update configuration for the next turn.
     */
    updateConfig(config: Partial<ManagedSessionConfig>): void {
        if (config.model !== undefined) this.config.model = config.model;
        if (Object.prototype.hasOwnProperty.call(config, "reasoningEffort")) this.config.reasoningEffort = config.reasoningEffort;
        if (Object.prototype.hasOwnProperty.call(config, "contextTier")) this.config.contextTier = config.contextTier;
        if (config.providerFingerprint !== undefined) this.config.providerFingerprint = config.providerFingerprint;
        if (config.tools !== undefined) this.config.tools = config.tools;
        if (config.systemMessage !== undefined) this.config.systemMessage = config.systemMessage;
        if (config.turnSystemPrompt !== undefined) this.config.turnSystemPrompt = config.turnSystemPrompt;
        if (config.waitThreshold !== undefined) this.config.waitThreshold = config.waitThreshold;
    }

    requiresModelRebind(config: Partial<ManagedSessionConfig>): boolean {
        const currentModel = this.config.model;
        const nextModel = config.model ?? this.config.model;
        const currentReasoningEffort = this.config.reasoningEffort ?? null;
        const nextReasoningEffort = config.reasoningEffort !== undefined
            ? config.reasoningEffort ?? null
            : this.config.reasoningEffort ?? null;
        // Context tier is a session-creation option on the Copilot side —
        // changing it (like model or effort) requires a fresh CopilotSession.
        const currentContextTier = this.config.contextTier ?? null;
        const nextContextTier = config.contextTier !== undefined
            ? config.contextTier ?? null
            : this.config.contextTier ?? null;
        const currentProviderFingerprint = this.config.providerFingerprint ?? null;
        const nextProviderFingerprint = config.providerFingerprint !== undefined
            ? config.providerFingerprint ?? null
            : currentProviderFingerprint;
        return Boolean(
            (currentModel || nextModel)
            && (currentModel !== nextModel
                || currentReasoningEffort !== nextReasoningEffort
                || currentContextTier !== nextContextTier
                || currentProviderFingerprint !== nextProviderFingerprint)
        );
    }

    /** Get the underlying CopilotSession (for direct access when needed). */
    getCopilotSession(): CopilotSession {
        return this.copilotSession;
    }
}
