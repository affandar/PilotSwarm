/**
 * Package diffing and patch sets.
 *
 * ── The property that makes this useful at all ──────────────────────────
 *
 * Diffs are computed POST-NORMALIZATION (§8, §15 A9). Upload canonicalizes a
 * package: files move into `agents/`, `skills/`, `.mcp.json`; ordering is
 * fixed; undeclared files are dropped. Diffing a raw source tree against a
 * canonically-packed artifact would therefore show the packer's reshuffling on
 * every single run, and bury the one line that actually changed under it.
 *
 * Two consequences worth having, both used by the cron freshness loop:
 *
 *   - **Identity is a hash compare, not a diff.** Packages are
 *     content-addressed, so "is this the same?" is free.
 *   - **An empty diff is a TRUE no-op**, which is exactly the signal that
 *     makes an hourly "keep this agent current" cron safe to leave running:
 *     unchanged source → identical hash → empty diff → no publish.
 *
 * @module
 */

import type { ExtractedTarEntry } from "./agent-package-format.js";

/** Beyond this, a file is summarized rather than inlined. */
export const DIFF_MAX_FILE_BYTES = 256 * 1024;
/** Beyond this many changed files, the set is truncated with a marker. */
export const DIFF_MAX_FILES = 200;

export interface FilePatch {
    path: string;
    status: "added" | "removed" | "modified";
    /** Unified diff, or null when the content was not diffable (binary/oversize). */
    diff: string | null;
    /** Why `diff` is null. */
    note?: string;
    binary?: boolean;
}

export interface PackageDiff {
    /** True when the two sides are byte-identical after normalization. */
    identical: boolean;
    patches: FilePatch[];
    /** Set when DIFF_MAX_FILES cut the list short. */
    truncated?: { omitted: number };
}

/**
 * An entry as either producer spells it.
 *
 * TWO shapes reach this module and they do not agree: `readAgentPackageTarGz`
 * emits `{name, body}`, while a staged edit is built as `{path, content}`.
 * The union is declared so the compiler checks both — the earlier version read
 * `path`/`content` through `as any`, which silently dropped every tar entry
 * (the map came out empty, so file reads reported "not in package" and every
 * diff reported "identical" even across different hashes).
 */
export type PackageEntry = ExtractedTarEntry | { path: string; content: Buffer | string };

/** A tar entry list reduced to path → bytes, ignoring the packer's ordering. */
export function entriesToMap(entries: PackageEntry[]): Map<string, Buffer> {
    const map = new Map<string, Buffer>();
    for (const entry of entries ?? []) {
        const named = entry as Partial<ExtractedTarEntry> & { path?: string; content?: Buffer | string };
        const p = String(named.path ?? named.name ?? "").replace(/^\.\//, "");
        if (!p || p.endsWith("/")) continue;
        const raw = named.content ?? named.body;
        map.set(p, Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? ""));
    }
    return map;
}

/**
 * Heuristic binary detection: a NUL byte in the first 8 KiB.
 *
 * Binaries are flagged, never inlined — a base64 blob in a diff is unreadable
 * for a human and pure token cost for a model.
 */
export function looksBinary(buf: Buffer): boolean {
    const limit = Math.min(buf.length, 8192);
    for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
    return false;
}

/**
 * Longest-common-subsequence unified diff.
 *
 * Small and dependency-free on purpose: this runs inside the worker, on
 * content that may be attacker-authored, and a diff library is a lot of
 * surface to take on for a few hundred lines of text.
 */
