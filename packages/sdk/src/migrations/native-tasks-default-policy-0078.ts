/** Publish the initial cluster policy separately from the frozen 0077 schema. */
export function nativeTasksDefaultPolicyMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
UPDATE ${s}.feature_flags
SET default_enabled = false,
    default_allow_user_override = true,
    revision = revision + 1
WHERE feature_key = 'copilot.native_tasks'
  AND (default_enabled IS DISTINCT FROM false
       OR default_allow_user_override IS DISTINCT FROM true);

INSERT INTO ${s}.feature_flag_settings
    (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, true, revision, 'migration:0078'
FROM ${s}.feature_flags
WHERE feature_key = 'copilot.native_tasks'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}
