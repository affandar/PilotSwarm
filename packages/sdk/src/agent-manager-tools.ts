/**
 * The Agent Manager write bundle — package mutation, diffing and import.
 *
 * Kept out of `inspect-tools.ts` deliberately: that file is the READ surface
 * and its grep-guard reasons about session-scoped reads. These tools are
 * package-scoped and mutating, with a different authorization story
 * (creator-or-admin on the package, not visibility on a session), and mixing
 * the two would blur which rule applies where.
 *
 * **Authorization is not implemented here.** Every mutation calls the same
 * `agent-package-service` / catalog functions the Web API calls, which enforce
 * creator-or-admin inside the database with a row lock. That is the whole
 * point of §4: one authz implementation serving portal, CLI, MCP and the
 * manager, so a tool cannot become a side door.
 *
 * @module
 */

import type { Tool } from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionCatalog, AgentPackageSelector, AgentPrincipal } from "./cms.js";
import type { ArtifactStore } from "./session-store.js";
import { readAgentPackageTarGz } from "./agent-package-format.js";
import { fetchAgentPackageTarGz, publishAgentPackageDir } from "./agent-package-service.js";
import { diffPackageTrees, patchArtifacts, entriesToMap } from "./agent-package-diff.js";
import { guardedImportFetch } from "./agent-package-import-fetch.js";
import { loadImportPolicy, type ImportPolicy } from "./agent-package-import-policy.js";
import { parseAgentFqn } from "./agent-fqn.js";

/**
 * Staging lives in ONE session artifact rather than N.
 *
 * Durable (so it survives the session moving workers), atomic (a half-written
 * edit is not a thing), and visible to a human in the portal's artifact list
 * while they are deciding whether to approve it.
 */
export const STAGING_ARTIFACT = "agent-package-staging.json";

/** The changelog every package carries. Read before editing, appended on publish. */
export const CHANGELOG_PATH = "CHANGELOG.md";

interface StagedEdit {
    package: string;
    fromSemver: string | null;
    /** path → UTF-8 content. Authored content is text; binaries are not authorable. */
    files: Record<string, string>;
}

export interface AgentManagerViewer {
    provider: string;
    subject: string;
    isAdmin: boolean;
    isSystemPrincipal: boolean;
}

export interface CreateAgentManagerToolsOptions {
    catalog: SessionCatalog;
    artifactStore?: ArtifactStore | null;
    /** Resolved per invocation, exactly as the read bundle does. */
    resolveViewer: () => Promise<AgentManagerViewer>;
    /** Injectable for tests; loaded from the deployment config otherwise. */
    importPolicy?: ImportPolicy;
    /** Session id used to attach patch artifacts. */
    sessionId?: string;
}

/** Turn an FQN into a registry selector, or explain why it cannot be one. */
export function selectorFromReference(reference: string, viewer: AgentManagerViewer): {
    name: string;
    selector: AgentPackageSelector | null;
    semver?: string;
    error?: string;
} {
    const fqn = parseAgentFqn(reference);
    switch (fqn.kind) {
        case "bare":
            // No selector = resolve own-then-shared, the same rule agent
            // binding uses. "Edit X" therefore means the same X that "run X"
            // would have used.
            return { name: fqn.name, selector: null };
        case "shared":
            return { name: fqn.name, selector: { scope: "shared" }, semver: fqn.semver };
        case "owner":
        case "ambiguous":
            // An owner FQN names a PERSON, and people are resolved to
            // (provider, subject) once — never re-resolved later (§15 A8).
            // Only the viewer's own reference is resolvable without a
            // directory lookup, so that is all this accepts for now.
            if (fqn.ownerRef && (fqn.ownerRef === viewer.subject || fqn.ownerRef === "me")) {
                return {
                    name: fqn.name,
                    selector: { scope: "user", owner: { provider: viewer.provider, subject: viewer.subject } },
                    semver: fqn.semver,
                };
            }
            return {
                name: fqn.name,
                selector: null,
                error:
                    `"${reference}" names another owner. Package operations act on your own copy or the shared one; `
                    + `use __shared:${fqn.name} for the deployment copy.`,
            };
        default:
            return { name: "", selector: null, error: fqn.reason ?? "unusable package reference" };
    }
}

