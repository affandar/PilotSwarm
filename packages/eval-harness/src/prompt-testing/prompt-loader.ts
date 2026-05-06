/**
 * Prompt loader: parse, write, and stage `.agent.md` files in temp plugin dirs.
 *
 * The format is YAML-ish frontmatter delimited by `---` at the very top of the
 * file, followed by a Markdown body.
 *
 * # Frontmatter handling — IMPORTANT
 *
 * No YAML dependency is available in this workspace. To avoid silently
 * corrupting frontmatter that uses YAML shapes our minimal parser doesn't
 * understand (nested mappings, anchors, multi-line strings, quoted keys,
 * comments, etc.), the loader preserves the **raw frontmatter text** when
 * the caller does not request a frontmatter override.
 *
 * Specifically:
 *   - `parseAgentMdString()` returns the parsed key/value map AND the raw
 *     frontmatter text on `parsed.rawFrontmatter`.
 *   - `applyOverride()` returns the raw text unchanged when the override has
 *     no `frontmatter` payload, and clears it (forcing re-serialization)
 *     only when an override is supplied. The override is applied as a
 *     shallow merge over the parsed map; this still relies on the simple
 *     parser, so callers that override frontmatter accept that they may
 *     lose comments / non-trivial YAML shapes for that file.
 *   - `writeAgentMd()` writes the raw text verbatim when present, and
 *     re-serializes the parsed map only when no raw text is available.
 *
 * The simple parser still supports the shapes the default agent uses
 * (flat scalars, simple scalar arrays). Production app agents with
 * complex YAML are passed through unmodified unless a frontmatter
 * override is explicitly requested.
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedAgentMd, PromptVariant, PromptUnderTest } from "./types.js";
import { registerTempDir, unregisterTempDir } from "./temp-registry.js";

const FRONTMATTER_FENCE = "---";

interface FrontmatterParseResult {
  frontmatter: Record<string, unknown>;
  raw: string;
}

function parseFrontmatter(text: string): FrontmatterParseResult {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    return { frontmatter: {}, raw: "" };
  }
  // Find the closing fence on its own line.
  const lines = trimmed.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: {}, raw: "" };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: {}, raw: "" };
  }
  const fmLines = lines.slice(1, endIdx);
  const raw = fmLines.join("\n");
  const fm = parseSimpleYaml(fmLines);
  return { frontmatter: fm, raw };
}

/**
 * Tiny YAML-ish parser supporting the shapes used by .agent.md frontmatter:
 *   key: value                     (string / number / boolean)
 *   key:                           (followed by indented "- item" lines)
 *     - item
 * Comments (`# ...`) on their own line are dropped. Quoted strings are
 * unquoted. Anything else is preserved as a literal string.
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line.trim().length === 0) continue;
    if (line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/u);
    if (listMatch && currentListKey) {
      const arr = result[currentListKey] as unknown[];
      arr.push(unquote(listMatch[1]!.trim()));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/u);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();
      if (value.length === 0) {
        result[key] = [];
        currentListKey = key;
      } else {
        result[key] = coerceScalar(value);
        currentListKey = null;
      }
    }
  }
  return result;
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s: string): unknown {
  const u = unquote(s);
  if (u === "true") return true;
  if (u === "false") return false;
  if (u === "null" || u === "~") return null;
  if (/^-?\d+$/u.test(u)) return Number.parseInt(u, 10);
  if (/^-?\d+\.\d+$/u.test(u)) return Number.parseFloat(u);
  return u;
}

/** Serialize a frontmatter object back to YAML-ish text. */
function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s.length === 0) return '""';
  if (/[:#\n]/u.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** Parse a `.agent.md` file into frontmatter + body. */
export function parseAgentMd(file: string): ParsedAgentMd {
  const text = readFileSync(file, "utf8");
  return parseAgentMdString(text);
}

/** Parse a `.agent.md` text buffer (for tests / inline prompts). */
export function parseAgentMdString(text: string): ParsedAgentMd {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    return { frontmatter: {}, body: trimmed, rawFrontmatter: null };
  }
  const { frontmatter, raw } = parseFrontmatter(trimmed);
  // Find the second fence and slice the body.
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: {}, body: trimmed, rawFrontmatter: null };
  }
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n/, "");
  return { frontmatter, body, rawFrontmatter: raw };
}

