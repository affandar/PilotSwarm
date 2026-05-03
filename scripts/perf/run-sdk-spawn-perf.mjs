import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const sdkDir = path.join(repoRoot, "packages", "sdk");
const vitestPath = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const reportDir = path.join(repoRoot, "perf", "reports", "spawn");
const historyDir = path.join(reportDir, "history");
const latestJsonPath = path.join(reportDir, "latest.json");
const latestMarkdownPath = path.join(reportDir, "latest.md");
const historyIndexPath = path.join(historyDir, "index.json");
const memoryDir = path.join(repoRoot, "perf", "memory");
const memoryPath = path.join(memoryDir, "perf-agent-memory.md");

function runGit(args) {
    try {
        return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

function loadJsonIfExists(filePath) {
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function toMs(secondsText) {
    if (!secondsText) return null;
    const parsed = Number.parseFloat(secondsText);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 1000);
}

function extractPerfEntries(outputText) {
    const entries = {};
    const lines = outputText.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/\[perf:([^\]]+)\]\s+(\{.*\})/);
        if (!match) continue;
        try {
            entries[match[1]] = JSON.parse(match[2]);
        } catch {}
    }
    return entries;
}

function pickMetric(metrics, key) {
    if (!metrics || typeof metrics !== "object") return null;
    const value = metrics[key];
    return typeof value === "number" ? value : null;
}

function summarize(entries) {
    const single = entries["single"] ?? null;
    const sequentialTurn1 = entries["sequential-turn-1"] ?? null;
    const sequentialTurn2 = entries["sequential-turn-2"] ?? null;
    const sequentialTurn3 = entries["sequential-turn-3"] ?? null;
    const sequentialTotal = entries["sequential-total"] ?? null;
    const sameTurnFanout = entries["same-turn-fanout"] ?? null;

    const summary = {
        single: single
            ? {
                turnMs: single.turnMs ?? null,
                child1VisibleMs: pickMetric(single.visibleAtMs, "1"),
                child1StartedMs: pickMetric(single.startedAtMs, "1"),
                spawnToolCalls: single.spawnToolCalls ?? null,
            }
            : null,
        sequential: {
            turns: [sequentialTurn1, sequentialTurn2, sequentialTurn3]
                .filter(Boolean)
                .map((entry, index) => ({
                    label: `turn-${index + 1}`,
                    turnMs: entry.turnMs ?? null,
                    child1VisibleMs: pickMetric(entry.visibleAtMs, "1"),
                    child1StartedMs: pickMetric(entry.startedAtMs, "1"),
                })),
            total: sequentialTotal
                ? {
                    totalMs: sequentialTotal.totalMs ?? null,
                    childCount: sequentialTotal.childCount ?? null,
                    spawnToolCalls: sequentialTotal.spawnToolCalls ?? null,
                }
                : null,
        },
        sameTurnFanout: sameTurnFanout
            ? {
                turnMs: sameTurnFanout.turnMs ?? null,
                child1VisibleMs: pickMetric(sameTurnFanout.visibleAtMs, "1"),
                child2VisibleMs: pickMetric(sameTurnFanout.visibleAtMs, "2"),
                child3VisibleMs: pickMetric(sameTurnFanout.visibleAtMs, "3"),
                child1StartedMs: pickMetric(sameTurnFanout.startedAtMs, "1"),
                child2StartedMs: pickMetric(sameTurnFanout.startedAtMs, "2"),
                child3StartedMs: pickMetric(sameTurnFanout.startedAtMs, "3"),
                visibleSpanMs: sameTurnFanout.visibleAtMs
                    ? pickMetric(sameTurnFanout.visibleAtMs, "3") - pickMetric(sameTurnFanout.visibleAtMs, "1")
                    : null,
                startedSpanMs: sameTurnFanout.startedAtMs
                    ? pickMetric(sameTurnFanout.startedAtMs, "3") - pickMetric(sameTurnFanout.startedAtMs, "1")
                    : null,
                spawnToolCalls: sameTurnFanout.spawnToolCalls ?? null,
            }
            : null,
    };

    return summary;
}

