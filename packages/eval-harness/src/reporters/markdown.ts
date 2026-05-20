import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reporter } from "../registry.js";
import type { CheckResult } from "../types.js";
import {
  checkCounts,
  markdownEscape,
  passRate,
  redactForArtifact,
  runOutputDirectory,
  scenarioReportEntries,
  truncate,
  writeSummaryJson
} from "./output.js";

export const markdownReporter: Reporter = {
  async emit(result, options) {
    const reportsDir = runOutputDirectory(result, options);
    await mkdir(reportsDir, { recursive: true });
    await writeSummaryJson(result, options);

    const entries = scenarioReportEntries(result);
    await Promise.all(entries.map(async (entry) => {
      const scenarioDir = join(reportsDir, "scenarios", entry.directoryName);
      await mkdir(scenarioDir, { recursive: true });
      await Promise.all([
        writeFile(join(scenarioDir, "result.json"), `${JSON.stringify(redactForArtifact(entry.result), null, 2)}\n`),
        writeFile(join(scenarioDir, "cms-events.json"), `${JSON.stringify(redactForArtifact(entry.result.observed.cmsEvents), null, 2)}\n`),
        writeFile(join(scenarioDir, "tool-calls.json"), `${JSON.stringify(redactForArtifact(entry.result.observed.toolCalls), null, 2)}\n`),
        writeFile(join(scenarioDir, "agent-sessions.json"), `${JSON.stringify(redactForArtifact(agentSessionSummary(entry)), null, 2)}\n`),
        writeFile(join(scenarioDir, "timeline.md"), scenarioTimelineMarkdown(entry)),
        writeFile(join(scenarioDir, "transcript.md"), scenarioTranscriptMarkdown(entry)),
        writeFile(join(scenarioDir, "README.md"), scenarioMarkdown(entry)),
      ]);
    }));

    const failureRows = entries
      .filter((entry) => entry.status === "FAIL" || entry.status === "INFRA ERROR")
      .map((entry) => `| [${markdownEscape(entry.result.scenarioId)}](scenarios/${entry.directoryName}/README.md) | ${entry.status} | ${markdownEscape(truncate(entry.result.failureMessage, 220))} |`);
    const scenarioRows = entries.map((entry) => {
      const counts = checkCounts(entry.result);
      return `| [${markdownEscape(entry.result.scenarioId)}](scenarios/${entry.directoryName}/README.md) | ${markdownEscape(entry.result.kind)} | ${entry.status} | ${counts.passed}/${entry.result.checks.length} | ${formatMs(entry.result.observed.latencyMs)} | ${formatUsd(entry.result.observed.costUsd)} | ${markdownEscape(truncate(entry.result.failureMessage, 160))} |`;
    });

    await Promise.all([
      writeFile(join(reportsDir, "README.md"), [
        `# Eval Results ${result.runId}`,
        "",
        "Start with [REPORT.md](REPORT.md). Machine-readable summaries live in `summary.json` and `machine/results.jsonl`.",
        "",
      ].join("\n")),
      writeFile(join(reportsDir, "REPORT.md"), [
        `# Eval Run ${result.runId}`,
        "",
        `Generated: \`${options?.generatedAt ?? result.finishedAt ?? new Date().toISOString()}\``,
        result.startedAt ? `Started: \`${result.startedAt}\`` : undefined,
        result.finishedAt ? `Finished: \`${result.finishedAt}\`` : undefined,
        typeof result.durationMs === "number" ? `Duration: ${formatMs(result.durationMs)}` : undefined,
        "",
        "## Contents",
        "",
        "- [Top-Line Summary](#top-line-summary)",
        "- [Failure Triage](#failure-triage)",
        "- [Scenario Index](#scenario-index)",
        "- [Budget](#budget)",
        "- [File Layout](#file-layout)",
        "- [How To Read This](#how-to-read-this)",
        "",
        "## Top-Line Summary",
        "",
        `Pass rate: ${formatPercent(passRate(result))}`,
        "",
        "| Metric | Value |",
        "|---|---:|",
        `| Discovered scenario definitions | ${result.configuration.discoveredScenarioCount} |`,
        `| Execution cells | ${result.configuration.executionCellCount} |`,
        `| Passed | ${result.passed} |`,
        `| Failed | ${result.failed} |`,
        `| Infra errors | ${result.infraErrors} |`,
        `| Skipped | ${result.skipped} |`,
        "",
        "## Failure Triage",
        "",
        failureRows.length > 0
          ? [
            "| Scenario | Status | First failure |",
            "|---|---|---|",
            ...failureRows,
          ].join("\n")
          : "No failing scenarios.",
        "",
        "## Scenario Index",
        "",
        "| Scenario | Kind | Status | Checks | Latency | Cost | Notes |",
        "|---|---|---|---:|---:|---:|---|",
        ...scenarioRows,
        "",
        "## Budget",
        "",
        "| Budget | Spent |",
        "|---|---:|",
        `| LLM judge | ${formatUsd(result.budget.llmJudgeSpentUsd)} |`,
        `| Trajectory summary | ${formatUsd(result.budget.trajectorySummaryCostUsd)} |`,
        "",
        "## File Layout",
        "",
        "| Path | Purpose |",
        "|---|---|",
        "| `REPORT.md` | Human-readable run report. |",
        "| `summary.json` | Compact machine-readable run summary. |",
        "| `run-config.json` | Redacted effective run configuration and CLI overrides. |",
        "| `machine/results.jsonl` | One JSON object per scenario, suitable for ingestion. |",
        "| `scenarios/<scenario>/README.md` | Human-readable drill-down for one scenario. |",
        "| `scenarios/<scenario>/result.json` | Redacted scenario result including observed events/checks. |",
        "| `scenarios/<scenario>/timeline.md` | Manual-review CMS event timeline. |",
        "| `scenarios/<scenario>/transcript.md` | User/assistant/system transcript reconstructed from CMS events. |",
        "| `scenarios/<scenario>/cms-events.json` | Redacted raw CMS events. |",
        "| `scenarios/<scenario>/tool-calls.json` | Redacted observed tool calls. |",
        "| `scenarios/<scenario>/agent-sessions.json` | Session/agent event summary derived from CMS events. |",
        "",
        "## How To Read This",
        "",
        "1. Start with Top-Line Summary to decide whether the run is healthy.",
        "2. If anything failed, use Failure Triage first; it only lists scenarios needing attention.",
        "3. Use Scenario Index to compare all cases and open the per-scenario README for details.",
        "4. Use `summary.json` or `machine/results.jsonl` for scripts, dashboards, and trend ingestion.",
        "",
      ].filter((line): line is string => typeof line === "string").join("\n")),
    ]);
  }
};