const principalOf = (viewer: AgentManagerViewer): AgentPrincipal | null =>
    viewer.provider && viewer.subject ? { provider: viewer.provider, subject: viewer.subject } : null;

export function createAgentManagerTools(opts: CreateAgentManagerToolsOptions): Tool<any>[] {
    const { catalog, artifactStore, resolveViewer } = opts;
    let cachedPolicy: ImportPolicy | null = opts.importPolicy ?? null;
    const policy = (): ImportPolicy => {
        // Loaded lazily and cached: a malformed config throws, and throwing at
        // worker construction would take the whole worker down for a feature
        // nobody may be using.
        if (!cachedPolicy) cachedPolicy = loadImportPolicy({ configDir: process.cwd() });
        return cachedPolicy;
    };

    /** Read a package's active (or named) version as tar entries. */
    const entriesForVersion = async (name: string, selector: AgentPackageSelector | null, semver: string | undefined, viewer: AgentManagerViewer) => {
        const detail = await catalog.getAgentPackage(name, principalOf(viewer), viewer.isAdmin, selector);
        if (!detail) return { error: `package "${name}" not found, or not visible to you.` };
        const version = semver
            ? detail.versions.find((v) => v.semver === semver)
            : detail.versions.find((v) => v.versionId === detail.activeVersionId) ?? detail.versions[0];
        if (!version) return { error: semver ? `${name}@${semver} is not a published version.` : `package "${name}" has no versions.` };
        if (!artifactStore) return { error: "no artifact store is configured on this worker." };
        const targz = await fetchAgentPackageTarGz(artifactStore, version.artifactFilename, version.sha256);
        return { entries: readAgentPackageTarGz(targz), version, detail };
    };

    const listAgentPackagesTool = defineTool("list_agent_packages", {
        description:
            "List agent packages you can see: the shared ones plus your own. "
            + "`shadowed` marks a shared package your own copy is currently overriding.",
        parameters: { type: "object" as const, properties: {}, required: [] },
        handler: async () => {
            const viewer = await resolveViewer();
            try {
                const rows = await catalog.listAgentPackages(principalOf(viewer), viewer.isAdmin);
                return {
                    packages: rows.map((p) => ({
                        name: p.name, scope: p.scope, enabled: p.enabled, shadowed: p.shadowed,
                        owner: p.owner ? `${p.owner.provider}:${p.owner.subject}` : null,
                        activeSemver: p.active?.semver ?? null,
                        sha256: p.active?.sha256 ?? null,
                    })),
                };
            } catch (err: any) {
                return { error: `list_agent_packages: ${err?.message || String(err)}` };
            }
        },
    });

    const readAgentPackageTool = defineTool("read_agent_package", {
        description:
            "One package with its full version history. Accepts a bare name (your copy, else shared) "
            + "or `__shared:<name>` to reach the deployment copy past your own.",
        parameters: {
            type: "object" as const,
            properties: { package: { type: "string", description: "Package name or __shared:<name>." } },
            required: ["package"],
        },
        handler: async (args: { package: string }) => {
            const viewer = await resolveViewer();
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `read_agent_package: ${ref.error}` };
            try {
                const detail = await catalog.getAgentPackage(ref.name, principalOf(viewer), viewer.isAdmin, ref.selector);
                if (!detail) return { error: `read_agent_package: "${ref.name}" not found, or not visible to you.` };
                return {
                    name: detail.name, scope: detail.scope, enabled: detail.enabled,
                    owner: detail.owner ? `${detail.owner.provider}:${detail.owner.subject}` : null,
                    activeVersionId: detail.activeVersionId,
                    versions: detail.versions.map((v) => ({
                        semver: v.semver, sha256: v.sha256, sizeBytes: v.sizeBytes,
                        createdAt: v.createdAt?.toISOString?.() ?? null, createdBy: v.createdBy,
                    })),
                };
            } catch (err: any) {
                return { error: `read_agent_package: ${err?.message || String(err)}` };
            }
        },
    });

    const diffAgentVersionsTool = defineTool("diff_agent_versions", {
        description:
            "Compare two package versions and return one unified diff per changed file. "
            + "Comparison happens AFTER canonical packing, so the packer's own file reshuffling never appears — "
            + "an empty diff therefore means genuinely nothing changed. "
            + "Use it to see what changed between versions, or how your copy differs from the shared one.",
        parameters: {
            type: "object" as const,
            properties: {
                left: { type: "string", description: "Package reference, e.g. `my-agent` or `__shared:my-agent`." },
                left_semver: { type: "string", description: "Version on the left. Defaults to active." },
                right: { type: "string", description: "Package reference for the right side. Defaults to `left`." },
                right_semver: { type: "string", description: "Version on the right. Defaults to active." },
            },
            required: ["left"],
        },
        handler: async (args: { left: string; left_semver?: string; right?: string; right_semver?: string }) => {
            const viewer = await resolveViewer();
            const leftRef = selectorFromReference(args.left, viewer);
            if (leftRef.error) return { error: `diff_agent_versions: ${leftRef.error}` };
            const rightRef = selectorFromReference(args.right ?? args.left, viewer);
            if (rightRef.error) return { error: `diff_agent_versions: ${rightRef.error}` };
            try {
                const left = await entriesForVersion(leftRef.name, leftRef.selector, args.left_semver ?? leftRef.semver, viewer);
                if ("error" in left) return { error: `diff_agent_versions (left): ${left.error}` };
                const right = await entriesForVersion(rightRef.name, rightRef.selector, args.right_semver ?? rightRef.semver, viewer);
                if ("error" in right) return { error: `diff_agent_versions (right): ${right.error}` };

                // Identity is a hash compare, not a diff — packages are
                // content-addressed, so this is free.
                if (left.version.sha256 === right.version.sha256) {
                    return { identical: true, note: "both sides are the same content (identical sha256).", patches: [] };
                }
                const diff = diffPackageTrees(left.entries, right.entries);
                return {
                    identical: diff.identical,
                    left: `${leftRef.name}@${left.version.semver}`,
                    right: `${rightRef.name}@${right.version.semver}`,
                    truncated: diff.truncated ?? undefined,
                    patches: diff.patches.map((p) => ({ path: p.path, status: p.status, note: p.note, diff: p.diff })),
                };
            } catch (err: any) {
                return { error: `diff_agent_versions: ${err?.message || String(err)}` };
            }
        },
    });

    const proposeAgentPatchTool = defineTool("propose_agent_patch", {
        description:
            "Render the change as ordered `.patch` artifacts on this session so a human can review the real diff "
            + "in the portal before anything is published. "
            + "With no `to_semver`, diffs your STAGED edit against the live version — this is the normal path: "
            + "stage, propose, show the human, wait for approval, then publish.",
        parameters: {
            type: "object" as const,
            properties: {
                package: { type: "string" },
                from_semver: { type: "string", description: "Base version. Defaults to active." },
                to_semver: { type: "string", description: "Compare against this published version instead of your staged edit." },
            },
            required: ["package"],
        },
        handler: async (args: { package: string; from_semver?: string; to_semver?: string }) => {
            const viewer = await resolveViewer();
            if (!opts.sessionId) return { error: "propose_agent_patch: no session to attach artifacts to." };
            if (!artifactStore) return { error: "propose_agent_patch: no artifact store is configured." };
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `propose_agent_patch: ${ref.error}` };
            try {
                const from = await entriesForVersion(ref.name, ref.selector, args.from_semver, viewer);
                const baseEntries = "error" in from ? [] : from.entries;
                const baseSemver = "error" in from ? null : from.version.semver;
                // A brand-new package has no base; that is an all-added diff,
                // not an error.
                if ("error" in from && args.to_semver) return { error: `propose_agent_patch (base): ${from.error}` };

                let toEntries;
                let label: string;
                if (args.to_semver) {
                    const to = await entriesForVersion(ref.name, ref.selector, args.to_semver, viewer);
                    if ("error" in to) return { error: `propose_agent_patch (target): ${to.error}` };
                    toEntries = to.entries;
                    label = `${ref.name}@${args.to_semver}`;
                } else {
                    const staged = await loadStaging();
                    if (!staged || staged.package !== ref.name) {
                        return { error: `propose_agent_patch: nothing staged for "${ref.name}". Use stage_agent_package_edit first.` };
                    }
                    toEntries = Object.entries(staged.files).map(([p, content]) => ({ path: p, content: Buffer.from(content, "utf8") })) as any;
                    label = "staged edit";
                }

                const diff = diffPackageTrees(baseEntries, toEntries);
                if (diff.identical) return { written: 0, note: "no differences — nothing to propose." };

                const artifacts = patchArtifacts(diff, { baseSemver: baseSemver ?? "(new package)" });
                for (const artifact of artifacts) {
                    await artifactStore.uploadArtifact(
                        opts.sessionId, artifact.filename,
                        Buffer.from(artifact.content, "utf8"), "text/x-diff",
                    );
                }
                const changelogTouched = diff.patches.some((p) => p.path === CHANGELOG_PATH);
                return {
                    written: artifacts.length,
                    base: baseSemver ?? "(new package)",
                    proposed: label,
                    files: artifacts.map((a) => a.filename),
                    changelogUpdated: changelogTouched,
                    ...(changelogTouched ? {} : { warning: `This change does not touch ${CHANGELOG_PATH}. Add an entry before publishing.` }),
                    next: "Show the human what changed and why, point them at these artifacts, and WAIT for an explicit approval before publish_agent_package.",
                };
            } catch (err: any) {
                return { error: `propose_agent_patch: ${err?.message || String(err)}` };
            }
        },
    });

    // ── Authoring ────────────────────────────────────────────────────────

    /** Load the session's staged edit, or null when nothing is staged. */
    const loadStaging = async (): Promise<StagedEdit | null> => {
        if (!artifactStore || !opts.sessionId) return null;
        try {
            const text = await artifactStore.downloadArtifactText(opts.sessionId, STAGING_ARTIFACT);
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object") return null;
            return parsed as StagedEdit;
        } catch {
            return null;
        }
    };

    const saveStaging = async (staged: StagedEdit): Promise<void> => {
        await artifactStore!.uploadArtifact(
            opts.sessionId!, STAGING_ARTIFACT,
            Buffer.from(JSON.stringify(staged, null, 2), "utf8"), "application/json",
        );
    };

    const readAgentPackageFileTool = defineTool("read_agent_package_file", {
        description:
            "Read ONE file out of a package version — an agent prompt, a skill, plugin.json, or CHANGELOG.md. "
            + "Read CHANGELOG.md before editing: it is where previous changes and their reasons are recorded.",
        parameters: {
            type: "object" as const,
            properties: {
                package: { type: "string" },
                path: { type: "string", description: "Path inside the package, e.g. `agents/triager.agent.md`." },
                semver: { type: "string", description: "Defaults to the active version." },
            },
            required: ["package", "path"],
        },
        handler: async (args: { package: string; path: string; semver?: string }) => {
            const viewer = await resolveViewer();
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `read_agent_package_file: ${ref.error}` };
            try {
                const got = await entriesForVersion(ref.name, ref.selector, args.semver ?? ref.semver, viewer);
                if ("error" in got) return { error: `read_agent_package_file: ${got.error}` };
                const map = entriesToMap(got.entries);
                const buf = map.get(args.path.replace(/^\.\//, ""));
                if (!buf) {
                    return {
                        error: `read_agent_package_file: "${args.path}" is not in ${ref.name}@${got.version.semver}.`,
                        available: [...map.keys()].slice(0, 50),
                    };
                }
                if (buf.includes(0)) return { error: `read_agent_package_file: "${args.path}" is binary.` };
                return { path: args.path, semver: got.version.semver, content: buf.toString("utf8") };
            } catch (err: any) {
                return { error: `read_agent_package_file: ${err?.message || String(err)}` };
            }
        },
    });

    const stageAgentPackageEditTool = defineTool("stage_agent_package_edit", {
        description:
            "Stage package content for a new version. Call with `from_package` to seed staging from a real "
            + "published version (the bytes actually running) and edit from there; call without it to author a "
            + "brand-new package from an empty staging area. Repeat calls accumulate. "
            + "Staging is written to a session artifact, so a human can see it while deciding. "
            + "Nothing is published until you call publish_agent_package.",
        parameters: {
            type: "object" as const,
            properties: {
                package: { type: "string", description: "Package name this edit is for." },
                from_package: { type: "string", description: "Seed staging from this package's content. Omit for a brand-new package." },
                from_semver: { type: "string", description: "Version to seed from. Defaults to active." },
                files: {
                    type: "object",
                    description: "Map of path → full file content, e.g. {\"agents/x.agent.md\": \"---\\nname: x\\n---\\n...\"}. Replaces the whole file.",
                    additionalProperties: { type: "string" },
                },
                remove: { type: "array", items: { type: "string" }, description: "Paths to delete from the staged tree." },
                reset: { type: "boolean", description: "Discard existing staging first." },
            },
            required: ["package"],
        },
        handler: async (args: { package: string; from_package?: string; from_semver?: string; files?: Record<string, string>; remove?: string[]; reset?: boolean }) => {
            const viewer = await resolveViewer();
            if (!artifactStore || !opts.sessionId) return { error: "stage_agent_package_edit: no artifact store on this session." };
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `stage_agent_package_edit: ${ref.error}` };
            try {
                let staged = args.reset ? null : await loadStaging();
                if (!staged || staged.package !== ref.name) {
                    staged = { package: ref.name, fromSemver: null, files: {} };
                }

                if (args.from_package) {
                    const seedRef = selectorFromReference(args.from_package, viewer);
                    if (seedRef.error) return { error: `stage_agent_package_edit: ${seedRef.error}` };
                    const seed = await entriesForVersion(seedRef.name, seedRef.selector, args.from_semver ?? seedRef.semver, viewer);
                    if ("error" in seed) return { error: `stage_agent_package_edit (seed): ${seed.error}` };
                    // Seed from the REAL bytes. Anything the agent cannot read
                    // as text is skipped rather than silently corrupted.
                    for (const [p, buf] of entriesToMap(seed.entries)) {
                        if (!buf.includes(0)) staged.files[p] = buf.toString("utf8");
                    }
                    staged.fromSemver = seed.version.semver;
                }

                for (const [p, content] of Object.entries(args.files ?? {})) {
                    staged.files[p.replace(/^\.\//, "")] = String(content);
                }
                for (const p of args.remove ?? []) delete staged.files[p.replace(/^\.\//, "")];

                await saveStaging(staged);
                return {
                    package: staged.package,
                    seededFrom: staged.fromSemver,
                    files: Object.keys(staged.files).sort(),
                    hasChangelog: Boolean(staged.files[CHANGELOG_PATH]),
                    note: staged.files[CHANGELOG_PATH]
                        ? undefined
                        : `No ${CHANGELOG_PATH} staged yet — add one describing this change, signed as Agent Manager.`,
                };
            } catch (err: any) {
                return { error: `stage_agent_package_edit: ${err?.message || String(err)}` };
            }
        },
    });

    const publishAgentPackageTool = defineTool("publish_agent_package", {
        description:
            "Publish the staged edit as a new version. ONLY call this after you have shown the human the diff "
            + "from propose_agent_patch and they have explicitly approved it. "
            + "Requires a CHANGELOG.md entry for this version. Published versions are immutable — bump the semver.",
        parameters: {
            type: "object" as const,
            properties: {
                package: { type: "string" },
                semver: { type: "string", description: "New version, e.g. 1.3.0. Must be greater than the active one." },
                scope: { type: "string", enum: ["user", "shared"], description: "Defaults to user (your own copy)." },
                approved_by: { type: "string", description: "Who approved this publish. Recorded in provenance." },
            },
            required: ["package", "semver", "approved_by"],
        },
        handler: async (args: { package: string; semver: string; scope?: "user" | "shared"; approved_by: string }) => {
            const viewer = await resolveViewer();
            if (!artifactStore || !opts.sessionId) return { error: "publish_agent_package: no artifact store on this session." };
            const staged = await loadStaging();
            if (!staged) return { error: "publish_agent_package: nothing staged. Use stage_agent_package_edit first." };
            if (Object.keys(staged.files).length === 0) return { error: "publish_agent_package: the staged tree is empty." };

            // The changelog is part of the package, and this version has to be
            // in it. Refusing here is what keeps the history from drifting
            // away from what was actually shipped.
            const changelog = staged.files[CHANGELOG_PATH];
            if (!changelog) {
                return { error: `publish_agent_package: no ${CHANGELOG_PATH} staged. Add one with an entry for ${args.semver}, signed as Agent Manager.` };
            }
            if (!changelog.includes(args.semver)) {
                return { error: `publish_agent_package: ${CHANGELOG_PATH} has no entry for ${args.semver}. Add one before publishing.` };
            }

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-publish-"));
            try {
                for (const [rel, content] of Object.entries(staged.files)) {
                    // Containment check: a staged path is model-authored, and
                    // `..` in it would write outside the staging root.
                    const target = path.resolve(dir, rel);
                    if (!target.startsWith(path.resolve(dir) + path.sep)) {
                        return { error: `publish_agent_package: staged path "${rel}" escapes the package root.` };
                    }
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, content, "utf8");
                }

                const owner = principalOf(viewer);
                const outcome = await publishAgentPackageDir(
                    { catalog, artifactStore },
                    {
                        dir,
                        scope: args.scope === "shared" ? "shared" : "user",
                        owner,
                        // Provenance: a reader must be able to tell an
                        // agent-authored version from a human `agents push`.
                        createdBy: `agent-manager (approved by ${args.approved_by})`,
                        isAdmin: viewer.isAdmin,
                        name: staged.package,
                        semver: args.semver,
                    } as any,
                );
                await artifactStore.deleteArtifact(opts.sessionId, STAGING_ARTIFACT).catch(() => {});
                return {
                    status: (outcome as any)?.status ?? "published",
                    package: staged.package,
                    semver: args.semver,
                    scope: args.scope === "shared" ? "shared" : "user",
                    approvedBy: args.approved_by,
                    note: "Published. The fleet converges on the next registry poll — verify before regenerating anything onto it.",
                };
            } catch (err: any) {
                return { error: `publish_agent_package: ${err?.message || String(err)}` };
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
    });

    const setEnabledTool = defineTool("set_agent_package_enabled", {
        description:
            "Enable or disable a package copy. Disabling YOUR copy of a shared package is the recovery path: "
            + "resolution falls back to the shared one. Creator-or-admin, enforced server-side.",
        parameters: {
            type: "object" as const,
            properties: { package: { type: "string" }, enabled: { type: "boolean" } },
            required: ["package", "enabled"],
        },
        handler: async (args: { package: string; enabled: boolean }) => {
            const viewer = await resolveViewer();
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `set_agent_package_enabled: ${ref.error}` };
            try {
                await catalog.setAgentPackageEnabled(ref.name, args.enabled, principalOf(viewer), viewer.isAdmin, ref.selector);
                return { ok: true, package: ref.name, enabled: args.enabled };
            } catch (err: any) {
                return { error: `set_agent_package_enabled: ${err?.message || String(err)}` };
            }
        },
    });

    const pinVersionTool = defineTool("pin_agent_package_version", {
        description:
            "Pin a package's active version — the rollback control. The fleet converges on the next registry poll. "
            + "Creator-or-admin, enforced server-side.",
        parameters: {
            type: "object" as const,
            properties: { package: { type: "string" }, semver: { type: "string" } },
            required: ["package", "semver"],
        },
        handler: async (args: { package: string; semver: string }) => {
            const viewer = await resolveViewer();
            const ref = selectorFromReference(args.package, viewer);
            if (ref.error) return { error: `pin_agent_package_version: ${ref.error}` };
            try {
                await catalog.pinAgentPackageVersion(ref.name, args.semver, principalOf(viewer), viewer.isAdmin, ref.selector);
                return { ok: true, package: ref.name, pinned: args.semver };
            } catch (err: any) {
                return { error: `pin_agent_package_version: ${err?.message || String(err)}` };
            }
        },
    });

    const importAgentPackageTool = defineTool("import_agent_package", {
        description:
            "Fetch a package from an ALLOWLISTED origin and report what importing it would change. "
            + "Only origins the deployment has named can be reached; anything else is refused without a request being made. "
            + "`dry_run` (the default) publishes nothing — it answers 'is there anything new?'.",
        parameters: {
            type: "object" as const,
            properties: {
                url: { type: "string", description: "https URL of a packed agent package." },
                compare_to: { type: "string", description: "Package name to diff against. Defaults to none." },
                dry_run: { type: "boolean", description: "Default true. When true, nothing is written." },
            },
            required: ["url"],
        },
        handler: async (args: { url: string; compare_to?: string; dry_run?: boolean }) => {
            const viewer = await resolveViewer();
            const dryRun = args.dry_run !== false;
            try {
                const fetched = await guardedImportFetch(args.url, policy());
                const entries = readAgentPackageTarGz(fetched.bytes);

                let comparison: unknown = undefined;
                if (args.compare_to) {
                    const ref = selectorFromReference(args.compare_to, viewer);
                    if (ref.error) return { error: `import_agent_package: ${ref.error}` };
                    const current = await entriesForVersion(ref.name, ref.selector, undefined, viewer);
                    if (!("error" in current)) {
                        const diff = diffPackageTrees(current.entries, entries);
                        comparison = {
                            identical: diff.identical,
                            changedFiles: diff.patches.length,
                            patches: diff.patches.map((p) => ({ path: p.path, status: p.status, diff: p.diff })),
                        };
                    }
                }

                return {
                    fetched: { url: fetched.finalUrl, hops: fetched.hops, bytes: fetched.bytes.length, files: entries.length },
                    dryRun,
                    ...(comparison ? { comparison } : {}),
                    ...(dryRun ? { note: "dry run — nothing was published." } : {}),
                };
            } catch (err: any) {
                // A denied import is a security signal: it is what a prompt
                // injection looks like from the outside. The reason names the
                // URL and how to extend the list, and NEVER carries a body.
                return { error: `import_agent_package: ${err?.message || String(err)}` };
            }
        },
    });

    return [
        listAgentPackagesTool,
        readAgentPackageTool,
        readAgentPackageFileTool,
        stageAgentPackageEditTool,
        diffAgentVersionsTool,
        proposeAgentPatchTool,
        publishAgentPackageTool,
        setEnabledTool,
        pinVersionTool,
        importAgentPackageTool,
    ];
}
