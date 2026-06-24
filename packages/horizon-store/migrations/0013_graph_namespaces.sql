-- 0013_graph_namespaces — graph namespace registry sidecar (graph-fact-search
-- enhancements).
--
-- GRAPH-OWNED, not facts-owned. The graph provider (HorizonDBGraphStore) runs
-- this inline as part of its idempotent bootstrap (alongside 0003); the facts
-- provider FILTERS it out. It may run against a database that has no facts
-- schema, so it creates and owns its own schema. The registry schema MUST be
-- distinct from the AGE graph name (create_graph() owns a schema of that name).
--
-- Tokens: {{REGISTRY_SCHEMA}}. Identifiers are quoted so a mixed-case schema
-- name matches the quoted, case-preserving identifier used at runtime. All DDL
-- is idempotent (IF NOT EXISTS / OR REPLACE / ON CONFLICT) so repeated and
-- concurrent bootstraps converge.

CREATE SCHEMA IF NOT EXISTS "{{REGISTRY_SCHEMA}}";

CREATE TABLE IF NOT EXISTS "{{REGISTRY_SCHEMA}}".graph_namespaces (
    namespace      text PRIMARY KEY,
    archived       boolean NOT NULL DEFAULT false,
    frontmatter    jsonb NOT NULL,
    source         text,
    node_schema    jsonb,
    edge_schema    jsonb,
    harvest_config jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Active-row lookups (list excludes archived by default).
CREATE INDEX IF NOT EXISTS graph_namespaces_active_idx
    ON "{{REGISTRY_SCHEMA}}".graph_namespaces (namespace)
    WHERE archived = false;

-- Prefix listing over namespace keys.
CREATE INDEX IF NOT EXISTS graph_namespaces_prefix_idx
    ON "{{REGISTRY_SCHEMA}}".graph_namespaces (namespace text_pattern_ops);

-- updated_at maintained by trigger so it never drifts from app code.
CREATE OR REPLACE FUNCTION "{{REGISTRY_SCHEMA}}".graph_namespaces_touch()
RETURNS trigger AS $touch$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$touch$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS graph_namespaces_touch_trg ON "{{REGISTRY_SCHEMA}}".graph_namespaces;
CREATE TRIGGER graph_namespaces_touch_trg
    BEFORE UPDATE ON "{{REGISTRY_SCHEMA}}".graph_namespaces
    FOR EACH ROW EXECUTE FUNCTION "{{REGISTRY_SCHEMA}}".graph_namespaces_touch();

-- Seed the reserved `default` namespace (the unscoped/NULL partition). It always
-- exists and cannot be archived or deleted by the provider.
INSERT INTO "{{REGISTRY_SCHEMA}}".graph_namespaces (namespace, archived, frontmatter)
VALUES (
    'default',
    false,
    '{"name":"default","description":"Unscoped graph knowledge: records with no namespace. Use when no specific corpus applies."}'::jsonb
)
ON CONFLICT (namespace) DO NOTHING;
