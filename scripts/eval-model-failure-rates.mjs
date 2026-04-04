#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sdkDir = path.join(rootDir, "packages", "sdk");
const reportDir = path.join(rootDir, "perf", "reports");
const timestamp = new Date().toISOString().replace(/[:]/g, "-");
const runDir = path.join(reportDir, `model-evals-${timestamp}`);
const MODEL_FILTERS = process.argv
    .filter((arg) => arg.startsWith("--model="))
    .map((arg) => arg.slice("--model=".length));
const FILE_FILTERS = process.argv
    .filter((arg) => arg.startsWith("--file="))
    .map((arg) => arg.slice("--file=".length));
const RUNS_OVERRIDE = process.argv
    .find((arg) => arg.startsWith("--runs="));
const RUN_BY_FILE = process.argv.includes("--by-file");

const MODEL_TARGETS = [
    { label: "glm", qualifiedName: "azure-fw-glm-5:FW-GLM-5" },
    { label: "kimi", qualifiedName: "azure-kimi:Kimi-K2.5" },
    { label: "sonnet", qualifiedName: "github-copilot:claude-sonnet-4.6" },
    { label: "opus46", qualifiedName: "github-copilot:claude-opus-4.6" },
    { label: "gpt54", qualifiedName: "azure-openai:gpt-5.4" },
    { label: "gpt54-mini", qualifiedName: "azure-openai:gpt-5.4-mini" },
    { label: "gpt54-nano", qualifiedName: "azure-openai:gpt-5.4-nano" },
]
;

const DEFAULT_RUNS_PER_MODEL = 2;
const EVAL_EXCLUDED_FILES = new Set([
    "model-selection.test.js",
]);
const TIMEOUT_PATTERNS = [
    /timed out/i,
    /timeout waiting for response/i,
    /taking too long to process/i,
    /test timed out/i,
];

function loadEnvFileIfPresent() {
    const envFile = path.join(rootDir, ".env");
    if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) {
        process.loadEnvFile(envFile);
    }
}

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function collectEvalTestFiles(dirPath, baseDir = dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectEvalTestFiles(fullPath, baseDir));
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".test.js")) continue;
        files.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"));
    }

    return files.sort();
}

function isExcludedEvalFile(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    for (const excluded of EVAL_EXCLUDED_FILES) {
        if (normalized === excluded) return true;
        if (normalized.endsWith(`/${excluded}`)) return true;
    }
    return false;
}

function relativeToRoot(filePath) {
    return path.relative(rootDir, filePath) || filePath;
}

function classifyFailure(message) {
    return TIMEOUT_PATTERNS.some((pattern) => pattern.test(message)) ? "timeout" : "non-timeout";
}

function summarizeAssertion(assertion) {
    const fullName = assertion.fullName || assertion.title || "(unknown test)";
    const failureMessage = (assertion.failureMessages || []).join("\n\n").trim();
    return {
        fullName,
        title: assertion.title || fullName,
        classification: classifyFailure(failureMessage),
        failureMessage,
    };
}

function parseVitestReport(reportPath) {
    const raw = fs.readFileSync(reportPath, "utf-8");
    const parsed = JSON.parse(raw);
    const failures = [];

    for (const suite of parsed.testResults || []) {
        for (const assertion of suite.assertionResults || []) {
            if (assertion.status === "failed") {
                failures.push(summarizeAssertion(assertion));
            }
        }
    }

    return {
        numPassedTests: parsed.numPassedTests ?? 0,
        numFailedTests: parsed.numFailedTests ?? 0,
        numPendingTests: parsed.numPendingTests ?? 0,
        failures,
    };
}

