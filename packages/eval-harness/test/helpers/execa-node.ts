import { spawn } from "node:child_process";

export type ExecaNodeResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function execaNode(args: string[]): Promise<ExecaNodeResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--loader", "tsx", ...args], {
      cwd: new URL("..", import.meta.url).pathname.replace(/\/test\/$/, ""),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
