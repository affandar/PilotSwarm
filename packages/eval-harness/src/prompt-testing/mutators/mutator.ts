/**
 * Mutator interface — every mutator transforms a markdown body deterministically
 * (or raises a clear error when external state is unavailable, e.g. paraphrase
 * without OPENAI_API_KEY).
 */

export interface MutatorContext {
  /** Markdown body of the source agent prompt. */
  body: string;
  /** Mutator-specific config object. Each mutator validates its own shape. */
  config: unknown;
}

export interface Mutator {
  readonly kind: string;
  apply(ctx: MutatorContext): Promise<string>;
}

export function assertObjectConfig(
  config: unknown,
  mutator: string,
): Record<string, unknown> {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${mutator}: config must be a non-null object`);
  }
  return config as Record<string, unknown>;
}
