/**
 * Deep-link parsing for agent-package sources: the Add-package dialog takes
 * ONE link — to plugin.json or the folder containing it — and this derives
 * the {kind, repoUrl, ref, path} triple the source registry stores.
 *
 * Recognized shapes:
 *   https://github.com/ORG/REPO
 *   https://github.com/ORG/REPO/(blob|tree)/REF[/PATH…]
 *   https://dev.azure.com/ORG/PROJECT/_git/REPO[?path=/P][&version=GBref]
 *   https://ORG.visualstudio.com/PROJECT/_git/REPO[?path=…&version=…]
 *
 * GitHub URLs cannot distinguish a branch containing "/" from the leading
 * path segment; the first segment after blob|tree is taken as the ref.
 */
export function parseAgentSourceLink(raw) {
    const text = String(raw || "").trim();
    if (!text) return { error: "Paste a link to plugin.json or the folder that contains it." };
    let url;
    try {
        url = new URL(text);
    } catch {
        return { error: "That does not look like a URL — paste the browser link to plugin.json or its folder." };
    }
    const host = url.hostname.toLowerCase();

    if (host === "github.com" || host === "www.github.com") {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length < 2) return { error: "GitHub links need at least github.com/org/repo." };
        const [org, repoRaw, marker, ref, ...rest] = segments;
        const repo = repoRaw.replace(/\.git$/u, "");
        const repoUrl = `https://github.com/${org}/${repo}`;
        if (!marker) return { kind: "github", repoUrl, ref: null, path: null };
        if (marker !== "blob" && marker !== "tree") {
            return { error: `Unrecognized GitHub link shape (…/${marker}/…) — use a /blob/ or /tree/ link, or the bare repo URL.` };
        }
        if (!ref) return { error: "That GitHub link is missing the branch segment." };
        return { kind: "github", repoUrl, ref, path: rest.length ? `/${rest.join("/")}` : null };
    }

    const isAdoHost = host === "dev.azure.com" || host.endsWith(".visualstudio.com");
    if (isAdoHost) {
        if (!url.pathname.includes("/_git/")) {
            return { error: "Azure DevOps links must point at a repo (…/_git/<repo>…)." };
        }
        const repoUrl = `${url.origin}${url.pathname.split("?")[0]}`.replace(/\/$/u, "");
        const pathParam = url.searchParams.get("path");
        const versionParam = url.searchParams.get("version");
        // version encodes the ref kind in a two-letter prefix: GB=branch, GT=tag.
        const ref = versionParam && /^G[BT]/u.test(versionParam) ? versionParam.slice(2) : (versionParam || null);
        return { kind: "ado", repoUrl, ref, path: pathParam || null };
    }

    return { error: "Only GitHub and Azure DevOps links are recognized here — for a tarball use the URL tab." };
}