function scenarioMarkdown(entry: ReturnType<typeof scenarioReportEntries>[number]): string {
  const scenario = entry.result;
  const counts = checkCounts(scenario);
  const checkRows = scenario.checks.map((check, index) => (
    `| ${index + 1} | ${checkStatus(check)} | ${markdownEscape(truncate(check.message, 240))} | ${markdownEscape(checkDetail(check))} |`
  ));

  return [
    `# ${scenario.scenarioId}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Status | ${entry.status} |`,
    `| Kind | ${markdownEscape(scenario.kind)} |`,
    `| Latency | ${formatMs(scenario.observed.latencyMs)} |`,
    `| Cost | ${formatUsd(scenario.observed.costUsd)} |`,
    `| Terminal state | ${markdownEscape(scenario.observed.terminalState ?? "")} |`,
    `| Checks passed | ${counts.passed}/${scenario.checks.length} |`,
    "",
    "## Failure",
    "",
    scenario.failureMessage ? markdownEscape(scenario.failureMessage) : "No failure.",
    "",
    "## Checks",
    "",
    checkRows.length > 0
      ? [
        "| # | Status | Message | Detail |",
        "|---:|---|---|---|",
        ...checkRows,
      ].join("\n")
      : "No checks were configured.",
    "",
    ...llmJudgeMarkdown(scenario.checks),
    "## Final Response",
    "",
    "```text",
    truncate(scenario.observed.finalResponse, 2000),
    "```",
    "",
    "## Observed Activity",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Tool calls | ${scenario.observed.toolCalls.length} |`,
    `| CMS events | ${scenario.observed.cmsEvents.length} |`,
    `| Tokens in | ${scenario.observed.tokensIn} |`,
    `| Tokens out | ${scenario.observed.tokensOut} |`,
    "",
    "## Review Artifacts",
    "",
    "- [timeline.md](timeline.md): CMS event timeline for manual review.",
    "- [transcript.md](transcript.md): reconstructed session transcript.",
    "- [cms-events.json](cms-events.json): redacted raw CMS event stream.",
    "- [tool-calls.json](tool-calls.json): redacted observed tool calls.",
    "- [agent-sessions.json](agent-sessions.json): session/agent event summary.",
    "- [result.json](result.json): full redacted scenario result.",
    "",
  ].join("\n");
}

type JudgeMetadata = {
  provider?: unknown;
  model?: unknown;
  verdict?: unknown;
  confidence?: unknown;
  reason?: unknown;
  evidence?: unknown;
  issues?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
};

function checkStatus(check: CheckResult): string {
  const judge = judgeMetadata(check);
  const verdict = typeof judge?.verdict === "string" ? judge.verdict : check.verdict;
  if (verdict === "PARTIAL") return "PARTIAL";
  if (verdict === "PASSED") return "PASS";
  if (verdict === "FAILED") return "FAIL";
  return check.errored ? "ERROR" : check.skipped ? "SKIP" : check.pass ? "PASS" : "FAIL";
}

function checkDetail(check: CheckResult): string {
  const judge = judgeMetadata(check);
  if (judge) {
    const verdict = typeof judge.verdict === "string" ? judge.verdict : check.verdict;
    const confidence = typeof judge.confidence === "string" ? judge.confidence : check.confidence;
    return [verdict, confidence ? `confidence ${confidence}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join(", ");
  }
  return "";
}

