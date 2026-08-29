export interface LifecycleStateOutcome {
    outcome: string;
    toState: string;
}

export interface LifecycleStateTransitionContract {
    terminal: boolean;
    outcomes: readonly Readonly<LifecycleStateOutcome>[];
}

export class LifecycleStateTransitionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LifecycleStateTransitionError";
    }
}

const STATE_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NEXT_STATES_HEADING_RE = /^##\s+Possible next states\s*$/i;
const HEADING_RE = /^#{1,6}\s+/;
const LINK_RE = /^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)\]\(([^)]+)\)/;
const CANONICAL_STATE_RE = /^\s*(?:[-*]|\d+\.)\s+`([A-Za-z][A-Za-z0-9_-]*)`(?:\s+-.*)?\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*]|\d+\.)\s+/;
const FENCE_RE = /^\s*(```|~~~)/;

function stateFromLinkTarget(target: string): string {
    const normalized = target.trim();
    const canonicalState = /^state:([A-Za-z][A-Za-z0-9_-]*)$/i.exec(normalized);
    if (canonicalState) return canonicalState[1];
    const clean = normalized.split(/[?#]/, 1)[0].replaceAll("\\", "/");
    const filename = clean.slice(clean.lastIndexOf("/") + 1);
    const match = /^.+\.([A-Za-z][A-Za-z0-9_-]*)\.md$/i.exec(filename);
    if (!match) {
        throw new LifecycleStateTransitionError(
            `Possible next state link must target state:State or a Prefix.State.md file: ${target}`,
        );
    }
    return match[1];
}

/**
 * Parse only the current state's outgoing links. This deliberately does not
 * load targets or validate the complete lifecycle graph.
 */
export function parseLifecycleStateTransitions(markdown: string): Readonly<LifecycleStateTransitionContract> {
    if (typeof markdown !== "string") {
        throw new LifecycleStateTransitionError("Lifecycle state Markdown must be text");
    }

    const lines = markdown.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) => NEXT_STATES_HEADING_RE.test(line.trim()));
    if (headingIndex < 0) {
        return Object.freeze({ terminal: true, outcomes: Object.freeze([]) });
    }

    const outcomes: LifecycleStateOutcome[] = [];
    const seen = new Set<string>();
    let fence: string | null = null;
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            fence = fence === fenceMatch[1] ? null : fence ?? fenceMatch[1];
            continue;
        }
        if (fence) continue;
        if (HEADING_RE.test(line.trim())) break;
        const match = LINK_RE.exec(line);
        const canonicalState = CANONICAL_STATE_RE.exec(line);
        if (!match && !canonicalState) {
            if (LIST_ITEM_RE.test(line)) {
                throw new LifecycleStateTransitionError(
                    `Possible next state list item must be a Markdown link or canonical state name: ${line.trim()}`,
                );
            }
            continue;
        }
        const outcome = (match?.[1] ?? canonicalState![1]).trim();
        if (!STATE_RE.test(outcome)) {
            throw new LifecycleStateTransitionError(`Invalid possible next state name: ${JSON.stringify(outcome)}`);
        }
        const toState = match ? stateFromLinkTarget(match[2]) : canonicalState![1];
        if (outcome !== toState) {
            throw new LifecycleStateTransitionError(
                `Possible next state label ${outcome} does not match linked state ${toState}`,
            );
        }
        if (seen.has(outcome)) {
            throw new LifecycleStateTransitionError(`Duplicate possible next state: ${outcome}`);
        }
        seen.add(outcome);
        outcomes.push(Object.freeze({ outcome, toState }));
    }

    return Object.freeze({
        terminal: outcomes.length === 0,
        outcomes: Object.freeze(outcomes),
    });
}
