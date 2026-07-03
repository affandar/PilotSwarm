import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HttpApiTransport } from "pilotswarm-sdk/api";

/**
 * TUI host for the Web API transport: HttpApiTransport plus the local-machine
 * conveniences the shared UI expects from a Node environment (artifact export
 * to disk, open-in-default-app/browser). All data flows through the API —
 * this file only touches the local filesystem and OS openers.
 */

function expandUserPath(filePath) {
    const raw = String(filePath || "");
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
    return raw;
}

const EXPORTS_DIR = path.resolve(
    expandUserPath(process.env.PILOTSWARM_EXPORT_DIR || path.join(os.homedir(), "pilotswarm-exports")),
);

function spawnDetached(command, args) {
    return new Promise((resolve, reject) => {
        try {
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.once("error", reject);
            child.unref();
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

async function openWithPlatformOpener(target) {
    if (process.platform === "darwin") {
        await spawnDetached("open", [target]);
    } else if (process.platform === "win32") {
        await spawnDetached("cmd", ["/c", "start", "", target]);
    } else {
        await spawnDetached("xdg-open", [target]);
    }
}

async function saveArtifactDownload(transport, sessionId, filename) {
    const response = await transport.api.downloadArtifactResponse(sessionId, filename);
    const body = Buffer.from(await response.arrayBuffer());
    const sessionDir = path.join(EXPORTS_DIR, String(sessionId || "").slice(0, 8));
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const localPath = path.join(sessionDir, path.basename(filename));
    await fs.promises.writeFile(localPath, body);
    return { localPath, filename };
}

async function uploadArtifactFromPath(transport, sessionId, filePath) {
    const resolvedPath = path.resolve(expandUserPath(filePath));
    const content = await fs.promises.readFile(resolvedPath);
    return transport.uploadArtifactContent(
        sessionId,
        path.basename(resolvedPath),
        content.toString("base64"),
        undefined,
        "base64",
    );
}

async function openPathInDefaultApp(targetPath) {
    const resolvedPath = path.resolve(expandUserPath(targetPath));
    const stat = await fs.promises.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isFile()) {
        throw new Error(`File not found: ${targetPath}`);
    }
    await openWithPlatformOpener(resolvedPath);
    return { localPath: resolvedPath };
}

export async function openUrlInDefaultBrowser(targetUrl) {
    const href = String(targetUrl || "").trim();
    if (!href) throw new Error("URL cannot be empty.");
    const parsedUrl = new URL(href);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
        throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }
    await openWithPlatformOpener(parsedUrl.toString());
    return { url: parsedUrl.toString() };
}

export function createHttpTransportHost({ apiUrl, getAccessToken, onUnauthorized, onForbidden }) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    return new HttpApiTransport({
        apiUrl,
        getAccessToken,
        onUnauthorized,
        onForbidden,
        host: {
            saveArtifactDownload,
            uploadArtifactFromPath,
            openPathInDefaultApp,
            openUrlInDefaultBrowser,
            artifactExportDirectory: EXPORTS_DIR,
        },
    });
}