function llmJudgeMarkdown(checks: CheckResult[]): string[] {
  const judgeChecks = checks
    .map((check, index) => ({ check, index, judge: judgeMetadata(check) }))
    .filter((entry): entry is { check: CheckResult; index: number; judge: JudgeMetadata } => Boolean(entry.judge));
  if (judgeChecks.length === 0) return [];

  return [
    "## LLM Judge",
    "",
    ...judgeChecks.flatMap(({ check, index, judge }) => {
      const evidence = stringList(judge.evidence);
      const issues = stringList(judge.issues);
      return [
        `### Judge ${index + 1}`,
        "",
        "| Field | Value |",
        "|---|---|",
        `| Verdict | ${markdownEscape(judge.verdict ?? check.verdict ?? "")} |`,
        `| Confidence | ${markdownEscape(judge.confidence ?? check.confidence ?? "")} |`,
        `| Provider | ${markdownEscape(judge.provider ?? "")} |`,
        `| Model | ${markdownEscape(judge.model ?? "")} |`,
        `| Tokens | ${markdownEscape(tokenSummary(judge))} |`,
        "",
        "#### Reason",
        "",
        String(judge.reason ?? check.message),
        "",
        "#### Evidence",
        "",
        evidence.length > 0 ? evidence.map((item) => `- ${markdownEscape(item)}`).join("\n") : "No evidence listed.",
        "",
        "#### Issues",
        "",
        issues.length > 0 ? issues.map((item) => `- ${markdownEscape(item)}`).join("\n") : "No issues listed.",
        "",
      ];
    }),
  ];
}

