// Unit tests for substitute-env.mjs (stdlib-only: node:test + node:assert).
//
// Run: node --test deploy/scripts/test/substitute-env.test.mjs
//   or: npm run test:deploy-scripts
//
// Covers planning §EC-3 fail-closed behavior + the rewrite rules in
// `KEY_LINE_RE` (UPPER_SNAKE keys only; comments / blanks / non-matching
// lines pass through verbatim).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { substituteOverlayEnv } from "../lib/substitute-env.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ps-substenv-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rewrites UPPER_SNAKE keys present in env map", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "KV_NAME=placeholder\nACR_NAME=placeholder\n");
    const res = substituteOverlayEnv({
      srcPath: src,
      dstPath: dst,
      envMap: { KV_NAME: "real-kv", ACR_NAME: "realacr" },
    });
    assert.deepEqual(res.substituted.sort(), ["ACR_NAME", "KV_NAME"]);
    const out = readFileSync(dst, "utf8");
    assert.ok(out.includes("KV_NAME=real-kv"));
    assert.ok(out.includes("ACR_NAME=realacr"));
  });
});

test("passes through comments and blank lines verbatim", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "# header comment\n\nKV_NAME=placeholder\n# trailer\n");
    substituteOverlayEnv({ srcPath: src, dstPath: dst, envMap: { KV_NAME: "v" } });
    const out = readFileSync(dst, "utf8");
    assert.ok(out.startsWith("# header comment\n"));
    assert.ok(out.includes("\n# trailer"));
    assert.ok(out.includes("KV_NAME=v"));
  });
});

test("ignores non-UPPER_SNAKE lines (lowercase keys, indented, etc.)", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "lowercase=skip\n  INDENTED=skip\nfoo: bar\n");
    substituteOverlayEnv({
      srcPath: src,
      dstPath: dst,
      envMap: { LOWERCASE: "x", INDENTED: "x" },
    });
    const out = readFileSync(dst, "utf8");
    assert.ok(out.includes("lowercase=skip"));
    assert.ok(out.includes("  INDENTED=skip"));
    assert.ok(out.includes("foo: bar"));
  });
});

test("fails closed with sorted unresolved-key summary (EC-3)", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "ZZZ=placeholder\nAAA=placeholder\nMID=placeholder\n");
    assert.throws(
      () =>
        substituteOverlayEnv({
          srcPath: src,
          dstPath: dst,
          envMap: { MID: "x" },
        }),
      /Unresolved overlay \.env keys.*AAA, ZZZ/,
    );
  });
});

test("treats empty-string values as unresolved (fail-closed)", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "KV_NAME=placeholder\n");
    assert.throws(
      () =>
        substituteOverlayEnv({
          srcPath: src,
          dstPath: dst,
          envMap: { KV_NAME: "" },
        }),
      /Unresolved overlay \.env keys.*KV_NAME/,
    );
  });
});

test("treats null/undefined values as unresolved (fail-closed)", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "KV_NAME=placeholder\nACR_NAME=placeholder\n");
    assert.throws(
      () =>
        substituteOverlayEnv({
          srcPath: src,
          dstPath: dst,
          envMap: { KV_NAME: null, ACR_NAME: undefined },
        }),
      /Unresolved overlay \.env keys.*ACR_NAME, KV_NAME/,
    );
  });
});

test("preserves CRLF input by re-emitting LF (Windows-friendly)", () => {
  withTmp((dir) => {
    const src = join(dir, "in.env");
    const dst = join(dir, "out.env");
    writeFileSync(src, "KV_NAME=placeholder\r\nACR_NAME=placeholder\r\n");
    substituteOverlayEnv({
      srcPath: src,
      dstPath: dst,
      envMap: { KV_NAME: "v1", ACR_NAME: "v2" },
    });
    const out = readFileSync(dst, "utf8");
    assert.ok(out.includes("KV_NAME=v1"));
    assert.ok(out.includes("ACR_NAME=v2"));
  });
});
