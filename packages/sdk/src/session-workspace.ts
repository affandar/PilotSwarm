import fs from "node:fs";
import path from "node:path";

export type SessionWorkspaceOwnership = "platform" | "caller";

export interface SessionWorkspace {
    path: string;
    ownership: SessionWorkspaceOwnership;
}

export interface RepositoryConfigurationTrust {
    agents?: boolean;
    skills?: boolean;
    mcp?: boolean;
}

export interface RepositoryConfigurationDiscoveryOptions {
    repositoryRoot: string;
    trust?: RepositoryConfigurationTrust;
}

export interface RepositoryConfiguration {
    repositoryRoot: string;
    agentFiles: string[];
    skillDirectories: string[];
    mcpFiles: string[];
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function validateSessionId(sessionId: string): void {
    if (
        !sessionId
        || sessionId === "."
        || sessionId === ".."
        || sessionId.length > 200
        || /[<>:"/\\|?*\0]/.test(sessionId)
        || /^[. ]|[. ]$/.test(sessionId)
        || WINDOWS_RESERVED_NAME.test(sessionId)
    ) {
        throw new Error(`Invalid session workspace id: ${JSON.stringify(sessionId)}`);
    }
}

function assertConfined(root: string, candidate: string): void {
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        return;
    }
    throw new Error(`Path escapes configured root: ${candidate}`);
}

function assertNoSymlink(root: string, candidate: string): void {
    assertConfined(root, candidate);
    const relative = path.relative(root, candidate);
    if (!relative) return;

    let current = root;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) return;
        if (fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`Symbolic links are not allowed in managed paths: ${current}`);
        }
    }
}

/**
 * Owns opt-in per-session working directories under one platform root.
 *
 * A caller-provided working directory always wins and remains caller-owned:
 * it is neither created nor removed here. Managed paths are created under the
 * canonical root and reject traversal, Windows-reserved names, and symlinks.
 */
export class SessionWorkspaceManager {
    readonly rootDir: string;

    constructor(rootDir: string) {
        const resolved = path.resolve(rootDir);
        fs.mkdirSync(resolved, { recursive: true });
        if (fs.lstatSync(resolved).isSymbolicLink()) {
            throw new Error(`Session workspace root must not be a symbolic link: ${resolved}`);
        }
        this.rootDir = fs.realpathSync.native(resolved);
    }

    resolve(sessionId: string, callerOverride?: string): SessionWorkspace {
        if (callerOverride) {
            return { path: path.resolve(callerOverride), ownership: "caller" };
        }

        validateSessionId(sessionId);
        const workspacePath = path.join(this.rootDir, sessionId);
        assertConfined(this.rootDir, workspacePath);
        assertNoSymlink(this.rootDir, workspacePath);
        fs.mkdirSync(workspacePath, { recursive: true });
        assertNoSymlink(this.rootDir, workspacePath);
        return { path: workspacePath, ownership: "platform" };
    }

    remove(sessionId: string): boolean {
        validateSessionId(sessionId);
        const workspacePath = path.join(this.rootDir, sessionId);
        assertConfined(this.rootDir, workspacePath);
        assertNoSymlink(this.rootDir, workspacePath);
        if (!fs.existsSync(workspacePath)) return false;
        fs.rmSync(workspacePath, { recursive: true, force: true });
        return true;
    }
}

function trustedDirectory(root: string, relativePath: string): string | null {
    const candidate = path.join(root, relativePath);
    assertConfined(root, candidate);
    assertNoSymlink(root, candidate);
    if (!fs.existsSync(candidate)) return null;
    if (!fs.statSync(candidate).isDirectory()) {
        throw new Error(`Expected repository configuration directory: ${candidate}`);
    }
    return candidate;
}

function trustedFile(root: string, relativePath: string): string | null {
    const candidate = path.join(root, relativePath);
    assertConfined(root, candidate);
    assertNoSymlink(root, candidate);
    if (!fs.existsSync(candidate)) return null;
    if (!fs.statSync(candidate).isFile()) {
        throw new Error(`Expected repository configuration file: ${candidate}`);
    }
    return candidate;
}

/**
 * Discover repository-authored configuration without loading or executing it.
 *
 * Every category is denied by default. Callers must independently opt into
 * agents, skills, and MCP because each expands the repository's authority over
 * the model or local process. Only conventional, confined paths are returned;
 * symlinked files/directories are rejected rather than followed.
 */
export function discoverRepositoryConfiguration(
    options: RepositoryConfigurationDiscoveryOptions,
): RepositoryConfiguration {
    const requestedRoot = path.resolve(options.repositoryRoot);
    if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
        throw new Error(`Repository root does not exist or is not a directory: ${requestedRoot}`);
    }
    const repositoryRoot = fs.realpathSync.native(requestedRoot);
    const trust = options.trust ?? {};
    const agentFiles: string[] = [];
    const skillDirectories: string[] = [];
    const mcpFiles: string[] = [];

    if (trust.agents) {
        const agentsDir = trustedDirectory(repositoryRoot, path.join(".github", "agents"));
        if (agentsDir) {
            for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
                if (!entry.name.endsWith(".agent.md")) continue;
                const file = trustedFile(repositoryRoot, path.join(".github", "agents", entry.name));
                if (file) agentFiles.push(file);
            }
        }
    }

    if (trust.skills) {
        const skillsDir = trustedDirectory(repositoryRoot, path.join(".github", "skills"));
        if (skillsDir) {
            for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    if (entry.isSymbolicLink()) {
                        throw new Error(`Symbolic links are not allowed in repository skills: ${path.join(skillsDir, entry.name)}`);
                    }
                    continue;
                }
                const skillFile = trustedFile(
                    repositoryRoot,
                    path.join(".github", "skills", entry.name, "SKILL.md"),
                );
                if (skillFile) skillDirectories.push(path.dirname(skillFile));
            }
        }
    }

    if (trust.mcp) {
        for (const relativePath of [path.join(".vscode", "mcp.json"), ".mcp.json"]) {
            const file = trustedFile(repositoryRoot, relativePath);
            if (file) mcpFiles.push(file);
        }
    }

    return {
        repositoryRoot,
        agentFiles: agentFiles.sort(),
        skillDirectories: skillDirectories.sort(),
        mcpFiles: mcpFiles.sort(),
    };
}
