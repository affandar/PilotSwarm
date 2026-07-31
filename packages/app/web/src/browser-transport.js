import { HttpApiTransport } from "pilotswarm-sdk/api";

function encodeBytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

/**
 * Browser data layer for the portal: HttpApiTransport over the same-origin
 * `/api/v1` Web API, plus the browser-specific conveniences (download via
 * anchor click, window.open). The legacy `/api/rpc` + `/portal-ws` surface
 * is no longer used by the portal itself.
 */

async function saveArtifactDownload(transport, sessionId, filename) {
    const response = await transport.api.downloadArtifactResponse(sessionId, filename);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    return {
        localPath: `browser-download://${sessionId}/${filename}`,
        filename,
    };
}

async function openUrlInDefaultBrowser(targetUrl) {
    const href = String(targetUrl || "").trim();
    if (!href) {
        throw new Error("URL cannot be empty.");
    }
    const parsedUrl = new URL(href, window.location.href);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
        throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }
    window.open(parsedUrl.toString(), "_blank", "noopener,noreferrer");
    return { url: parsedUrl.toString() };
}

/** Azure DevOps' first-party resource id — the audience for repo reads. */
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

export class BrowserPortalTransport extends HttpApiTransport {
    constructor({ getAccessToken, getResourceToken, onUnauthorized, onForbidden } = {}) {
        super({
            apiUrl: window.location.origin,
            getAccessToken,
            onUnauthorized,
            onForbidden,
            host: {
                saveArtifactDownload,
                openUrlInDefaultBrowser,
                artifactExportDirectory: "Browser downloads",
            },
        });
        this.getResourceTokenImpl = typeof getResourceToken === "function" ? getResourceToken : null;
    }

    /**
     * Access token for reading a code host AS THE SIGNED-IN USER, so package
     * import happens in this browser with the viewer's own permissions.
     * GitHub needs none for public repos (a PAT covers private ones).
     */
    async getRepoAccessToken(kind) {
        if (kind !== "ado" || typeof this.getResourceTokenImpl !== "function") return null;
        return this.getResourceTokenImpl(ADO_RESOURCE_ID);
    }

    async uploadArtifactFromFile(sessionId, file, filenameOverride = null) {
        if (!file || typeof file.name !== "string") {
            throw new Error("A browser File is required for upload");
        }
        const filename = String(filenameOverride || file.name);
        const content = encodeBytesToBase64(new Uint8Array(await file.arrayBuffer()));
        return this.uploadArtifactContent(sessionId, filename, content, file.type || undefined, "base64");
    }

    /**
     * Capability probe for the composer's attach affordances (paste / drop /
     * picker). The portal server ships the same build as this bundle, so a
     * static true is honest — the API edge still validates every send.
     */
    supportsPromptImageAttachments() {
        return true;
    }
}
