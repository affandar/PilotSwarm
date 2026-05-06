import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MultiTrialResult, MatrixResult } from "../types.js";
import type { AggregateReporter } from "./aggregate-types.js";
import { escapeMarkdownCell, matrixMarkdown, multiTrialMarkdown } from "./util.js";

// F27: read the harness version once at module load so every report carries
// reliable provenance even when run from a built dist tree.
function readHarnessVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(url), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HARNESS_VERSION = readHarnessVersion();

function provenanceMarkdown(result: MultiTrialResult | MatrixResult): string {
  const lines: string[] = [];
  lines.push("### Provenance");
  lines.push("");
  lines.push(`- **Run ID:** ${escapeMarkdownCell(result.runId)}`);
  if (result.gitSha) {
    lines.push(`- **Git SHA:** ${escapeMarkdownCell(result.gitSha)}`);
  }
  const model = (result as MultiTrialResult).model;
  if (model) {
    lines.push(`- **Model:** ${escapeMarkdownCell(model)}`);
  }
  lines.push(`- **Started:** ${escapeMarkdownCell(result.startedAt)}`);
  lines.push(`- **Finished:** ${escapeMarkdownCell(result.finishedAt)}`);
  lines.push(`- **Harness Version:** ${escapeMarkdownCell(HARNESS_VERSION)}`);
  lines.push("");
  return lines.join("\n");
}

export class MarkdownReporter implements AggregateReporter {
  constructor(private outputPath: string) {}

  onMultiTrialComplete(result: MultiTrialResult): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    const body = `${multiTrialMarkdown(result)}\n${provenanceMarkdown(result)}`;
    writeFileSync(this.outputPath, body, "utf8");
  }

  onMatrixComplete(result: MatrixResult): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    const body = `${matrixMarkdown(result, { includePerSampleBreakdown: true })}\n${provenanceMarkdown(result)}`;
    writeFileSync(this.outputPath, body, "utf8");
  }
}
