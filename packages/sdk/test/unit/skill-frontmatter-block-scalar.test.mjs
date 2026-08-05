/**
 * SKILL.md frontmatter supports block scalars.
 *
 * It did not, and the failure was silent and shipped: `description: |` stored
 * the literal "|" and dropped every indented line under it. The agent-manager
 * package's `agent-repair-loop` skill listed its description as `"|"` in every
 * package listing, picker and manifest on the live deployment.
 *
 * The same bug was fixed in agent-loader's parser months earlier. This is a
 * SECOND, independent frontmatter parser, and it never got the fix — which is
 * the real lesson: the two parse the same file format and have to agree.
 *
 * Run: node --test test/unit/skill-frontmatter-block-scalar.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadSkillsSync } from "../../dist/skills.js";

function skillDir(skillMd) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-fm-"));
    fs.mkdirSync(path.join(root, "demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "demo", "SKILL.md"), skillMd);
    return root;
}

const load = (md) => loadSkillsSync(skillDir(md))[0];

test("a literal block scalar keeps its lines", () => {
    const skill = load([
        "---",
        "name: demo",
        "description: |",
        "  First line.",
        "  Second line.",
        "---",
        "",
        "Body.",
    ].join("\n"));

    assert.equal(skill.description, "First line.\nSecond line.");
    assert.notEqual(skill.description, "|", "the shipped bug");
});

test("a folded block scalar joins onto one line", () => {
    const skill = load([
        "---",
        "name: demo",
        "description: >",
        "  Wrapped across",
        "  two source lines.",
        "---",
        "",
        "Body.",
    ].join("\n"));

    assert.equal(skill.description, "Wrapped across two source lines.");
});

test("the block ends at the next top-level key, which keeps its own value", () => {
    // The failure mode if the terminator is wrong: `name` gets swallowed into
    // the description and the skill loads without a name.
    const skill = load([
        "---",
        "description: |",
        "  Some text.",
        "name: demo",
        "---",
        "",
        "Body.",
    ].join("\n"));

    assert.equal(skill.name, "demo");
    assert.equal(skill.description, "Some text.");
});

test("a literal block keeps blank lines as paragraph breaks", () => {
    const skill = load([
        "---",
        "name: demo",
        "description: |",
        "  Para one.",
        "",
        "  Para two.",
        "---",
        "",
        "Body.",
    ].join("\n"));

    assert.equal(skill.description, "Para one.\n\nPara two.");
});

test("the value is dedented, so the frontmatter's layout does not leak", () => {
    const skill = load([
        "---",
        "name: demo",
        "description: |",
        "    Deeply indented.",
        "      Relatively deeper.",
        "---",
        "",
        "Body.",
    ].join("\n"));

    assert.equal(skill.description, "Deeply indented.\n  Relatively deeper.",
        "the common indent goes, relative indent stays");
});

test("plain and quoted scalars are untouched", () => {
    // The compatibility floor: every SKILL.md written before block scalars
    // worked must parse identically.
    assert.equal(load("---\nname: demo\ndescription: Plain text.\n---\n\nBody.").description, "Plain text.");
    assert.equal(load('---\nname: demo\ndescription: "Quoted text."\n---\n\nBody.').description, "Quoted text.");
    assert.equal(load("---\nname: demo\n---\n\nBody.").description, "", "a missing description stays empty");
});

test("the body after the frontmatter is unaffected by a block scalar", () => {
    const skill = load([
        "---",
        "name: demo",
        "description: |",
        "  Text.",
        "---",
        "",
        "# Heading",
        "",
        "Body prose.",
    ].join("\n"));

    // The markdown body becomes the skill's `prompt`.
    assert.match(skill.prompt, /# Heading/);
    assert.match(skill.prompt, /Body prose\./);
    assert.doesNotMatch(skill.prompt, /^---/, "the frontmatter must not bleed into the prompt");
});
