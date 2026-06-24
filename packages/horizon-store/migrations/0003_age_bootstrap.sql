-- 0003_age_bootstrap — AGE extension + the per-deployment graph.
--
-- Tokens: {{GRAPH_NAME}}. NOTE: create_graph() creates a Postgres schema named
-- after the graph, so the graph name MUST differ from the facts schema name.

CREATE EXTENSION IF NOT EXISTS age;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '{{GRAPH_NAME}}') THEN
        PERFORM ag_catalog.create_graph('{{GRAPH_NAME}}');
    END IF;
END $$;
