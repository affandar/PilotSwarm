import type { JudgeCache, JudgeResponse } from "./judge-types.js";

export class InMemoryJudgeCache implements JudgeCache {
  private store = new Map<string, JudgeResponse>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<JudgeResponse | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: JudgeResponse): Promise<void> {
    if (this.store.has(key)) {
      this.store.set(key, value);
      return;
    }
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