function compareNumbers(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    return current - previous;
}

function buildComparison(currentSummary, previousSummary) {
    if (!previousSummary) return null;
    return {
        single: currentSummary.single && previousSummary.single
            ? {
                turnMsDelta: compareNumbers(currentSummary.single.turnMs, previousSummary.single.turnMs),
                child1VisibleMsDelta: compareNumbers(currentSummary.single.child1VisibleMs, previousSummary.single.child1VisibleMs),
                child1StartedMsDelta: compareNumbers(currentSummary.single.child1StartedMs, previousSummary.single.child1StartedMs),
            }
            : null,
        sequentialTotal: currentSummary.sequential?.total && previousSummary.sequential?.total
            ? {
                totalMsDelta: compareNumbers(currentSummary.sequential.total.totalMs, previousSummary.sequential.total.totalMs),
            }
            : null,
        sameTurnFanout: currentSummary.sameTurnFanout && previousSummary.sameTurnFanout
            ? {
                turnMsDelta: compareNumbers(currentSummary.sameTurnFanout.turnMs, previousSummary.sameTurnFanout.turnMs),
                child1VisibleMsDelta: compareNumbers(currentSummary.sameTurnFanout.child1VisibleMs, previousSummary.sameTurnFanout.child1VisibleMs),
                child3VisibleMsDelta: compareNumbers(currentSummary.sameTurnFanout.child3VisibleMs, previousSummary.sameTurnFanout.child3VisibleMs),
                visibleSpanMsDelta: compareNumbers(currentSummary.sameTurnFanout.visibleSpanMs, previousSummary.sameTurnFanout.visibleSpanMs),
                startedSpanMsDelta: compareNumbers(currentSummary.sameTurnFanout.startedSpanMs, previousSummary.sameTurnFanout.startedSpanMs),
            }
            : null,
    };
}

function formatValue(value) {
    return Number.isFinite(value) ? `${value} ms` : "-";
}

