// Tests for render-params.mjs.
//
// Run: node --test deploy/scripts/test/render-params.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderParams } from "../lib/render-params.mjs";
import { parseEnvFile, templateEnvPath, REPO_ROOT } from "../lib/common.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "render-params-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("substitutes ${VAR} placeholders against the env map", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: {
          name: { value: "${RESOURCE_PREFIX}" },
          loc: { value: "${LOCATION}" },
        },
      }),
    );
    const r = renderParams({
      module: "T",
      templatePath: tpl,
      envMap: { RESOURCE_PREFIX: "psfoo", LOCATION: "westus3" },
      outDir: dir,
    });

    const json = JSON.parse(readFileSync(r.renderedPath, "utf8"));
    assert.equal(json.parameters.name.value, "psfoo");
    assert.equal(json.parameters.loc.value, "westus3");
    assert.deepEqual(r.substituted.sort(), ["LOCATION", "RESOURCE_PREFIX"]);
  });
});

test("empty string is a legitimate value, not unresolved (OSS-path SSL_CERT_DOMAIN_SUFFIX case)", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: {
          suffix: { value: "${SSL_CERT_DOMAIN_SUFFIX}" },
        },
      }),
    );
    const r = renderParams({
      module: "T",
      templatePath: tpl,
      envMap: { SSL_CERT_DOMAIN_SUFFIX: "" },
      outDir: dir,
    });
    const json = JSON.parse(readFileSync(r.renderedPath, "utf8"));
    assert.equal(json.parameters.suffix.value, "");
  });
});

test("undefined / missing key is reported as unresolved", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: { foo: { value: "${UNSET_KEY}" } },
      }),
    );
    assert.throws(
      () => renderParams({ module: "T", templatePath: tpl, envMap: {}, outDir: dir }),
      /unresolved placeholders: UNSET_KEY/,
    );
  });
});

test("real base-infra template renders a boolean for new, legacy, and pre-key envs", () => {
  withTmp((dir) => {
    const templatePath = join(REPO_ROOT, "deploy/services/base-infra/bicep/base-infra.params.template.json");
    for (const [flag, expected] of [
      ["true", true], ["false", false], ["1", true], ["0", false],
      [" FALSE ", false], [false, false], [true, true], [undefined, true],
    ]) {
      const envMap = {
        ...parseEnvFile(templateEnvPath()),
        FRONT_DOOR_ID: "fixture-front-door",
        FRONT_DOOR_PROFILE_NAME: "fixture-profile",
        FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg",
      };
      if (flag === undefined) delete envMap.DEPLOY_POSTGRES;
      else envMap.DEPLOY_POSTGRES = flag;
      const { renderedPath } = renderParams({ module: "base-infra", templatePath, envMap, outDir: dir });
      const params = JSON.parse(readFileSync(renderedPath, "utf8"));
      assert.equal(typeof params.parameters.deployPostgres.value, "boolean");
      assert.equal(params.parameters.deployPostgres.value, expected);
    }
  });
});

test("invalid DEPLOY_POSTGRES cannot render as a number or bypass validation", () => {
  withTmp((dir) => {
    const templatePath = join(dir, "bool.json");
    writeFileSync(templatePath, '{"parameters":{"deployPostgres":{"value":${DEPLOY_POSTGRES}}}}');
    for (const flag of ["", "2", "no"]) {
      assert.throws(
        () => renderParams({ module: "base-infra", templatePath, envMap: { DEPLOY_POSTGRES: flag }, outDir: dir }),
        /DEPLOY_POSTGRES must be true or false/,
      );
    }
  });
});