/**
 * Write a `.agent.md` file with the given frontmatter and body.
 *
 * If `rawFrontmatter` is provided, it is written verbatim — this is the
 * round-trip-safe path for sources whose frontmatter uses YAML shapes our
 * minimal parser does not understand (nested mappings, comments, anchors,
 * multi-line strings). Pass `rawFrontmatter: null` to force re-serialization
 * of the parsed `frontmatter` object (lossy for complex YAML but required
 * when the caller has overridden frontmatter values).
 *
 * Creates intermediate directories as needed.
 */
export function writeAgentMd(
  outFile: string,
  frontmatter: Record<string, unknown>,
  body: string,
  rawFrontmatter: string | null = null,
): void {
  const fm = rawFrontmatter !== null ? rawFrontmatter : serializeFrontmatter(frontmatter);
  const out = `${FRONTMATTER_FENCE}\n${fm}\n${FRONTMATTER_FENCE}\n${body.startsWith("\n") ? body.slice(1) : body}`;
  writeFileSync(outFile, out, "utf8");
}

/**
 * Create a temporary plugin directory containing a single mutated agent.
 * Returns the absolute path of the created plugin dir.
 *
 * The directory is registered with the process-exit cleanup hook
 * (see `temp-registry.ts`) so it will be best-effort removed even if the
 * caller is killed mid-run. Callers SHOULD still call `rmSync(dir, { recursive: true })`
 * (or `cleanupPluginDir(dir)`) when they are finished, both for prompt
 * resource release and to keep the registry small.
 *
 * Layout:
 *   <tempDir>/agents/<name>.agent.md
 */
export function preparePluginDir(opts: {
  agentName: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** When provided, written verbatim instead of re-serializing. */
  rawFrontmatter?: string | null;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "ps-prompt-variant-"));
  registerTempDir(dir);
  // If anything below fails, the dir was already created and registered.
  // Roll it back immediately so neither the on-disk fs nor the registry
  // accumulates a partially-materialized variant. Re-throw the original
  // error so callers see the real failure cause.
  try {
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const file = join(agentsDir, `${opts.agentName}.agent.md`);
    writeAgentMd(file, opts.frontmatter, opts.body, opts.rawFrontmatter ?? null);
    return dir;
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — surface the original error, not the cleanup error
    }
    unregisterTempDir(dir);
    throw err;
  }
}

/** Resolve the full source ParsedAgentMd for a PromptUnderTest. */
export function loadPromptSource(prompt: PromptUnderTest): {
  agentName: string;
  parsed: ParsedAgentMd;
} {
  if (prompt.source.kind === "file") {
    const parsed = parseAgentMd(prompt.source.path);
    const fmName =
      typeof parsed.frontmatter.name === "string"
        ? (parsed.frontmatter.name as string)
        : null;
    if (!fmName) {
      throw new Error(
        `loadPromptSource: agent file ${prompt.source.path} is missing 'name' frontmatter field`,
      );
    }
    return { agentName: fmName, parsed };
  }
  return {
    agentName: prompt.source.agentName,
    parsed: {
      frontmatter: { name: prompt.source.agentName },
      body: prompt.source.prompt,
      rawFrontmatter: null,
    },
  };
}

/**
 * Apply override (frontmatter merge + body replacement) to a parsed agent.
 * Override is applied AFTER mutators — a hand-authored override always wins.
 *
 * When `override.frontmatter` is supplied we MUST re-serialize, so we drop
 * `rawFrontmatter` to force the writer to use the (lossy) serializer. When
 * only the body is overridden, we keep `rawFrontmatter` so frontmatter
 * round-trips byte-for-byte.
 */
export function applyOverride(
  parsed: ParsedAgentMd,
  override: PromptVariant["override"],
): ParsedAgentMd {
  if (!override) return parsed;
  const newFrontmatter: Record<string, unknown> = override.frontmatter
    ? { ...parsed.frontmatter, ...override.frontmatter }
    : parsed.frontmatter;
  return {
    frontmatter: newFrontmatter,
    body: override.body ?? parsed.body,
    rawFrontmatter: override.frontmatter ? null : parsed.rawFrontmatter,
  };
}
