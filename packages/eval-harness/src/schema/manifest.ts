import { z } from "zod";

const ManifestOverridesSchema = z.object({
  tags: z.array(z.string()).optional()
}).strict();

export const ManifestSchemaLineSchema = z.union([
  z.object({ schemaVersion: z.literal(1) }).strict(),
  z.object({
    path: z.string().min(1),
    overrides: ManifestOverridesSchema.optional()
  }).strict(),
  z.object({ include: z.string().min(1) }).strict(),
  z.object({ exclude: z.string().min(1) }).strict(),
  z.object({ "include-manifest": z.string().min(1) }).strict()
]);

export type ManifestDirective = z.infer<typeof ManifestSchemaLineSchema>;

export const ManifestHeaderSchema = z.object({ schemaVersion: z.literal(1) }).strict();
export const ManifestDirectiveSchema = ManifestSchemaLineSchema;

export function parseManifestJsonl(source: string): ManifestDirective[] {
  const directives: ManifestDirective[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    try {
      directives.push(ManifestSchemaLineSchema.parse(JSON.parse(line)) as ManifestDirective);
    } catch (error) {
      if (error instanceof z.ZodError && error.issues.some((issue) => issue.code === "unrecognized_keys")) {
        throw new Error("Manifest overrides may only set tags.");
      }
      throw error;
    }
  }
  if (directives[0] == null || !("schemaVersion" in directives[0])) {
    throw new Error('Manifest first non-comment line must be {"schemaVersion":1}.');
  }
  return directives;
}
