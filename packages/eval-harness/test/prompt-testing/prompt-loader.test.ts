import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentMd,
  parseAgentMdString,
  writeAgentMd,
  preparePluginDir,
  loadPromptSource,
  applyOverride,
} from "../../src/prompt-testing/prompt-loader.js";

const SAMPLE_MD = `---
name: testbot
description: A test agent.
tools:
  - bash
  - wait
flag: true
count: 5
---

# Test agent

Body line 1.

## Section A

Inside A.
`;

describe("prompt-loader", () => {
  it("parseAgentMdString parses frontmatter and body", () => {
    const parsed = parseAgentMdString(SAMPLE_MD);
    expect(parsed.frontmatter.name).toBe("testbot");
    expect(parsed.frontmatter.description).toBe("A test agent.");
    expect(parsed.frontmatter.tools).toEqual(["bash", "wait"]);
    expect(parsed.frontmatter.flag).toBe(true);
    expect(parsed.frontmatter.count).toBe(5);
    expect(parsed.body).toContain("# Test agent");
    expect(parsed.body).toContain("## Section A");
  });

  it("parseAgentMdString handles input without frontmatter", () => {
    const parsed = parseAgentMdString("Just a body.\n\n## Section\n");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toContain("Just a body.");
  });

  it("parseAgentMd reads from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-loader-test-"));
    try {
      const file = join(dir, "x.agent.md");
      writeFileSync(file, SAMPLE_MD, "utf8");
      const parsed = parseAgentMd(file);
      expect(parsed.frontmatter.name).toBe("testbot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeAgentMd round-trips via parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-loader-test-"));
    try {
      const file = join(dir, "x.agent.md");
      writeAgentMd(
        file,
        { name: "rt", description: "round-trip", tools: ["a", "b"] },
        "## Body\n\nHello.\n",
      );
      const parsed = parseAgentMd(file);
      expect(parsed.frontmatter.name).toBe("rt");
      expect(parsed.frontmatter.tools).toEqual(["a", "b"]);
      expect(parsed.body).toContain("## Body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preparePluginDir creates the expected layout", () => {
    const pluginDir = preparePluginDir({
      agentName: "myagent",
      frontmatter: { name: "myagent", tools: ["wait"] },
      body: "# Body\n",
    });
    try {
      const file = join(pluginDir, "agents", "myagent.agent.md");
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/^---/u);
      expect(text).toContain("name: myagent");
      expect(text).toContain("# Body");
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("loadPromptSource works for inline source", () => {
    const { agentName, parsed } = loadPromptSource({
      label: "inline",
      source: { kind: "inline", agentName: "x", prompt: "Hi." },
    });
    expect(agentName).toBe("x");
    expect(parsed.body).toBe("Hi.");
  });

  it("loadPromptSource throws when file is missing 'name' frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-loader-test-"));
    try {
      const file = join(dir, "noname.agent.md");
      writeFileSync(file, "---\ndescription: missing name\n---\n# body\n", "utf8");
      expect(() =>
        loadPromptSource({ label: "f", source: { kind: "file", path: file } }),
      ).toThrow(/missing 'name'/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applyOverride merges frontmatter and replaces body", () => {
    const parsed = { frontmatter: { name: "x", tools: ["a"] }, body: "old body" };
    const out = applyOverride(parsed, {
      frontmatter: { description: "new" },
      body: "new body",
    });
    expect(out.frontmatter).toEqual({ name: "x", tools: ["a"], description: "new" });
    expect(out.body).toBe("new body");
  });

  it("applyOverride is a no-op when override is undefined", () => {
    const parsed = { frontmatter: { name: "x" }, body: "b" };
    const out = applyOverride(parsed, undefined);
    expect(out).toBe(parsed);
  });
});
