export function jobGeneratorTreeRowKey(kind, generatorId, jobId, transitionId) {
    if (kind === "generator") return `generator:${generatorId}`;
    if (kind === "job") return `job:${generatorId}:${jobId}`;
    if (kind === "transition") {
        return `transition:${generatorId}:${jobId}:${transitionId}`;
    }
    return null;
}

export function jobGeneratorTreeSelectionKey(selected) {
    return jobGeneratorTreeRowKey(
        selected?.kind,
        selected?.generatorId,
        selected?.jobId,
        selected?.transitionId,
    );
}

export function buildVisibleJobGeneratorTreeRows(
    generators,
    expandedGeneratorIds,
    expandedJobIds,
) {
    const rows = [];
    for (const generator of generators || []) {
        const generatorKey = jobGeneratorTreeRowKey("generator", generator.id);
        const generatorExpanded = expandedGeneratorIds.has(generator.id);
        rows.push({
            key: generatorKey,
            kind: "generator",
            generatorId: generator.id,
            parentKey: null,
            depth: 1,
            expanded: generatorExpanded,
            hasChildren: generator.jobs.length > 0,
        });
        if (!generatorExpanded) continue;

        for (const job of generator.jobs) {
            const jobKey = jobGeneratorTreeRowKey("job", generator.id, job.id);
            const jobExpanded = expandedJobIds.has(job.id);
            rows.push({
                key: jobKey,
                kind: "job",
                generatorId: generator.id,
                jobId: job.id,
                parentKey: generatorKey,
                depth: 2,
                expanded: jobExpanded,
                hasChildren: job.transitions.length > 0,
            });
            if (!jobExpanded) continue;

            for (const transition of job.transitions) {
                rows.push({
                    key: jobGeneratorTreeRowKey(
                        "transition",
                        generator.id,
                        job.id,
                        transition.id,
                    ),
                    kind: "transition",
                    generatorId: generator.id,
                    jobId: job.id,
                    transitionId: transition.id,
                    parentKey: jobKey,
                    depth: 3,
                    expanded: false,
                    hasChildren: false,
                });
            }
        }
    }
    return rows;
}

export function navigateJobGeneratorTree(rows, selectedKey, key) {
    if (!rows.length) return null;
    const currentIndex = rows.findIndex((row) => row.key === selectedKey);
    if (currentIndex < 0) {
        if (key === "ArrowUp") return { type: "select", row: rows[rows.length - 1] };
        if (key === "ArrowDown" || key === "ArrowRight") {
            return { type: "select", row: rows[0] };
        }
        return null;
    }

    const current = rows[currentIndex];
    if (key === "ArrowUp") {
        return currentIndex > 0 ? { type: "select", row: rows[currentIndex - 1] } : null;
    }
    if (key === "ArrowDown") {
        return currentIndex < rows.length - 1
            ? { type: "select", row: rows[currentIndex + 1] }
            : null;
    }
    if (key === "ArrowRight") {
        if (current.hasChildren && !current.expanded) {
            return { type: "expand", row: current };
        }
        const child = rows[currentIndex + 1];
        return child?.parentKey === current.key ? { type: "select", row: child } : null;
    }
    if (key === "ArrowLeft") {
        if (current.hasChildren && current.expanded) {
            return { type: "collapse", row: current };
        }
        const parent = rows.find((row) => row.key === current.parentKey);
        return parent ? { type: "select", row: parent } : null;
    }
    return null;
}
