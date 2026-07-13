import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Session artifact tools (proposal G4). Web-mode only — artifacts are served
 * by the deployment's blob store through the Web API; the MCP server has no
 * blob-store client in direct mode.
 *
 * Binary content stays over HTTP: get_artifact returns the authenticated
 * download route for binaries rather than base64-inflating MCP responses.
 */
export function registerArtifactTools(server: McpServer, ctx: ServerContext) {
    const api = ctx.api;
    if (!api) return;

    server.registerTool(
        "list_artifacts",
        {
            title: "List Artifacts",
            description: "List the artifacts (files) a PilotSwarm session has produced or been given.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session whose artifacts to list"),
            },
        },
        withToolErrors(async ({ session_id }) => {
            const artifacts = await api.call("listArtifacts", { sessionId: session_id });
            const list = Array.isArray(artifacts) ? artifacts : (artifacts?.artifacts ?? []);
            return jsonResult({ count: list.length, artifacts: list });
        }),
    );

    server.registerTool(
        "get_artifact",
        {
            title: "Get Artifact",
            description:
                "Fetch a session artifact. include controls what comes back: 'meta' (metadata with sha256), 'text' "
                + "(content as text — for text artifacts), 'base64' (content base64-encoded — for binary artifacts, "
                + "bounded by max_bytes). Large binaries: use the download_url returned with meta.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session owning the artifact"),
                filename: z.string().min(1).describe("Artifact filename"),
                include: z.array(z.enum(["meta", "text", "base64"])).optional().describe("What to fetch (default ['meta'])"),
                max_bytes: z.number().optional().describe("Byte cap for include 'base64' (default 256KB, max 1MB)"),
            },
        },
        withToolErrors(async ({ session_id, filename, include, max_bytes }) => {
            const wants = new Set(include ?? ["meta"]);
            const result: Record<string, unknown> = { session_id, filename };
            let meta: unknown;
            try {
                meta = await api.call("getArtifactMetadata", { sessionId: session_id, filename });
            } catch (err: unknown) {
                return errorResult(err instanceof Error ? err.message : String(err), { session_id, filename });
            }
            if (!meta) {
                // Loud not-found: no fabricated download_url for files that don't exist.
                return errorResult(`Artifact not found: ${filename} in session ${session_id}`, { session_id, filename });
            }
            if (wants.has("meta")) {
                result.meta = meta;
                // Authenticated binary download route (bespoke, streams).
                result.download_url = `/api/v1/sessions/${session_id}/artifacts/${encodeURIComponent(filename)}/download`;
            }
            if (wants.has("text")) {
                try {
                    result.text = await api.call("downloadArtifact", { sessionId: session_id, filename });
                } catch (err: unknown) {
                    result.text = null;
                    result.text_error = err instanceof Error ? err.message : String(err);
                }
            }
            if (wants.has("base64")) {
                try {
                    const read = await api.call("readArtifactBase64", { sessionId: session_id, filename, maxBytes: max_bytes });
                    result.base64 = (read as any)?.base64;
                    result.truncated = (read as any)?.truncated;
                } catch (err: unknown) {
                    result.base64 = null;
                    result.base64_error = err instanceof Error ? err.message : String(err);
                }
            }
            return jsonResult(result);
        }),
    );

    server.registerTool(
        "upload_artifact",
        {
            title: "Upload Artifact",
            description:
                "Upload an artifact into a session (visible to the agent). Text content directly, or base64 with "
                + "content_encoding='base64' for binary. 2 MB JSON envelope limit.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to attach the artifact to"),
                filename: z.string().min(1).describe("Artifact filename"),
                content: z.string().describe("Content (text, or base64 when content_encoding='base64')"),
                content_type: z.string().optional().describe("MIME type (e.g. text/markdown, application/pdf)"),
                content_encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of `content` (default utf8)"),
            },
        },
        withToolErrors(async ({ session_id, filename, content, content_type, content_encoding }) => {
            const meta = await api.call("uploadArtifact", {
                sessionId: session_id,
                filename,
                content,
                contentType: content_type,
                contentEncoding: content_encoding,
            });
            return jsonResult({ uploaded: true, meta });
        }),
    );

    server.registerTool(
        "copy_artifact",
        {
            title: "Copy Artifact",
            description:
                "Server-side copy of an artifact between sessions — bytes never leave the store. "
                + "Optionally verify the copy against an expected SHA-256.",
            inputSchema: {
                from_session_id: sessionIdShape().describe("Session that owns the source artifact"),
                from_filename: z.string().min(1).describe("Source artifact filename"),
                to_session_id: sessionIdShape().describe("Destination session"),
                to_filename: z.string().optional().describe("Destination filename (defaults to the source name)"),
                expected_sha256: z.string().optional().describe("Fail (and delete the copy) if the copied bytes hash differently"),
            },
        },
        withToolErrors(async ({ from_session_id, from_filename, to_session_id, to_filename, expected_sha256 }) => {
            const meta = await api.call("copyArtifact", {
                fromSessionId: from_session_id,
                fromFilename: from_filename,
                toSessionId: to_session_id,
                toFilename: to_filename,
            }) as { filename?: string; sha256?: string } | null;
            if (expected_sha256 && meta?.sha256 !== expected_sha256) {
                await api.call("deleteArtifact", { sessionId: to_session_id, filename: meta?.filename ?? to_filename ?? from_filename });
                return errorResult(
                    `SHA_MISMATCH: copied bytes hash ${meta?.sha256}, expected ${expected_sha256}. The copy was deleted.`,
                    { from_session_id, from_filename },
                );
            }
            return jsonResult({ copied: true, meta });
        }),
    );

    server.registerTool(
        "pin_artifact",
        {
            title: "Pin Artifact",
            description:
                "Pin (or unpin) an artifact so it survives session cleanup — use for deliverables that must "
                + "outlive their producing session.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session owning the artifact"),
                filename: z.string().min(1).describe("Artifact filename"),
                pinned: z.boolean().optional().describe("true to pin (default), false to unpin"),
            },
        },
        withToolErrors(async ({ session_id, filename, pinned }) => {
            const meta = await api.call("setArtifactPinned", { sessionId: session_id, filename, pinned: pinned !== false });
            return jsonResult({ pinned: pinned !== false, meta });
        }),
    );

    server.registerTool(
        "delete_artifact",
        {
            title: "Delete Artifact",
            description: "Delete an artifact from a session.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session owning the artifact"),
                filename: z.string().min(1).describe("Artifact filename to delete"),
            },
        },
        withToolErrors(async ({ session_id, filename }) => {
            await api.call("deleteArtifact", { sessionId: session_id, filename });
            return jsonResult({ deleted: true, filename });
        }),
    );
}
