-- 0003_age_bootstrap — AGE extension + the per-deployment graph.
--
-- Tokens: {{GRAPH_NAME}}. NOTE: create_graph() creates a Postgres schema named
-- after the graph, so the graph name MUST differ from the facts schema name.

CREATE EXTENSION IF NOT EXISTS age;

-- create_graph() resolves graphid_ops (label-table index opclass) through the
-- caller's search_path on newer AGE builds (Azure HorizonDB ships 1.7.x), so
-- ag_catalog must be visible or bootstrap fails with:
--   operator class "graphid_ops" does not exist for access method "btree"
-- SET LOCAL is safe here: this migration is graph-owned and always runs inside
-- the graph store's bootstrap transaction, so the setting dies at COMMIT.
SET LOCAL search_path = ag_catalog, "$user", public;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '{{GRAPH_NAME}}') THEN
        PERFORM ag_catalog.create_graph('{{GRAPH_NAME}}');
    END IF;
END $$;
