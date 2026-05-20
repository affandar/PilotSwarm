import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI", () => {
  it("lists agent inventory", async () => {
    const { stdout } = await execFileAsync("bash", ["bin/run-eval.sh", "--list-agents"], {
      cwd: join(import.meta.dirname, "..")
    });
    expect(stdout).toContain("default");
  });

  it("runs a fake scenario and prints schema validation passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-cli-"));
    const scenarioPath = join(dir, "single.scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "cli.single",
        description: "CLI scenario.",
        input: { prompt: "Say hello." },
        checks: [{ type: "response-contains", any: ["hello"] }],
      }),
    );

    const { stdout } = await execFileAsync("bash", ["bin/run-eval.sh", `--scenarios=${scenarioPath}`, "--driver=fake"], {
      cwd: join(import.meta.dirname, "..")
    });
    expect(stdout).toContain("schema validation passed");
    expect(stdout).toContain("cli.single");
  });
});
