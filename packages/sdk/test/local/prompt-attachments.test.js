/**
 * Image prompt attachments (docs/proposals/image-attachments-in-chat.md).
 *
 * Phase 1 — backend threading. Three seams are guarded here:
 *   1. WIRE HYGIENE — sanitizePromptAttachmentRefs is the single normalizer
 *      for every untrusted attachments array (queue payloads, API bodies).
 *   2. VISION GATE INPUTS — SessionManager.getModelVisionInfo resolves the
 *      session's model against the Copilot catalog; `known: false` must be
 *      the answer for anything unresolvable so callers degrade to text-only
 *      instead of guessing.
 *   3. BLOB PASS-THROUGH — ManagedSession.runTurn forwards ready-made blobs
 *      to copilotSession.send as {type:"blob"} attachments, and (byte-shape
 *      regression) sends do NOT grow an attachments key when none are given.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    ATTACHMENTS_MAX_COUNT,
    sanitizePromptAttachmentRefs,
} from "../../src/types.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { SessionManager } from "../../src/session-manager.ts";

class FakeCopilotSession {
    catchAllHandlers = [];
    listeners = new Map();
    sends = [];

    on(eventTypeOrHandler, handler) {
        if (typeof eventTypeOrHandler === "function") {
            this.catchAllHandlers.push(eventTypeOrHandler);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((h) => h !== eventTypeOrHandler);
            };
        }
        const handlers = this.listeners.get(eventTypeOrHandler) ?? [];
        handlers.push(handler);
        this.listeners.set(eventTypeOrHandler, handlers);
        return () => {
            const current = this.listeners.get(eventTypeOrHandler) ?? [];
            this.listeners.set(eventTypeOrHandler, current.filter((h) => h !== handler));
        };
    }

    registerTools() {}

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        for (const handler of this.listeners.get(eventType) ?? []) {
            handler(payload);
        }
    }

    async send(options) {
        this.sends.push(typeof options === "string" ? { prompt: options } : options);
        // Complete the turn on the next tick so runTurn resolves.
        setTimeout(() => {
            this.emit("assistant.message", { data: { content: "Done." } });
            this.emit("session.idle", { data: {} });
        }, 0);
    }

    abort() {}
}

describe("sanitizePromptAttachmentRefs (wire hygiene)", () => {
    it("keeps well-formed refs and preserves order", () => {
        const refs = sanitizePromptAttachmentRefs([
            { filename: "a.png", contentType: "image/png", sizeBytes: 1024 },
            { filename: "b.jpg", contentType: "IMAGE/JPEG", sizeBytes: 2048 },
        ]);
        expect(refs).toEqual([
            { filename: "a.png", contentType: "image/png", sizeBytes: 1024 },
            { filename: "b.jpg", contentType: "image/jpeg", sizeBytes: 2048 },
        ]);
    });

    it("drops malformed entries instead of throwing (replayed-history hygiene)", () => {
        expect(sanitizePromptAttachmentRefs(null)).toEqual([]);
        expect(sanitizePromptAttachmentRefs("nope")).toEqual([]);
        expect(sanitizePromptAttachmentRefs([
            null,
            42,
            { filename: "", contentType: "image/png", sizeBytes: 10 },
            { filename: "x.png", contentType: "", sizeBytes: 10 },
            { filename: "x.png", contentType: "image/png", sizeBytes: 0 },
            { filename: "x.png", contentType: "image/png", sizeBytes: Number.NaN },
            { filename: "ok.png", contentType: "image/png", sizeBytes: 5 },
        ])).toEqual([{ filename: "ok.png", contentType: "image/png", sizeBytes: 5 }]);
    });

    it("clamps to the per-turn count cap", () => {
        const many = Array.from({ length: ATTACHMENTS_MAX_COUNT + 3 }, (_, i) => ({
            filename: `f${i}.png`, contentType: "image/png", sizeBytes: 10,
        }));
        expect(sanitizePromptAttachmentRefs(many)).toHaveLength(ATTACHMENTS_MAX_COUNT);
    });
});

describe("SessionManager.getModelVisionInfo (vision gate inputs)", () => {
    const CATALOG = [
        {
            id: "claude-sonnet-5",
            capabilities: {
                supports: { vision: true, reasoningEffort: true },
                limits: {
                    max_context_window_tokens: 200000,
                    vision: {
                        supported_media_types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
                        max_prompt_images: 5,
                        max_prompt_image_size: 3145728,
                    },
                },
            },
        },
        {
            id: "text-only-model",
            capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 8192 } },
        },
    ];

    function managerWithCatalog(models = CATALOG) {
        const stateDir = path.join(os.tmpdir(), `ps-vision-test-${process.pid}`);
        const manager = new SessionManager(undefined, null, {}, stateDir);
        manager.client = { listModels: async () => models };
        return manager;
    }

    it("reports vision + provider limits for a bare model id", async () => {
        const info = await managerWithCatalog().getModelVisionInfo("claude-sonnet-5");
        expect(info).toMatchObject({
            modelId: "claude-sonnet-5",
            known: true,
            vision: true,
            supportedMediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
            maxImages: 5,
            maxImageBytes: 3145728,
        });
    });

    it("strips a provider-qualified ref before the catalog lookup", async () => {
        const info = await managerWithCatalog().getModelVisionInfo("github-copilot:claude-sonnet-5");
        expect(info.known).toBe(true);
        expect(info.vision).toBe(true);
        expect(info.modelId).toBe("claude-sonnet-5");
    });

    it("reports a non-vision model as known but vision:false", async () => {
        const info = await managerWithCatalog().getModelVisionInfo("text-only-model");
        expect(info).toMatchObject({ known: true, vision: false });
    });

    it("reports unknown (never guesses) for models absent from the catalog", async () => {
        const info = await managerWithCatalog().getModelVisionInfo("some-byok-model");
        expect(info).toMatchObject({ known: false, vision: false });
    });

    it("reports unknown when the catalog fetch fails and no cache exists", async () => {
        const manager = managerWithCatalog();
        manager.client = { listModels: async () => { throw new Error("catalog down"); } };
        const info = await manager.getModelVisionInfo("claude-sonnet-5");
        expect(info).toMatchObject({ known: false, vision: false });
    });
});

describe("ManagedSession.runTurn blob pass-through", () => {
    it("forwards resolved blobs to copilotSession.send as blob attachments", async () => {
        const fake = new FakeCopilotSession();
        const managed = new ManagedSession("attach-turn", fake, {});
        const result = await managed.runTurn("what is in this image?", {
            attachments: [
                { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png", displayName: "shot.png" },
                { data: Buffer.from("jpg-bytes").toString("base64"), mimeType: "image/jpeg" },
            ],
        });
        expect(result.type).not.toBe("error");
        expect(fake.sends).toHaveLength(1);
        expect(fake.sends[0].attachments).toEqual([
            { type: "blob", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png", displayName: "shot.png" },
            { type: "blob", data: Buffer.from("jpg-bytes").toString("base64"), mimeType: "image/jpeg" },
        ]);
        expect(fake.sends[0].prompt).toContain("what is in this image?");
    });

    it("does not add an attachments key to plain sends (byte-shape regression)", async () => {
        const fake = new FakeCopilotSession();
        const managed = new ManagedSession("plain-turn", fake, {});
        const result = await managed.runTurn("hello");
        expect(result.type).not.toBe("error");
        expect(fake.sends).toHaveLength(1);
        expect(Object.prototype.hasOwnProperty.call(fake.sends[0], "attachments")).toBe(false);
    });
});
