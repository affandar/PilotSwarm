import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GitPluginSpec } from "./plugin-source-spec.js";

export interface GitPluginSourceResolver {
    /**
     * Materialize exactly the requested repository/ref into destination.
     * Implementations may acquire credentials, but must not change spec.path.
     */
    checkout(spec: GitPluginSpec, destination: string): Promise<void>;
}

export interface PluginProcessOptions {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
}

export type PluginProcessRunner = (
    command: string,
    args: readonly string[],
    options?: PluginProcessOptions,
) => Promise<void>;

/**
 * Provider-neutral Git resolver with no ambient credential acquisition.
 *
 * A caller that needs provider authentication should inject its own resolver.
 * The default disables interactive prompts and user/system Git config so a
 * worker cannot unexpectedly inherit credential helpers or checkout filters.
 */
export function createGitPluginSourceResolver(
    options: { run?: PluginProcessRunner } = {},
): GitPluginSourceResolver {
    const run = options.run ?? runProcess;
    return {
        async checkout(spec, destination) {
            if (spec.repository.toLowerCase().startsWith("ssh:")) {
                throw new Error("SSH repositories require an injected GitPluginSourceResolver");
            }
            const emptyConfig = path.join(path.dirname(destination), ".gitconfig");
            await fs.writeFile(emptyConfig, "");
            const environment = {
                GIT_CONFIG_GLOBAL: emptyConfig,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
                GIT_ASKPASS: "",
                SSH_ASKPASS: "",
                GIT_CONFIG_COUNT: "0",
                GIT_CONFIG_PARAMETERS: "",
            };
            await run("git", ["init", "--quiet", "--template=", destination], { env: environment });
            await run("git", ["-C", destination, "remote", "add", "origin", spec.repository], { env: environment });
            await run(
                "git",
                ["-C", destination, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", spec.ref ?? "HEAD"],
                { env: environment },
            );
            await run("git", ["-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
                env: environment,
            });
        },
    };
}

async function runProcess(
    command: string,
    args: readonly string[],
    options: PluginProcessOptions = {},
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            shell: false,
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const detail = signal ? `signal ${signal}` : `exit code ${code}`;
            reject(new Error(`${command} failed: ${detail}`));
        });
    });
}
