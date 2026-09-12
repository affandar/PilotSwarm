// Synthetic loaded definitions: no production packages, credentials, or tools
// are used. Feed these through the same caller-visible discovery as the worker.
const local = (name, description, tools, namespace = "eval") => ({ name, description, tools, namespace, prompt: "Synthetic evaluation role." });
const published = (name, description, tools, scope = "shared", subject) => ({
    ...local(name, description, tools),
    packageId: `eval-${scope}-${subject || "shared"}-${name}`,
    packageScope: scope,
    ...(subject && { packageOwner: { provider: "eval", subject } }),
});

export function delegationCatalogDefinitions(profile = "basic") {
    const basic = [
        local("deepwiki", "Answers questions about public GitHub repositories using a hosted DeepWiki knowledge index. It does not inspect private repositories or local uncommitted files.", ["deepwiki_query"]),
        published("generic-crawler", "Consultative crawler that scopes a documentation source, designs fact and graph schemas, pilots and ingests a corpus, and keeps it fresh.", ["crawl_source", "store_fact"]),
    ];
    if (profile === "basic") return basic;
    if (profile !== "specialists") throw new Error(`Unknown catalog profile: ${profile}`);
    return [
        ...basic,
        local("incident-index", "Searches a curated incident archive and correlates prior outage causes from the incident service. Does not access source code, issue trackers, or CI runs.", ["incident_search", "incident_timeline"]),
        published("incident-review", "Reviews incident response documentation in public GitHub repositories through their hosted documentation index. Does not access actual incident records.", ["deepwiki_query"]),
        published("release-watch", "Monitors deployment promotions and release approvals in the shared release service. Cannot read build logs or CI check runs.", ["release_events"]),
        published("build-sentinel", "Investigates CI failures using check runs and build logs for repositories available to the caller; can monitor checks and report regressions over time.", ["ci_checks", "ci_logs"]),
        published("release-watch", "Examines private CI build failures from the caller's personal development projects, with access to the caller's check-run logs. Does not access shared deployment approvals.", ["ci_checks", "ci_logs"], "user", "alice"),
        published("payroll-auditor", "Reconciles payroll export ledgers in a private finance workspace. Not available to other users.", ["payroll_ledger"], "user", "bob"),
    ];
}