export function unifiedDiff(
    oldText: string,
    newText: string,
    filePath: string,
    context = 3,
): string {
    const a = oldText.split("\n");
    const b = newText.split("\n");

    // LCS table. Bounded by DIFF_MAX_FILE_BYTES upstream, so this cannot be
    // driven to arbitrary size by a hostile package.
    const n = a.length, m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    type Op = { kind: " " | "-" | "+"; text: string };
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ kind: " ", text: a[i] }); i += 1; j += 1; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: "-", text: a[i] }); i += 1; }
        else { ops.push({ kind: "+", text: b[j] }); j += 1; }
    }
    while (i < n) { ops.push({ kind: "-", text: a[i] }); i += 1; }
    while (j < m) { ops.push({ kind: "+", text: b[j] }); j += 1; }

    if (!ops.some((op) => op.kind !== " ")) return "";

    // Group into hunks with `context` lines of surrounding agreement.
    const keep = new Array(ops.length).fill(false);
    ops.forEach((op, idx) => {
        if (op.kind === " ") return;
        for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
    });

    const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
    let oldLine = 1, newLine = 1;
    let idx = 0;
    while (idx < ops.length) {
        if (!keep[idx]) {
            if (ops[idx].kind !== "+") oldLine += 1;
            if (ops[idx].kind !== "-") newLine += 1;
            idx += 1;
            continue;
        }
        const hunkStartOld = oldLine, hunkStartNew = newLine;
        const body: string[] = [];
        let oldCount = 0, newCount = 0;
        while (idx < ops.length && keep[idx]) {
            const op = ops[idx];
            body.push(`${op.kind}${op.text}`);
            if (op.kind !== "+") { oldLine += 1; oldCount += 1; }
            if (op.kind !== "-") { newLine += 1; newCount += 1; }
            idx += 1;
        }
        lines.push(`@@ -${hunkStartOld},${oldCount} +${hunkStartNew},${newCount} @@`);
        lines.push(...body);
    }
    return lines.join("\n");
}

/**
 * Diff two normalized package trees.
 *
 * Both sides must already be canonically packed — the caller is responsible
 * for staging a raw source tree through the same packer first, or the result
 * is the noise this module exists to avoid.
 */
export function diffPackageTrees(
    left: PackageEntry[],
    right: PackageEntry[],
): PackageDiff {
    const a = entriesToMap(left);
    const b = entriesToMap(right);

    const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
    const patches: FilePatch[] = [];

    for (const p of paths) {
        const oldBuf = a.get(p);
        const newBuf = b.get(p);
        if (oldBuf && newBuf && oldBuf.equals(newBuf)) continue;   // unchanged

        const status: FilePatch["status"] = !oldBuf ? "added" : !newBuf ? "removed" : "modified";
        const probe = newBuf ?? oldBuf!;
        if (looksBinary(probe)) {
            patches.push({ path: p, status, diff: null, binary: true, note: "binary file — content not shown" });
            continue;
        }
        if ((oldBuf?.length ?? 0) > DIFF_MAX_FILE_BYTES || (newBuf?.length ?? 0) > DIFF_MAX_FILE_BYTES) {
            patches.push({
                path: p, status, diff: null,
                note: `file exceeds the ${DIFF_MAX_FILE_BYTES}-byte diff cap — content not shown`,
            });
            continue;
        }
        const diff = unifiedDiff(oldBuf?.toString("utf8") ?? "", newBuf?.toString("utf8") ?? "", p);
        patches.push({ path: p, status, diff: diff || null, ...(diff ? {} : { note: "no textual change" }) });
    }

    // `identical` is deliberately about CONTENT, not about the patch list
    // being empty — a set consisting only of unshowable binaries is still a
    // real difference, and the cron loop must not treat it as a no-op.
    const identical = patches.length === 0;

    if (patches.length > DIFF_MAX_FILES) {
        const omitted = patches.length - DIFF_MAX_FILES;
        return { identical, patches: patches.slice(0, DIFF_MAX_FILES), truncated: { omitted } };
    }
    return { identical, patches };
}

/**
 * Render a diff as ordered `.patch` artifacts.
 *
 * The numeric prefix is what makes the portal's existing artifact list show
 * them in intent order rather than alphabetically; it already renders
 * `.patch` files with gutter markers, so this needs no client work.
 */
export function patchArtifacts(diff: PackageDiff, opts: { baseSemver?: string } = {}): Array<{ filename: string; content: string }> {
    const width = String(diff.patches.length).length;
    return diff.patches.map((patch, index) => {
        const seq = String(index + 1).padStart(Math.max(2, width), "0");
        const flat = patch.path.replace(/[^A-Za-z0-9._-]+/g, "_");
        const header = [
            `# ${patch.status}: ${patch.path}`,
            opts.baseSemver ? `# base: ${opts.baseSemver}` : null,
            patch.note ? `# note: ${patch.note}` : null,
            "",
        ].filter((l) => l !== null).join("\n");
        return { filename: `${seq}-${flat}.patch`, content: `${header}${patch.diff ?? ""}\n` };
    });
}