function formatDelta(value) {
    if (!Number.isFinite(value)) return "-";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value} ms`;
}

function formatPercent(value) {
    if (!Number.isFinite(value)) return "-";
    return `${value.toFixed(1)}%`;
}

function average(values) {
    const numbers = values.filter((value) => Number.isFinite(value));
    if (numbers.length === 0) return null;
    return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function takeLastRuns(historyIndex, limit = 5) {
    const runs = Array.isArray(historyIndex?.runs) ? historyIndex.runs : [];
    return runs.slice(-limit).reverse();
}

function buildFindingLines(summary) {
    const lines = [];
    const single = summary.single;
    const sequential = summary.sequential;
    const sameTurn = summary.sameTurnFanout;
    const sequentialWarmAverage = average(
        (sequential?.turns ?? []).slice(1).map((turn) => turn.turnMs),
    );

    if (single?.turnMs != null && single?.child1VisibleMs != null && single?.child1StartedMs != null) {
        lines.push(
            `Single spawn baseline: parent turn ${single.turnMs} ms; first child visible at ${single.child1VisibleMs} ms and started at ${single.child1StartedMs} ms.`,
        );
    }

    if (sequential?.total?.totalMs != null && sameTurn?.turnMs != null) {
        const savedMs = sequential.total.totalMs - sameTurn.turnMs;
        const savedPct = sequential.total.totalMs > 0
            ? (savedMs / sequential.total.totalMs) * 100
            : null;
        lines.push(
            `Three children in one parent turn completed ${savedMs} ms faster than three sequential parent turns (${formatPercent(savedPct)} improvement in total parent time).`,
        );
    }

    if (sequential?.turns?.[0]?.turnMs != null && sequentialWarmAverage != null) {
        const coldPenaltyMs = sequential.turns[0].turnMs - sequentialWarmAverage;
        lines.push(
            `Sequential turn 1 was ${coldPenaltyMs} ms slower than the average of turns 2 and 3, which suggests a meaningful first-spawn cold-start penalty.`,
        );
    }

    if (sameTurn?.visibleSpanMs != null && sameTurn?.startedSpanMs != null) {
        lines.push(
            `In same-turn fanout, children became visible within ${sameTurn.visibleSpanMs} ms and started within ${sameTurn.startedSpanMs} ms once creation began.`,
        );
    }

    return lines.length > 0 ? lines : ["No confirmed findings were derived from the latest report."];
}

function buildHypothesisLines() {
    return [
        "The current activity-mediated child creation path is still likely adding overhead before the child orchestration begins useful work.",
        "Same-turn multi-spawn requests are likely leaving time on the table because child creation is still replayed sequentially instead of being batched or fanned out in parallel.",
    ];
}

function buildNextStepLines() {
    return [
        "Instrument the spawn path more finely to separate parent orchestration replay time, activity dispatch time, child bootstrap time, and child orchestration start time.",
        "Prototype direct fire-and-forget child orchestration starts from the parent orchestration and rerun `npm run perf:spawn`.",
        "Prototype batched or parallel handling for same-turn multiple `spawn_agent` calls and compare the new same-turn fanout numbers against the current baseline.",
    ];
}

function renderRecentRuns(historyIndex) {
    const recentRuns = takeLastRuns(historyIndex);
    if (recentRuns.length === 0) return ["- None yet."];
    return recentRuns.map((run) => {
        const gitLabel = run.git?.shortCommit ?? run.git?.commit ?? "(unknown)";
        const singleTurnMs = run.summary?.singleTurnMs ?? "-";
        const sequentialTotalMs = run.summary?.sequentialTotalMs ?? "-";
        const sameTurnTurnMs = run.summary?.sameTurnTurnMs ?? "-";
        return `- ${run.runAt} | ${gitLabel} | single: ${singleTurnMs} ms | sequential total: ${sequentialTotalMs} ms | same-turn fanout: ${sameTurnTurnMs} ms`;
    });
}

function renderMemory({ report, historyIndex, failure }) {
    const currentScopeLines = [
        "- Canonical perf surface: SDK sub-agent spawn performance.",
        "- Canonical runner: `npm run perf:spawn`",
        "- Canonical generated outputs:",
        "  - `perf/reports/spawn/latest.json`",
        "  - `perf/reports/spawn/latest.md`",
        "  - `perf/reports/spawn/history/index.json`",
    ];

    const latestRunLines = failure
        ? [
            "- Status: Failed",
            `- Command: \`${failure.command}\``,
            `- Timestamp: ${failure.runAt}`,
            `- Git commit: ${failure.git.commit ?? "(unknown)"}`,
            `- Git branch: ${failure.git.branch ?? "(unknown)"}`,
            `- Dirty worktree: ${failure.git.dirty ? "yes" : "no"}`,
            `- Failure: ${failure.message}`,
            `- Raw log: \`${failure.rawLog}\``,
        ]
        : [
            "- Status: Passed",
            `- Command: \`${report.command}\``,
            `- Timestamp: ${report.runAt}`,
            `- Git commit: ${report.git.commit ?? "(unknown)"}`,
            `- Git branch: ${report.git.branch ?? "(unknown)"}`,
            `- Dirty worktree: ${report.git.dirty ? "yes" : "no"}`,
            `- Suite duration: ${report.suite.durationMs != null ? `${report.suite.durationMs} ms` : "(unknown)"}`,
            `- Latest report: \`${report.files.markdown}\``,
            `- Latest metrics: \`${path.relative(repoRoot, latestJsonPath)}\``,
        ];

    const findings = failure
        ? [
            "The latest canonical run failed, so no new performance baseline was confirmed.",
            "Use the raw log above to unblock the runner before trusting any older conclusions.",
        ]
        : buildFindingLines(report.summary);

    const hypotheses = buildHypothesisLines();
    const nextSteps = failure
        ? [
            "Fix the failing canonical runner or its environment and rerun `npm run perf:spawn`.",
            "Once the runner passes again, regenerate the latest report and refresh this memory file.",
        ]
        : buildNextStepLines();

    const openQuestions = failure
        ? ["- What environment or dependency failure blocked the canonical spawn perf run?"]
        : [
            "- How much of the first-spawn penalty is in orchestration replay and activity dispatch versus child-side bootstrap work?",
            "- How much same-turn fanout improvement is available once child creation is actually parallelized?",
        ];

    const lines = [
        "# Perf Agent Memory",
        "",
        "This file is maintained by the canonical spawn perf runner and the repo-local `pilotswarm-perf` agent in [.github/agents/pilotswarm-perf.agent.md](../../.github/agents/pilotswarm-perf.agent.md).",
        "",
        "The runner rewrites this file after every canonical spawn perf run so the latest numbers, findings, and next steps stay in-repo.",
        "",
        "## Current Scope",
        "",
        ...currentScopeLines,
        "",
        "## Latest Confirmed Run",
        "",
        ...latestRunLines,
        "",
        "## Recent Run History",
        "",
        ...renderRecentRuns(historyIndex),
        "",
        "## Confirmed Findings",
        "",
        ...findings.map((line) => `- ${line}`),
        "",
        "## Active Hypotheses",
        "",
        ...hypotheses.map((line) => `- ${line}`),
        "",
        "## Next Steps",
        "",
        ...nextSteps.map((line) => `- ${line}`),
        "",
        "## Open Questions",
        "",
        ...openQuestions,
        "",
    ];

    return `${lines.join("\n")}\n`;
}