function judgeMetadata(check: CheckResult): JudgeMetadata | undefined {
  const judge = check.metadata?.judge;
  return judge && typeof judge === "object" && !Array.isArray(judge)
    ? judge as JudgeMetadata
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function tokenSummary(judge: JudgeMetadata): string {
  const parts = [
    typeof judge.promptTokens === "number" ? `prompt ${judge.promptTokens}` : undefined,
    typeof judge.completionTokens === "number" ? `completion ${judge.completionTokens}` : undefined,
    typeof judge.totalTokens === "number" ? `total ${judge.totalTokens}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(", ") : "";
}

function scenarioTimelineMarkdown(entry: ReturnType<typeof scenarioReportEntries>[number]): string {
  const events = entry.result.observed.cmsEvents;
  const rows = events.map((event, index) => {
    const metadata = redactForArtifact(event.metadata ?? {});
    return `| ${index + 1} | ${markdownEscape(event.timestamp ?? "")} | ${markdownEscape(shortSessionId(event.sessionId))} | ${markdownEscape(event.type)} | ${markdownEscape(eventSummary(metadata))} |`;
  });

  return [
    `# ${entry.result.scenarioId} Timeline`,
    "",
    events.length > 0
      ? [
        "| # | Timestamp | Session | Event | Summary |",
        "|---:|---|---|---|---|",
        ...rows,
      ].join("\n")
      : "No CMS events were captured.",
    "",
  ].join("\n");
}

function scenarioTranscriptMarkdown(entry: ReturnType<typeof scenarioReportEntries>[number]): string {
  const transcriptEvents = entry.result.observed.cmsEvents.filter((event) => (
    event.type === "user.message"
    || event.type === "assistant.message"
    || event.type === "system.message"
  ));
  const blocks = transcriptEvents.map((event, index) => {
    const metadata = event.metadata ?? {};
    const content = String(metadata.content ?? "");
    return [
      `## ${index + 1}. ${event.type}${event.sessionId ? ` (${shortSessionId(event.sessionId)})` : ""}`,
      "",
      metadata.phase ? `Phase: \`${markdownEscape(metadata.phase)}\`` : undefined,
      "",
      "```text",
      truncate(content, 4000),
      "```",
      "",
    ].filter((line): line is string => typeof line === "string").join("\n");
  });

  return [
    `# ${entry.result.scenarioId} Transcript`,
    "",
    blocks.length > 0 ? blocks.join("\n") : "No transcript events were captured.",
  ].join("\n");
}

function agentSessionSummary(entry: ReturnType<typeof scenarioReportEntries>[number]): Array<Record<string, unknown>> {
  const sessions = new Map<string, {
    sessionId: string;
    events: number;
    eventTypes: Set<string>;
    toolCalls: string[];
    messages: number;
  }>();

  for (const event of entry.result.observed.cmsEvents) {
    const sessionId = event.sessionId ?? "unknown";
    const existing = sessions.get(sessionId) ?? {
      sessionId,
      events: 0,
      eventTypes: new Set<string>(),
      toolCalls: [],
      messages: 0,
    };
    existing.events += 1;
    existing.eventTypes.add(event.type);
    if (event.type.endsWith(".message")) existing.messages += 1;
    if (event.type === "tool.execution_start") {
      const toolName = event.metadata?.toolName ?? event.metadata?.name;
      if (toolName) existing.toolCalls.push(String(toolName));
    }
    sessions.set(sessionId, existing);
  }

  return [...sessions.values()].map((session) => ({
    sessionId: session.sessionId,
    events: session.events,
    messages: session.messages,
    eventTypes: [...session.eventTypes].sort(),
    toolCalls: session.toolCalls,
  }));
}

function eventSummary(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  if (typeof metadata.content === "string") return truncate(metadata.content, 160);
  if (typeof metadata.message === "string") return truncate(metadata.message, 160);
  if (metadata.toolName) return `${metadata.toolName}${metadata.arguments ? ` ${truncate(JSON.stringify(metadata.arguments), 120)}` : ""}`;
  if (metadata.intent) return `intent: ${metadata.intent}`;
  if (metadata.seconds) return `seconds: ${metadata.seconds}`;
  if (metadata.iteration != null) return `iteration: ${metadata.iteration}`;
  if (metadata.state) return `state: ${metadata.state}`;
  const compact = JSON.stringify(metadata);
  return compact === "{}" ? "" : truncate(compact, 160);
}

function shortSessionId(sessionId?: string): string {
  if (!sessionId) return "";
  return sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}
