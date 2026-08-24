-- Rollback step for the provider-budgets release (after migration 0058).
--
-- 0058 rewrote every ACTIVE github-copilot session to its owner's personal
-- ghcp-u<id> provider. The pre-budgets build resolves models from the
-- model-providers FILE, which has never heard of those names — a rewritten
-- session does not fail on the old build, it HANGS SILENTLY (running, no
-- error, forever; verified live 2026-08-24). Restore the original labels
-- BEFORE rolling images back.
--
-- Idempotent: the guard `s.model = m.migrated_model` means a session already
-- restored (or since moved by its owner) is left alone. Run via psql from a
-- portal pod:
--
--   psql "$DATABASE_URL" -v schema=copilot_sessions \
--        -f scripts/rollback-provider-session-models.sql
--
-- KNOWN GAP, by design: sessions their OWNERS switched to a personal
-- provider after the upgrade are NOT in the rollback table (it records only
-- the 0058 rewrites). The second query lists them — each must be switched
-- back by hand (or completed) or it will hang on the old build the same way.

\set schema_ident :schema

UPDATE :schema_ident.sessions s
   SET model = m.original_model
  FROM :schema_ident.provider_legacy_session_models m
 WHERE s.session_id = m.session_id
   AND s.model = m.migrated_model;

SELECT 'restored' AS what, count(*) AS sessions
  FROM :schema_ident.sessions s
  JOIN :schema_ident.provider_legacy_session_models m
    ON s.session_id = m.session_id
 WHERE s.model = m.original_model;

-- Owner-switched sessions the rollback table cannot restore: live sessions
-- whose model prefix is a PERSONAL provider name, minus the rewrites.
SELECT s.session_id, s.model, s.state,
       u.email AS owner_email
  FROM :schema_ident.sessions s
  JOIN :schema_ident.provider_instances pi
    ON pi.name = split_part(s.model, ':', 1) AND pi.class = 'personal'
  LEFT JOIN :schema_ident.session_owners so ON so.session_id = s.session_id
  LEFT JOIN :schema_ident.users u ON u.user_id = so.user_id
 WHERE s.deleted_at IS NULL
   AND s.state NOT IN ('completed', 'failed', 'cancelled')
   AND NOT EXISTS (
       SELECT 1 FROM :schema_ident.provider_legacy_session_models m
        WHERE m.session_id = s.session_id AND s.model = m.migrated_model)
 ORDER BY s.updated_at DESC;
