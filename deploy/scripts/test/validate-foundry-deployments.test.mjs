// Tests for validate-foundry-deployments.mjs.
//
// Run: node --test deploy/scripts/test/validate-foundry-deployments.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateFoundryDeployments,
  assertFoundryDeploymentsValid,
} from "../lib/validate-foundry-deployments.mjs";

// Shape mirrors `az cognitiveservices model list -o json` (only the fields
// we read).
const WESTUS3_MODELS = [
  { model: { format: "OpenAI", name: "gpt-5", version: "2025-08-07" } },
  { model: { format: "OpenAI", name: "gpt-5-mini", version: "2025-08-07" } },
  { model: { format: "OpenAI", name: "gpt-5-nano", version: "2025-08-07" } },
  { model: { format: "OpenAI", name: "gpt-5.2", version: "2025-12-11" } },
  { model: { format: "OpenAI", name: "gpt-5-mini", version: "2024-07-18" } },
];

test("returns no errors when every deployment has a matching model triple", () => {
  const deployments = [
    {
      name: "main",
      model: { format: "OpenAI", name: "gpt-5-mini", version: "2025-08-07" },
      sku: { name: "GlobalStandard", capacity: 50 },
    },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.deepEqual(errors, []);
});

test("flags an unknown version and lists the available alternatives", () => {
  const deployments = [
    {
      name: "main",
      model: { format: "OpenAI", name: "gpt-5-mini", version: "2099-99-99" },
    },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /gpt-5-mini@2099-99-99/);
  assert.match(errors[0], /not available in westus3/);
  // Surfaces both real versions, sorted, so the user can copy-paste
  assert.match(errors[0], /2024-07-18, 2025-08-07/);
});

test("flags an unknown model name with a helpful 'list-all' hint", () => {
  const deployments = [
    {
      name: "main",
      model: { format: "OpenAI", name: "imaginary-model", version: "2030-01-01" },
    },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /imaginary-model/);
  assert.match(errors[0], /not offered in westus3/);
  assert.match(errors[0], /az cognitiveservices model list --location westus3/);
});

test("flags every invalid deployment in one pass (not just the first)", () => {
  const deployments = [
    { name: "good", model: { format: "OpenAI", name: "gpt-5", version: "2025-08-07" } },
    { name: "bad-version", model: { format: "OpenAI", name: "gpt-5", version: "1999-01-01" } },
    { name: "bad-name", model: { format: "OpenAI", name: "fake", version: "2025-08-07" } },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /bad-version/);
  assert.match(errors[1], /bad-name/);
});

test("flags missing model.format / name / version on a deployment entry", () => {
  const deployments = [
    { name: "incomplete", model: { format: "OpenAI", name: "gpt-5" } },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /incomplete is missing model\.format \/ model\.name \/ model\.version/);
});

test("uses the deployment array index when 'name' is missing", () => {
  const deployments = [
    { model: { format: "OpenAI", name: "gpt-5", version: "9999-12-31" } },
  ];
  const errors = validateFoundryDeployments({
    deployments,
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.match(errors[0], /^\[0\] \(unnamed\) -> /);
});

test("returns a structural error when deployments is not an array", () => {
  const errors = validateFoundryDeployments({
    deployments: { foo: "bar" },
    availableModels: WESTUS3_MODELS,
    region: "westus3",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must contain a JSON array/);
});

test("assertFoundryDeploymentsValid is a no-op for valid input (mocked listFn)", () => {
  let called = 0;
  assertFoundryDeploymentsValid({
    deployments: [
      { name: "main", model: { format: "OpenAI", name: "gpt-5-mini", version: "2025-08-07" } },
    ],
    region: "westus3",
    listFn: (region) => {
      called++;
      assert.equal(region, "westus3");
      return WESTUS3_MODELS;
    },
  });
  assert.equal(called, 1);
});

test("assertFoundryDeploymentsValid throws a consolidated message on invalid input", () => {
  assert.throws(
    () =>
      assertFoundryDeploymentsValid({
        deployments: [
          { name: "first", model: { format: "OpenAI", name: "gpt-5", version: "1999-01-01" } },
          { name: "second", model: { format: "OpenAI", name: "fake", version: "2099-12-31" } },
        ],
        region: "westus3",
        listFn: () => WESTUS3_MODELS,
      }),
    (err) => {
      assert.match(err.message, /Foundry deployments validation failed for region westus3/);
      assert.match(err.message, /first/);
      assert.match(err.message, /second/);
      assert.match(err.message, /FOUNDRY_ENABLED=false/);
      return true;
    },
  );
});
