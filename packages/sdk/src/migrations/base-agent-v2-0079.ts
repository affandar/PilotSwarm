/** Add the prompt switch without changing existing native-task preferences. */
export function baseAgentV2Migration(schema: string): string {
    const s = `"${schema.replace(/"/g, '\"\"')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.session_capabilities (
    session_id TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    state JSONB NOT NULL
);
INSERT INTO ${s}.feature_flags (feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('agents.base_v2', 'Base Agent V2', 'Discovery-first base instructions. Requires Native Copilot tasks.', false, true, 'agents.base_v2')
ON CONFLICT (feature_key) DO NOTHING;
INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, true, revision, 'migration:0079'
FROM ${s}.feature_flags WHERE feature_key = 'agents.base_v2'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}