function aggregateFailures(failures, classification) {
    const grouped = new Map();

    for (const failure of failures.filter((entry) => entry.classification === classification)) {
        const existing = grouped.get(failure.fullName) || {
            fullName: failure.fullName,
            count: 0,
            messages: new Set(),
        };
        existing.count += 1;
        if (failure.failureMessage) existing.messages.add(failure.failureMessage);
        grouped.set(failure.fullName, existing);
    }

    return [...grouped.values()]
        .sort((left, right) => right.count - left.count || left.fullName.localeCompare(right.fullName))
        .map((entry) => ({
            fullName: entry.fullName,
            count: entry.count,
            message: [...entry.messages][0] || "",
        }));
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function recomputeModelSummary(modelSummary) {
    const allFailures = modelSummary.runs.flatMap((run) => run.failures);
    modelSummary.executedTests = modelSummary.runs.reduce((sum, run) => sum + run.executedTests, 0);
    modelSummary.failedTests = modelSummary.runs.reduce((sum, run) => sum + run.failedTests, 0);
    modelSummary.timeoutFailures = modelSummary.runs.reduce((sum, run) => sum + run.timeoutFailures, 0);
    modelSummary.nonTimeoutFailures = modelSummary.runs.reduce((sum, run) => sum + run.nonTimeoutFailures, 0);
    modelSummary.failureRate = modelSummary.executedTests > 0
        ? modelSummary.failedTests / modelSummary.executedTests
        : 0;
    modelSummary.nonTimeoutFailureDetails = aggregateFailures(allFailures, "non-timeout");
}

function createTempProviderConfig(sourceConfig, defaultModel) {
    return {
        ...sourceConfig,
        defaultModel,
    };
}

function writeSummaryArtifacts(summary) {
    const jsonPath = path.join(runDir, "summary.json");
    const markdownPath = path.join(runDir, "summary.md");
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    fs.writeFileSync(markdownPath, buildMarkdownReport(summary));
    return { jsonPath, markdownPath };
}

function runCommand(command, args, options) {
    return new Promise((resolve) => {
        const child = spawn(command, args, options);
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

        child.on("close", (code, signal) => {
            resolve({ code: code ?? 1, signal, stdout, stderr });
        });
    });
}

function buildMarkdownReport(summary) {
    const lines = [
        "# Model Failure Rate Eval",
        "",
        `Generated: ${new Date().toISOString()}`,
        `Runs per model: ${summary.runsPerModel}`,
        `Execution mode: ${summary.executionMode}`,
        "Suite: packages/sdk local Vitest suite with single-model eval mode enabled",
        "",
        "Notes:",
        "- The runner forces fixture-selected models with PS_TEST_FORCE_MODEL so TEST_GPT_MODEL / TEST_CLAUDE_MODEL both use the eval target.",
        "- The dedicated multi-model suite model-selection.test.js is skipped during eval mode because it is not meaningful in a single-model sweep.",
        "- Default model selection is isolated per run via a temporary model_providers.json passed through PS_MODEL_PROVIDERS_PATH.",
        "",
        "| Model | Runs | Executed Tests | Failed Tests | Failure Rate | Timeout Failures | Non-timeout Failures |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ];

    for (const model of summary.models) {
        lines.push(
            `| ${model.label} | ${model.runs.length} | ${model.executedTests} | ${model.failedTests} | ${formatPercent(model.failureRate)} | ${model.timeoutFailures} | ${model.nonTimeoutFailures} |`,
        );
    }

    for (const model of summary.models) {
        lines.push("", `## ${model.label}`, "");
        lines.push(`Qualified model: ${model.qualifiedName}`);
        lines.push(`Executed tests: ${model.executedTests}`);
        lines.push(`Failed tests: ${model.failedTests}`);
        lines.push(`Failure rate: ${formatPercent(model.failureRate)}`);
        lines.push(`Timeout failures: ${model.timeoutFailures}`);
        lines.push(`Non-timeout failures: ${model.nonTimeoutFailures}`);
        lines.push("");

        lines.push("Per-run results:");
        for (const run of model.runs) {
            lines.push(`- Run ${run.runNumber}: executed=${run.executedTests}, failed=${run.failedTests}, timeout=${run.timeoutFailures}, non-timeout=${run.nonTimeoutFailures}, exitCode=${run.exitCode}`);
        }

        lines.push("");
        if (model.nonTimeoutFailureDetails.length === 0) {
            lines.push("Non-timeout failing tests: none");
        } else {
            lines.push("Non-timeout failing tests:");
            for (const failure of model.nonTimeoutFailureDetails) {
                lines.push(`- ${failure.fullName} (${failure.count} failure(s))`);
                if (failure.message) {
                    lines.push(`  Sample: ${failure.message.split("\n")[0]}`);
                }
            }
        }
    }

    return lines.join("\n");
}

async function main() {
    loadEnvFileIfPresent();
    ensureDirectory(runDir);

    const runsPerModel = RUNS_OVERRIDE ? Number(RUNS_OVERRIDE.slice("--runs=".length)) : DEFAULT_RUNS_PER_MODEL;
    if (!Number.isInteger(runsPerModel) || runsPerModel <= 0) {
        throw new Error(`Invalid --runs value: ${RUNS_OVERRIDE}`);
    }

    const sourceConfigPath = process.env.PS_MODEL_PROVIDERS_PATH
        || process.env.MODEL_PROVIDERS_PATH
        || path.join(rootDir, ".model_providers.json");

    if (!fs.existsSync(sourceConfigPath)) {
        throw new Error(`model provider config not found: ${sourceConfigPath}`);
    }

    console.log(`Using provider config: ${relativeToRoot(sourceConfigPath)}`);
    console.log(`Writing eval artifacts to: ${relativeToRoot(runDir)}`);

    const sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, "utf-8"));
    const localTestFiles = collectEvalTestFiles(path.join(sdkDir, "test", "local"))
        .filter((file) => !isExcludedEvalFile(file))
        .filter((file) => FILE_FILTERS.length === 0 || FILE_FILTERS.some((filter) => file.includes(filter)));

    const selectedTargets = MODEL_FILTERS.length === 0
        ? MODEL_TARGETS
        : MODEL_TARGETS.filter((target) =>
            MODEL_FILTERS.includes(target.label) || MODEL_FILTERS.includes(target.qualifiedName),
        );

    if (localTestFiles.length === 0) {
        throw new Error("No eval test files found after exclusions.");
    }
    if (selectedTargets.length === 0) {
        throw new Error(`No models matched filters: ${MODEL_FILTERS.join(", ")}`);
    }

    console.log("Building TypeScript once before model sweeps...");
    const buildResult = await runCommand("npm", ["run", "build"], {
        cwd: sdkDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (buildResult.code !== 0) {
        throw new Error(`TypeScript build failed with exit code ${buildResult.code}`);
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        runsPerModel,
        sourceConfigPath: relativeToRoot(sourceConfigPath),
        outputDir: relativeToRoot(runDir),
        executionMode: RUN_BY_FILE ? "by-file" : "full-suite",
        evalTestFiles: localTestFiles,
        models: [],
    };

    for (const target of selectedTargets) {
        console.log(`\n=== ${target.label} (${target.qualifiedName}) ===`);
        const modelConfigPath = path.join(runDir, `${target.label}.model_providers.json`);
        fs.writeFileSync(modelConfigPath, JSON.stringify(createTempProviderConfig(sourceConfig, target.qualifiedName), null, 2));

        const modelSummary = {
            label: target.label,
            qualifiedName: target.qualifiedName,
            runs: [],
            executedTests: 0,
            failedTests: 0,
            failureRate: 0,
            timeoutFailures: 0,
            nonTimeoutFailures: 0,
            nonTimeoutFailureDetails: [],
        };
        summary.models.push(modelSummary);
        writeSummaryArtifacts(summary);

        for (let runNumber = 1; runNumber <= runsPerModel; runNumber++) {
            console.log(`\n--- ${target.label} run ${runNumber}/${runsPerModel} ---`);
            const env = {
                ...process.env,
                RUST_LOG: process.env.RUST_LOG || "error",
                PS_MODEL_PROVIDERS_PATH: modelConfigPath,
                PS_TEST_FORCE_MODEL: target.qualifiedName,
                PS_INTERRUPT_TEST_MODEL: target.qualifiedName,
            };
            const runSummary = {
                runNumber,
                exitCode: 0,
                executedTests: 0,
                failedTests: 0,
                timeoutFailures: 0,
                nonTimeoutFailures: 0,
                failures: [],
                files: [],
            };

            if (RUN_BY_FILE) {
                const runArtifactsDir = path.join(runDir, `${target.label}.run${runNumber}`);
                ensureDirectory(runArtifactsDir);

                for (let fileIndex = 0; fileIndex < localTestFiles.length; fileIndex++) {
                    const testFile = localTestFiles[fileIndex];
                    const safeFileName = testFile.replace(/[\/]/g, "__");
                    const reportPath = path.join(runArtifactsDir, `${safeFileName}.vitest.json`);
                    const logPath = path.join(runArtifactsDir, `${safeFileName}.log`);

                    console.log(`[${target.label} run ${runNumber}] ${fileIndex + 1}/${localTestFiles.length} ${testFile}`);

                    const result = await runCommand("npx", [
                        "vitest",
                        "--run",
                        "--no-file-parallelism",
                        "--maxConcurrency=1",
                        "--reporter=json",
                        `--outputFile=${reportPath}`,
                        testFile,
                    ], {
                        cwd: sdkDir,
                        env,
                        stdio: ["ignore", "pipe", "pipe"],
                    });

                    fs.writeFileSync(logPath, `${result.stdout}\n\n--- STDERR ---\n\n${result.stderr}`);

                    if (!fs.existsSync(reportPath)) {
                        const harnessFailure = {
                            fullName: `${testFile} harness failure`,
                            classification: "non-timeout",
                            failureMessage: `Vitest report not generated. Exit code ${result.code}.`,
                        };
                        runSummary.exitCode = runSummary.exitCode || result.code || 1;
                        runSummary.failedTests += 1;
                        runSummary.nonTimeoutFailures += 1;
                        runSummary.failures.push(harnessFailure);
                        runSummary.files.push({
                            testFile,
                            exitCode: result.code,
                            executedTests: 0,
                            failedTests: 1,
                            timeoutFailures: 0,
                            nonTimeoutFailures: 1,
                        });
                        continue;
                    }

                    const parsed = parseVitestReport(reportPath);
                    const executedTests = parsed.numPassedTests + parsed.numFailedTests;
                    const timeoutFailures = parsed.failures.filter((failure) => failure.classification === "timeout").length;
                    const nonTimeoutFailures = parsed.failures.length - timeoutFailures;

                    if (result.code !== 0 && runSummary.exitCode === 0) {
                        runSummary.exitCode = result.code;
                    }

                    runSummary.executedTests += executedTests;
                    runSummary.failedTests += parsed.numFailedTests;
                    runSummary.timeoutFailures += timeoutFailures;
                    runSummary.nonTimeoutFailures += nonTimeoutFailures;
                    runSummary.failures.push(...parsed.failures);
                    runSummary.files.push({
                        testFile,
                        exitCode: result.code,
                        executedTests,
                        failedTests: parsed.numFailedTests,
                        timeoutFailures,
                        nonTimeoutFailures,
                    });
                }
            } else {
                const reportPath = path.join(runDir, `${target.label}.run${runNumber}.vitest.json`);
                const logPath = path.join(runDir, `${target.label}.run${runNumber}.log`);

                console.log(`[${target.label} run ${runNumber}] running ${localTestFiles.length} files in one Vitest pass`);

                const result = await runCommand("npx", [
                    "vitest",
                    "--run",
                    "--reporter=default",
                    "--reporter=json",
                    `--outputFile=${reportPath}`,
                    ...localTestFiles,
                ], {
                    cwd: sdkDir,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                });

                fs.writeFileSync(logPath, `${result.stdout}\n\n--- STDERR ---\n\n${result.stderr}`);

                if (!fs.existsSync(reportPath)) {
                    runSummary.exitCode = result.code || 1;
                    runSummary.failedTests = 1;
                    runSummary.nonTimeoutFailures = 1;
                    runSummary.failures.push({
                        fullName: `${target.label} run ${runNumber} harness failure`,
                        classification: "non-timeout",
                        failureMessage: `Vitest report not generated. Exit code ${result.code}.`,
                    });
                    runSummary.files.push({
                        testFile: "<full-suite>",
                        exitCode: result.code,
                        executedTests: 0,
                        failedTests: 1,
                        timeoutFailures: 0,
                        nonTimeoutFailures: 1,
                    });
                } else {
                    const parsed = parseVitestReport(reportPath);
                    const executedTests = parsed.numPassedTests + parsed.numFailedTests;
                    const timeoutFailures = parsed.failures.filter((failure) => failure.classification === "timeout").length;
                    const nonTimeoutFailures = parsed.failures.length - timeoutFailures;

                    runSummary.exitCode = result.code;
                    runSummary.executedTests = executedTests;
                    runSummary.failedTests = parsed.numFailedTests;
                    runSummary.timeoutFailures = timeoutFailures;
                    runSummary.nonTimeoutFailures = nonTimeoutFailures;
                    runSummary.failures = parsed.failures;
                    runSummary.files.push({
                        testFile: "<full-suite>",
                        exitCode: result.code,
                        executedTests,
                        failedTests: parsed.numFailedTests,
                        timeoutFailures,
                        nonTimeoutFailures,
                    });
                }
            }

            modelSummary.runs.push(runSummary);
            recomputeModelSummary(modelSummary);
            writeSummaryArtifacts(summary);
        }
    }

    const { jsonPath, markdownPath } = writeSummaryArtifacts(summary);

    console.log(`\nSummary JSON: ${relativeToRoot(jsonPath)}`);
    console.log(`Summary Markdown: ${relativeToRoot(markdownPath)}`);
}

main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
});