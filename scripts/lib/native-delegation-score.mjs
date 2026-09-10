const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;

function withoutQuotedExamples(text) {
    return text
        .replace(/\b(\w+)n['’]t\b/gi, "$1 not")
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
        .replace(/^\s*>.*$/gm, " ")
        .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/g, " ")
        // Preserve inline tool/profile names, but not quoted imperative prose.
        // A bare tool example still lacks the required surrounding directive.
        .replace(/`([^`\n]*)`/g, (_, code) => /^(?:task(?:\s*\([\s\S]*\))?|swarm-(?:explore|task))$/.test(code.trim()) ? code : " ");
}

function childAssignmentRequestsNative(args) {
    const contract = isRecord(args.contract) ? args.contract : {};
    // Titles, metadata, artifact names, and quoted user requests are context,
    // not instructions delivered to the child.
    const instructions = [args.task, contract.purpose,
        ...(Array.isArray(contract.successCriteria) ? contract.successCriteria : [])]
        .filter(nonempty);
    let affirmative = false;
    for (const instruction of instructions) {
        const clauses = withoutQuotedExamples(instruction).split(/[.!?;\n]+/);
        for (const clause of clauses) {
            const mentions = clause.matchAll(/\bnative(?:\s+(?:local|sync|synchronous|investigation|research))*\s+(?:tasks?|sub-?agents?|work)\b|\btask\s*\(|\bswarm-(?:explore|task)\b/gi);
            for (const mention of mentions) {
                const before = clause.slice(0, mention.index);
                const after = clause.slice(mention.index + mention[0].length);
                // A reported request alone is not a directive, even when it
                // contains imperative wording without quotation marks.
                if (/\b(?:user|parent|request|prompt|example|instruction)\b[\s\S]*\b(?:said|says|asked|asks|requested|requests|wants?|wanted|reads?|states?|was|is)\b/i.test(before)
                    || /\b(?:user intent|user request|original prompt|quoted request)\b/i.test(before)) continue;
                const prohibited = /\b(?:not|never|no|avoid|without|refrain|prohibit|forbid|forbidden|instead\s+of|rather\s+than)\b/i.test(before)
                    || /^\s+(?:are|is|must\s+be|should\s+be)\s+(?:not\s+(?:allowed|permitted|required)|forbidden|prohibited|disabled|unavailable)\b/i.test(after);
                // Contradictory assignment/contract instructions are a review
                // failure, rather than letting an affirmative keyword win.
                if (prohibited) return false;
                if (/\b(?:use[sd]?|using|run[s]?|running|launch(?:es)?|invoke[sd]?|call[s]?|execute[sd]?|delegat(?:e[sd]?|ing))\b/i.test(before)
                    || /\b(?:audit|inspect|research|investigate|find|read|test|build|verify|search|check|review|perform|conduct)\b[\s\S]*\b(?:via|through|with)\s+(?:\w+\s+){0,3}$/i.test(before)) {
                    affirmative = true;
                }
            }
        }
    }
    return affirmative;
}

/**
 * Grade the captured initial decision, not eventual execution or task quality.
 * Nested-work grading is deliberately a conservative English prose heuristic:
 * it checks explicit execution instructions in task/purpose/successCriteria,
 * rejects common negations and quoted intent, and may reject unusual but valid
 * wording. It cannot prove that a descendant actually invokes a native task,
 * understand arbitrary negation scope, or enforce the requested fan-out count
 * from a first decision (children may be spawned in successive waves). Inspect
 * failures manually; use the end-to-end test for actual nested execution.
 */
export function scoreDelegation(scenario, decision, { model, knownAgents, catalogLookups = 0, nativeMode = "sync" } = {}) {
    const failures = [];
    const rawCalls = decision?.calls;
    if (!Array.isArray(rawCalls)) failures.push("Decision calls must be an array");
    const calls = Array.isArray(rawCalls) ? rawCalls.filter(call => {
        if (isRecord(call) && nonempty(call.name)) return true;
        failures.push("Decision contains an invalid tool call");
        return false;
    }) : [];
    const durable = calls.filter(c => c.name === "spawn_agent");
    const native = calls.filter(c => c.name === "task");
    const route = durable.length && native.length ? "mixed" : durable.length ? "durable" : native.length ? "native"
        : calls.some(c => c.name === "ask_user") || !calls.length ? "clarify" : "direct";
    if (!scenario.expected.includes(route)) failures.push(`Expected ${scenario.expected.join(" or ")}; saw ${route}`);
    if (nativeMode === "off" && native.length) failures.push("Native invocation is unavailable when native subagents are off");
    for (const call of native) {
        const a = call.arguments;
        if (!isRecord(a)) { failures.push("Native arguments must be an object"); continue; }
        if (!["swarm-explore", "swarm-task"].includes(a.agent_type) || !model || (a.mode !== undefined && a.mode !== "sync")
            || (a.model !== undefined && a.model !== model) || a.reasoning_effort !== undefined || a.context_tier !== undefined) {
            failures.push("Native invocation violates the admitted profile/mode/model policy");
        }
        if (!nonempty(a.prompt)) failures.push("Native invocation has no prompt");
    }
    for (const call of durable) {
        const a = call.arguments;
        if (!isRecord(a)) { failures.push("Durable arguments must be an object"); continue; }
        if (a.agent_name !== undefined) {
            if (!nonempty(a.agent_name) || (knownAgents && !knownAgents.includes(a.agent_name))
                || a.task !== undefined || a.system_message !== undefined) {
                failures.push("Named agent is unknown or overrides its task/system message");
            }
        } else if (!nonempty(a.task)) failures.push("Ad-hoc durable agent has no task");
    }
    if (scenario.expectedAgent && (!durable.length || durable.some(c => c.arguments?.agent_name !== scenario.expectedAgent))) {
        failures.push("Matching named role was not selected for every child");
    }
    if (scenario.expectedChildNative && (!durable.length || durable.some(c =>
        !isRecord(c.arguments) || !childAssignmentRequestsNative(c.arguments)))) {
        failures.push("Initial child assignment does not preserve the requested native work");
    }
    if (scenario.expectedCatalogLookup && !(Number.isInteger(catalogLookups) && catalogLookups > 0)) failures.push("Unknown catalog was not discovered");
    return { route, pass: failures.length === 0, failures };
}