function renderMarkdown(report) {
    const single = report.summary.single;
    const sequentialTurns = report.summary.sequential.turns;
    const sequentialTotal = report.summary.sequential.total;
    const sameTurn = report.summary.sameTurnFanout;
    const comparison = report.comparisonToPrevious;

    const lines = [
        "# Spawn Perf Report",
        "",
        `- Run at: ${report.runAt}`,
        `- Command: \`${report.command}\``,
        `- Git commit: ${report.git.commit ?? "(unknown)"}`,
        `- Git branch: ${report.git.branch ?? "(unknown)"}`,
        `- Dirty worktree: ${report.git.dirty ? "yes" : "no"}`,
        `- Suite duration: ${report.suite.durationMs != null ? `${report.suite.durationMs} ms` : "(unknown)"}`,
        "",
        "## Scenario Summary",
        "",
        "| Scenario | Parent Turn | Child Visible | Child Started | Notes |",
        "| --- | ---: | ---: | ---: | --- |",
        `| Single spawn | ${formatValue(single?.turnMs)} | ${formatValue(single?.child1VisibleMs)} | ${formatValue(single?.child1StartedMs)} | spawn_agent calls: ${single?.spawnToolCalls ?? "-"} |`,
    ];

    for (const turn of sequentialTurns) {
        lines.push(
            `| Sequential ${turn.label} | ${formatValue(turn.turnMs)} | ${formatValue(turn.child1VisibleMs)} | ${formatValue(turn.child1StartedMs)} | single child in one parent turn |`,
        );
    }

    lines.push(
        `| Sequential total | ${formatValue(sequentialTotal?.totalMs)} | - | - | child count: ${sequentialTotal?.childCount ?? "-"}, spawn_agent calls: ${sequentialTotal?.spawnToolCalls ?? "-"} |`,
        `| Same-turn fanout | ${formatValue(sameTurn?.turnMs)} | ${formatValue(sameTurn?.child1VisibleMs)} -> ${formatValue(sameTurn?.child3VisibleMs)} | ${formatValue(sameTurn?.child1StartedMs)} -> ${formatValue(sameTurn?.child3StartedMs)} | visible span: ${formatValue(sameTurn?.visibleSpanMs)}, started span: ${formatValue(sameTurn?.startedSpanMs)} |`,
        "",
    );

    if (comparison) {
        lines.push(
            "## Comparison To Previous Latest",
            "",
            "| Scenario | Turn Delta | First Child Visible Delta | Extra |",
            "| --- | ---: | ---: | --- |",
            `| Single spawn | ${formatDelta(comparison.single?.turnMsDelta)} | ${formatDelta(comparison.single?.child1VisibleMsDelta)} | first child started delta: ${formatDelta(comparison.single?.child1StartedMsDelta)} |`,
            `| Sequential total | ${formatDelta(comparison.sequentialTotal?.totalMsDelta)} | - | - |`,
            `| Same-turn fanout | ${formatDelta(comparison.sameTurnFanout?.turnMsDelta)} | ${formatDelta(comparison.sameTurnFanout?.child1VisibleMsDelta)} | child3 visible delta: ${formatDelta(comparison.sameTurnFanout?.child3VisibleMsDelta)}, visible span delta: ${formatDelta(comparison.sameTurnFanout?.visibleSpanMsDelta)}, started span delta: ${formatDelta(comparison.sameTurnFanout?.startedSpanMsDelta)} |`,
            "",
        );
    }

    lines.push(
        "## Raw Artifacts",
        "",
        `- Latest metrics JSON: \`perf/reports/spawn/latest.json\``,
        `- History index: \`perf/reports/spawn/history/index.json\``,
        `- This run log: \`${report.files.rawLog}\``,
        `- This run JSON: \`${report.files.json}\``,
        "",
        "## Notes",
        "",
        "- `latest.md` is generated by `scripts/perf/run-sdk-spawn-perf.mjs` and should not be edited by hand.",
        "- Durable conclusions and next steps belong in `perf/memory/perf-agent-memory.md`.",
        "",
    );

    return lines.join("\n");
}

