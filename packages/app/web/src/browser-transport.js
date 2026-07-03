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

export class BrowserPortalTransport extends HttpApiTransport {
    constructor({ getAccessToken, onUnauthorized, onForbidden } = {}) {
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
    }

    async uploadArtifactFromFile(sessionId, file) {
        if (!file || typeof file.name !== "string") {
            throw new Error("A browser File is required for upload");
        }
        const content = encodeBytesToBase64(new Uint8Array(await file.arrayBuffer()));
        return this.uploadArtifactContent(sessionId, file.name, content, file.type || undefined, "base64");
    }
}
