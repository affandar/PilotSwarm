// @incubator/horizon-facts — Node-side embedding client.
//
// Two roles:
//   1. QUERY-TIME embedding for semantic/hybrid search (the adapter embeds the
//      query string here, then passes the vector to SQL as `$1::vector`).
//   2. A reference implementation of the request/response contract that the
//   2. A reference implementation of the request/response contract that any
//      provider's embedding path must speak. The HorizonDB provider mirrors it
//      in-database (sql/006 df.http); the integration test stub server speaks
//      this exact shape.
//
// It calls an OpenAI/Azure-OpenAI-compatible embeddings endpoint over HTTP using
// the global fetch (Node ≥ 18).

import type { EmbeddingEndpointConfig } from "./config.js";

export class EmbeddingClient {
    constructor(private readonly cfg: EmbeddingEndpointConfig) {
        if (!cfg?.url) throw new Error("EmbeddingClient requires an endpoint url.");
        if (!cfg.dim || cfg.dim < 1) throw new Error("EmbeddingClient requires a positive dim.");
    }

    get dim(): number {
        return this.cfg.dim;
    }

    /** Embed a single string. Returns a vector of length `cfg.dim`. */
    async embed(text: string): Promise<number[]> {
        const [v] = await this.embedBatch([text]);
        return v;
    }

    /** Embed a batch. Returns one vector per input, in order. */
    async embedBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const inputField = this.cfg.inputField ?? "input";
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(this.cfg.headers ?? {}),
        };
        if (this.cfg.apiKey) {
            const headerName = this.cfg.apiKeyHeader ?? "api-key";
            headers[headerName] = this.cfg.bearer ? `Bearer ${this.cfg.apiKey}` : this.cfg.apiKey;
        }

        const body = JSON.stringify({ [inputField]: texts.length === 1 ? texts[0] : texts, model: this.cfg.model });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
        let res: Response;
        try {
            res = await fetch(this.cfg.url, { method: "POST", headers, body, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`embedding endpoint ${res.status}: ${detail.slice(0, 200)}`);
        }
        const json: any = await res.json();
        const data = json?.data;
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error("embedding endpoint returned no data[]");
        }
        const out = data.map((d: any) => {
            const emb = d?.embedding;
            if (!Array.isArray(emb)) throw new Error("embedding endpoint item missing embedding[]");
            if (emb.length !== this.cfg.dim) {
                throw new Error(`embedding dim mismatch: got ${emb.length}, expected ${this.cfg.dim}`);
            }
            return emb as number[];
        });
        return out;
    }
}

/** Format a JS number[] as a pgvector literal: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
}
