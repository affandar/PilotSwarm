import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = new URL("../..", import.meta.url).pathname;
const LOADER = new URL("../../bin/ts-loader.mjs", import.meta.url).pathname;
const ENTRY = new URL("../../bin/run-eval.ts", import.meta.url).pathname;

export type CliResult = { code: number; stdout: string; stderr: string };

/**
 * Run the eval-harness CLI through the same node binary vitest is using, via the
 * package's ts-loader. Deterministic — no bash wrapper, no PATH dependency on a
 * node version manager. Exercises bin/run-eval.ts directly (arg parsing, exit
 * codes, discovery, run).
 */
export async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--loader", LOADER, ENTRY, ...args],
      { cwd: PACKAGE_ROOT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