async function writeJson(filePath, value) {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
    await writeFile(filePath, value, "utf8");
}

async function writeMemoryFile({ report = null, historyIndex = null, failure = null }) {
    await mkdir(memoryDir, { recursive: true });
    const safeHistoryIndex = historyIndex ?? loadJsonIfExists(historyIndexPath) ?? {
        schemaVersion: 1,
        kind: "spawn-perf-history-index",
        updatedAt: null,
        runs: [],
    };
    const memoryText = renderMemory({ report, historyIndex: safeHistoryIndex, failure });
    await writeText(memoryPath, memoryText);
}

async function main() {
    await mkdir(historyDir, { recursive: true });

    const runAt = new Date().toISOString();
    const runId = runAt.replace(/[:.]/g, "-");
    const rawLogPath = path.join(historyDir, `${runId}.log`);
    const jsonPath = path.join(historyDir, `${runId}.json`);
    const markdownPath = path.join(historyDir, `${runId}.md`);
    const relativeRawLogPath = path.relative(repoRoot, rawLogPath);
    const relativeJsonPath = path.relative(repoRoot, jsonPath);

    const previousLatest = loadJsonIfExists(latestJsonPath);

    const commandArgs = [
        vitestPath,
        "--config",
        "vitest.perf.config.js",
        "run",
        "test/perf/spawn.perf.test.js",
        "--reporter=verbose",
    ];
    const commandText = "npm run perf:spawn";

    const child = spawn(process.execPath, commandArgs, {
        cwd: sdkDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
    });

    const exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
    });

    const combinedOutput = `${stdout}${stderr ? `\n${stderr}` : ""}`;
    await writeText(rawLogPath, combinedOutput);

    if (exitCode !== 0) {
        await writeMemoryFile({
            failure: {
                runAt,
                command: commandText,
                git: {
                    commit: runGit(["rev-parse", "HEAD"]),
                    shortCommit: runGit(["rev-parse", "--short", "HEAD"]),
                    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
                    dirty: Boolean(runGit(["status", "--short"])),
                },
                message: `Spawn perf run failed with exit code ${exitCode}.`,
                rawLog: relativeRawLogPath,
            },
        });
        throw new Error(
            `Spawn perf run failed with exit code ${exitCode}. Raw log saved to ${relativeRawLogPath}.`,
        );
    }

    const perfEntries = extractPerfEntries(combinedOutput);
    if (Object.keys(perfEntries).length === 0) {
        await writeMemoryFile({
            failure: {
                runAt,
                command: commandText,
                git: {
                    commit: runGit(["rev-parse", "HEAD"]),
                    shortCommit: runGit(["rev-parse", "--short", "HEAD"]),
                    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
                    dirty: Boolean(runGit(["status", "--short"])),
                },
                message: "Spawn perf run completed but no [perf:*] summaries were found.",
                rawLog: relativeRawLogPath,
            },
        });
        throw new Error(`Spawn perf run completed but no [perf:*] summaries were found. Raw log: ${relativeRawLogPath}`);
    }

    const durationMatch = combinedOutput.match(/Duration\s+([\d.]+)s/);
    const summary = summarize(perfEntries);
    const comparisonToPrevious = buildComparison(summary, previousLatest?.summary ?? null);
    const report = {
        schemaVersion: 1,
        kind: "spawn-perf-report",
        surface: "sdk-spawn",
        status: "passed",
        runAt,
        command: commandText,
        git: {
            commit: runGit(["rev-parse", "HEAD"]),
            shortCommit: runGit(["rev-parse", "--short", "HEAD"]),
            branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
            dirty: Boolean(runGit(["status", "--short"])),
        },
        suite: {
            durationMs: toMs(durationMatch?.[1] ?? null),
        },
        metrics: perfEntries,
        summary,
        comparisonToPrevious,
        files: {
            rawLog: relativeRawLogPath,
            json: relativeJsonPath,
            markdown: path.relative(repoRoot, markdownPath),
        },
    };

    const markdown = renderMarkdown(report);

    await writeJson(jsonPath, report);
    await writeText(markdownPath, `${markdown}\n`);
    await writeJson(latestJsonPath, report);
    await writeText(latestMarkdownPath, `${markdown}\n`);

    const historyIndex = existsSync(historyIndexPath)
        ? JSON.parse(await readFile(historyIndexPath, "utf8"))
        : {
            schemaVersion: 1,
            kind: "spawn-perf-history-index",
            updatedAt: null,
            runs: [],
        };

    historyIndex.updatedAt = runAt;
    historyIndex.runs.push({
        id: runId,
        runAt,
        git: report.git,
        suiteDurationMs: report.suite.durationMs,
        summary: {
            singleTurnMs: summary.single?.turnMs ?? null,
            singleChild1VisibleMs: summary.single?.child1VisibleMs ?? null,
            sequentialTotalMs: summary.sequential?.total?.totalMs ?? null,
            sameTurnTurnMs: summary.sameTurnFanout?.turnMs ?? null,
            sameTurnVisibleSpanMs: summary.sameTurnFanout?.visibleSpanMs ?? null,
            sameTurnStartedSpanMs: summary.sameTurnFanout?.startedSpanMs ?? null,
        },
        files: report.files,
    });

    await writeJson(historyIndexPath, historyIndex);
    await writeMemoryFile({ report, historyIndex });

    console.log(`\nGenerated spawn perf report: ${path.relative(repoRoot, latestMarkdownPath)}`);
    console.log(`Generated spawn perf metrics: ${path.relative(repoRoot, latestJsonPath)}`);
    console.log(`Updated perf memory: ${path.relative(repoRoot, memoryPath)}`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
