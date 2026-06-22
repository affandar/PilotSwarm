// Unit tests for deploy/scripts/lib/common.mjs. Currently covers redactArgs(),
// the helper that masks known-sensitive flag values in error messages and logs
// (FR-007). The patterns are anchored end-of-string so a short-form secret flag
// (e.g. `-p`) does NOT over-mask a longer flag whose name happens to begin with
// the same letter (e.g. `--port`, `--profile`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactArgs } from "../lib/common.mjs";

test("redactArgs masks long-form --password value (space-separated)", () => {
  const out = redactArgs(["az", "login", "--username", "u", "--password", "s3cret"]);
  assert.deepEqual(out, ["az", "login", "--username", "u", "--password", "***"]);
});

test("redactArgs masks long-form --password=value (equals-form)", () => {
  const out = redactArgs(["az", "login", "--username=u", "--password=s3cret"]);
  assert.deepEqual(out, ["az", "login", "--username=u", "--password=***"]);
});

test("redactArgs masks short-form -p value (space-separated)", () => {
  const out = redactArgs(["az", "ad", "sp", "create-for-rbac", "-p", "s3cret"]);
  assert.deepEqual(out, ["az", "ad", "sp", "create-for-rbac", "-p", "***"]);
});

test("redactArgs masks short-form -p=value (equals-form)", () => {
  const out = redactArgs(["az", "login", "-p=s3cret"]);
  assert.deepEqual(out, ["az", "login", "-p=***"]);
});

test("redactArgs does NOT over-mask --port (sanity: longer flag beginning with -p)", () => {
  const out = redactArgs(["mycli", "--port", "8080"]);
  assert.deepEqual(out, ["mycli", "--port", "8080"]);
});

test("redactArgs does NOT over-mask --profile (sanity: longer flag beginning with -p)", () => {
  const out = redactArgs(["mycli", "--profile", "dev"]);
  assert.deepEqual(out, ["mycli", "--profile", "dev"]);
});

test("redactArgs masks generic --value (long-form generic-value flag)", () => {
  const out = redactArgs(["az", "keyvault", "secret", "set", "--name", "k", "--value", "s3cret"]);
  assert.deepEqual(out, ["az", "keyvault", "secret", "set", "--name", "k", "--value", "***"]);
});

test("redactArgs masks generic --value=foo (equals-form)", () => {
  const out = redactArgs(["az", "keyvault", "secret", "set", "--name=k", "--value=s3cret"]);
  assert.deepEqual(out, ["az", "keyvault", "secret", "set", "--name=k", "--value=***"]);
});

test("redactArgs masks --token, --secret, --client-secret, --connection-string, --sas-token, --account-key", () => {
  const flags = ["--token", "--secret", "--client-secret", "--connection-string", "--sas-token", "--account-key", "--admin-password"];
  for (const f of flags) {
    assert.deepEqual(
      redactArgs(["cli", f, "v"]),
      ["cli", f, "***"],
      `space-form should mask ${f}`,
    );
    assert.deepEqual(
      redactArgs(["cli", `${f}=v`]),
      ["cli", `${f}=***`],
      `equals-form should mask ${f}`,
    );
  }
});

test("redactArgs is case-insensitive on long-form flag names", () => {
  assert.deepEqual(
    redactArgs(["cli", "--Password", "v"]),
    ["cli", "--Password", "***"],
  );
});

test("redactArgs does not mutate the input array", () => {
  const input = ["cli", "--password", "v"];
  const before = input.slice();
  redactArgs(input);
  assert.deepEqual(input, before);
});

test("redactArgs leaves a trailing sensitive flag (no following value) alone", () => {
  const out = redactArgs(["cli", "--password"]);
  assert.deepEqual(out, ["cli", "--password"]);
});

test("redactArgs returns the input unchanged when given a non-array", () => {
  assert.equal(redactArgs(undefined), undefined);
  assert.equal(redactArgs(null), null);
  assert.equal(redactArgs("not-an-array"), "not-an-array");
});

test("redactArgs preserves non-string entries verbatim", () => {
  const out = redactArgs(["cli", 42, { x: 1 }, "--password", "v"]);
  assert.deepEqual(out, ["cli", 42, { x: 1 }, "--password", "***"]);
});

test("redactArgs masks --sp (azcopy / az login service principal)", () => {
  const out = redactArgs(["azcopy", "login", "--sp", "secret-value"]);
  assert.deepEqual(out, ["azcopy", "login", "--sp", "***"]);
});


// ── parseEnvFile: inline `# comment` stripping for unquoted values ──
// Regression for the VPN gateway deploy failure where VPN_GATEWAY_SKU
// carried its template.env documentation comment into the bicep param,
// triggering "value is not part of the allowed value(s)".

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../lib/common.mjs";

function writeTmpEnv(body) {
  const dir = mkdtempSync(join(tmpdir(), "parseenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, body, "utf8");
  return { dir, path };
}

test("parseEnvFile strips inline `# comment` after unquoted value", () => {
  const { dir, path } = writeTmpEnv("VPN_GATEWAY_SKU=VpnGw1                                    # @allowed: VpnGw1 / VpnGw2\n");
  try {
    const env = parseEnvFile(path);
    assert.equal(env.VPN_GATEWAY_SKU, "VpnGw1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile preserves `#` inside quoted values", () => {
  const { dir, path } = writeTmpEnv('TOKEN="abc#def"\n');
  try {
    const env = parseEnvFile(path);
    assert.equal(env.TOKEN, "abc#def");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile preserves `#` in unquoted value when not preceded by whitespace", () => {
  const { dir, path } = writeTmpEnv("URL=https://example.com/page#section\n");
  try {
    const env = parseEnvFile(path);
    assert.equal(env.URL, "https://example.com/page#section");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile leaves full-line `#` comments alone (existing behavior)", () => {
  const { dir, path } = writeTmpEnv("# this is a comment\nKEY=value\n");
  try {
    const env = parseEnvFile(path);
    assert.equal(env.KEY, "value");
    assert.equal(Object.keys(env).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
