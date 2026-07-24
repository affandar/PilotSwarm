/**
 * Distiller Tools — the regen-distiller service session's toolset.
 *
 * One tool: `read_transcript_page`, which pages through the ARCHIVED
 * transcript (`transcript-e<E>-<attemptId>.jsonl`) of the session the
 * distiller serves. The security model is CMS truth, not registration-time
 * gating: the tool is registered on every worker (any pod can host the
 * distiller's turn), but at call time it requires the CALLER's session row
 * to carry `service_kind = "regen-distiller"` and reads only from that
 * row's `service_of` session, only artifacts matching the archive name
 * shape. A spoofed session named "regen-distiller" has no service columns
 * (they are set exclusively by the worker's spawn activity) and gets
 * nothing.
 *
 * @internal
 */
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { ArtifactStore } from "./session-store.js";
import type { SessionCatalog } from "./cms.js";

export const REGEN_DISTILLER_SERVICE_KIND = "regen-distiller";

/** Archive artifact name shape — the ONLY thing the pager will open. */
const ARCHIVE_NAME_RE = /^transcript-e\d+-[A-Za-z0-9._:-]+\.jsonl$/;

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
/** Per-entry content clip — keeps a page well inside one tool result. */
const ENTRY_CLIP = 2_000;

export function createDistillerTools(opts: {
    catalog: SessionCatalog;
    blobStore: ArtifactStore;
}): Tool<any>[] {
    const { catalog, blobStore } = opts;

    const readTranscriptPage = defineTool("read_transcript_page", {
        description:
            "Regen-distiller ONLY: read one page of the archived transcript you were spawned to distill. "
            + "Call with the archive artifact id from your seed prompt and page=1, then keep incrementing "
            + "page until has_more is false. Other sessions: this tool always refuses.",
        parameters: {
            type: "object" as const,
            properties: {
                artifact: {
                    type: "string",
                    description: "Archive artifact id (transcript-e<E>-<attemptId>.jsonl) from the seed prompt.",
                },
                page: { type: "number", description: "1-based page number." },
                page_size: { type: "number", description: `Messages per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).` },
            },
            required: ["artifact", "page"],
        },
        handler: async (
            params: { artifact: string; page: number; page_size?: number },
            context: any,
        ) => {
            const callerId = context?.durableSessionId;
            if (!callerId) return { error: "read_transcript_page: no session context" };
            let caller;
            try {
                caller = await catalog.getSession(callerId);
            } catch (err: any) {
                return { error: `read_transcript_page: ${err?.message || String(err)}` };
            }
            if (!caller || caller.serviceKind !== REGEN_DISTILLER_SERVICE_KIND || !caller.serviceOf) {
                return { error: "read_transcript_page is reserved for the regen-distiller service session." };
            }
            const artifact = String(params.artifact || "").trim();
            if (!ARCHIVE_NAME_RE.test(artifact)) {
                return { error: "read_transcript_page: artifact must be a transcript-e<E>-<attemptId>.jsonl archive id." };
            }
            const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.page_size) || DEFAULT_PAGE_SIZE));
            const page = Math.max(1, Math.floor(Number(params.page) || 1));
            let body: Buffer;
            try {
                const download = await blobStore.downloadArtifact(caller.serviceOf, artifact);
                body = download.body;
            } catch (err: any) {
                return { error: `read_transcript_page: archive not readable (${err?.message || String(err)})` };
            }
            const lines = body.toString("utf8").split("\n").filter((l) => l.trim());
            const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));
            const start = (page - 1) * pageSize;
            const entries = lines.slice(start, start + pageSize).map((line) => {
                try {
                    const evt = JSON.parse(line);
                    const role = evt.eventType === "user.message"
                        ? "user"
                        : evt.eventType === "assistant.message" ? "assistant" : "system";
                    const content = String(evt?.data?.content ?? "");
                    return {
                        seq: evt.seq,
                        role,
                        content: content.length > ENTRY_CLIP ? content.slice(0, ENTRY_CLIP) + "…" : content,
                    };
                } catch {
                    return { role: "unparseable", content: line.slice(0, 200) };
                }
            });
            return {
                page,
                total_pages: totalPages,
                total_messages: lines.length,
                has_more: page < totalPages,
                entries,
            };
        },
    });

    return [readTranscriptPage];
}
