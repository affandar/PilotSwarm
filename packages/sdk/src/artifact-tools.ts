/**
 * Artifact Tools — agent-facing surface over the artifact store.
 *
 * Three tools, consolidated along the source/destination axis so the model's
 * mental picture stays "read and write":
 *
 *   - `write_artifact` — store bytes from exactly one of three sources:
 *       content       (inline, model-authored — the only path where bytes
 *                      transit the context window)
 *       fromFile      (worker-local path → streamed; zero payload tokens)
 *       fromArtifact  (server-side copy from another session, with optional
 *                      SHA-256 precondition)
 *   - `read_artifact` — fetch metadata (`metaOnly`), stream to a worker-local
 *       file (`toFile`), or return content inline (utf-8 or base64, bounded).
 *   - `list_artifacts` — discovery, with full provenance metadata.
 *
 * Every result carries { sha256, sizeBytes, contentType, isBinary,
 * artifactLink, … } so provenance verification never requires a transfer.
 *
 * DESIGN RULE (born from the 2026-07-12 Diagon Alley incident): the model is
 * a control plane, not a wire. Payloads that already exist as bytes must move
 * via `fromFile` / `fromArtifact` / `toFile`, never by being reproduced as
 * model tokens. Inline reads are size-guarded for the same reason.
 *
 * @module
 * @internal
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { ArtifactStore } from "./session-store.js";

const INLINE_READ_DEFAULT_BYTES = 65_536;
const INLINE_READ_MAX_BYTES = 262_144;

function artifactLink(sessionId: string, filename: string): string {
    return `artifact://${sessionId}/${filename}`;
}

function toolError(code: string, message: string, hint?: string): string {
    return JSON.stringify({ error: code, message, ...(hint ? { hint } : {}) });
}

/**
 * Worker-local paths handed to fromFile/toFile are jailed to a set of allowed
 * roots (default: the process working directory and the OS temp dir, where
 * session `bash` work lands). Symlink escapes are rejected via realpath.
 */
