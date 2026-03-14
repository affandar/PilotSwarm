/**
 * SessionDumper — generates Markdown debug dumps of session conversations.
 *
 * Recursively traverses parent → child → grandchild sessions, rendering
 * all user/assistant messages, tool calls, and cross-session communication
 * into a single structured Markdown document.
 *
 * @module
 */

import type { SessionCatalogProvider, SessionRow, SessionEvent } from "./cms.js";

// ─── Types ───────────────────────────────────────────────────────

interface SessionNode {
    row: SessionRow;
    events: SessionEvent[];
    children: SessionNode[];
}

// ─── Helpers ─────────────────────────────────────────────────────

function shortId(id: string): string {
    return id.slice(0, 8);
}

function fmtTime(date: Date): string {
    return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function indent(text: string, prefix: string): string {
    return text.split("\n").map(l => prefix + l).join("\n");
}

function escapeContent(text: string): string {
    // Trim very long content but keep it readable
    if (text.length > 5000) {
        return text.slice(0, 5000) + "\n\n... (truncated, " + text.length + " chars total)";
    }
    return text;
}

// ─── SessionDumper ───────────────────────────────────────────────

export class SessionDumper {
    constructor(private catalog: SessionCatalogProvider) {}

    /**
     * Dump a single session and all its descendants to Markdown.
     */
    async dump(sessionId: string): Promise<string> {
        const tree = await this._buildTree(sessionId);
        if (!tree) {
            return `# Session Dump\n\n> Session \`${sessionId}\` not found.\n`;
        }
        const lines: string[] = [];
        lines.push(`# Session Debug Dump`);
        lines.push(``);
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push(``);

        // Session tree overview
        lines.push(`## Session Tree`);
        lines.push(``);
        lines.push("```");
        this._renderTreeAscii(tree, lines, "");
        lines.push("```");
        lines.push(``);

        // Detailed conversation for each session
        this._renderSessionDetail(tree, lines, 0);

        return lines.join("\n");
    }

    /**
     * Dump all active sessions to Markdown.
     */
    async dumpAll(): Promise<string> {
        const sessions = await this.catalog.listSessions();
        // Find root sessions (no parent)
        const roots = sessions.filter(s => !s.parentSessionId);

        const lines: string[] = [];
        lines.push(`# All Sessions Debug Dump`);
        lines.push(``);
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push(`Total sessions: ${sessions.length} (${roots.length} root)`);
        lines.push(``);

        for (const root of roots) {
            const tree = await this._buildTree(root.sessionId);
            if (!tree) continue;

            lines.push(`---`);
            lines.push(``);

            // Tree overview
            lines.push(`## Session Tree: ${shortId(root.sessionId)}`);
            lines.push(``);
            lines.push("```");
            this._renderTreeAscii(tree, lines, "");
            lines.push("```");
            lines.push(``);

            // Detailed conversation
            this._renderSessionDetail(tree, lines, 0);
        }

        return lines.join("\n");
    }

    // ─── Private: tree building ──────────────────────────────

    private async _buildTree(sessionId: string): Promise<SessionNode | null> {
        const row = await this.catalog.getSession(sessionId);
        if (!row) return null;

        const events = await this.catalog.getSessionEvents(sessionId);

        // Find direct children
        const allDescendants = await this.catalog.getDescendantSessionIds(sessionId);
        const allSessions = await this.catalog.listSessions();
        const directChildren = allSessions.filter(
            s => s.parentSessionId === sessionId && allDescendants.includes(s.sessionId)
        );

        const children: SessionNode[] = [];
        for (const child of directChildren) {
            const childNode = await this._buildTree(child.sessionId);
            if (childNode) children.push(childNode);
        }

        // Sort children by creation time
        children.sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime());

        return { row, events, children };
    }

    // ─── Private: ASCII tree rendering ───────────────────────

    private _renderTreeAscii(node: SessionNode, lines: string[], prefix: string): void {
        const { row } = node;
        const model = row.model || "(default)";
        const status = row.state || "unknown";
        const title = row.title ? ` "${row.title}"` : "";
        lines.push(`${prefix}${shortId(row.sessionId)} [${model}] (${status})${title}`);

        for (let i = 0; i < node.children.length; i++) {
            const isLast = i === node.children.length - 1;
            const childPrefix = prefix + (isLast ? "└── " : "├── ");
            const contPrefix = prefix + (isLast ? "    " : "│   ");
            this._renderTreeAscii(node.children[i], lines, childPrefix);
            // For grandchildren, use contPrefix
            // (already handled recursively by the prefix parameter)
        }
    }

    // ─── Private: detailed session rendering ─────────────────

    private _renderSessionDetail(node: SessionNode, lines: string[], depth: number): void {
        const { row, events } = node;
        const headingLevel = Math.min(depth + 2, 6); // ##, ###, ####, etc.
        const hashes = "#".repeat(headingLevel);

        const model = row.model || "(default)";
        const title = row.title ? ` — ${row.title}` : "";
        const parentNote = row.parentSessionId
            ? ` (child of ${shortId(row.parentSessionId)})`
            : "";

        lines.push(`${hashes} Session ${shortId(row.sessionId)}${title}${parentNote}`);
        lines.push(``);
        lines.push(`| Field | Value |`);
        lines.push(`|-------|-------|`);
        lines.push(`| ID | \`${row.sessionId}\` |`);
        lines.push(`| Model | ${model} |`);
        lines.push(`| Status | ${row.state} |`);
        lines.push(`| Created | ${fmtTime(row.createdAt)} |`);
        lines.push(`| Updated | ${fmtTime(row.updatedAt)} |`);
        if (row.parentSessionId) {
            lines.push(`| Parent | \`${row.parentSessionId}\` |`);
        }
        if (node.children.length > 0) {
            lines.push(`| Children | ${node.children.map(c => `\`${shortId(c.row.sessionId)}\``).join(", ")} |`);
        }
        lines.push(``);

        // Conversation log
        lines.push(`<details><summary><strong>Conversation (${events.length} events)</strong></summary>`);
        lines.push(``);

        for (const evt of events) {
            const t = fmtTime(evt.createdAt);
            const data = evt.data as any;

            switch (evt.eventType) {
                case "user.message": {
                    const content = data?.content || "";
                    // Strip system prefixes for readability
                    const clean = content.replace(/^\[SYSTEM: Running on host "[^"]*"\.\]\n\n/, "");
                    // Detect child updates forwarded as user messages
                    const childMatch = clean.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)/);
                    if (childMatch) {
                        lines.push(`**\`${t}\`** 🔗 **Child Update** (from \`${shortId(childMatch[1])}\`, ${childMatch[2]}):`);
                        const body = clean.replace(/^\[CHILD_UPDATE[^\]]*\]\n?/, "");
                        if (body.trim()) {
                            lines.push(``);
                            lines.push(`> ${escapeContent(body.trim()).split("\n").join("\n> ")}`);
                        }
                    } else {
                        lines.push(`**\`${t}\`** 👤 **User:**`);
                        lines.push(``);
                        lines.push(`> ${escapeContent(clean).split("\n").join("\n> ")}`);
                    }
                    lines.push(``);
                    break;
                }
                case "assistant.message": {
                    const content = data?.content || "";
                    lines.push(`**\`${t}\`** 🤖 **Assistant:**`);
                    lines.push(``);
                    lines.push(escapeContent(content));
                    lines.push(``);
                    break;
                }
                case "tool.execution_start": {
                    const toolName = data?.toolName || data?.name || "unknown";
                    const args = data?.arguments || data?.args;
                    lines.push(`**\`${t}\`** 🔧 **Tool Call:** \`${toolName}\``);
                    if (args) {
                        const argsStr = typeof args === "string" ? args : JSON.stringify(args, null, 2);
                        if (argsStr.length < 500) {
                            lines.push(``);
                            lines.push("```json");
                            lines.push(argsStr);
                            lines.push("```");
                        }
                    }
                    lines.push(``);
                    break;
                }
                case "tool.execution_complete": {
                    const toolName = data?.toolName || data?.name || "unknown";
                    const result = data?.result || data?.output;
                    lines.push(`**\`${t}\`** ✅ **Tool Result:** \`${toolName}\``);
                    if (result) {
                        const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                        if (resultStr.length > 0 && resultStr.length < 1000) {
                            lines.push(``);
                            lines.push("```");
                            lines.push(resultStr.slice(0, 1000));
                            lines.push("```");
                        }
                    }
                    lines.push(``);
                    break;
                }
                case "assistant.turn_start": {
                    lines.push(`**\`${t}\`** ⏳ *Turn started*`);
                    lines.push(``);
                    break;
                }
                case "assistant.turn_end": {
                    lines.push(`**\`${t}\`** ⏹ *Turn ended*`);
                    lines.push(``);
                    break;
                }
                case "assistant.reasoning": {
                    const content = data?.content || data?.text || "";
                    if (content) {
                        lines.push(`**\`${t}\`** 💭 **Reasoning:**`);
                        lines.push(``);
                        lines.push(`> ${escapeContent(content).split("\n").join("\n> ")}`);
                        lines.push(``);
                    }
                    break;
                }
                case "assistant.usage": {
                    const usage = data || {};
                    const inputTokens = usage.inputTokens || usage.prompt_tokens || "?";
                    const outputTokens = usage.outputTokens || usage.completion_tokens || "?";
                    lines.push(`**\`${t}\`** 📊 *Usage: ${inputTokens} in / ${outputTokens} out*`);
                    lines.push(``);
                    break;
                }
                default: {
                    // Other event types — show raw
                    lines.push(`**\`${t}\`** 📌 **${evt.eventType}**`);
                    if (data && Object.keys(data).length > 0) {
                        const raw = JSON.stringify(data, null, 2);
                        if (raw.length < 500) {
                            lines.push(``);
                            lines.push("```json");
                            lines.push(raw);
                            lines.push("```");
                        }
                    }
                    lines.push(``);
                    break;
                }
            }
        }

        lines.push(`</details>`);
        lines.push(``);

        // Recursively render children
        for (const child of node.children) {
            this._renderSessionDetail(child, lines, depth + 1);
        }
    }
}
