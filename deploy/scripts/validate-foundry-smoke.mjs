#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPRESENTATIVE_TOOLS = [
  {
    type: "function",
    function: {
      name: "task",
      description: "Delegate a bounded repository task to a specialized child agent.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Request a human decision before a gated action.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

const REPRESENTATIVE_CASES = [
  {
    name: "primary-agent",
    messages: [
      {
        role: "system",
        content:
          "You are a software engineering agent running inside a durable orchestration framework. " +
          "Follow the user's request, preserve safety boundaries, never disclose credentials, and use tools only when needed. " +
          "A parent agent may delegate bounded repository tasks. Human approval is required for deployments, permission changes, and merges.",
      },
      {
        role: "user",
        content:
          "Compatibility smoke test: review a fictional database migration plan without changing files or calling tools. " +
          "Reply with exactly READY if these instructions can be processed safely.",
      },
    ],
  },
  {
    name: "delegated-session",
    messages: [
      {
        role: "system",
        content:
          "You are a delegated coding session. Complete only the bounded task from the creator, report evidence, and do not deploy, merge, " +
          "change permissions, or expose secrets. Cross-session request and response markers are product-visible transcript items.",
      },
      {
        role: "user",
        content:
          "[SESSION_MESSAGE creator=parent focus=database-migration] Inspect a fictional repository plan read-only. " +
          "Return a short compatibility acknowledgment without invoking tools.",
      },
    ],
  },
];

function endpointUrl(rawEndpoint) {
  const trimmed = String(rawEndpoint || "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("FOUNDRY_ENDPOINT is required.");
  const base = trimmed.endsWith("/openai/v1") ? trimmed : `${trimmed}/openai/v1`;
  return `${base}/chat/completions`;
}

export function requestFingerprint(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function sanitizeFoundryResult({ response, payload, requestBody, caseName = "representative" }) {
  const inner = payload?.error?.innererror ?? payload?.error?.innerError ?? {};
  const filter = inner?.content_filter_result ?? inner?.contentFilterResult ?? {};
  const jailbreak = filter?.jailbreak ?? {};
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    caseName,
    endpointHost: new URL(response.url).host,
    model: requestBody.model,
    requestFingerprint: requestFingerprint(requestBody),
    httpStatus: response.status,
    ok: response.ok,
    requestId:
      response.headers.get("apim-request-id") ??
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      null,
    errorCode: payload?.error?.code ?? null,
    innerErrorCode: inner?.code ?? null,
    policyRejected:
      response.status === 400 &&
      (payload?.error?.code === "content_filter" || inner?.code === "ResponsibleAIPolicyViolation"),
    jailbreak: {
      detected: jailbreak?.detected === true,
      filtered: jailbreak?.filtered === true,
    },
    responseShapeValid:
      response.ok &&
      typeof payload?.choices?.[0]?.message?.content === "string" &&
      payload.choices[0].message.content.trim().length > 0,
  };
}

export async function runFoundrySmoke({
  endpoint = process.env.FOUNDRY_ENDPOINT,
  apiKey = process.env.AZURE_OAI_KEY,
  model = process.env.FOUNDRY_SMOKE_MODEL || "gpt-5.4-mini",
  evidencePath = process.env.FOUNDRY_SMOKE_EVIDENCE || "deploy/.tmp/foundry-smoke.json",
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error("AZURE_OAI_KEY is required and must be supplied through the process environment.");
  const checks = [];
  for (const representativeCase of REPRESENTATIVE_CASES) {
    const requestBody = {
      model,
      messages: representativeCase.messages,
      tools: REPRESENTATIVE_TOOLS,
      tool_choice: "none",
      temperature: 0,
      max_completion_tokens: 64,
    };
    const response = await fetchImpl(endpointUrl(endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    checks.push(
      sanitizeFoundryResult({
        response,
        payload,
        requestBody,
        caseName: representativeCase.name,
      }),
    );
  }
  const result = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    model,
    passed: checks.every((check) => check.ok && check.responseShapeValid && !check.policyRejected),
    checks,
  };
  const absoluteEvidencePath = resolve(evidencePath);
  mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
  writeFileSync(absoluteEvidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");

  const policyFailure = checks.find((check) => check.policyRejected);
  if (policyFailure) {
    const error = new Error(
      `Foundry compatibility gate failed closed for ${policyFailure.caseName}: policy rejection ` +
        `(${policyFailure.errorCode || policyFailure.innerErrorCode || policyFailure.httpStatus}).`,
    );
    error.exitCode = 2;
    error.result = result;
    throw error;
  }
  const failedCheck = checks.find((check) => !check.ok || !check.responseShapeValid);
  if (failedCheck) {
    const error = new Error(
      `Foundry compatibility gate failed for ${failedCheck.caseName}: HTTP ${failedCheck.httpStatus}; ` +
        `sanitized evidence: ${absoluteEvidencePath}`,
    );
    error.exitCode = 1;
    error.result = result;
    throw error;
  }
  return { result, evidencePath: absoluteEvidencePath };
}

async function main() {
  try {
    const { evidencePath } = await runFoundrySmoke();
    console.log(`Foundry compatibility gate passed; sanitized evidence: ${evidencePath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