function allowedFileRoots(): string[] {
    const configured = (process.env.PILOTSWARM_ARTIFACT_FILE_ROOTS || "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const roots = configured.length > 0 ? configured : [process.cwd(), os.tmpdir()];
    return roots.map((root) => {
        const resolved = path.resolve(root);
        try {
            return fs.realpathSync(resolved);
        } catch {
            return resolved;
        }
    });
}

function resolveJailedPath(candidate: string, mustExist: boolean): { path?: string; error?: string } {
    const resolved = path.resolve(String(candidate || ""));
    // realpath the deepest existing ancestor so symlinks can't tunnel out.
    let probe = mustExist ? resolved : path.dirname(resolved);
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    let real: string;
    try {
        real = fs.realpathSync(probe);
    } catch {
        return { error: `Path is not accessible: ${candidate}` };
    }
    const effective = mustExist ? real : path.join(real, path.relative(probe, resolved));
    const roots = allowedFileRoots();
    const inJail = roots.some((root) => effective === root || effective.startsWith(root + path.sep));
    if (!inJail) {
        return { error: `Path is outside the allowed roots (${roots.join(", ")}): ${candidate}` };
    }
    if (mustExist && !fs.existsSync(effective)) {
        return { error: `File not found: ${candidate}` };
    }
    return { path: effective };
}

/**
 * Create the artifact tools bound to the given store. The store can be Azure
 * Blob (SessionBlobStore) or local filesystem (FilesystemArtifactStore); the
 * `sessionId` for writes is injected via the session context.
 */
export function createArtifactTools(opts: {
    blobStore: ArtifactStore;
}): Tool<any>[] {
    const { blobStore } = opts;

    // ── write_artifact ─────────────────────────────────────────

    const writeTool = defineTool("write_artifact", {
        description:
            "Write an artifact from EXACTLY ONE of three sources: inline `content` (text you are authoring), " +
            "`fromFile` (a worker-local file path — streamed server-side, use this for anything that already " +
            "exists as a file, especially binaries and archives), or `fromArtifact` (server-side copy from " +
            "another session's artifact, optionally verified against an expected SHA-256). " +
            "Returns full metadata including sha256 and an artifact:// link — include the link in your " +
            "response when the user should see it. Never read a file just to re-send its bytes as `content`; " +
            "pass the path via `fromFile` instead.",
        parameters: {
            type: "object" as const,
            properties: {
                filename: {
                    type: "string",
                    description:
                        "Destination filename, e.g. 'report.md'. No path separators. " +
                        "Optional for fromFile/fromArtifact (defaults to the source basename).",
                },
                content: {
                    type: "string",
                    description: "Inline content to write (source 1 of 3). Max 1MB.",
                },
                encoding: {
                    type: "string",
                    enum: ["utf-8", "base64"],
                    description: "Encoding of `content`. Default 'utf-8'; 'base64' for small binary payloads.",
                },
                fromFile: {
                    type: "string",
                    description:
                        "Worker-local file path to upload (source 2 of 3). Streamed — bytes never enter " +
                        "the conversation. Preferred for files created with bash/tar/build steps.",
                },
                fromArtifact: {
                    type: "object",
                    description:
                        "Copy another session's artifact server-side (source 3 of 3). " +
                        "Bytes move store-to-store.",
                    properties: {
                        sessionId: { type: "string", description: "Session that owns the source artifact." },
                        filename: { type: "string", description: "Source artifact filename." },
                        expectedSha256: {
                            type: "string",
                            description: "Optional precondition: fail with SHA_MISMATCH if the copied bytes hash differently.",
                        },
                    },
                    required: ["sessionId", "filename"],
                },
                contentType: {
                    type: "string",
                    description: "MIME type. Default: 'text/markdown' for inline text; sniffed for fromFile.",
                },
                content_type: {
                    type: "string",
                    description: "Alias for contentType. Supported for compatibility; contentType is preferred.",
                },
                pin: {
                    type: "boolean",
                    description: "Pin the artifact so it survives session cleanup (deliverables).",
                },
            },
            required: [],
        },
        handler: async (params: {
            filename?: string;
            content?: string;
            encoding?: "utf-8" | "base64";
            fromFile?: string;
            fromArtifact?: { sessionId: string; filename: string; expectedSha256?: string };
            contentType?: string;
            content_type?: string;
            pin?: boolean;
        }, context: any) => {
            const sessionId = context?.durableSessionId;
            if (!sessionId) {
                return toolError("NO_SESSION_CONTEXT", "No session context — cannot determine artifact path.");
            }

            const sources = [params.content !== undefined, !!params.fromFile, !!params.fromArtifact]
                .filter(Boolean).length;
            if (sources !== 1) {
                return toolError(
                    "EXCLUSIVE_SOURCE",
                    `write_artifact needs exactly one byte source; you provided ${sources}.`,
                    "Pass exactly one of: content (inline text), fromFile (worker-local path), fromArtifact ({sessionId, filename}).",
                );
            }

            const contentType = params.contentType ?? params.content_type;
            const pinned = params.pin === true;

            try {
                if (params.fromFile) {
                    const jailed = resolveJailedPath(params.fromFile, true);
                    if (jailed.error) return toolError("PATH_OUTSIDE_WORKDIR", jailed.error);
                    const filename = params.filename || path.basename(jailed.path!);
                    const metadata = await blobStore.uploadArtifactFromFile(
                        sessionId, filename, jailed.path!, contentType, { pinned },
                    );
                    return JSON.stringify({
                        success: true,
                        sessionId,
                        ...metadata,
                        artifactLink: artifactLink(sessionId, metadata.filename),
                    });
                }

                if (params.fromArtifact) {
                    const from = params.fromArtifact;
                    const filename = params.filename || path.basename(from.filename);
                    const metadata = await blobStore.copyArtifact(
                        from.sessionId, from.filename, sessionId, filename, { pinned },
                    );
                    if (from.expectedSha256 && metadata.sha256 !== from.expectedSha256) {
                        await blobStore.deleteArtifact(sessionId, metadata.filename);
                        return toolError(
                            "SHA_MISMATCH",
                            `Copied bytes hash ${metadata.sha256}, expected ${from.expectedSha256}. The copy was deleted.`,
                            "The source artifact is not the bytes you believed. Re-verify the source with read_artifact({metaOnly: true}).",
                        );
                    }
                    return JSON.stringify({
                        success: true,
                        sessionId,
                        ...metadata,
                        artifactLink: artifactLink(sessionId, metadata.filename),
                    });
                }

                if (!params.filename) {
                    return toolError(
                        "FILENAME_REQUIRED",
                        "filename is required when writing inline content.",
                    );
                }
                const metadata = await blobStore.uploadArtifact(
                    sessionId, params.filename, params.content!, contentType,
                    { encoding: params.encoding, pinned },
                );
                return JSON.stringify({
                    success: true,
                    sessionId,
                    ...metadata,
                    artifactLink: artifactLink(sessionId, metadata.filename),
                });
            } catch (err: any) {
                return toolError(err?.code || "ARTIFACT_WRITE_FAILED", err.message);
            }
        },
    });

    // ── read_artifact ──────────────────────────────────────────

    const readTool = defineTool("read_artifact", {
        description:
            "Read a session artifact (yours or another session's). Three modes: default returns text content " +
            "inline (bounded by maxBytes, use offset to page); `toFile` streams the artifact to a worker-local " +
            "path without the bytes entering the conversation (REQUIRED for large or binary artifacts you want " +
            "to process with bash); `metaOnly` returns just metadata (size, sha256, contentType) — use it to " +
            "verify provenance cheaply. Small binary artifacts can be read inline with encoding='base64'.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session that owns the artifact (your own session ID for your files).",
                },
                filename: { type: "string", description: "The artifact filename, e.g. 'report.md'." },
                metaOnly: {
                    type: "boolean",
                    description: "Return metadata only — no content transfer.",
                },
                toFile: {
                    type: "string",
                    description:
                        "Write the artifact to this worker-local path instead of returning content. " +
                        "Zero context cost; works for any size and any content type.",
                },
                encoding: {
                    type: "string",
                    enum: ["utf-8", "base64"],
                    description: "Inline content encoding. 'base64' permits reading small binary artifacts inline.",
                },
                maxBytes: {
                    type: "number",
                    description: `Max bytes returned inline (default ${INLINE_READ_DEFAULT_BYTES}, hard cap ${INLINE_READ_MAX_BYTES}). Result sets truncated=true when the artifact is larger.`,
                },
                offset: {
                    type: "number",
                    description: "Byte offset for inline reads — page through large text artifacts.",
                },
            },
            required: ["sessionId", "filename"],
        },
        handler: async (params: {
            sessionId: string;
            filename: string;
            metaOnly?: boolean;
            toFile?: string;
            encoding?: "utf-8" | "base64";
            maxBytes?: number;
            offset?: number;
        }) => {
            if (params.metaOnly && params.toFile) {
                return toolError(
                    "EXCLUSIVE_MODE",
                    "metaOnly and toFile are mutually exclusive.",
                    "Use metaOnly for metadata, toFile to materialize bytes, or neither for inline content.",
                );
            }

            try {
                if (params.metaOnly) {
                    const metadata = await blobStore.statArtifact(params.sessionId, params.filename);
                    if (!metadata) {
                        return toolError("ARTIFACT_NOT_FOUND", `Artifact not found: ${params.filename} in session ${params.sessionId}`);
                    }
                    return JSON.stringify({
                        success: true,
                        sessionId: params.sessionId,
                        ...metadata,
                        artifactLink: artifactLink(params.sessionId, metadata.filename),
                    });
                }

                if (params.toFile) {
                    const jailed = resolveJailedPath(params.toFile, false);
                    if (jailed.error) return toolError("PATH_OUTSIDE_WORKDIR", jailed.error);
                    const result = await blobStore.downloadArtifact(params.sessionId, params.filename);
                    fs.mkdirSync(path.dirname(jailed.path!), { recursive: true });
                    fs.writeFileSync(jailed.path!, result.body);
                    const { body: _body, ...metadata } = result;
                    return JSON.stringify({
                        success: true,
                        sessionId: params.sessionId,
                        path: jailed.path,
                        ...metadata,
                        sha256: metadata.sha256 || crypto.createHash("sha256").update(result.body).digest("hex"),
                        artifactLink: artifactLink(params.sessionId, metadata.filename),
                    });
                }

                const result = await blobStore.downloadArtifact(params.sessionId, params.filename);
                const encoding = params.encoding || "utf-8";
                if (result.isBinary && encoding !== "base64") {
                    return JSON.stringify({
                        error: "ARTIFACT_IS_BINARY",
                        message: `Artifact '${params.filename}' is binary (${result.contentType}, ${result.sizeBytes} bytes) and cannot be returned as text.`,
                        hint: "Use toFile to materialize it on the worker filesystem, or encoding='base64' if it is small enough to inspect inline.",
                        contentType: result.contentType,
                        sizeBytes: result.sizeBytes,
                    });
                }

                const maxBytes = Math.min(
                    Math.max(1, Math.floor(params.maxBytes ?? INLINE_READ_DEFAULT_BYTES)),
                    INLINE_READ_MAX_BYTES,
                );
                const offset = Math.max(0, Math.floor(params.offset ?? 0));
                const slice = result.body.subarray(offset, offset + maxBytes);
                const truncated = offset > 0 || offset + slice.length < result.body.length;
                const { body: _body, ...metadata } = result;
                return JSON.stringify({
                    success: true,
                    sessionId: params.sessionId,
                    ...metadata,
                    sha256: metadata.sha256 || crypto.createHash("sha256").update(result.body).digest("hex"),
                    content: slice.toString(encoding === "base64" ? "base64" : "utf8"),
                    truncated,
                    ...(truncated ? { range: { offset, length: slice.length } } : {}),
                    artifactLink: artifactLink(params.sessionId, metadata.filename),
                });
            } catch (err: any) {
                return toolError(err?.code || "ARTIFACT_READ_FAILED", err.message);
            }
        },
    });

    // ── list_artifacts ─────────────────────────────────────────

    const listTool = defineTool("list_artifacts", {
        description:
            "List all artifact files in a session's storage folder, with full metadata " +
            "(sizeBytes, contentType, sha256, pinned). Returns filenames that can be read " +
            "with `read_artifact`.",
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
                return toolError("NO_SESSION_CONTEXT", "No session ID provided or available from context.");
            }

            try {
                const files = await blobStore.listArtifacts(targetId);
                return JSON.stringify({
                    success: true,
                    sessionId: targetId,
                    files,
                    filenames: files.map((file) => file.filename),
                    count: files.length,
                });
            } catch (err: any) {
                return toolError(err?.code || "ARTIFACT_LIST_FAILED", err.message);
            }
        },
    });

    return [writeTool, readTool, listTool];
}
