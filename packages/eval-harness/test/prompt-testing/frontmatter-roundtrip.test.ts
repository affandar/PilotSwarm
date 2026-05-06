import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentMd,
  applyOverride,
  preparePluginDir,
  parseAgentMdString,
} from "../../src/prompt-testing/prompt-loader.js";
import { cleanupPluginDir } from "../../src/prompt-testing/variant-runner.js";

function tmpFile(text: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ps-fm-rt-"));
  const path = join(dir, "agent.agent.md");
  writeFileSync(path, text, "utf8");
  return { dir, path };
}

describe("HIGH #4 — frontmatter round-trip preservation", () => {
  it("preserves complex frontmatter VERBATIM when no override is applied", () => {
    const original = `---
# This comment must survive round-trip.
name: complex
description: rich frontmatter
nested:
  inner: value
  list:
    - a
    - b
multiline: |
  line one
  line two
quoted: "with: colon and # hash"
tools:
  - bash
  - sh
---

# Body

content here
`;
    const f = tmpFile(original);
    try {
      const parsed = parseAgentMd(f.path);
      // The parsed.rawFrontmatter is the exact text between fences (no fences).
      expect(parsed.rawFrontmatter).toContain("# This comment must survive round-trip.");
      expect(parsed.rawFrontmatter).toContain("nested:");
      expect(parsed.rawFrontmatter).toContain("multiline: |");
      // applyOverride with no override → rawFrontmatter passthrough is preserved.
      const after = applyOverride(parsed, undefined);
      expect(after.rawFrontmatter).toBe(parsed.rawFrontmatter);

      // Materialize a plugin dir and read back the file: frontmatter
      // section must equal the original verbatim.
      const dir = preparePluginDir({
        agentName: "complex",
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        rawFrontmatter: parsed.rawFrontmatter,
      });
      try {
        const out = readFileSync(join(dir, "agents", "complex.agent.md"), "utf8");
        expect(out).toContain("# This comment must survive round-trip.");
        expect(out).toContain("multiline: |");
        expect(out).toContain('quoted: "with: colon and # hash"');
        // Body present
        expect(out).toContain("# Body");
      } finally {
        cleanupPluginDir(dir);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("re-serializes frontmatter when an override is supplied (lossy by design)", () => {
    const original = `---
name: simple
description: orig
tools:
  - bash
---

# Body
`;
    const f = tmpFile(original);
    try {
      const parsed = parseAgentMd(f.path);
      const after = applyOverride(parsed, { frontmatter: { description: "overridden" } });
      // rawFrontmatter must be cleared so the writer re-serializes
      expect(after.rawFrontmatter).toBe(null);
      expect(after.frontmatter.description).toBe("overridden");

      const dir = preparePluginDir({
        agentName: "simple",
        frontmatter: after.frontmatter,
        body: after.body,
        rawFrontmatter: after.rawFrontmatter,
      });
      try {
        const out = readFileSync(join(dir, "agents", "simple.agent.md"), "utf8");
        expect(out).toContain("description: overridden");
        expect(out).toContain("name: simple");
      } finally {
        cleanupPluginDir(dir);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("body-only override keeps raw frontmatter verbatim", () => {
    const original = `---
# preserved comment
name: bo
custom_unparsed_yaml: { a: 1, b: 2 }
---

# Original Body
`;
    const f = tmpFile(original);
    try {
      const parsed = parseAgentMd(f.path);
      const after = applyOverride(parsed, { body: "# Replaced Body\n" });
      expect(after.rawFrontmatter).toBe(parsed.rawFrontmatter);
      expect(after.body).toBe("# Replaced Body\n");

      const dir = preparePluginDir({
        agentName: "bo",
        frontmatter: after.frontmatter,
        body: after.body,
        rawFrontmatter: after.rawFrontmatter,
      });
      try {
        const out = readFileSync(join(dir, "agents", "bo.agent.md"), "utf8");
        expect(out).toContain("# preserved comment");
        expect(out).toContain("custom_unparsed_yaml: { a: 1, b: 2 }");
        expect(out).toContain("# Replaced Body");
      } finally {
        cleanupPluginDir(dir);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("inline source has rawFrontmatter null", () => {
    const parsed = parseAgentMdString("body without frontmatter");
    expect(parsed.rawFrontmatter).toBe(null);
  });
});
