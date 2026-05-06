import { describe, it, expect } from "vitest";
import { removeSectionMutator } from "../../src/prompt-testing/mutators/remove-section.js";

const SAMPLE = `Preamble.

## Be Autonomous

You should keep going.

## Tools

Use tools.

## Notes

Some notes.
`;

describe("remove-section mutator", () => {
  it("drops a single section by heading (case-insensitive)", async () => {
    const out = await removeSectionMutator.apply({
      body: SAMPLE,
      config: { headings: ["be autonomous"] },
    });
    expect(out).not.toContain("## Be Autonomous");
    expect(out).not.toContain("You should keep going.");
    expect(out).toContain("## Tools");
    expect(out).toContain("## Notes");
  });

  it("drops multiple sections", async () => {
    const out = await removeSectionMutator.apply({
      body: SAMPLE,
      config: { headings: ["Tools", "Notes"] },
    });
    expect(out).not.toContain("## Tools");
    expect(out).not.toContain("## Notes");
    expect(out).toContain("## Be Autonomous");
  });

  it("returns input unchanged when headings=[]", async () => {
    const out = await removeSectionMutator.apply({
      body: SAMPLE,
      config: { headings: [] },
    });
    expect(out).toBe(SAMPLE);
  });

  it("returns input unchanged when headings don't match", async () => {
    const out = await removeSectionMutator.apply({
      body: SAMPLE,
      config: { headings: ["nonexistent"] },
    });
    // No content removed, but joinSections may normalize trailing newlines.
    expect(out).toContain("## Be Autonomous");
    expect(out).toContain("## Tools");
    expect(out).toContain("## Notes");
  });

  it("preserves preamble", async () => {
    const out = await removeSectionMutator.apply({
      body: SAMPLE,
      config: { headings: ["Be Autonomous", "Tools", "Notes"] },
    });
    expect(out.trim().startsWith("Preamble.")).toBe(true);
  });

  it("rejects invalid config", async () => {
    await expect(
      removeSectionMutator.apply({ body: SAMPLE, config: null }),
    ).rejects.toThrow();
    await expect(
      removeSectionMutator.apply({ body: SAMPLE, config: { headings: "Tools" } }),
    ).rejects.toThrow();
    await expect(
      removeSectionMutator.apply({ body: SAMPLE, config: { headings: [1, 2] } }),
    ).rejects.toThrow();
  });
});
