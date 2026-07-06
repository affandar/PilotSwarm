import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session whose artifacts to list"),
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
                "Fetch a session artifact. include controls what comes back: 'meta' (metadata), 'text' (content as "
                + "text — for text artifacts). Binary artifacts: use the download_url returned in meta.",
            inputSchema: {
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session owning the artifact"),
                filename: z.string().min(1).describe("Artifact filename"),
                include: z.array(z.enum(["meta", "text"])).optional().describe("What to fetch (default ['meta'])"),
            },
        },
        withToolErrors(async ({ session_id, filename, include }) => {
            const wants = new Set(include ?? ["meta"]);
            const result: Record<string, unknown> = { session_id, filename };
            if (wants.has("meta")) {
                try {
                    result.meta = await api.call("getArtifactMetadata", { sessionId: session_id, filename });
                } catch (err: unknown) {
                    return errorResult(err instanceof Error ? err.message : String(err), { session_id, filename });
                }
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
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session to attach the artifact to"),
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
        "delete_artifact",
        {
            title: "Delete Artifact",
            description: "Delete an artifact from a session.",
            inputSchema: {
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session owning the artifact"),
                filename: z.string().min(1).describe("Artifact filename to delete"),
            },
        },
        withToolErrors(async ({ session_id, filename }) => {
            await api.call("deleteArtifact", { sessionId: session_id, filename });
            return jsonResult({ deleted: true, filename });
        }),
    );
}
