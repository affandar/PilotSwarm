/**
 * Artifact Tools — allow agents to read/write markdown files via Azure Blob Storage.
 *
 * Three tools:
 *   - `write_artifact` — upload a file to blob storage
 *   - `read_artifact`  — read a file from another session's artifacts
 *   - `export_artifact` — generate a short-lived SAS URL for TUI download
 *
 * Plus a discovery tool:
 *   - `list_artifacts`  — list files in a session's artifact folder
 *
 * Agents communicate via artifacts: Agent A writes, Agent B reads.
 * For TUI download, the agent calls `export_artifact` which returns a
 * 1-minute SAS URL that the TUI auto-downloads.
 *
 * @module
 * @internal
 */

import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { SessionBlobStore } from "./blob-store.js";

/**
 * Create artifact tools bound to the given blob store.
 *
 * The `sessionId` for write/export operations is injected by the tool handler
 * via the session context (the agent's own session ID).
 */
export function createArtifactTools(opts: {
    blobStore: SessionBlobStore;
}): Tool<any>[] {
    const { blobStore } = opts;

    // ── write_artifact ─────────────────────────────────────────

    const writeTool = defineTool("write_artifact", {
        description:
            "Write a file (typically markdown) to shared blob storage. " +
            "Other agents can read it via `read_artifact`. " +
            "To make it downloadable by the TUI user, call `export_artifact` afterwards.\n\n" +
            "The file is stored under the current session's artifact folder. " +
            "Maximum file size: 1MB.",
        parameters: {
            type: "object" as const,
            properties: {
                filename: {
                    type: "string",
                    description:
                        "Filename including extension, e.g. 'report.md' or 'analysis.json'. " +
                        "No path separators allowed.",
                },
                content: {
                    type: "string",
                    description: "The full file content to write.",
                },
                contentType: {
                    type: "string",
                    description:
                        "MIME type. Default: 'text/markdown'. Use 'application/json' for JSON, etc.",
                },
            },
            required: ["filename", "content"],
        },
        handler: async (params: {
            filename: string;
            content: string;
            contentType?: string;
        }, context: any) => {
            const sessionId = context?.durableSessionId;
            if (!sessionId) {
                return JSON.stringify({ error: "No session context — cannot determine artifact path." });
            }

            try {
                const blobPath = await blobStore.uploadArtifact(
                    sessionId,
                    params.filename,
                    params.content,
                    params.contentType ?? "text/markdown",
                );
                return JSON.stringify({
                    success: true,
                    sessionId,
                    filename: params.filename,
                    blobPath,
                    sizeBytes: params.content.length,
                });
            } catch (err: any) {
                return JSON.stringify({ error: err.message });
            }
        },
    });

    // ── read_artifact ──────────────────────────────────────────

    const readTool = defineTool("read_artifact", {
        description:
            "Read a file from any session's artifact storage. " +
            "Use this to read files written by other agents via `write_artifact`. " +
            "You need the session ID and filename.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description:
                        "The session ID that owns the artifact. Use your own session ID for your own files, " +
                        "or another agent's session ID to read their files.",
                },
                filename: {
                    type: "string",
                    description: "The filename to read, e.g. 'report.md'.",
                },
            },
            required: ["sessionId", "filename"],
        },
        handler: async (params: { sessionId: string; filename: string }) => {
            try {
                const content = await blobStore.downloadArtifact(params.sessionId, params.filename);
                return JSON.stringify({
                    success: true,
                    sessionId: params.sessionId,
                    filename: params.filename,
                    content,
                    sizeBytes: content.length,
                });
            } catch (err: any) {
                return JSON.stringify({ error: err.message });
            }
        },
    });

    // ── list_artifacts ─────────────────────────────────────────

    const listTool = defineTool("list_artifacts", {
        description:
            "List all artifact files in a session's storage folder. " +
            "Returns filenames that can be read with `read_artifact`.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description:
                        "The session ID to list artifacts for. " +
                        "Omit or leave empty to list your own session's artifacts.",
                },
            },
            required: [],
        },
        handler: async (params: { sessionId?: string }, context: any) => {
            const targetId = params.sessionId || context?.durableSessionId;
            if (!targetId) {
                return JSON.stringify({ error: "No session ID provided or available from context." });
            }

            try {
                const files = await blobStore.listArtifacts(targetId);
                return JSON.stringify({
                    success: true,
                    sessionId: targetId,
                    files,
                    count: files.length,
                });
            } catch (err: any) {
                return JSON.stringify({ error: err.message });
            }
        },
    });

    // ── export_artifact ────────────────────────────────────────

    const exportTool = defineTool("export_artifact", {
        description:
            "Generate a short-lived download URL for a file in your artifact storage. " +
            "The URL is valid for 1 minute and allows the TUI user to download the file. " +
            "The TUI will automatically detect and download files from these URLs.\n\n" +
            "You must have written the file with `write_artifact` first.",
        parameters: {
            type: "object" as const,
            properties: {
                filename: {
                    type: "string",
                    description: "The filename to export, e.g. 'report.md'.",
                },
            },
            required: ["filename"],
        },
        handler: async (params: { filename: string }, context: any) => {
            const sessionId = context?.durableSessionId;
            if (!sessionId) {
                return JSON.stringify({ error: "No session context — cannot determine artifact path." });
            }

            try {
                // Verify the file exists
                const exists = await blobStore.artifactExists(sessionId, params.filename);
                if (!exists) {
                    return JSON.stringify({
                        error: `Artifact '${params.filename}' not found. Write it first with write_artifact.`,
                    });
                }

                const sasUrl = blobStore.generateArtifactSasUrl(sessionId, params.filename, 1);
                return JSON.stringify({
                    success: true,
                    filename: params.filename,
                    downloadUrl: sasUrl,
                    expiresInSeconds: 60,
                    message: "The TUI will automatically download this file.",
                });
            } catch (err: any) {
                return JSON.stringify({ error: err.message });
            }
        },
    });

    return [writeTool, readTool, listTool, exportTool];
}
