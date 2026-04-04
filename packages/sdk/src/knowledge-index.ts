import type { FactStore } from "./facts-store.js";

export interface KnowledgeIndexSkill {
    key: string;
    name: string;
    description: string;
}

export interface KnowledgeIndexAsk {
    key: string;
    summary: string;
}

export interface KnowledgeIndex {
    skills: KnowledgeIndexSkill[];
    asks: KnowledgeIndexAsk[];
}

function normalizeBlock(text?: string | null): string | undefined {
    const value = (text ?? "").trim();
    return value || undefined;
}

export async function loadKnowledgeIndexFromFactStore(
    factStore: FactStore,
    cap = 50,
): Promise<KnowledgeIndex> {
    const skillResult = await factStore.readFacts(
        { keyPattern: "skills/%", scope: "shared", limit: cap },
        { readerSessionId: null, grantedSessionIds: [] },
    );
    const skills: KnowledgeIndexSkill[] = [];
    if (skillResult?.facts?.length) {
        for (const row of skillResult.facts) {
            const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
            if (val?.status === "aged-out") continue;
            skills.push({
                key: row.key,
                name: val?.name ?? row.key?.replace("skills/", "").replace(/\//g, "-") ?? "unknown",
                description: val?.description ?? "",
            });
        }
    }

    const askResult = await factStore.readFacts(
        { keyPattern: "asks/%", scope: "shared", limit: cap },
        { readerSessionId: null, grantedSessionIds: [] },
    );
    const asks: KnowledgeIndexAsk[] = [];
    if (askResult?.facts?.length) {
        for (const row of askResult.facts) {
            const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
            if (val?.status !== "open") continue;
            asks.push({
                key: row.key,
                summary: val?.summary ?? "",
            });
        }
    }

    if (skills.length + asks.length > cap) {
        const skillCap = Math.min(skills.length, Math.floor(cap * 0.7));
        const askCap = cap - skillCap;
        skills.splice(skillCap);
        asks.splice(askCap);
    }

    return { skills, asks };
}

export function buildKnowledgePromptBlocks(knowledgeIndex: KnowledgeIndex): {
    askBlock?: string;
    skillBlock?: string;
} {
    const askBlock = knowledgeIndex.asks.length > 0
        ? `[ACTIVE FACT REQUESTS]\n` +
            `The Facts Manager is seeking corroboration on these topics.\n` +
            `If any are relevant to your current task, read the full ask\n` +
            `with read_facts and contribute intake evidence if you can.\n` +
            `${knowledgeIndex.asks.map((a) => `- ${a.key}`).join("\n")}\n\n` +
            `[FACT NAMESPACE RULES]\n` +
            `- You can WRITE to: intake/<topic>/<session-id> (shared observations)\n` +
            `- You can READ from: skills/*, asks/* (curated knowledge, open requests)\n` +
            `- You CANNOT write to skills/ or asks/ (Facts Manager only)\n` +
            `- You CANNOT read from intake/ (Facts Manager only)`
        : undefined;

    const skillBlock = knowledgeIndex.skills.length > 0
        ? `[CURATED SKILLS]\n` +
            `The following shared skills are available. If one is relevant to your current task,\n` +
            `call read_facts(key_pattern="<key>", scope="shared") to load the full instructions before applying.\n\n` +
            `${knowledgeIndex.skills.map((s) => `- ${s.key} — ${s.name}: ${s.description}`).join("\n")}`
        : undefined;

    return {
        askBlock: normalizeBlock(askBlock),
        skillBlock: normalizeBlock(skillBlock),
    };
}

export function mergePromptBlocks(parts: Array<string | null | undefined>): string | undefined {
    const normalized = parts
        .map((part) => normalizeBlock(part))
        .filter((part): part is string => Boolean(part));
    return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}