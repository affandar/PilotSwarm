/**
 * CMS Migration definitions — ordered SQL migrations for the session catalog.
 *
 * Each migration is a function of schema name → SQL string so that the schema
 * placeholder is resolved at runtime (supporting isolated test schemas).
 *
 * @module
 */

import type { MigrationEntry } from "./pg-migrator.js";

/**
 * Return the ordered list of CMS migrations for a given schema.
 * Migrations are idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
export function CMS_MIGRATIONS(schema: string): MigrationEntry[] {
    return [
        {
            version: "0001",
            name: "baseline",
            sql: migration_0001_baseline(schema),
        },
        {
            version: "0002",
            name: "session_metric_summaries",
            sql: migration_0002_session_metric_summaries(schema),
        },
        {
            version: "0003",
            name: "session_metric_summaries_backfill_from_events",
            sql: migration_0003_session_metric_summaries_backfill_from_events(schema),
        },
        {
            version: "0004",
            name: "stored_procedures",
            sql: migration_0004_stored_procedures(schema),
        },
        {
            version: "0005",
            name: "skill_usage_procs",
            sql: migration_0005_skill_usage_procs(schema),
        },
        {
            version: "0006",
            name: "fleet_cache_columns",
            sql: migration_0006_fleet_cache_columns(schema),
        },
        {
            version: "0007",
            name: "session_tree_stats_by_model",
            sql: migration_0007_session_tree_stats_by_model(schema),
        },
        {
            version: "0008",
            name: "session_owner_users",
            sql: migration_0008_session_owner_users(schema),
        },
        {
            version: "0009",
            name: "user_stats_by_model",
            sql: migration_0009_user_stats_by_model(schema),
        },
        {
            version: "0010",
            name: "user_profile_and_copilot_key",
            sql: migration_0010_user_profile_and_copilot_key(schema),
        },
        {
            version: "0011",
            name: "session_reasoning_effort",
            sql: migration_0011_session_reasoning_effort(schema),
        },
        {
            version: "0012",
            name: "session_reasoning_effort_read_views",
            sql: migration_0012_session_reasoning_effort_read_views(schema),
        },
        {
            version: "0013",
            name: "bounded_session_reads_and_emitters",
            sql: migration_0013_bounded_session_reads_and_emitters(schema),
        },
        {
            version: "0014",
            name: "turn_metrics_foundations",
            sql: migration_0014_turn_metrics_foundations(schema),
        },
        {
            version: "0015",
            name: "base_infra_state",
            sql: migration_0015_base_infra_state(schema),
        },
        {
            version: "0016",
            name: "base_infra_state_compat_fixes",
            sql: migration_0016_base_infra_state_compat_fixes(schema),
        },
        {
            version: "0017",
            name: "system_session_restart_archive",
            sql: migration_0017_system_session_restart_archive(schema),
        },
        {
            version: "0018",
            name: "session_group_assignment_update",
            sql: migration_0018_session_group_assignment_update(schema),
        },
        {
            version: "0019",
            name: "session_group_owner_enforcement",
            sql: migration_0019_session_group_owner_enforcement(schema),
        },
        {
            version: "0020",
            name: "session_group_owner_adoption",
            sql: migration_0020_session_group_owner_adoption(schema),
        },
        {
            version: "0021",
            name: "retrieval_usage_procs",
            sql: migration_0021_retrieval_usage_procs(schema),
        },
        {
            version: "0022",
            name: "turn_metrics_reasoning_effort",
            sql: migration_0022_turn_metrics_reasoning_effort(schema),
        },
        {
            version: "0023",
            name: "turn_metrics_stats_fallbacks_and_group_owner_patch",
            sql: migration_0023_turn_metrics_stats_fallbacks_and_group_owner_patch(schema),
        },
        {
            version: "0024",
            name: "stop_turn_active_turn_index",
            sql: migration_0024_stop_turn_active_turn_index(schema),
        },
        {
            version: "0025",
            name: "session_events_type_filter",
            sql: migration_0025_session_events_type_filter(schema),
        },
        {
            version: "0026",
            name: "session_splash_mobile",
            sql: migration_0026_session_splash_mobile(schema),
        },
        {
            version: "0027",
            name: "session_raw_size_bytes",
            sql: migration_0027_session_raw_size_bytes(schema),
        },
        {
            version: "0028",
            name: "list_sessions_page_owner",
            sql: migration_0028_list_sessions_page_owner(schema),
        },
        {
            version: "0029",
            name: "session_visibility_shares",
            steps: migration_0029_session_visibility_shares(schema),
        },
        {
            version: "0030",
            name: "register_user_update_on_sighting",
            sql: migration_0030_register_user_update_on_sighting(schema),
        },
        {
            version: "0031",
            name: "list_users_directory",
            sql: migration_0031_list_users_directory(schema),
        },
        {
            version: "0032",
            name: "adopt_email_keyed_grants",
            sql: migration_0032_adopt_email_keyed_grants(schema),
        },
        {
            version: "0033",
            name: "grant_share_create_only_grantee",
            sql: migration_0033_grant_share_create_only_grantee(schema),
        },
        {
            version: "0034",
            name: "user_session_group_placements",
            sql: migration_0034_user_session_group_placements(schema),
        },
        {
            version: "0035",
            name: "footprint_stat_procs",
            sql: migration_0035_footprint_stat_procs(schema),
        },
        {
            version: "0036",
            name: "session_regeneration",
            steps: migration_0036_session_regeneration(schema),
        },
        {
            version: "0037",
            name: "service_sessions",
            sql: migration_0037_service_sessions(schema),
        },
        {
            version: "0038",
            name: "agent_packages",
            sql: migration_0038_agent_packages(schema),
        },
        {
            version: "0039",
            name: "agent_worker_heartbeat_prune",
            sql: migration_0039_agent_worker_heartbeat_prune(schema),
        },
        {
            version: "0040",
            name: "worker_registry",
            sql: migration_0040_worker_registry(schema),
        },
        {
            version: "0041",
            name: "agent_package_owner_identity",
            sql: migration_0041_agent_package_owner_identity(schema),
        },
        {
            version: "0042",
            name: "user_role_from_signin",
            sql: migration_0042_user_role_from_signin(schema),
        },
        {
            version: "0043",
            name: "agent_package_namespaces",
            sql: migration_0043_agent_package_namespaces(schema),
        },
        {
            version: "0044",
            name: "list_sessions_page_ms_cursor",
            sql: migration_0044_list_sessions_page_ms_cursor(schema),
        },
        {
            version: "0045",
            name: "session_canvases",
            sql: migration_0045_session_canvases(schema),
        },
        {
            version: "0046",
            name: "agent_package_delete_blob_refcount",
            sql: migration_0046_agent_package_delete_blob_refcount(schema),
        },
        {
            version: "0047",
            name: "canvas_live_plane",
            sql: migration_0047_canvas_live_plane(schema),
        },
        {
            version: "0048",
            name: "canvas_share_links",
            sql: migration_0048_canvas_share_links(schema),
        },
        {
            version: "0049",
            name: "provider_budgets",
            sql: migration_0049_provider_budgets(schema),
        },
        {
            version: "0050",
            name: "provider_budget_procs",
            sql: migration_0050_provider_budget_procs(schema),
        },
        {
            version: "0051",
            name: "provider_budget_runtime",
            sql: migration_0051_provider_budget_runtime(schema),
        },
        {
            version: "0052",
            name: "provider_pause_liveness",
            sql: migration_0052_provider_pause_liveness(schema),
        },
        {
            version: "0053",
            name: "provider_meters",
            sql: migration_0053_provider_meters(schema),
        },
        {
            version: "0054",
            name: "provider_grid_owner",
            sql: migration_0054_provider_grid_owner(schema),
        },
        {
            version: "0055",
            name: "provider_grid_owner_label",
            sql: migration_0055_provider_grid_owner_label(schema),
        },
        {
            version: "0056",
            name: "provider_admission_defaults",
            sql: migration_0056_provider_admission_defaults(schema),
        },
        {
            version: "0057",
            name: "provider_system_routing",
            sql: migration_0057_provider_system_routing(schema),
        },
        {
            version: "0058",
            name: "legacy_github_provider_migration",
            sql: migration_0058_legacy_github_provider_migration(schema),
        },
        {
            version: "0059",
            name: "provider_authoritative_routing",
            sql: migration_0059_provider_authoritative_routing(schema),
        },
        {
            version: "0060",
            name: "provider_grid_metered_models",
            sql: migration_0060_provider_grid_metered_models(schema),
        },
        {
            version: "0061",
            name: "provider_correctness_fixes",
            sql: migration_0061_provider_correctness_fixes(schema),
        },
        {
            version: "0062",
            name: "provider_ledger_base",
            sql: migration_0062_provider_ledger_base(schema),
        },
        {
            version: "0063",
            name: "agent_package_editors",
            sql: migration_0063_agent_package_editors(schema),
        },
        {
            version: "0064",
            name: "canvas_kv",
            sql: migration_0064_canvas_kv(schema),
        },
        {
            version: "0065",
            name: "personal_provider_credential_update",
            sql: migration_0065_personal_provider_credential_update(schema),
        },
        {
            version: "0066",
            name: "personal_credential_update_preserves_api_version",
            sql: migration_0066_personal_credential_update_preserves_api_version(schema),
        },
        {
            version: "0067",
            name: "shared_provider_credential_update",
            sql: migration_0067_shared_provider_credential_update(schema),
        },
        {
            version: "0068",
            name: "provider_usage_summary",
            sql: migration_0068_provider_usage_summary(schema),
        },
        {
            version: "0069",
            name: "provider_grid_token_split",
            sql: migration_0069_provider_grid_token_split(schema),
        },
        {
            version: "0070",
            name: "token_total_is_input_plus_output",
            steps: migration_0070_token_total_is_input_plus_output(schema),
        },
        {
            version: "0071",
            name: "provider_usage_agents",
            sql: migration_0071_provider_usage_agents(schema),
        },
        {
            version: "0072",
            name: "session_creation_config",
            sql: migration_0072_session_creation_config(schema),
        },
    ];
}



// ─── Migration 0044: ms-space keyset for session paging ──────────
//
// PG stores updated_at at MICROsecond precision; the wire cursor is a JS Date
// (milliseconds). Comparing an ms-truncated cursor against full-precision
// columns silently skipped every same-millisecond row that landed at a page
// boundary — cms-read-bounds is the detector, open since v0.5.31. Predicate
// and ORDER BY now both truncate to milliseconds, so (trunc_ms, session_id)
// is a total order the ms cursor addresses exactly. Function replace only —
// same signature, no table DDL, no lock exposure.
function migration_0044_list_sessions_page_ms_cursor(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0044_list_sessions_page_ms_cursor: keyset comparisons in millisecond space.
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions_page(
    p_limit                 INT         DEFAULT 51,
    p_cursor_updated_at     TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id     TEXT        DEFAULT NULL,
    p_include_deleted       BOOL        DEFAULT FALSE,
    p_viewer_provider       TEXT        DEFAULT NULL,
    p_viewer_subject        TEXT        DEFAULT NULL,
    p_viewer_system_visible BOOL        DEFAULT TRUE,
    p_placement_provider    TEXT        DEFAULT NULL,
    p_placement_subject     TEXT        DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
    v_placement_user BIGINT;
BEGIN
    IF p_placement_provider IS NOT NULL AND p_placement_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_placement_user
        FROM ${s}.users u
        WHERE u.provider = BTRIM(p_placement_provider) AND u.subject = BTRIM(p_placement_subject);
    END IF;
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        usgp.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider     AS owner_provider,
        u.subject      AS owner_subject,
        u.email        AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    LEFT JOIN ${s}.user_session_group_placements usgp
        ON usgp.user_id = v_placement_user AND usgp.root_session_id = sess.session_id
    WHERE
        (p_include_deleted OR sess.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR date_trunc('milliseconds', sess.updated_at) < date_trunc('milliseconds', p_cursor_updated_at)
            OR (
                date_trunc('milliseconds', sess.updated_at) = date_trunc('milliseconds', p_cursor_updated_at)
                AND sess.session_id < p_cursor_session_id
            )
        )
        AND (
            p_viewer_provider IS NULL
            OR EXISTS (
                SELECT 1
                FROM ${s}.sessions r
                LEFT JOIN ${s}.session_owners rso ON rso.session_id = r.session_id
                LEFT JOIN ${s}.users ru ON ru.user_id = rso.user_id
                WHERE r.session_id = COALESCE(sess.root_session_id, sess.session_id)
                  AND (
                    (r.is_system AND p_viewer_system_visible)
                    OR (ru.provider = BTRIM(p_viewer_provider) AND ru.subject = BTRIM(p_viewer_subject))
                    OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
                    OR EXISTS (
                        SELECT 1 FROM ${s}.session_shares sh
                        JOIN ${s}.users vu ON vu.user_id = sh.user_id
                        WHERE sh.session_id = r.session_id
                          AND vu.provider = BTRIM(p_viewer_provider)
                          AND vu.subject = BTRIM(p_viewer_subject)
                    )
                  )
            )
        )
    ORDER BY date_trunc('milliseconds', sess.updated_at) DESC, sess.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0040: worker registry ─────────────────────────────
//
// docs/proposals/worker-registry.md (rev 4). Substrate-neutral, uniformly
// ephemeral workers (presence, not enrollment) + fleet_directives, the
// scoped desired-state channel (fleet/pool/worker, shallow-merge union,
// epoch = SUM of contributing rows). The heartbeat IS the convergence poll:
// one proc upserts the worker row, prunes hour-silent rows, and returns the
// effective directive set.
//
// Agent packages fold in as the first tenant VIA SHIMS with unchanged
// signatures: cms_agent_registry_bump/_epoch ride the
// ('agent-packages','*','*') directive row (seeded from
// agent_registry_state so epochs continue monotonically — old workers see
// no spurious change), and cms_list_agent_worker_state unions the legacy
// table with workers.state so mixed fleets display correctly during a
// rolling upgrade. Legacy tables are dropped later (0041) once the fleet
// is upgraded.
function migration_0040_worker_registry(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0040_worker_registry: workers + fleet_directives + heartbeat + shims.

CREATE TABLE IF NOT EXISTS ${s}.workers (
    worker_node_id TEXT PRIMARY KEY,
    pool           TEXT NOT NULL DEFAULT 'default',
    phase          TEXT NOT NULL DEFAULT 'starting' CHECK (phase IN ('starting', 'ready', 'draining')),
    owner_provider TEXT,
    owner_subject  TEXT,
    registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    info           JSONB NOT NULL DEFAULT '{}'::jsonb,
    health         JSONB NOT NULL DEFAULT '{}'::jsonb,
    state          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS workers_pool_idx ON ${s}.workers (pool);

CREATE TABLE IF NOT EXISTS ${s}.fleet_directives (
    domain         TEXT NOT NULL,
    pool           TEXT NOT NULL DEFAULT '*',
    worker_node_id TEXT NOT NULL DEFAULT '*',
    epoch          BIGINT NOT NULL DEFAULT 1,
    actuation      TEXT NOT NULL DEFAULT 'worker' CHECK (actuation IN ('worker', 'external')),
    desired        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by     TEXT,
    -- Canonical form is structural: a row specializes pool OR worker, never
    -- both, so even direct SQL cannot create an undefined-precedence row.
    CONSTRAINT fleet_directives_canonical_scope CHECK (pool = '*' OR worker_node_id = '*'),
    PRIMARY KEY (domain, pool, worker_node_id)
);

-- Seed the agent-packages directive from the legacy epoch so old and new
-- workers observe ONE continuous monotonic counter. Idempotent; the second
-- insert covers schemas where agent_registry_state was never populated.
INSERT INTO ${s}.fleet_directives (domain, pool, worker_node_id, epoch, actuation, desired, updated_by)
SELECT 'agent-packages', '*', '*', GREATEST(st.epoch, 1), 'worker', '{}'::jsonb, 'migration-0040'
  FROM ${s}.agent_registry_state st WHERE st.id = 1
ON CONFLICT (domain, pool, worker_node_id) DO NOTHING;
INSERT INTO ${s}.fleet_directives (domain, pool, worker_node_id, epoch, actuation, desired, updated_by)
VALUES ('agent-packages', '*', '*', 1, 'worker', '{}'::jsonb, 'migration-0040')
ON CONFLICT (domain, pool, worker_node_id) DO NOTHING;

-- ── directive mutation ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_fleet_directive_bump(
    p_domain TEXT, p_pool TEXT, p_worker_node_id TEXT,
    p_desired JSONB, p_actuation TEXT, p_updated_by TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_pool TEXT := COALESCE(NULLIF(BTRIM(p_pool), ''), '*');
    v_worker TEXT := COALESCE(NULLIF(BTRIM(p_worker_node_id), ''), '*');
    v_actuation TEXT := COALESCE(NULLIF(p_actuation, ''), 'worker');
    v_existing_actuation TEXT;
    v_epoch BIGINT;
BEGIN
    -- One writer per domain: the actuation-uniformity check below is
    -- read-then-write, and two first-bumps racing could persist a mixed
    -- domain that wedges every later bump. Directive writes are admin-rate.
    PERFORM pg_advisory_xact_lock(hashtext('fleet_directive:' || p_domain));
    -- Canonical worker-row form: worker-scoped rows use pool '*'; a triple
    -- with BOTH pool and worker specialized has no defined precedence.
    IF v_worker <> '*' AND v_pool <> '*' THEN
        RAISE EXCEPTION 'FLEET_DIRECTIVE_BAD_SCOPE: worker-scoped directives use pool ''*'' (canonical form)';
    END IF;
    -- agent-packages converges through the legacy epoch shim (fleet row
    -- only) until the registrar consumes the heartbeat's directive set; a
    -- scoped row would be silently dead while skewing the summed epoch.
    IF p_domain = 'agent-packages' AND (v_pool <> '*' OR v_worker <> '*') THEN
        RAISE EXCEPTION 'FLEET_DIRECTIVE_BAD_SCOPE: agent-packages directives are fleet-wide for now (workers converge on the fleet row only)';
    END IF;
    -- Actuation is a property of the DOMAIN, uniform across its rows.
    SELECT d.actuation INTO v_existing_actuation
      FROM ${s}.fleet_directives d WHERE d.domain = p_domain LIMIT 1;
    IF v_existing_actuation IS NOT NULL AND v_existing_actuation <> v_actuation THEN
        RAISE EXCEPTION 'FLEET_DIRECTIVE_ACTUATION_MISMATCH: domain "%" is %-actuated; all rows of a domain share one actuation', p_domain, v_existing_actuation;
    END IF;
    INSERT INTO ${s}.fleet_directives (domain, pool, worker_node_id, epoch, actuation, desired, updated_at, updated_by)
    VALUES (p_domain, v_pool, v_worker, 1, v_actuation, COALESCE(p_desired, '{}'::jsonb), now(), p_updated_by)
    ON CONFLICT (domain, pool, worker_node_id) DO UPDATE
        SET epoch = ${s}.fleet_directives.epoch + 1,
            desired = COALESCE(p_desired, ${s}.fleet_directives.desired),
            updated_at = now(),
            updated_by = COALESCE(p_updated_by, ${s}.fleet_directives.updated_by)
    RETURNING epoch INTO v_epoch;
    RETURN v_epoch;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_directives()
RETURNS TABLE(domain TEXT, pool TEXT, worker_node_id TEXT, epoch BIGINT,
              actuation TEXT, desired JSONB, updated_at TIMESTAMPTZ, updated_by TEXT) AS $$
    SELECT domain, pool, worker_node_id, epoch, actuation, desired, updated_at, updated_by
      FROM ${s}.fleet_directives
     ORDER BY domain, pool, worker_node_id;
$$ LANGUAGE sql;

-- ── the one round-trip ───────────────────────────────────────────
--
-- Upsert the worker row (info/owner insert-only; pool/phase/health/state/
-- updated_at every beat), apply the uniform prune, and return the worker's
-- effective directive set: per domain, the shallow-merge union of the
-- fleet/pool/worker rows (worker > pool > fleet on conflicting keys) with
-- epoch = SUM of contributing epochs (monotonic under any single-row bump).

CREATE OR REPLACE FUNCTION ${s}.cms_worker_heartbeat(
    p_worker_node_id TEXT, p_pool TEXT, p_phase TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT,
    p_info JSONB, p_health JSONB, p_state JSONB
) RETURNS TABLE(domain TEXT, epoch BIGINT, actuation TEXT, desired JSONB) AS $$
DECLARE
    v_pool TEXT := COALESCE(NULLIF(BTRIM(p_pool), ''), 'default');
    -- Unknown phases coerce to 'starting' (never advertise garbage as
    -- healthy); '*' or blank ids would cross-match every worker-scoped
    -- directive at top specificity, so they are rejected outright.
    v_phase TEXT := CASE WHEN p_phase IN ('starting', 'ready', 'draining') THEN p_phase ELSE 'starting' END;
BEGIN
    IF p_worker_node_id IS NULL OR BTRIM(p_worker_node_id) = '' OR p_worker_node_id = '*' THEN
        RAISE EXCEPTION 'WORKER_ID_INVALID: worker_node_id must be a non-empty identifier';
    END IF;
    INSERT INTO ${s}.workers (worker_node_id, pool, phase, owner_provider, owner_subject,
                              registered_at, updated_at, info, health, state)
    VALUES (p_worker_node_id, v_pool, v_phase,
            NULLIF(BTRIM(p_owner_provider), ''), NULLIF(BTRIM(p_owner_subject), ''),
            now(), now(),
            COALESCE(p_info, '{}'::jsonb), COALESCE(p_health, '{}'::jsonb), COALESCE(p_state, '{}'::jsonb))
    ON CONFLICT (worker_node_id) DO UPDATE
        SET pool = EXCLUDED.pool,
            phase = EXCLUDED.phase,
            health = EXCLUDED.health,
            state = EXCLUDED.state,
            updated_at = now();

    -- Uniform gone-ness: silent for an hour = gone, whatever the substrate.
    DELETE FROM ${s}.workers w WHERE w.updated_at < now() - interval '1 hour';

    RETURN QUERY
    WITH contrib AS (
        SELECT d.domain AS c_domain, d.epoch AS c_epoch,
               d.actuation AS c_actuation, d.desired AS c_desired,
               CASE WHEN d.worker_node_id = p_worker_node_id THEN 3
                    WHEN d.pool = v_pool THEN 2
                    ELSE 1 END AS specificity
          FROM ${s}.fleet_directives d
         WHERE (d.pool = '*' AND d.worker_node_id = '*')
            OR (d.pool = v_pool AND d.worker_node_id = '*')
            OR (d.worker_node_id = p_worker_node_id)
    )
    SELECT c.c_domain,
           SUM(c.c_epoch)::BIGINT,
           (array_agg(c.c_actuation ORDER BY c.specificity DESC))[1],
           COALESCE((array_agg(c.c_desired ORDER BY c.specificity ASC))[1], '{}'::jsonb)
           || COALESCE((array_agg(c.c_desired ORDER BY c.specificity ASC))[2], '{}'::jsonb)
           || COALESCE((array_agg(c.c_desired ORDER BY c.specificity ASC))[3], '{}'::jsonb)
      FROM contrib c
     GROUP BY c.c_domain;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_workers()
RETURNS TABLE(worker_node_id TEXT, pool TEXT, phase TEXT,
              owner_provider TEXT, owner_subject TEXT,
              registered_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
              info JSONB, health JSONB, state JSONB) AS $$
    SELECT worker_node_id, pool, phase, owner_provider, owner_subject,
           registered_at, updated_at, info, health, state
      FROM ${s}.workers
     ORDER BY pool, worker_node_id;
$$ LANGUAGE sql;

-- ── agent-packages fold-in shims (signatures unchanged) ──────────

CREATE OR REPLACE FUNCTION ${s}.cms_agent_registry_bump() RETURNS BIGINT AS $$
    SELECT ${s}.cms_fleet_directive_bump('agent-packages', '*', '*', NULL, 'worker', 'agent-packages');
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_agent_registry_epoch() RETURNS BIGINT AS $$
    SELECT COALESCE((SELECT d.epoch FROM ${s}.fleet_directives d
                      WHERE d.domain = 'agent-packages' AND d.pool = '*' AND d.worker_node_id = '*'), 0);
$$ LANGUAGE sql;

-- Mixed-fleet display: union legacy agent_worker_state (old workers still
-- write it) with workers.state->'agent-packages' (new workers), newest row
-- per worker wins. Read paths (portal fleet adoption, MCP) stay untouched.
CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_worker_state()
RETURNS TABLE(worker_node_id TEXT, epoch BIGINT, installed JSONB, updated_at TIMESTAMPTZ) AS $$
    SELECT DISTINCT ON (u.worker_node_id)
           u.worker_node_id, u.epoch, u.installed, u.updated_at
      FROM (
        SELECT w.worker_node_id,
               CASE WHEN jsonb_typeof(w.state->'agent-packages'->'epoch') = 'number'
                    THEN (w.state->'agent-packages'->>'epoch')::BIGINT
                    ELSE 0 END AS epoch,
               COALESCE(w.state->'agent-packages'->'installed', '{}'::jsonb) AS installed,
               w.updated_at
          FROM ${s}.workers w
        UNION ALL
        SELECT a.worker_node_id, a.epoch, a.installed, a.updated_at
          FROM ${s}.agent_worker_state a
      ) u
     ORDER BY u.worker_node_id, u.updated_at DESC;
$$ LANGUAGE sql;
`;
}

// ─── Migration 0039: agent_worker_state self-prune ───────────────
//
// Workers are EPHEMERAL (K8s pods; names change every rollout), so
// agent_worker_state accumulated a row per pod that ever reported and
// fleet adoption read "8/16 workers". Workers now heartbeat updated_at on
// every poll; liveness is a display-side window (~90s), and this upsert
// prunes rows silent for over an hour so the table stays the live fleet
// plus a short tail. Same signature as 0038's version — CREATE OR REPLACE.
function migration_0039_agent_worker_heartbeat_prune(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_agent_worker_state(
    p_worker_node_id TEXT, p_epoch BIGINT, p_installed JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.agent_worker_state (worker_node_id, epoch, installed, updated_at)
    VALUES (p_worker_node_id, p_epoch, COALESCE(p_installed, '{}'::jsonb), now())
    ON CONFLICT (worker_node_id) DO UPDATE
        SET epoch = EXCLUDED.epoch,
            installed = EXCLUDED.installed,
            updated_at = now();
    -- Ephemeral-fleet hygiene: a worker silent for an hour is gone (pods
    -- report every ~20s; rollouts retire names forever).
    DELETE FROM ${s}.agent_worker_state
     WHERE updated_at < now() - interval '1 hour';
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0038: agent packages registry ─────────────────────
//
// User-uploadable agent packages (docs/proposals/agent-packages.md).
// All-new tables, so a single transactional migration is safe — no hot-table
// ALTERs, no steps shape needed. Identity is (name, semver); sha256 is a
// verifier. agent_registry_state.epoch is bumped by EVERY mutating proc that
// changes what workers should run — workers poll it to converge without
// restarts. auth_token follows the users.github_copilot_key posture: status
// procs return a boolean, the raw read is internal-only.
function migration_0038_agent_packages(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0038_agent_packages: registry for user-uploadable agent packages.

CREATE TABLE IF NOT EXISTS ${s}.agent_sources (
    source_id        TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('github', 'ado', 'url', 'upload')),
    scope            TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('shared', 'user')),
    repo_url         TEXT,
    ref              TEXT,
    path             TEXT,
    url              TEXT,
    auth_token       TEXT,
    auto_sync        BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_at     TIMESTAMPTZ,
    last_sync_status TEXT,
    last_sync_error  TEXT,
    last_commit_sha  TEXT,
    owner_provider   TEXT,
    owner_subject    TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${s}.agent_packages (
    package_id        TEXT PRIMARY KEY,
    source_id         TEXT REFERENCES ${s}.agent_sources(source_id) ON DELETE SET NULL,
    name              TEXT NOT NULL UNIQUE,
    scope             TEXT NOT NULL CHECK (scope IN ('shared', 'user')),
    owner_provider    TEXT,
    owner_subject     TEXT,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    active_version_id TEXT,
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_packages_owner_idx ON ${s}.agent_packages (owner_provider, owner_subject);

CREATE TABLE IF NOT EXISTS ${s}.agent_package_versions (
    version_id        TEXT PRIMARY KEY,
    package_id        TEXT NOT NULL REFERENCES ${s}.agent_packages(package_id) ON DELETE CASCADE,
    semver            TEXT NOT NULL,
    sha256            TEXT NOT NULL,
    size_bytes        BIGINT NOT NULL,
    artifact_filename TEXT NOT NULL,
    commit_sha        TEXT,
    manifest          JSONB NOT NULL,
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (package_id, semver)
);

CREATE TABLE IF NOT EXISTS ${s}.agent_registry_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    epoch      BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ${s}.agent_registry_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ${s}.agent_worker_state (
    worker_node_id TEXT PRIMARY KEY,
    epoch          BIGINT NOT NULL DEFAULT 0,
    installed      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── epoch ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_agent_registry_epoch() RETURNS BIGINT AS $$
    SELECT epoch FROM ${s}.agent_registry_state WHERE id = 1;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_agent_registry_bump() RETURNS BIGINT AS $$
    UPDATE ${s}.agent_registry_state
       SET epoch = epoch + 1, updated_at = now()
     WHERE id = 1
    RETURNING epoch;
$$ LANGUAGE sql;

-- ── sources ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_register_agent_source(
    p_source_id TEXT, p_kind TEXT, p_scope TEXT, p_repo_url TEXT, p_ref TEXT, p_path TEXT,
    p_url TEXT, p_auth_token TEXT, p_auto_sync BOOLEAN,
    p_owner_provider TEXT, p_owner_subject TEXT, p_created_by TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.agent_sources
        (source_id, kind, scope, repo_url, ref, path, url, auth_token, auto_sync,
         owner_provider, owner_subject, created_by)
    VALUES (p_source_id, p_kind, COALESCE(NULLIF(p_scope, ''), 'user'), p_repo_url, p_ref, p_path,
            NULLIF(p_url, ''), NULLIF(p_auth_token, ''), COALESCE(p_auto_sync, FALSE),
            NULLIF(BTRIM(p_owner_provider), ''), NULLIF(BTRIM(p_owner_subject), ''), p_created_by);
END;
$$ LANGUAGE plpgsql;

-- Listing never returns auth_token — only whether one is set.
CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_sources(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    source_id TEXT, kind TEXT, scope TEXT, repo_url TEXT, ref TEXT, path TEXT, url TEXT,
    auth_token_set BOOLEAN, auto_sync BOOLEAN, last_sync_at TIMESTAMPTZ,
    last_sync_status TEXT, last_sync_error TEXT, last_commit_sha TEXT,
    owner_provider TEXT, owner_subject TEXT, created_by TEXT, created_at TIMESTAMPTZ
) AS $$
    SELECT source_id, kind, scope, repo_url, ref, path, url,
           (auth_token IS NOT NULL), auto_sync, last_sync_at,
           last_sync_status, last_sync_error, last_commit_sha,
           owner_provider, owner_subject, created_by, created_at
      FROM ${s}.agent_sources s
     WHERE p_is_admin
        OR (s.owner_provider = BTRIM(p_viewer_provider) AND s.owner_subject = BTRIM(p_viewer_subject))
     ORDER BY created_at DESC;
$$ LANGUAGE sql;

-- Internal-only raw token read for the sync fetchers. Never expose through
-- the public management API (github_copilot_key precedent, migration 0010).
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_source_token(p_source_id TEXT)
RETURNS TEXT AS $$
    SELECT auth_token FROM ${s}.agent_sources WHERE source_id = p_source_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_source(p_source_id TEXT)
RETURNS TABLE(
    source_id TEXT, kind TEXT, scope TEXT, repo_url TEXT, ref TEXT, path TEXT, url TEXT,
    auth_token_set BOOLEAN, auto_sync BOOLEAN, last_sync_at TIMESTAMPTZ,
    last_sync_status TEXT, last_sync_error TEXT, last_commit_sha TEXT,
    owner_provider TEXT, owner_subject TEXT, created_by TEXT, created_at TIMESTAMPTZ
) AS $$
    SELECT source_id, kind, scope, repo_url, ref, path, url,
           (auth_token IS NOT NULL), auto_sync, last_sync_at,
           last_sync_status, last_sync_error, last_commit_sha,
           owner_provider, owner_subject, created_by, created_at
      FROM ${s}.agent_sources
     WHERE source_id = p_source_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_agent_source_sync(
    p_source_id TEXT, p_status TEXT, p_error TEXT, p_commit_sha TEXT
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.agent_sources
       SET last_sync_at = now(),
           last_sync_status = p_status,
           last_sync_error = p_error,
           last_commit_sha = COALESCE(p_commit_sha, last_commit_sha)
     WHERE source_id = p_source_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_delete_agent_source(
    p_source_id TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_src RECORD;
BEGIN
    SELECT * INTO v_src FROM ${s}.agent_sources WHERE source_id = p_source_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_SOURCE_NOT_FOUND: source % does not exist', p_source_id;
    END IF;
    IF NOT p_is_admin AND (
        v_src.owner_provider IS NULL
        OR v_src.owner_provider IS DISTINCT FROM NULLIF(BTRIM(p_actor_provider), '')
        OR v_src.owner_subject IS DISTINCT FROM NULLIF(BTRIM(p_actor_subject), '')
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the source creator or an admin can delete it';
    END IF;
    DELETE FROM ${s}.agent_sources WHERE source_id = p_source_id;
END;
$$ LANGUAGE plpgsql;

-- ── publish (the atomic heart) ───────────────────────────────────
--
-- Row-locks the package by name, enforces creator-or-admin, treats an
-- identical (semver, sha256) republish as a no-op, rejects same-semver
-- different-content outright (bump the version — no replace), inserts the
-- version, activates it, and bumps the registry epoch. status is one of
-- 'published' | 'noop'.

CREATE OR REPLACE FUNCTION ${s}.cms_publish_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_name TEXT, p_scope TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT, p_source_id TEXT,
    p_semver TEXT, p_sha256 TEXT, p_size_bytes BIGINT, p_artifact_filename TEXT,
    p_commit_sha TEXT, p_manifest JSONB, p_created_by TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(status TEXT, package_id TEXT, version_id TEXT) AS $$
DECLARE
    v_pkg RECORD;
    v_ver RECORD;
    v_owner_provider TEXT := NULLIF(BTRIM(p_owner_provider), '');
    v_owner_subject  TEXT := NULLIF(BTRIM(p_owner_subject), '');
BEGIN
    -- An owner-less publish is admin-only: a NULL-owner package would be
    -- unmanageable by its (anonymous) creator afterwards, so reject the
    -- combination up front instead of minting an orphan.
    IF NOT p_is_admin AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: publishing without an owner identity requires the admin role';
    END IF;

    <<retry>>
    LOOP
        SELECT * INTO v_pkg FROM ${s}.agent_packages p WHERE p.name = p_name FOR UPDATE;
        IF NOT FOUND THEN
            -- First publish. FOR UPDATE on a missing row takes no lock, so a
            -- concurrent first publish can beat this INSERT — catch the
            -- unique violation and loop back to lock the winner's row.
            BEGIN
                INSERT INTO ${s}.agent_packages
                    (package_id, source_id, name, scope, owner_provider, owner_subject, created_by)
                VALUES (p_package_id, p_source_id, p_name, p_scope,
                        v_owner_provider, v_owner_subject, p_created_by);
            EXCEPTION WHEN unique_violation THEN
                CONTINUE retry;
            END;
            INSERT INTO ${s}.agent_package_versions
                (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
            VALUES (p_version_id, p_package_id, p_semver, p_sha256, p_size_bytes,
                    p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
            UPDATE ${s}.agent_packages SET active_version_id = p_version_id WHERE ${s}.agent_packages.package_id = p_package_id;
            PERFORM ${s}.cms_agent_registry_bump();
            RETURN QUERY SELECT 'published'::TEXT, p_package_id, p_version_id;
            RETURN;
        END IF;
        EXIT retry;
    END LOOP;

    -- A NULL-owner package (no-auth or system provenance) is admin-managed:
    -- publish must not be the one mutation left open to null principals.
    IF NOT p_is_admin AND (
        v_pkg.owner_provider IS NULL
        OR v_pkg.owner_provider IS DISTINCT FROM v_owner_provider
        OR v_pkg.owner_subject IS DISTINCT FROM v_owner_subject
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can publish new versions of "%"', p_name;
    END IF;

    IF p_scope IS DISTINCT FROM v_pkg.scope THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_SCOPE_MISMATCH: "%" is scope %, not %; change scope with promote/demote, not publish', p_name, v_pkg.scope, p_scope;
    END IF;

    SELECT * INTO v_ver FROM ${s}.agent_package_versions v
     WHERE v.package_id = v_pkg.package_id AND v.semver = p_semver;
    IF FOUND THEN
        IF v_ver.sha256 = p_sha256 THEN
            RETURN QUERY SELECT 'noop'::TEXT, v_pkg.package_id, v_ver.version_id;
            RETURN;
        END IF;
        RAISE EXCEPTION 'AGENT_PACKAGE_SEMVER_CONFLICT: %@% is already published with different content — published versions are immutable, bump the version', p_name, p_semver;
    END IF;

    INSERT INTO ${s}.agent_package_versions
        (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
    VALUES (p_version_id, v_pkg.package_id, p_semver, p_sha256, p_size_bytes,
            p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
    UPDATE ${s}.agent_packages
       SET active_version_id = p_version_id,
           source_id = COALESCE(p_source_id, ${s}.agent_packages.source_id)
     WHERE ${s}.agent_packages.package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
    RETURN QUERY SELECT 'published'::TEXT, v_pkg.package_id, p_version_id;
END;
$$ LANGUAGE plpgsql;

-- ── package reads ────────────────────────────────────────────────
--
-- Visibility: shared packages are visible to everyone; user packages only to
-- their owner (or an admin). This filter is THE user-scope privacy boundary —
-- every listing path goes through one of these two procs.

CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_packages(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, semver TEXT, sha256 TEXT, size_bytes BIGINT,
    artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           p.enabled, p.created_by, p.created_at,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
     WHERE p.scope = 'shared'
        OR p_is_admin
        OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
     ORDER BY p.scope, p.name;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, version_id TEXT, semver TEXT, sha256 TEXT,
    size_bytes BIGINT, artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           p.enabled, p.created_by, p.created_at, p.active_version_id,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.package_id = p.package_id
     WHERE p.name = p_name
       AND (p.scope = 'shared' OR p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject)))
     ORDER BY v.created_at DESC;
$$ LANGUAGE sql;

-- Worker-facing install manifest: every enabled package's active version.
-- Workers are trusted infrastructure — no viewer filter here by design.
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_install_manifest()
RETURNS TABLE(
    name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB
) AS $$
    SELECT p.name, p.scope, p.owner_provider, p.owner_subject, v.semver, v.sha256,
           v.size_bytes, v.artifact_filename, v.manifest
      FROM ${s}.agent_packages p
      JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
     WHERE p.enabled
     ORDER BY p.name;
$$ LANGUAGE sql;

-- ── package mutations (all creator-or-admin, all epoch-bumping) ──

CREATE OR REPLACE FUNCTION ${s}.cms_agent_package_authz(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS ${s}.agent_packages AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE name = p_name FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
    END IF;
    IF NOT p_is_admin AND (
        v_pkg.owner_provider IS NULL
        OR v_pkg.owner_provider IS DISTINCT FROM NULLIF(BTRIM(p_actor_provider), '')
        OR v_pkg.owner_subject IS DISTINCT FROM NULLIF(BTRIM(p_actor_subject), '')
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can modify "%"', p_name;
    END IF;
    RETURN v_pkg;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_scope(
    p_name TEXT, p_scope TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    UPDATE ${s}.agent_packages SET scope = p_scope WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_enabled(
    p_name TEXT, p_enabled BOOLEAN, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    UPDATE ${s}.agent_packages SET enabled = p_enabled WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_pin_agent_package_version(
    p_name TEXT, p_semver TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_version_id TEXT;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    SELECT version_id INTO v_version_id FROM ${s}.agent_package_versions
     WHERE package_id = v_pkg.package_id AND semver = p_semver;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_VERSION_NOT_FOUND: %@% is not a published version', p_name, p_semver;
    END IF;
    UPDATE ${s}.agent_packages SET active_version_id = v_version_id WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- Returns the artifact filenames of every deleted version so the caller can
-- clean up the artifact store after the transaction commits.
CREATE OR REPLACE FUNCTION ${s}.cms_delete_agent_package(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(artifact_filename TEXT) AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    RETURN QUERY
        SELECT v.artifact_filename FROM ${s}.agent_package_versions v
         WHERE v.package_id = v_pkg.package_id;
    DELETE FROM ${s}.agent_packages WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- ── worker fleet state ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_upsert_agent_worker_state(
    p_worker_node_id TEXT, p_epoch BIGINT, p_installed JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.agent_worker_state (worker_node_id, epoch, installed, updated_at)
    VALUES (p_worker_node_id, p_epoch, COALESCE(p_installed, '{}'::jsonb), now())
    ON CONFLICT (worker_node_id) DO UPDATE
        SET epoch = EXCLUDED.epoch,
            installed = EXCLUDED.installed,
            updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_worker_state()
RETURNS TABLE(worker_node_id TEXT, epoch BIGINT, installed JSONB, updated_at TIMESTAMPTZ) AS $$
    SELECT worker_node_id, epoch, installed, updated_at
      FROM ${s}.agent_worker_state
     ORDER BY worker_node_id;
$$ LANGUAGE sql;
`;
}

// ─── Migration 0037: service sessions (tree-scoped system sessions) ─────
//
// A service session is machinery that serves ONE session tree (first kind:
// "regen-distiller"), parented under the tree's root. Columns only — every
// read path joins the raw table (the transcript_epoch precedent) and the
// create path UPDATEs post-insert inside the same transaction, so no proc
// signature changes and re-application stays idempotent.
function migration_0037_service_sessions(schema: string): string {
    const s = `"${schema}"`;
    return `
        ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS service_kind text;
        ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS service_of uuid;
    `;
}

// ─── Migration 0036: session regeneration (epoch rebirth) ────────

function migration_0036_session_regeneration(schema: string): string[] {
    const s = `"${schema}"`;

    // Non-transactional steps (0029 hardened shape): the ALTERs are
    // metadata-only fast defaults but still take a brief ACCESS EXCLUSIVE
    // lock on hot tables — commit them alone under a lock_timeout so a
    // blocked ALTER fails fast and the CMS-init retry re-attempts, instead
    // of queueing the fleet behind the lock request. Function DDL stays one
    // atomic step. Every step is idempotent.

    const step_columns = `
SET lock_timeout = '5s';
ALTER TABLE ${s}.sessions
    ADD COLUMN IF NOT EXISTS transcript_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${s}.sessions
    ADD COLUMN IF NOT EXISTS last_regenerated_at TIMESTAMPTZ;
ALTER TABLE ${s}.session_metrics
    ADD COLUMN IF NOT EXISTS regen_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${s}.session_metrics
    ADD COLUMN IF NOT EXISTS last_regen_stats JSONB;
-- session_metric_summaries is the 0027 compatibility VIEW (SELECT * frozen at
-- creation) — recreate it so the new columns are visible through it.
DROP VIEW IF EXISTS ${s}.session_metric_summaries;
CREATE VIEW ${s}.session_metric_summaries AS SELECT * FROM ${s}.session_metrics;
`;

    const step_functions = `
-- Idempotency note: the two record procs below dedup on the attempt id via
-- SELECT-then-INSERT, which is replay-safe under duroxide's single-active-
-- execution guarantee (the only writer). A DB-enforced partial unique index
-- was evaluated but deferred: CREATE INDEX CONCURRENTLY interacts poorly with
-- the migrator's advisory-lock path under many parallel schema builds, and it
-- guards only a scenario the single-writer guarantee already prevents.

-- ── cms_record_epoch_committed ───────────────────────────────────
-- The flip's boundary record, ONE transaction (a plpgsql function body):
-- the session.epoch_committed event, sessions.transcript_epoch, and
-- regen_count can never disagree, and replay cannot double-count —
-- idempotent on the attempt id (a repeat returns the original seq).
-- Emitted by the NEW execution before any epoch turn, so its seq is the
-- epoch boundary every per-epoch axis keys on.
CREATE OR REPLACE FUNCTION ${s}.cms_record_epoch_committed(
    p_session_id TEXT,
    p_payload    JSONB
) RETURNS BIGINT AS $$
DECLARE
    v_existing BIGINT;
    v_seq      BIGINT;
BEGIN
    SELECT e.seq INTO v_existing
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type = 'session.epoch_committed'
      AND e.data->>'attemptId' = p_payload->>'attemptId'
    ORDER BY e.seq DESC
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (p_session_id, 'session.epoch_committed', p_payload)
    RETURNING seq INTO v_seq;

    UPDATE ${s}.sessions
    SET transcript_epoch = COALESCE(NULLIF(p_payload->>'toEpoch', ''), '0')::int,
        last_regenerated_at = NOW(),
        updated_at = NOW()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (session_id, regen_count)
    VALUES (p_session_id, 1)
    ON CONFLICT (session_id) DO UPDATE
    SET regen_count = COALESCE(${s}.session_metrics.regen_count, 0) + 1,
        updated_at = NOW();

    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;

-- ── cms_record_regenerated ───────────────────────────────────────
-- The PROVEN rebirth (first epoch snapshot commit landed): the
-- session.regenerated event + last_regen_stats. Idempotent on attempt id.
CREATE OR REPLACE FUNCTION ${s}.cms_record_regenerated(
    p_session_id TEXT,
    p_payload    JSONB
) RETURNS BIGINT AS $$
DECLARE
    v_existing BIGINT;
    v_seq      BIGINT;
BEGIN
    SELECT e.seq INTO v_existing
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type = 'session.regenerated'
      AND e.data->>'attemptId' = p_payload->>'attemptId'
    ORDER BY e.seq DESC
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (p_session_id, 'session.regenerated', p_payload)
    RETURNING seq INTO v_seq;

    UPDATE ${s}.session_metrics
    SET last_regen_stats = p_payload->'stats',
        updated_at = NOW()
    WHERE session_id = p_session_id;

    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;

`;

    return [step_columns, step_functions];
}

// ─── Migration 0035: footprint stat procs ───────────────────────

function migration_0035_footprint_stat_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0035_footprint_stat_procs: per-session aggregates for the session
-- footprint sensor (docs/proposals/session-regen-and-footprint.md §11).
-- CREATE FUNCTION only — no table DDL, no locks, safe on hot tables.
--
-- Both functions REQUIRE the session_id predicate by construction: the
-- events table has no full-coverage created_at index, so an unfiltered
-- aggregate would seq-scan the fleet table.

-- ── cms_get_session_event_stats ──────────────────────────────────
-- Count + stored payload bytes + max seq for one session's events,
-- optionally restricted to events after p_after_seq (the epoch boundary).
-- Served by idx_events_session_seq: the count is index-driven and the byte
-- sum heap-fetches only this session's rows. pg_column_size reports stored
-- (possibly TOAST-compressed) size without detoasting.
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_event_stats(
    p_session_id TEXT,
    p_after_seq  BIGINT DEFAULT NULL
) RETURNS TABLE (
    event_count BIGINT,
    data_bytes  BIGINT,
    max_seq     BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::bigint                                   AS event_count,
        COALESCE(SUM(pg_column_size(e.data)), 0)::bigint   AS data_bytes,
        COALESCE(MAX(e.seq), 0)::bigint                    AS max_seq
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND (p_after_seq IS NULL OR e.seq > p_after_seq);
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_compaction_stats ─────────────────────────────
-- Compaction counters derived from the persisted SDK transcript events
-- (session.compaction_start / session.compaction_complete — these are NOT
-- in the ephemeral filter, so they land in session_events). Uses the
-- (session_id, event_type, seq) index. tokensRemoved is summed defensively:
-- non-numeric payloads are skipped, never an error.
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_compaction_stats(
    p_session_id TEXT,
    p_after_seq  BIGINT DEFAULT NULL
) RETURNS TABLE (
    starts         BIGINT,
    completes      BIGINT,
    failed         BIGINT,
    tokens_removed BIGINT,
    last_start_at    TIMESTAMPTZ,
    last_complete_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*) FILTER (WHERE e.event_type = 'session.compaction_start')::bigint
            AS starts,
        COUNT(*) FILTER (WHERE e.event_type = 'session.compaction_complete')::bigint
            AS completes,
        COUNT(*) FILTER (
            WHERE e.event_type = 'session.compaction_complete'
              AND (e.data->>'success') = 'false'
        )::bigint AS failed,
        COALESCE(SUM(
            CASE
                WHEN e.event_type = 'session.compaction_complete'
                 AND (e.data->>'tokensRemoved') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (e.data->>'tokensRemoved')::numeric
                ELSE NULL
            END
        ), 0)::bigint AS tokens_removed,
        MAX(e.created_at) FILTER (WHERE e.event_type = 'session.compaction_start')
            AS last_start_at,
        MAX(e.created_at) FILTER (WHERE e.event_type = 'session.compaction_complete')
            AS last_complete_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('session.compaction_start', 'session.compaction_complete')
      AND (p_after_seq IS NULL OR e.seq > p_after_seq);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0034: private per-user session-group placements ──

function migration_0034_user_session_group_placements(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0034_user_session_group_placements: session groups become private per-user
-- organization (docs/proposals/private-session-groups-and-deep-links.md).
--
-- A group assignment stops being a property of the session row and becomes a
-- (viewer, root) placement owned by the viewer: organizing a shared session
-- changes nothing for anyone else. Placement requires only read access to
-- the tree; the target group must be owned by the placing viewer — enforced
-- structurally by a composite FK into session_group_owners, so cross-user
-- placement is impossible. Children are never placed: ids normalize to their
-- tree root and only root rows carry a placement-sourced group_id in reads.
--
-- After this migration nothing reads or writes sessions.group_id (the column
-- is dropped in a LATER release). cms_assign_session_group and the zero-arg
-- cms_list_session_groups stay defined but uncalled for the rolling window;
-- the zero-arg group list remains the unscoped audit path.
--
-- No hot-table DDL: only a unique on the tiny session_group_owners table, a
-- new table, a backfill INSERT..SELECT, and function swaps — safe as one
-- plain transactional migration.

DO $usgp$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${schema}'
          AND t.relname = 'session_group_owners'
          AND c.conname = 'session_group_owners_group_user_uq'
    ) THEN
        ALTER TABLE ${s}.session_group_owners
            ADD CONSTRAINT session_group_owners_group_user_uq UNIQUE (group_id, user_id);
    END IF;
END
$usgp$;

CREATE TABLE IF NOT EXISTS ${s}.user_session_group_placements (
    user_id         BIGINT NOT NULL REFERENCES ${s}.users(user_id) ON DELETE CASCADE,
    root_session_id TEXT   NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    group_id        TEXT   NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, root_session_id),
    FOREIGN KEY (group_id, user_id)
        REFERENCES ${s}.session_group_owners(group_id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_${schema}_usgp_group_user
    ON ${s}.user_session_group_placements(group_id, user_id);

-- Ownerless-group adoption: a legacy group with no owner row adopts the
-- owner of its live member ROOTS when every such root is owned and all
-- resolve to the same user. Groups with zero live member roots or with
-- conflicting owners stay ownerless (quarantined: absent from viewer-scoped
-- lists, visible only through the unscoped audit path).
INSERT INTO ${s}.session_group_owners (group_id, user_id)
SELECT grp.group_id, grp.owner_user_id
FROM (
    SELECT sess.group_id, MIN(so.user_id) AS owner_user_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    WHERE sess.group_id IS NOT NULL
      AND sess.parent_session_id IS NULL
      AND sess.deleted_at IS NULL
    GROUP BY sess.group_id
    HAVING COUNT(*) FILTER (WHERE so.user_id IS NULL) = 0
       AND COUNT(DISTINCT so.user_id) = 1
) grp
JOIN ${s}.session_groups g ON g.group_id = grp.group_id
WHERE NOT EXISTS (
    SELECT 1 FROM ${s}.session_group_owners go WHERE go.group_id = grp.group_id
)
ON CONFLICT (group_id) DO NOTHING;

-- Placement backfill FROM ROOT ROWS ONLY: each live grouped root becomes its
-- owner's placement, and only when the group owner IS the root owner —
-- legacy rows that would cross user boundaries are skipped (diagnosed
-- below), never silently re-owned.
DO $usgp$
DECLARE
    v_placed         BIGINT;
    v_owner_mismatch BIGINT;
    v_unowned        BIGINT;
    v_ownerless      BIGINT;
    v_child_mismatch BIGINT;
BEGIN
    INSERT INTO ${s}.user_session_group_placements (user_id, root_session_id, group_id)
    SELECT so.user_id, sess.session_id, sess.group_id
    FROM ${s}.sessions sess
    JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    JOIN ${s}.session_group_owners go ON go.group_id = sess.group_id AND go.user_id = so.user_id
    WHERE sess.group_id IS NOT NULL
      AND sess.parent_session_id IS NULL
      AND sess.deleted_at IS NULL
    ON CONFLICT (user_id, root_session_id) DO NOTHING;
    GET DIAGNOSTICS v_placed = ROW_COUNT;

    SELECT COUNT(*) INTO v_owner_mismatch
    FROM ${s}.sessions sess
    JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    JOIN ${s}.session_group_owners go ON go.group_id = sess.group_id
    WHERE sess.group_id IS NOT NULL
      AND sess.parent_session_id IS NULL
      AND sess.deleted_at IS NULL
      AND go.user_id <> so.user_id;

    SELECT COUNT(*) INTO v_unowned
    FROM ${s}.sessions sess
    WHERE sess.group_id IS NOT NULL
      AND sess.parent_session_id IS NULL
      AND sess.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${s}.session_owners so WHERE so.session_id = sess.session_id);

    SELECT COUNT(*) INTO v_ownerless
    FROM ${s}.sessions sess
    WHERE sess.group_id IS NOT NULL
      AND sess.parent_session_id IS NULL
      AND sess.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${s}.session_group_owners go WHERE go.group_id = sess.group_id);

    SELECT COUNT(DISTINCT COALESCE(child.root_session_id, child.session_id)) INTO v_child_mismatch
    FROM ${s}.sessions child
    JOIN ${s}.sessions root ON root.session_id = COALESCE(child.root_session_id, child.session_id)
    WHERE child.parent_session_id IS NOT NULL
      AND child.deleted_at IS NULL
      AND child.group_id IS DISTINCT FROM root.group_id;

    RAISE NOTICE 'cms 0034: backfilled % session-group placement(s) from legacy root assignments', v_placed;
    IF v_owner_mismatch > 0 THEN
        RAISE WARNING 'cms 0034: skipped % grouped root(s) whose owner does not match the group owner', v_owner_mismatch;
    END IF;
    IF v_unowned > 0 THEN
        RAISE WARNING 'cms 0034: skipped % grouped root(s) with no session owner', v_unowned;
    END IF;
    IF v_ownerless > 0 THEN
        RAISE WARNING 'cms 0034: skipped % grouped root(s) in ownerless (quarantined) groups', v_ownerless;
    END IF;
    IF v_child_mismatch > 0 THEN
        RAISE WARNING 'cms 0034: % tree(s) have children whose legacy group_id differs from the root; children are never placed', v_child_mismatch;
    END IF;
END
$usgp$;

-- ── cms_place_sessions_in_group ──────────────────────────────────
-- The single placement mutation: upsert (or delete, when p_group_id is NULL)
-- the caller's placement for each distinct resolved live root. The target
-- group must be owned by the caller (raises; no distinction between missing
-- and foreign — no existence oracle). Per-root outcomes: unknown/unreadable
-- ids report placed=false, reason='not_found' with identical shape; system
-- trees report reason='system'. p_is_admin is the caller's concern — the
-- runtime passes admin OR NOT enforce, making permissive mode read-all.
-- Never touches the sessions table (placement is viewer-private state).
CREATE OR REPLACE FUNCTION ${s}.cms_place_sessions_in_group(
    p_provider    TEXT,
    p_subject     TEXT,
    p_is_admin    BOOLEAN,
    p_session_ids TEXT[],
    p_group_id    TEXT
) RETURNS TABLE (
    root_session_id TEXT,
    placed          BOOLEAN,
    reason          TEXT
) AS $$
-- The ON CONFLICT column list would otherwise be ambiguous against the
-- root_session_id OUT column; every other reference is table-qualified.
#variable_conflict use_column
DECLARE
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_user BIGINT;
    v_id TEXT;
    v_root TEXT;
    v_is_system BOOLEAN;
    v_readable BOOLEAN;
    v_seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
    v_user := ${s}.cms_register_user(p_provider, p_subject, NULL, NULL);

    IF v_group_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ${s}.session_group_owners go
        WHERE go.group_id = v_group_id AND go.user_id = v_user
    ) THEN
        RAISE EXCEPTION 'Session group % was not found or is not owned by the caller', v_group_id;
    END IF;

    FOREACH v_id IN ARRAY COALESCE(p_session_ids, ARRAY[]::TEXT[]) LOOP
        v_root := ${s}.cms_resolve_root_session(v_id);

        -- Unknown and unreadable ids must be indistinguishable: echo the INPUT
        -- id and dedupe on it, never on the resolved root — keying on the
        -- resolved root would leak the existence, id, and co-membership of a
        -- private foreign tree the caller cannot read.
        IF v_root IS NULL THEN
            IF array_position(v_seen, v_id) IS NOT NULL THEN
                CONTINUE;
            END IF;
            v_seen := v_seen || v_id;
            root_session_id := v_id; placed := FALSE; reason := 'not_found';
            RETURN NEXT;
            CONTINUE;
        END IF;

        SELECT r.is_system,
               (p_is_admin
                OR EXISTS (
                    SELECT 1 FROM ${s}.session_owners so
                    WHERE so.session_id = r.session_id AND so.user_id = v_user
                )
                OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
                OR EXISTS (
                    SELECT 1 FROM ${s}.session_shares sh
                    WHERE sh.session_id = r.session_id AND sh.user_id = v_user
                ))
        INTO v_is_system, v_readable
        FROM ${s}.sessions r
        WHERE r.session_id = v_root AND r.deleted_at IS NULL;

        IF NOT FOUND THEN
            IF array_position(v_seen, v_id) IS NOT NULL THEN
                CONTINUE;
            END IF;
            v_seen := v_seen || v_id;
            root_session_id := v_id; placed := FALSE; reason := 'not_found';
            RETURN NEXT;
            CONTINUE;
        END IF;

        -- System trees are deployment-visible: their root id is not private, so
        -- reason='system' may key on the resolved root.
        IF v_is_system THEN
            IF array_position(v_seen, v_root) IS NOT NULL THEN
                CONTINUE;
            END IF;
            v_seen := v_seen || v_root;
            root_session_id := v_root; placed := FALSE; reason := 'system';
            RETURN NEXT;
            CONTINUE;
        END IF;

        IF NOT v_readable THEN
            IF array_position(v_seen, v_id) IS NOT NULL THEN
                CONTINUE;
            END IF;
            v_seen := v_seen || v_id;
            root_session_id := v_id; placed := FALSE; reason := 'not_found';
            RETURN NEXT;
            CONTINUE;
        END IF;

        IF array_position(v_seen, v_root) IS NOT NULL THEN
            CONTINUE;
        END IF;
        v_seen := v_seen || v_root;

        IF v_group_id IS NULL THEN
            DELETE FROM ${s}.user_session_group_placements p
            WHERE p.user_id = v_user AND p.root_session_id = v_root;
        ELSE
            INSERT INTO ${s}.user_session_group_placements (user_id, root_session_id, group_id)
            VALUES (v_user, v_root, v_group_id)
            ON CONFLICT (user_id, root_session_id) DO UPDATE
            SET group_id = EXCLUDED.group_id,
                updated_at = now();
        END IF;
        root_session_id := v_root; placed := TRUE; reason := NULL;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── cms_list_session_groups (viewer-scoped overload) ─────────────
-- Only groups OWNED by the viewer, with counts/activity computed from the
-- viewer's OWN placements whose root is live and still readable to them
-- (a revoked share retains the placement but drops it from counts). Foreign
-- groups are never returned — admins included; the zero-arg legacy overload
-- remains the unscoped audit path. No parameter defaults: defaults would
-- make zero-arg calls ambiguous against the legacy overload.
CREATE OR REPLACE FUNCTION ${s}.cms_list_session_groups(
    p_provider TEXT,
    p_subject  TEXT,
    p_is_admin BOOLEAN
) RETURNS TABLE (
    group_id                  TEXT,
    title                     TEXT,
    description               TEXT,
    owner                     JSONB,
    metadata                  JSONB,
    member_count              INT,
    running_count             INT,
    waiting_count             INT,
    completed_count           INT,
    failed_count              INT,
    cancelled_count           INT,
    latest_activity_at        TIMESTAMPTZ,
    latest_summary_updated_at TIMESTAMPTZ,
    created_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ
) AS $$
DECLARE
    v_user BIGINT;
BEGIN
    SELECT u.user_id INTO v_user
    FROM ${s}.users u
    WHERE u.provider = BTRIM(p_provider) AND u.subject = BTRIM(p_subject);
    IF v_user IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        g.group_id,
        g.title,
        g.description,
        jsonb_build_object(
            'provider', u.provider,
            'subject', u.subject,
            'email', u.email,
            'displayName', u.display_name
        ) AS owner,
        g.metadata,
        COUNT(sess.session_id)::INT AS member_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('running', 'idle', 'pending'))::INT AS running_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('waiting', 'input_required'))::INT AS waiting_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'completed')::INT AS completed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('failed', 'error'))::INT AS failed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'cancelled')::INT AS cancelled_count,
        MAX(COALESCE(sess.last_active_at, sess.updated_at)) AS latest_activity_at,
        MAX(sess.summary_updated_at) AS latest_summary_updated_at,
        g.created_at,
        g.updated_at
    FROM ${s}.session_groups g
    JOIN ${s}.session_group_owners go ON go.group_id = g.group_id AND go.user_id = v_user
    JOIN ${s}.users u ON u.user_id = go.user_id
    LEFT JOIN ${s}.user_session_group_placements usgp
        ON usgp.group_id = g.group_id AND usgp.user_id = v_user
    LEFT JOIN ${s}.sessions sess
        ON sess.session_id = usgp.root_session_id
       AND sess.deleted_at IS NULL
       AND (
            p_is_admin
            OR EXISTS (
                SELECT 1 FROM ${s}.session_owners so
                WHERE so.session_id = sess.session_id AND so.user_id = v_user
            )
            OR COALESCE(sess.visibility, 'private') IN ('shared_read', 'shared_write')
            OR EXISTS (
                SELECT 1 FROM ${s}.session_shares sh
                WHERE sh.session_id = sess.session_id AND sh.user_id = v_user
            )
       )
    GROUP BY g.group_id, g.title, g.description, u.provider, u.subject, u.email, u.display_name, g.metadata, g.created_at, g.updated_at
    ORDER BY MAX(sess.summary_updated_at) DESC NULLS LAST, g.updated_at DESC, g.group_id DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_delete_session_group ─────────────────────────────────────
-- Groups are private per-user organization now: deleting one deletes the
-- owner row and (via the composite FK) that owner's placements — never
-- sessions — so non-empty groups delete cleanly. FALSE = group not found.
CREATE OR REPLACE FUNCTION ${s}.cms_delete_session_group(
    p_group_id TEXT
) RETURNS BOOLEAN AS $$
BEGIN
    DELETE FROM ${s}.session_groups WHERE group_id = p_group_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- ── cms_create_session (placement-era body swap) ─────────────────
-- Same 10-arg signature (CREATE OR REPLACE, rolling-deploy safe). Deletes
-- the parent group inheritance and never writes sessions.group_id;
-- p_group_id is retained for arity compatibility and ignored — the caller
-- places the root for the creator via cms_place_sessions_in_group.
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT,
    p_splash_mobile     TEXT,
    p_visibility        TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_root TEXT;
    v_visibility TEXT := CASE
        WHEN p_visibility IN ('private', 'shared_read', 'shared_write') THEN p_visibility
        ELSE 'private'
    END;
BEGIN
    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id)
        INTO v_root
        FROM ${s}.sessions parent
        WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, splash_mobile, root_session_id, visibility)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, p_splash_mobile, v_root, v_visibility)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        splash_mobile     = EXCLUDED.splash_mobile,
        root_session_id   = EXCLUDED.root_session_id,
        visibility        = EXCLUDED.visibility,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session (placement-era body swap) ─────────────────
-- Same 2-arg signature. Drops the 'groupId' patch handling — group changes
-- route through cms_place_sessions_in_group now, and sessions.group_id is
-- never written.
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        splash_mobile     = CASE WHEN p_updates ? 'splashMobile'    THEN (p_updates->>'splashMobile')                              ELSE splash_mobile     END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL                       ELSE active_turn_index END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── Read procs: placement-sourced group_id ───────────────────────
-- The whole 0029 list/get family gains two trailing placement-viewer params
-- and sources the returned group_id column from that viewer's placements
-- (root rows only; children report NULL; sessions.group_id is never read).
-- Signature changes require drop-then-create with the exact old arg lists;
-- CREATE OR REPLACE keeps re-runs idempotent. cms_list_sessions and
-- cms_list_group_sessions must keep byte-identical column lists.

-- cms_get_session
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE OR REPLACE FUNCTION ${s}.cms_get_session(
    p_session_id         TEXT,
    p_placement_provider TEXT DEFAULT NULL,
    p_placement_subject  TEXT DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    active_turn_index  INTEGER,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
DECLARE
    v_placement_user BIGINT;
BEGIN
    IF p_placement_provider IS NOT NULL AND p_placement_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_placement_user
        FROM ${s}.users u
        WHERE u.provider = BTRIM(p_placement_provider) AND u.subject = BTRIM(p_placement_subject);
    END IF;
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        usgp.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.active_turn_index,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    LEFT JOIN ${s}.user_session_group_placements usgp
        ON usgp.user_id = v_placement_user AND usgp.root_session_id = sess.session_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions / cms_list_group_sessions (shapes must stay identical)
DROP FUNCTION IF EXISTS ${s}.cms_list_group_sessions(TEXT);
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions(
    p_placement_provider TEXT DEFAULT NULL,
    p_placement_subject  TEXT DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
DECLARE
    v_placement_user BIGINT;
BEGIN
    IF p_placement_provider IS NOT NULL AND p_placement_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_placement_user
        FROM ${s}.users u
        WHERE u.provider = BTRIM(p_placement_provider) AND u.subject = BTRIM(p_placement_subject);
    END IF;
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        usgp.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    LEFT JOIN ${s}.user_session_group_placements usgp
        ON usgp.user_id = v_placement_user AND usgp.root_session_id = sess.session_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

-- Viewer-scoped group membership: sessions whose ROOT the placement viewer
-- placed in the group (children ride along; their group_id column is NULL).
CREATE OR REPLACE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id           TEXT,
    p_placement_provider TEXT DEFAULT NULL,
    p_placement_subject  TEXT DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions(p_placement_provider, p_placement_subject) sess
    WHERE EXISTS (
        SELECT 1
        FROM ${s}.user_session_group_placements usgp
        JOIN ${s}.users pu ON pu.user_id = usgp.user_id
        WHERE usgp.root_session_id = COALESCE(sess.root_session_id, sess.session_id)
          AND usgp.group_id = p_group_id
          AND pu.provider = BTRIM(p_placement_provider)
          AND pu.subject = BTRIM(p_placement_subject)
    )
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions_page
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_page(INT, TIMESTAMPTZ, TEXT, BOOL, TEXT, TEXT, BOOL);
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions_page(
    p_limit                 INT         DEFAULT 51,
    p_cursor_updated_at     TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id     TEXT        DEFAULT NULL,
    p_include_deleted       BOOL        DEFAULT FALSE,
    p_viewer_provider       TEXT        DEFAULT NULL,
    p_viewer_subject        TEXT        DEFAULT NULL,
    p_viewer_system_visible BOOL        DEFAULT TRUE,
    p_placement_provider    TEXT        DEFAULT NULL,
    p_placement_subject     TEXT        DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
    v_placement_user BIGINT;
BEGIN
    IF p_placement_provider IS NOT NULL AND p_placement_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_placement_user
        FROM ${s}.users u
        WHERE u.provider = BTRIM(p_placement_provider) AND u.subject = BTRIM(p_placement_subject);
    END IF;
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        usgp.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider     AS owner_provider,
        u.subject      AS owner_subject,
        u.email        AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    LEFT JOIN ${s}.user_session_group_placements usgp
        ON usgp.user_id = v_placement_user AND usgp.root_session_id = sess.session_id
    WHERE
        (p_include_deleted OR sess.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR sess.updated_at < p_cursor_updated_at
            OR (sess.updated_at = p_cursor_updated_at AND sess.session_id < p_cursor_session_id)
        )
        AND (
            p_viewer_provider IS NULL
            OR EXISTS (
                SELECT 1
                FROM ${s}.sessions r
                LEFT JOIN ${s}.session_owners rso ON rso.session_id = r.session_id
                LEFT JOIN ${s}.users ru ON ru.user_id = rso.user_id
                WHERE r.session_id = COALESCE(sess.root_session_id, sess.session_id)
                  AND (
                    (r.is_system AND p_viewer_system_visible)
                    OR (ru.provider = BTRIM(p_viewer_provider) AND ru.subject = BTRIM(p_viewer_subject))
                    OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
                    OR EXISTS (
                        SELECT 1 FROM ${s}.session_shares sh
                        JOIN ${s}.users vu ON vu.user_id = sh.user_id
                        WHERE sh.session_id = r.session_id
                          AND vu.provider = BTRIM(p_viewer_provider)
                          AND vu.subject = BTRIM(p_viewer_subject)
                    )
                  )
            )
        )
    ORDER BY sess.updated_at DESC, sess.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions_visible
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_visible(TEXT, TEXT, BOOL);
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions_visible(
    p_viewer_provider       TEXT,
    p_viewer_subject        TEXT,
    p_viewer_system_visible BOOL,
    p_placement_provider    TEXT DEFAULT NULL,
    p_placement_subject     TEXT DEFAULT NULL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions(p_placement_provider, p_placement_subject) sess
    WHERE EXISTS (
        SELECT 1
        FROM ${s}.sessions r
        LEFT JOIN ${s}.session_owners rso ON rso.session_id = r.session_id
        LEFT JOIN ${s}.users ru ON ru.user_id = rso.user_id
        WHERE r.session_id = COALESCE(sess.root_session_id, sess.session_id)
          AND (
            (r.is_system AND p_viewer_system_visible)
            OR (ru.provider = BTRIM(p_viewer_provider) AND ru.subject = BTRIM(p_viewer_subject))
            OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
            OR EXISTS (
                SELECT 1 FROM ${s}.session_shares sh
                JOIN ${s}.users vu ON vu.user_id = sh.user_id
                WHERE sh.session_id = r.session_id
                  AND vu.provider = BTRIM(p_viewer_provider)
                  AND vu.subject = BTRIM(p_viewer_subject)
            )
          )
    )
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0033: grant path never overwrites directory identity ──

function migration_0033_grant_share_create_only_grantee(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0033_grant_share_create_only_grantee: close a cross-user directory-tampering
-- hole. cms_grant_session_share resolved the grantee via cms_register_user,
-- which does UPDATE-on-sighting: a caller-supplied email/display_name
-- OVERWROTE an existing user's stored identity. Since a grant only needs the
-- caller to own the (throwaway) session being shared, ANY user could rewrite
-- ANY other user's display name / email as it appears in session lists, the
-- member directory, and share dialogs — impersonation, not an access bypass.
--
-- Fix: the grant path resolves-or-CREATES the grantee keyed ONLY on
-- (provider, subject), with NULL display fields — never touching an existing
-- row (this restores migration 0031's stated invariant that grants carry no
-- display_name). Names/emails enter the directory ONLY from a principal's own
-- sightings (login / session-create → cms_register_user). A brand-new grantee
-- placeholder therefore has display_name NULL, so it is correctly excluded
-- from cms_list_users until that person actually signs in (and email-keyed
-- placeholders still fold into the real principal via 0032 adoption).
--
-- Same 8-arg signature — CREATE OR REPLACE, rolling-deploy safe. The
-- p_email/p_display_name params are retained for signature stability but are
-- no longer written to the directory.

CREATE OR REPLACE FUNCTION ${s}.cms_grant_session_share(
    p_session_id     TEXT,
    p_provider       TEXT,
    p_subject        TEXT,
    p_email          TEXT,
    p_display_name   TEXT,
    p_access         TEXT,
    p_granted_by_provider TEXT,
    p_granted_by_subject  TEXT
) RETURNS VOID AS $$
DECLARE
    v_root TEXT;
    v_is_system BOOLEAN;
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_user_id BIGINT;
    v_granted_by BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'Grantee provider and subject are required';
    END IF;
    IF p_access NOT IN ('read', 'write') THEN
        RAISE EXCEPTION 'Invalid share access "%" (expected read|write)', p_access;
    END IF;
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RAISE EXCEPTION 'Session not found';
    END IF;
    SELECT sess.is_system INTO v_is_system FROM ${s}.sessions sess WHERE sess.session_id = v_root;
    IF COALESCE(v_is_system, FALSE) THEN
        RAISE EXCEPTION 'Cannot share a system session';
    END IF;

    -- Create-only: never overwrite a sighted row's identity. Display fields
    -- come only from the grantee's own sightings, never from a grant.
    INSERT INTO ${s}.users (provider, subject)
    VALUES (v_provider, v_subject)
    ON CONFLICT (provider, subject) DO NOTHING;
    SELECT u.user_id INTO v_user_id
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;

    IF p_granted_by_provider IS NOT NULL AND p_granted_by_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_granted_by FROM ${s}.users u
        WHERE u.provider = BTRIM(p_granted_by_provider) AND u.subject = BTRIM(p_granted_by_subject);
    END IF;

    INSERT INTO ${s}.session_shares (session_id, user_id, access, granted_by)
    VALUES (v_root, v_user_id, p_access, v_granted_by)
    ON CONFLICT (session_id, user_id) DO UPDATE
    SET access = EXCLUDED.access,
        granted_by = EXCLUDED.granted_by,
        granted_at = now();
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0032: adopt email-keyed grants on first sign-in ───

function migration_0032_adopt_email_keyed_grants(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0032_adopt_email_keyed_grants: make "share with someone who has never
-- signed in" actually bind for providers with opaque subjects.
--
-- A share grant may target a user the granter identifies only by EMAIL —
-- someone who has never signed in. The grant path stores what it was given,
-- so that placeholder user row is keyed (provider, subject = typed email).
-- But real Entra principals are keyed by OID: on first sign-in the user
-- upserts a DIFFERENT row and the email-keyed grant would never match.
--
-- Fix: on every sighting that carries an email, cms_register_user adopts any
-- placeholder rows keyed (same provider, subject = this email, other user_id):
-- their shares move to the real user (keeping the stronger access where both
-- have one), residual references re-point, and the placeholder is deleted.
-- Same 4-arg signature as 0030 — CREATE OR REPLACE, rolling-deploy safe.

CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_email    TEXT := NULLIF(BTRIM(p_email), '');
    v_display  TEXT := NULLIF(BTRIM(p_display_name), '');
    v_user_id  BIGINT;
    v_ghost    BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;

    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (v_provider, v_subject, v_email, v_display)
    ON CONFLICT (provider, subject) DO UPDATE
    SET email        = COALESCE(EXCLUDED.email, ${s}.users.email),
        display_name = COALESCE(EXCLUDED.display_name, ${s}.users.display_name),
        updated_at   = now()
    WHERE COALESCE(EXCLUDED.email, ${s}.users.email) IS DISTINCT FROM ${s}.users.email
       OR COALESCE(EXCLUDED.display_name, ${s}.users.display_name) IS DISTINCT FROM ${s}.users.display_name;

    SELECT user_id INTO v_user_id
    FROM ${s}.users
    WHERE provider = v_provider AND subject = v_subject;

    -- Adopt placeholder rows keyed by this sighting's email (grants made
    -- before the grantee ever signed in). The users table is a small
    -- directory, so the case-insensitive subject scan is cheap.
    IF v_email IS NOT NULL THEN
        FOR v_ghost IN
            SELECT u.user_id FROM ${s}.users u
            WHERE u.provider = v_provider
              AND LOWER(u.subject) = LOWER(v_email)
              AND u.user_id <> v_user_id
        LOOP
            -- Move shares where the real user has none on that session.
            UPDATE ${s}.session_shares ss SET user_id = v_user_id
            WHERE ss.user_id = v_ghost
              AND NOT EXISTS (
                  SELECT 1 FROM ${s}.session_shares e
                  WHERE e.session_id = ss.session_id AND e.user_id = v_user_id
              );
            -- Where both have a grant, keep the stronger access.
            UPDATE ${s}.session_shares e SET access = 'write'
            FROM ${s}.session_shares g
            WHERE g.user_id = v_ghost AND g.session_id = e.session_id
              AND e.user_id = v_user_id AND g.access = 'write' AND e.access <> 'write';
            DELETE FROM ${s}.session_shares WHERE user_id = v_ghost;
            -- Defensive: placeholders never sign in, so they shouldn't own or
            -- grant anything — but re-point rather than break the FK delete.
            UPDATE ${s}.session_shares SET granted_by = v_user_id WHERE granted_by = v_ghost;
            UPDATE ${s}.session_owners SET user_id = v_user_id WHERE user_id = v_ghost;
            UPDATE ${s}.session_group_owners SET user_id = v_user_id WHERE user_id = v_ghost;
            DELETE FROM ${s}.users WHERE user_id = v_ghost;
        END LOOP;
    END IF;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0031: user directory for share autocomplete ───────

function migration_0031_list_users_directory(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0031_list_users_directory: a read-only member directory so the share UI can
-- autocomplete a grantee by NAME (resolving to the stable provider/subject the
-- grant is keyed on) instead of asking for an internal id. Excludes the
-- synthetic system/local principals. Newest-updated first, capped.

CREATE OR REPLACE FUNCTION ${s}.cms_list_users(
    p_limit INT
) RETURNS TABLE (
    provider     TEXT,
    subject      TEXT,
    email        TEXT,
    display_name TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
BEGIN
    RETURN QUERY
    SELECT u.provider, u.subject, u.email, u.display_name
    FROM ${s}.users u
    WHERE NOT (u.provider = 'system' AND u.subject = 'system')
      AND NOT (u.provider = 'local' AND u.subject = 'default')
      -- Only sighted members (a real login/session-create sets display_name).
      -- Excludes rows created solely by a mistyped raw-id grant.
      AND u.display_name IS NOT NULL
    ORDER BY u.updated_at DESC, u.user_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0030: user profile update-on-sighting ─────────────

function migration_0030_register_user_update_on_sighting(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0030_register_user_update_on_sighting: flip cms_register_user from
-- first-seen-write-wins to update-on-sighting for the display fields.
--
-- Why: a user row is created the first time a principal is *seen*, which can
-- be a share grant (cms_grant_session_share) carrying only (provider, subject)
-- — no email/display_name, because the granter rarely knows them. Under the
-- old first-seen rule that null-display row was frozen, so when the grantee
-- later signed in and created sessions, the owner-initials UI still rendered
-- "?" for their own sessions. The security-model share dialog and audit views
-- make stale/missing display names a real cost (see the user-lifecycle section
-- of docs/proposals/user-admin-security-model.md).
--
-- New rule: on every sighting, COALESCE a non-empty incoming email/display_name
-- over the stored value. A sighting that carries the fields (a real login /
-- session create) backfills or refreshes them; a sighting that carries nulls
-- (a share grant) leaves existing values untouched. The identity key
-- (provider, subject) is never changed. Same signature — CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_email    TEXT := NULLIF(BTRIM(p_email), '');
    v_display  TEXT := NULLIF(BTRIM(p_display_name), '');
    v_user_id  BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;

    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (v_provider, v_subject, v_email, v_display)
    ON CONFLICT (provider, subject) DO UPDATE
    SET email        = COALESCE(EXCLUDED.email, ${s}.users.email),
        display_name = COALESCE(EXCLUDED.display_name, ${s}.users.display_name),
        updated_at   = now()
    WHERE COALESCE(EXCLUDED.email, ${s}.users.email) IS DISTINCT FROM ${s}.users.email
       OR COALESCE(EXCLUDED.display_name, ${s}.users.display_name) IS DISTINCT FROM ${s}.users.display_name;

    SELECT user_id INTO v_user_id
    FROM ${s}.users
    WHERE provider = v_provider AND subject = v_subject;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0001: Baseline ────────────────────────────────────

function migration_0001_baseline(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0001_baseline: captures the CMS schema as of v1.0.41.
-- All statements are idempotent.

CREATE TABLE IF NOT EXISTS ${s}.sessions (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    title_locked      BOOLEAN NOT NULL DEFAULT FALSE,
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    parent_session_id TEXT,
    wait_reason       TEXT
);

CREATE TABLE IF NOT EXISTS ${s}.session_events (
    seq            BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    data           JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_state
    ON ${s}.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_updated
    ON ${s}.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_${schema}_events_session_seq
    ON ${s}.session_events(session_id, seq);

-- Column migrations (idempotent for existing DBs)
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS splash TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${s}.session_events ADD COLUMN IF NOT EXISTS worker_node_id TEXT;
`;
}

// ─── Migration 0002: Session Metric Summaries ────────────────────

function migration_0002_session_metric_summaries(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0002_session_metric_summaries: per-session metric summary table.

CREATE TABLE IF NOT EXISTS ${s}.session_metric_summaries (
    session_id              TEXT PRIMARY KEY,
    agent_id                TEXT,
    model                   TEXT,
    parent_session_id       TEXT,
    snapshot_size_bytes     BIGINT NOT NULL DEFAULT 0,
    dehydration_count       INTEGER NOT NULL DEFAULT 0,
    hydration_count         INTEGER NOT NULL DEFAULT 0,
    lossy_handoff_count     INTEGER NOT NULL DEFAULT 0,
    last_dehydrated_at      TIMESTAMPTZ,
    last_hydrated_at        TIMESTAMPTZ,
    last_checkpoint_at      TIMESTAMPTZ,
    tokens_input            BIGINT NOT NULL DEFAULT 0,
    tokens_output           BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read       BIGINT NOT NULL DEFAULT 0,
    tokens_cache_write      BIGINT NOT NULL DEFAULT 0,
    deleted_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_sms_agent_model
    ON ${s}.session_metric_summaries(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_${schema}_sms_parent
    ON ${s}.session_metric_summaries(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_sms_updated
    ON ${s}.session_metric_summaries(updated_at DESC);

-- Backfill: create a zeroed summary row for every existing session.
INSERT INTO ${s}.session_metric_summaries (session_id, agent_id, model, parent_session_id, deleted_at)
SELECT session_id, agent_id, model, parent_session_id, deleted_at
FROM ${s}.sessions
ON CONFLICT (session_id) DO NOTHING;
`;
}

function migration_0003_session_metric_summaries_backfill_from_events(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0003_session_metric_summaries_backfill_from_events: populate summary counters from historical session_events.

WITH event_metrics AS (
    SELECT
        session_id,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'inputTokens')::bigint, (data->>'prompt_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_input,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'outputTokens')::bigint, (data->>'completion_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_output,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'cacheReadTokens')::bigint, (data->>'cached_prompt_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'cacheWriteTokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_cache_write,
        COUNT(*) FILTER (WHERE event_type = 'session.dehydrated')::int AS dehydration_count,
        COUNT(*) FILTER (WHERE event_type = 'session.hydrated')::int AS hydration_count,
        COUNT(*) FILTER (WHERE event_type = 'session.lossy_handoff')::int AS lossy_handoff_count,
        MAX(CASE WHEN event_type = 'session.dehydrated' THEN created_at END) AS last_dehydrated_at,
        MAX(CASE WHEN event_type = 'session.hydrated' THEN created_at END) AS last_hydrated_at
    FROM ${s}.session_events
    GROUP BY session_id
)
UPDATE ${s}.session_metric_summaries sms
SET
    tokens_input = em.tokens_input,
    tokens_output = em.tokens_output,
    tokens_cache_read = em.tokens_cache_read,
    tokens_cache_write = em.tokens_cache_write,
    dehydration_count = em.dehydration_count,
    hydration_count = em.hydration_count,
    lossy_handoff_count = em.lossy_handoff_count,
    last_dehydrated_at = em.last_dehydrated_at,
    last_hydrated_at = em.last_hydrated_at,
    updated_at = now()
FROM event_metrics em
WHERE sms.session_id = em.session_id;
`;
}

// ─── Migration 0004: Stored Procedures ──────────────────────────

function migration_0004_stored_procedures(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0004_stored_procedures: all CMS data-access moves behind functions.

-- ── cms_create_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.sessions
        (session_id, model, parent_session_id, is_system, agent_id, splash)
    VALUES
        (p_session_id, p_model, p_parent_session_id, p_is_system, p_agent_id, p_splash)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    -- Seed zeroed metric summary row
    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, p_parent_session_id)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_soft_delete_session ──────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_soft_delete_session(
    p_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id;

    IF v_is_system THEN
        RAISE EXCEPTION 'Cannot delete system session';
    END IF;

    UPDATE ${s}.sessions
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_list_sessions ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions()
RETURNS SETOF ${s}.sessions AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS SETOF ${s}.sessions AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_descendant_session_ids ───────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_descendant_session_ids(
    p_session_id TEXT
) RETURNS TABLE (session_id TEXT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE descendants AS (
        SELECT s.session_id FROM ${s}.sessions s
        WHERE s.parent_session_id = p_session_id AND s.deleted_at IS NULL
        UNION ALL
        SELECT s.session_id FROM ${s}.sessions s
        INNER JOIN descendants d ON s.parent_session_id = d.session_id
        WHERE s.deleted_at IS NULL
    )
    SELECT d.session_id FROM descendants d;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_last_session_id ──────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_last_session_id()
RETURNS TEXT AS $$
DECLARE
    v_session_id TEXT;
BEGIN
    SELECT s.session_id INTO v_session_id
    FROM ${s}.sessions s
    WHERE s.deleted_at IS NULL AND s.is_system = FALSE
    ORDER BY s.last_active_at DESC NULLS LAST
    LIMIT 1;
    RETURN v_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_record_events ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_record_events(
    p_session_id     TEXT,
    p_events         JSONB,
    p_worker_node_id TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    SELECT
        p_session_id,
        (elem->>'eventType'),
        (elem->'data'),
        p_worker_node_id
    FROM jsonb_array_elements(p_events) AS elem;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events ───────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id TEXT,
    p_after_seq  BIGINT,
    p_limit      INT
) RETURNS SETOF ${s}.session_events AS $$
BEGIN
    IF p_after_seq IS NOT NULL AND p_after_seq > 0 THEN
        RETURN QUERY
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq > p_after_seq
        ORDER BY seq ASC LIMIT p_limit;
    ELSE
        RETURN QUERY
        SELECT * FROM (
            SELECT * FROM ${s}.session_events
            WHERE session_id = p_session_id
            ORDER BY seq DESC LIMIT p_limit
        ) t ORDER BY seq ASC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events_before ────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT
) RETURNS SETOF ${s}.session_events AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
        ORDER BY seq DESC LIMIT p_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_metric_summary ───────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_metric_summary(
    p_session_id TEXT
) RETURNS SETOF ${s}.session_metric_summaries AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_metric_summaries
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_stats ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_stats(
    p_session_id TEXT
) RETURNS TABLE (
    session_count              INT,
    total_tokens_input         BIGINT,
    total_tokens_output        BIGINT,
    total_tokens_cache_read    BIGINT,
    total_tokens_cache_write   BIGINT,
    total_dehydration_count    INT,
    total_hydration_count      INT,
    total_lossy_handoff_count  INT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.dehydration_count), 0)::int      AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int        AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int    AS total_lossy_handoff_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree);
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_by_agent ─────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        m.model,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, m.model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_totals ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    earliest_session_created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        MIN(m.created_at)                                      AS earliest_session_created_at
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;

-- ── cms_upsert_session_metric_summary ────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_session_metric_summary(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
DECLARE
    v_snapshot       BIGINT  := COALESCE((p_updates->>'snapshotSizeBytes')::BIGINT, 0);
    v_dehydration    INT     := COALESCE((p_updates->>'dehydrationCountIncrement')::INT, 0);
    v_hydration      INT     := COALESCE((p_updates->>'hydrationCountIncrement')::INT, 0);
    v_lossy          INT     := COALESCE((p_updates->>'lossyHandoffCountIncrement')::INT, 0);
    v_tokens_in      BIGINT  := COALESCE((p_updates->>'tokensInputIncrement')::BIGINT, 0);
    v_tokens_out     BIGINT  := COALESCE((p_updates->>'tokensOutputIncrement')::BIGINT, 0);
    v_tokens_cread   BIGINT  := COALESCE((p_updates->>'tokensCacheReadIncrement')::BIGINT, 0);
    v_tokens_cwrite  BIGINT  := COALESCE((p_updates->>'tokensCacheWriteIncrement')::BIGINT, 0);
    v_set_dehydrated BOOLEAN := COALESCE((p_updates->>'lastDehydratedAt')::BOOLEAN, FALSE);
    v_set_hydrated   BOOLEAN := COALESCE((p_updates->>'lastHydratedAt')::BOOLEAN, FALSE);
    v_set_checkpoint BOOLEAN := COALESCE((p_updates->>'lastCheckpointAt')::BOOLEAN, FALSE);
BEGIN
    INSERT INTO ${s}.session_metric_summaries (
        session_id, snapshot_size_bytes,
        dehydration_count, hydration_count, lossy_handoff_count,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, v_snapshot,
        v_dehydration, v_hydration, v_lossy,
        v_tokens_in, v_tokens_out, v_tokens_cread, v_tokens_cwrite
    )
    ON CONFLICT (session_id) DO UPDATE SET
        snapshot_size_bytes = CASE
            WHEN p_updates ? 'snapshotSizeBytes'
            THEN v_snapshot
            ELSE ${s}.session_metric_summaries.snapshot_size_bytes
        END,
        dehydration_count   = ${s}.session_metric_summaries.dehydration_count   + v_dehydration,
        hydration_count     = ${s}.session_metric_summaries.hydration_count     + v_hydration,
        lossy_handoff_count = ${s}.session_metric_summaries.lossy_handoff_count + v_lossy,
        tokens_input        = ${s}.session_metric_summaries.tokens_input        + v_tokens_in,
        tokens_output       = ${s}.session_metric_summaries.tokens_output       + v_tokens_out,
        tokens_cache_read   = ${s}.session_metric_summaries.tokens_cache_read   + v_tokens_cread,
        tokens_cache_write  = ${s}.session_metric_summaries.tokens_cache_write  + v_tokens_cwrite,
        last_dehydrated_at  = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metric_summaries.last_dehydrated_at END,
        last_hydrated_at    = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metric_summaries.last_hydrated_at   END,
        last_checkpoint_at  = CASE WHEN v_set_checkpoint  THEN now() ELSE ${s}.session_metric_summaries.last_checkpoint_at  END,
        updated_at          = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_prune_deleted_summaries ──────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_prune_deleted_summaries(
    p_older_than TIMESTAMPTZ
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${s}.session_metric_summaries
    WHERE deleted_at IS NOT NULL AND deleted_at < p_older_than;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0005: Skill Usage Procs ───────────────────────────

function migration_0005_skill_usage_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0005_skill_usage_procs: per-session, tree, and fleet skill-usage queries.
-- Two source event types, both rare relative to assistant.delta /
-- tool.execution_*:
--   * 'skill.invoked'      — Copilot SDK fires this when the model expands
--                             a static skill from a plugin's skills/ dir.
--                             Payload: { name, pluginName?, pluginVersion?, ... }
--   * 'learned_skill.read' — emitted by the read_facts tool wrapper when
--                             the call touches the 'skills/' fact namespace.
--                             Payload: { name (key|keyPattern), scope, matchCount, ... }
--
-- Each row carries a 'kind' discriminator so callers can distinguish the
-- two flavors without inspecting event_type. 'name' is the static skill
-- name OR the requested learned-skill key/keyPattern. Plugin metadata is
-- only meaningful for static skills.

-- ── Unified partial index for skill-signal rows ──────────────────
CREATE INDEX IF NOT EXISTS idx_${schema}_events_skill_signals
    ON ${s}.session_events (session_id, created_at DESC)
    WHERE event_type IN ('skill.invoked', 'learned_skill.read');

-- ── cms_get_session_skill_usage ──────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_skill_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    invocations    BIGINT,
    first_used_at  TIMESTAMPTZ,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(*)::BIGINT                               AS invocations,
        MIN(e.created_at)                              AS first_used_at,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3, 4
    ORDER BY invocations DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_skill_usage ─────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_skill_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    session_id     TEXT,
    agent_id       TEXT,
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    invocations    BIGINT,
    first_used_at  TIMESTAMPTZ,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT s0.session_id, s0.agent_id FROM ${s}.sessions s0 WHERE s0.session_id = p_session_id
        UNION ALL
        SELECT s1.session_id, s1.agent_id FROM ${s}.sessions s1
        INNER JOIN tree t ON s1.parent_session_id = t.session_id
    )
    SELECT
        e.session_id                                   AS session_id,
        t.agent_id                                     AS agent_id,
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(*)::BIGINT                               AS invocations,
        MIN(e.created_at)                              AS first_used_at,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN tree t ON e.session_id = t.session_id
    WHERE e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY e.session_id, t.agent_id, kind, name, plugin_name, plugin_version
    ORDER BY e.session_id, invocations DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_skill_usage ────────────────────────────────────
-- Joined to the sessions row for agent_id. p_include_deleted controls
-- whether soft-deleted sessions contribute. p_since bounds the scan.
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_skill_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN
) RETURNS TABLE (
    agent_id       TEXT,
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    session_count  BIGINT,
    invocations    BIGINT,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id                                     AS agent_id,
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(DISTINCT e.session_id)::BIGINT           AS session_count,
        COUNT(*)::BIGINT                               AS invocations,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY s.agent_id, kind, name, plugin_name, plugin_version
    ORDER BY invocations DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0006: Fleet Cache Columns ─────────────────────────

function migration_0006_fleet_cache_columns(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0006_fleet_cache_columns: surface prompt-cache token counts at the fleet
-- aggregation level. Data is already collected per session in
-- session_metric_summaries.tokens_cache_read / tokens_cache_write; the prior
-- fleet procs simply ignored those columns. This migration adds them to the
-- two fleet read paths.
--
-- PostgreSQL refuses CREATE OR REPLACE FUNCTION when the RETURNS TABLE shape
-- changes. We DROP-then-CREATE for both procs. Idempotent via IF EXISTS.

-- ── cms_get_fleet_stats_by_agent (drop + recreate) ───────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        m.model,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, m.model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_totals (drop + recreate) ─────────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_totals(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    total_tokens_cache_read      BIGINT,
    total_tokens_cache_write     BIGINT,
    earliest_session_created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(m.created_at)                                      AS earliest_session_created_at
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0007: Session-Tree Stats By Model ─────────────────

function migration_0007_session_tree_stats_by_model(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0007_session_tree_stats_by_model: per-model breakdown across the
-- spawn tree rooted at a session. Mirrors the shape of
-- cms_get_fleet_stats_by_agent so the TUI/portal "By Model" card can
-- render uniformly for both the fleet view and the per-session tree
-- view. Uses the same recursive-descendant CTE pattern as
-- cms_get_session_tree_stats so they stay in sync.

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_stats_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                       TEXT,
    session_count               INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COALESCE(m.model, '(unknown)')                  AS model,
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree)
    GROUP BY m.model
    ORDER BY total_tokens_input DESC, model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0008: Session Owner Users ─────────────────────────

function migration_0008_session_owner_users(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0008_session_owner_users: lazily catalog authenticated users and link
-- non-system sessions to their first-seen owner. CMS access remains behind
-- stored procedures; callers do not read or mutate these tables directly.

CREATE TABLE IF NOT EXISTS ${s}.users (
    user_id      BIGSERIAL PRIMARY KEY,
    provider     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    email        TEXT,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_${schema}_users_provider_subject
    ON ${s}.users(provider, subject);

CREATE TABLE IF NOT EXISTS ${s}.session_owners (
    session_id  TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_session_owners_user
    ON ${s}.session_owners(user_id);

-- ── cms_register_user ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_user_id  BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;

    -- First-seen-write-wins: do not refresh profile fields on later sightings.
    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (
        v_provider,
        v_subject,
        NULLIF(BTRIM(p_email), ''),
        NULLIF(BTRIM(p_display_name), '')
    )
    ON CONFLICT (provider, subject) DO NOTHING;

    SELECT user_id INTO v_user_id
    FROM ${s}.users
    WHERE provider = v_provider AND subject = v_subject;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_session_owner ────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_set_session_owner(
    p_session_id    TEXT,
    p_provider      TEXT,
    p_subject       TEXT,
    p_email         TEXT,
    p_display_name  TEXT
) RETURNS VOID AS $$
DECLARE
    v_user_id   BIGINT;
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    -- First assignment wins for a session.
    INSERT INTO ${s}.session_owners (session_id, user_id)
    VALUES (p_session_id, v_user_id)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ── cms_inherit_session_owner ────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_inherit_session_owner(
    p_session_id        TEXT,
    p_parent_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    INSERT INTO ${s}.session_owners (session_id, user_id)
    SELECT p_session_id, so.user_id
    FROM ${s}.session_owners so
    WHERE so.session_id = p_parent_session_id
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL refuses CREATE OR REPLACE FUNCTION when the return row shape
-- changes, so the read functions are drop-then-create.

-- ── cms_list_sessions (drop + recreate with owner join) ──────────
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session (drop + recreate with owner join) ────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0009: User Stats By Model ─────────────────────────

function migration_0009_user_stats_by_model(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0009_user_stats_by_model: user/session-owner aggregate for the stats pane.
-- Runtime orchestration history bytes are enriched by management code because
-- they live in the orchestration provider, not in CMS tables.

CREATE OR REPLACE FUNCTION ${s}.cms_get_user_stats_by_model(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    owner_kind                  TEXT,
    owner_provider              TEXT,
    owner_subject               TEXT,
    owner_email                 TEXT,
    owner_display_name          TEXT,
    model                       TEXT,
    session_ids                 TEXT[],
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    earliest_session_created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::text      AS owner_kind,
            u.provider     AS owner_provider,
            u.subject      AS owner_subject,
            u.email        AS owner_email,
            u.display_name AS owner_display_name,
            m.model,
            m.session_id,
            m.created_at,
            m.snapshot_size_bytes,
            m.dehydration_count,
            m.hydration_count,
            m.lossy_handoff_count,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metric_summaries m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        LEFT JOIN ${s}.session_owners so ON so.session_id = m.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
    )
    SELECT
        b.owner_kind                                           AS owner_kind,
        b.owner_provider                                       AS owner_provider,
        b.owner_subject                                        AS owner_subject,
        b.owner_email                                          AS owner_email,
        b.owner_display_name                                   AS owner_display_name,
        b.model                                                AS model,
        ARRAY_AGG(b.session_id ORDER BY b.created_at DESC)     AS session_ids,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(b.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(b.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(b.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(b.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(b.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(b.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(b.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(b.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(b.created_at)                                      AS earliest_session_created_at
    FROM base b
    GROUP BY
        b.owner_kind,
        b.owner_provider,
        b.owner_subject,
        b.owner_email,
        b.owner_display_name,
        b.model
    ORDER BY
        COALESCE(SUM(b.tokens_input), 0)::bigint DESC,
        b.owner_kind,
        b.owner_display_name,
        b.owner_email,
        b.model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0010: User Profile + GitHub Copilot Key ───────────

function migration_0010_user_profile_and_copilot_key(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0010_user_profile_and_copilot_key:
--   - profile_settings JSONB on users: per-user UI preferences blob (theme,
--     pinned sessions, layout adjustments, etc.). Replaced wholesale by the
--     setter so the application owns the schema of the JSON document.
--   - github_copilot_key TEXT on users: optional per-user override for the
--     github-copilot model provider token. When set, the worker prefers it
--     over the env-supplied GITHUB_TOKEN for sessions owned by this user.

ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS profile_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS github_copilot_key TEXT;

-- ── cms_get_user_profile ─────────────────────────────────────────
-- Public read: returns the user row plus a boolean flag indicating whether
-- a GitHub Copilot key is set. The actual key is intentionally NOT returned
-- here; use cms_get_user_github_copilot_key() from the worker resolver only.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_profile(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS TABLE (
    user_id                BIGINT,
    provider               TEXT,
    subject                TEXT,
    email                  TEXT,
    display_name           TEXT,
    profile_settings       JSONB,
    github_copilot_key_set BOOLEAN,
    created_at             TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ
) AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        u.user_id,
        u.provider,
        u.subject,
        u.email,
        u.display_name,
        COALESCE(u.profile_settings, '{}'::jsonb)        AS profile_settings,
        (u.github_copilot_key IS NOT NULL)::boolean      AS github_copilot_key_set,
        u.created_at,
        u.updated_at
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_user_github_copilot_key ──────────────────────────────
-- Internal-only read: returns the raw key text for the worker's per-user
-- token resolver. Never expose this through the public management API.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_github_copilot_key(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS TEXT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
    v_key      TEXT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT u.github_copilot_key INTO v_key
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;

    RETURN v_key;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_user_profile_settings ────────────────────────────────
-- Creates the user row if it does not yet exist (so settings can be saved
-- before the user has any sessions), then replaces profile_settings with
-- the supplied JSONB document. Pass '{}' to clear all settings.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_profile_settings(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_settings     JSONB
) RETURNS BIGINT AS $$
DECLARE
    v_user_id  BIGINT;
    v_settings JSONB := COALESCE(p_settings, '{}'::jsonb);
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    UPDATE ${s}.users
    SET profile_settings = v_settings,
        updated_at       = now()
    WHERE user_id = v_user_id;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_user_github_copilot_key ──────────────────────────────
-- Creates the user row if missing, then sets or clears the per-user key.
-- A NULL or all-whitespace key clears the override and reverts the user
-- to the worker's env-supplied default token.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_github_copilot_key(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_key          TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_user_id BIGINT;
    v_key     TEXT := NULLIF(BTRIM(p_key), '');
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    UPDATE ${s}.users
    SET github_copilot_key = v_key,
        updated_at         = now()
    WHERE user_id = v_user_id;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0011: Session Reasoning Effort ───────────────────

function migration_0011_session_reasoning_effort(schema: string): string {
    const s = `"${schema}"`;
    const modelLabelExpr = `(CASE
            WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL THEN m.model
            WHEN NULLIF(BTRIM(m.model), '') IS NULL THEN '(unknown):' || BTRIM(m.reasoning_effort)
            ELSE m.model || ':' || BTRIM(m.reasoning_effort)
        END)`;
    return `
-- 0011_session_reasoning_effort:
--   - Persist optional per-session reasoning effort alongside the canonical
--     provider:model id.
--   - Keep stats return shapes stable by deriving model classification labels
--     as provider:model:reasoning_effort inside the existing model column.

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
ALTER TABLE ${s}.session_metric_summaries ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

UPDATE ${s}.session_metric_summaries m
SET reasoning_effort = sess.reasoning_effort,
    updated_at       = now()
FROM ${s}.sessions sess
WHERE sess.session_id = m.session_id
  AND m.reasoning_effort IS NULL
  AND sess.reasoning_effort IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_${schema}_sms_agent_model_reasoning
    ON ${s}.session_metric_summaries(agent_id, model, reasoning_effort);

-- ── cms_create_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
BEGIN
    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_stats_by_model ─────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_stats_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                       TEXT,
    session_count               INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COALESCE(${modelLabelExpr}, '(unknown)')          AS model,
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree)
    GROUP BY ${modelLabelExpr}
    ORDER BY total_tokens_input DESC, model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_by_agent ────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        ${modelLabelExpr}                                  AS model,
        COUNT(*)::int                                      AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint    AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int         AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int           AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int       AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint           AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint          AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint      AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint     AS total_tokens_cache_write
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, ${modelLabelExpr};
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_user_stats_by_model ─────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_stats_by_model(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    owner_kind                  TEXT,
    owner_provider              TEXT,
    owner_subject               TEXT,
    owner_email                 TEXT,
    owner_display_name          TEXT,
    model                       TEXT,
    session_ids                 TEXT[],
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    earliest_session_created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::text      AS owner_kind,
            u.provider     AS owner_provider,
            u.subject      AS owner_subject,
            u.email        AS owner_email,
            u.display_name AS owner_display_name,
            ${modelLabelExpr} AS model,
            m.session_id,
            m.created_at,
            m.snapshot_size_bytes,
            m.dehydration_count,
            m.hydration_count,
            m.lossy_handoff_count,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metric_summaries m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        LEFT JOIN ${s}.session_owners so ON so.session_id = m.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
    )
    SELECT
        b.owner_kind                                           AS owner_kind,
        b.owner_provider                                       AS owner_provider,
        b.owner_subject                                        AS owner_subject,
        b.owner_email                                          AS owner_email,
        b.owner_display_name                                   AS owner_display_name,
        b.model                                                AS model,
        ARRAY_AGG(b.session_id ORDER BY b.created_at DESC)     AS session_ids,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(b.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(b.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(b.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(b.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(b.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(b.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(b.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(b.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(b.created_at)                                      AS earliest_session_created_at
    FROM base b
    GROUP BY
        b.owner_kind,
        b.owner_provider,
        b.owner_subject,
        b.owner_email,
        b.owner_display_name,
        b.model
    ORDER BY
        COALESCE(SUM(b.tokens_input), 0)::bigint DESC,
        b.owner_kind,
        b.owner_display_name,
        b.owner_email,
        b.model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0012: Reasoning Effort Read Views ────────────────

function migration_0012_session_reasoning_effort_read_views(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0012_session_reasoning_effort_read_views:
--   The reasoning_effort columns were added in 0011. The owner-aware session
--   read procedures from 0008 use explicit RETURNS TABLE shapes, so they must
--   be drop/recreated to expose reasoning_effort to management clients.

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0013: Bounded Session Reads And Emitters ──────────

function migration_0013_bounded_session_reads_and_emitters(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0013_bounded_session_reads_and_emitters:
--   Adds keyset-paginated session listing, bounded event-emitter diagnostics,
--   and SQL-side caps for session event history reads.

-- ── cms_list_sessions_page ───────────────────────────────────────
-- Keyset-paginated session listing ordered by updated_at DESC, session_id DESC.
-- Callers can request limit+1 rows later to compute hasMore without a count query.
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions_page(
    p_limit             INT         DEFAULT 51,
    p_cursor_updated_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id TEXT        DEFAULT NULL,
    p_include_deleted   BOOL        DEFAULT FALSE
) RETURNS SETOF ${s}.sessions AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions s
    WHERE
        (p_include_deleted OR s.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR s.updated_at < p_cursor_updated_at
            OR (s.updated_at = p_cursor_updated_at AND s.session_id < p_cursor_session_id)
        )
    ORDER BY s.updated_at DESC, s.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events (bounded) ─────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id TEXT,
    p_after_seq  BIGINT,
    p_limit      INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
BEGIN
    IF p_after_seq IS NOT NULL AND p_after_seq > 0 THEN
        RETURN QUERY
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq > p_after_seq
        ORDER BY seq ASC LIMIT v_limit;
    ELSE
        RETURN QUERY
        SELECT * FROM (
            SELECT * FROM ${s}.session_events
            WHERE session_id = p_session_id
            ORDER BY seq DESC LIMIT v_limit
        ) t ORDER BY seq ASC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events_before (bounded) ──────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
        ORDER BY seq DESC LIMIT v_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_top_event_emitters ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_top_event_emitters(
    p_since TIMESTAMPTZ,
    p_limit INT
) RETURNS TABLE (
    worker_node_id TEXT,
    event_type     TEXT,
    event_count    BIGINT,
    session_count  BIGINT,
    first_seen_at  TIMESTAMPTZ,
    last_seen_at   TIMESTAMPTZ
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
BEGIN
    RETURN QUERY
    SELECT
        se.worker_node_id,
        se.event_type,
        COUNT(*)::BIGINT                      AS event_count,
        COUNT(DISTINCT se.session_id)::BIGINT AS session_count,
        MIN(se.created_at)                    AS first_seen_at,
        MAX(se.created_at)                    AS last_seen_at
    FROM ${s}.session_events se
    WHERE se.worker_node_id IS NOT NULL
      AND se.created_at >= COALESCE(p_since, now() - INTERVAL '24 hours')
    GROUP BY se.worker_node_id, se.event_type
    ORDER BY event_count DESC, last_seen_at DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0014: Turn Metrics Foundations ───────────────────

function migration_0014_turn_metrics_foundations(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0014_turn_metrics_foundations:
--   Adds per-turn analytics storage and bounded turn-metrics read functions.

CREATE TABLE IF NOT EXISTS ${s}.session_turn_metrics (
    id                  BIGSERIAL PRIMARY KEY,
    session_id          TEXT        NOT NULL,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INTEGER     NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    duration_ms         INTEGER     NOT NULL CHECK (duration_ms >= 0),
    tokens_input        BIGINT      NOT NULL DEFAULT 0,
    tokens_output       BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_read   BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_write  BIGINT      NOT NULL DEFAULT 0,
    tool_calls          INTEGER     NOT NULL DEFAULT 0,
    tool_errors         INTEGER     NOT NULL DEFAULT 0,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_session_idx
    ON ${s}.session_turn_metrics(session_id, turn_index DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_started
    ON ${s}.session_turn_metrics(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_agent_started
    ON ${s}.session_turn_metrics(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_model_started
    ON ${s}.session_turn_metrics(model, started_at DESC);

CREATE OR REPLACE FUNCTION ${s}.cms_insert_turn_metric(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, p_turn_index,
        p_started_at, p_ended_at, p_duration_ms,
        p_tokens_input, p_tokens_output, p_tokens_cache_read, p_tokens_cache_write,
        p_tool_calls, p_tool_errors, p_result_type, p_error_message, p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_turn_metrics(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ DEFAULT NULL,
    p_limit      INT         DEFAULT 200
) RETURNS TABLE (
    id                  BIGINT,
    session_id          TEXT,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_ms         INT,
    tokens_input        BIGINT,
    tokens_output       BIGINT,
    tokens_cache_read   BIGINT,
    tokens_cache_write  BIGINT,
    tool_calls          INT,
    tool_errors         INT,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
    RETURN QUERY
    SELECT
        t.id, t.session_id, t.agent_id, t.model, t.turn_index,
        t.started_at, t.ended_at, t.duration_ms,
        t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write,
        t.tool_calls, t.tool_errors, t.result_type, t.error_message,
        t.worker_node_id, t.created_at
    FROM ${s}.session_turn_metrics t
    WHERE t.session_id = p_session_id
      AND (p_since IS NULL OR t.started_at >= p_since)
    ORDER BY t.turn_index DESC, t.id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_hourly_token_buckets(
    p_since    TIMESTAMPTZ,
    p_agent_id TEXT DEFAULT NULL,
    p_model    TEXT DEFAULT NULL
) RETURNS TABLE (
    hour_bucket              TIMESTAMPTZ,
    turn_count               BIGINT,
    total_tokens_input       BIGINT,
    total_tokens_output      BIGINT,
    total_tokens_cache_read  BIGINT,
    total_tokens_cache_write BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        date_trunc('hour', t.started_at)                AS hour_bucket,
        COUNT(*)::bigint                                AS turn_count,
        COALESCE(SUM(t.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(t.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(t.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(t.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write
    FROM ${s}.session_turn_metrics t
    WHERE t.started_at >= p_since
      AND (p_agent_id IS NULL OR t.agent_id = p_agent_id)
      AND (p_model IS NULL OR t.model = p_model)
    GROUP BY date_trunc('hour', t.started_at)
    ORDER BY hour_bucket DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_prune_turn_metrics(
    p_older_than TIMESTAMPTZ
) RETURNS INT AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM ${s}.session_turn_metrics
    WHERE started_at < p_older_than;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0015: Base Infrastructure State ─────────────────

function migration_0015_base_infra_state(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0015_base_infra_state:
--   Adds additive state for session groups, live summaries, and child outcomes.

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS group_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS short_summary TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS summary_state JSONB;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_group_id
    ON ${s}.sessions(group_id)
    WHERE deleted_at IS NULL AND group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.session_groups (
    group_id    TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    owner       JSONB,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${s}.session_child_outcomes (
    child_session_id  TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    contract_json     JSONB,
    result_json       JSONB,
    verdict           TEXT,
    summary           TEXT,
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_child_outcomes_parent
    ON ${s}.session_child_outcomes(parent_session_id);

-- ── cms_create_session (group-aware overload) ───────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        group_id          = EXCLUDED.group_id,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session_summary ─────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_update_session_summary(
    p_session_id     TEXT,
    p_summary_state  JSONB,
    p_short_summary  TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_short_summary TEXT := NULLIF(BTRIM(p_short_summary), '');
BEGIN
    IF p_summary_state IS NULL OR jsonb_typeof(p_summary_state) <> 'object' THEN
        RAISE EXCEPTION 'summary_state must be a JSON object';
    END IF;

    UPDATE ${s}.sessions
    SET summary_state = p_summary_state,
        short_summary = COALESCE(v_short_summary, NULLIF(BTRIM(p_summary_state->>'summary'), '')),
        summary_updated_at = now(),
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── owner/reasoning/summary-aware read procedures ───────────────
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY COALESCE(sess.summary_updated_at, sess.updated_at) DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── session group procedures ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, owner, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, p_owner, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (group_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_group(
    p_group_id TEXT,
    p_patch    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.session_groups
    SET title = CASE WHEN p_patch ? 'title' THEN NULLIF(BTRIM(p_patch->>'title'), '') ELSE title END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        metadata = CASE WHEN p_patch ? 'metadataPatch' THEN metadata || COALESCE(p_patch->'metadataPatch', '{}'::jsonb) ELSE metadata END,
        updated_at = now()
    WHERE group_id = p_group_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_session_groups()
RETURNS TABLE (
    group_id                  TEXT,
    title                     TEXT,
    description               TEXT,
    owner                     JSONB,
    metadata                  JSONB,
    member_count              INT,
    running_count             INT,
    waiting_count             INT,
    completed_count           INT,
    failed_count              INT,
    cancelled_count           INT,
    latest_activity_at        TIMESTAMPTZ,
    latest_summary_updated_at TIMESTAMPTZ,
    created_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        g.group_id,
        g.title,
        g.description,
        g.owner,
        g.metadata,
        COUNT(sess.session_id)::INT AS member_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('running', 'idle', 'pending'))::INT AS running_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('waiting', 'input_required'))::INT AS waiting_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'completed')::INT AS completed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('failed', 'error'))::INT AS failed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'cancelled')::INT AS cancelled_count,
        MAX(COALESCE(sess.last_active_at, sess.updated_at)) AS latest_activity_at,
        MAX(sess.summary_updated_at) AS latest_summary_updated_at,
        g.created_at,
        g.updated_at
    FROM ${s}.session_groups g
    LEFT JOIN ${s}.sessions sess ON sess.group_id = g.group_id AND sess.deleted_at IS NULL
    GROUP BY g.group_id, g.title, g.description, g.owner, g.metadata, g.created_at, g.updated_at
    ORDER BY MAX(sess.summary_updated_at) DESC NULLS LAST, g.updated_at DESC, g.group_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() s
    WHERE s.group_id = p_group_id
    ORDER BY COALESCE(s.summary_updated_at, s.updated_at) DESC, s.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_delete_session_group(
    p_group_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_member_count INT;
BEGIN
    SELECT COUNT(*)::INT INTO v_member_count
    FROM ${s}.sessions
    WHERE group_id = p_group_id AND deleted_at IS NULL;

    IF v_member_count > 0 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM ${s}.session_groups WHERE group_id = p_group_id;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ── child outcome procedures ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_child_outcome(
    p_child_session_id  TEXT,
    p_parent_session_id TEXT,
    p_contract_json     JSONB DEFAULT NULL,
    p_result_json       JSONB DEFAULT NULL,
    p_verdict           TEXT DEFAULT NULL,
    p_summary           TEXT DEFAULT NULL,
    p_completed_at      TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_child_outcomes (
        child_session_id, parent_session_id, contract_json, result_json,
        verdict, summary, completed_at
    ) VALUES (
        p_child_session_id, p_parent_session_id, p_contract_json, p_result_json,
        p_verdict, p_summary, p_completed_at
    )
    ON CONFLICT (child_session_id) DO UPDATE
    SET parent_session_id = EXCLUDED.parent_session_id,
        contract_json = COALESCE(EXCLUDED.contract_json, ${s}.session_child_outcomes.contract_json),
        result_json = COALESCE(EXCLUDED.result_json, ${s}.session_child_outcomes.result_json),
        verdict = COALESCE(EXCLUDED.verdict, ${s}.session_child_outcomes.verdict),
        summary = COALESCE(EXCLUDED.summary, ${s}.session_child_outcomes.summary),
        completed_at = COALESCE(EXCLUDED.completed_at, ${s}.session_child_outcomes.completed_at),
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_child_outcome(
    p_child_session_id TEXT
) RETURNS SETOF ${s}.session_child_outcomes AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_child_outcomes
    WHERE child_session_id = p_child_session_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_child_outcomes(
    p_parent_session_id TEXT
) RETURNS SETOF ${s}.session_child_outcomes AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_child_outcomes
    WHERE parent_session_id = p_parent_session_id
    ORDER BY updated_at DESC, child_session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0016: Base Infra State Compatibility Fixes ───────

function migration_0016_base_infra_state_compat_fixes(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0016_base_infra_state_compat_fixes: applies post-0015 procedure fixes
-- for schemas that already recorded migration 0015.

CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
BEGIN
    PERFORM ${s}.cms_create_session(
        p_session_id,
        p_model,
        p_reasoning_effort,
        p_parent_session_id,
        p_is_system,
        p_agent_id,
        p_splash,
        NULL::TEXT
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_summary(
    p_session_id     TEXT,
    p_summary_state  JSONB,
    p_short_summary  TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_short_summary TEXT := NULLIF(BTRIM(regexp_replace(COALESCE(p_short_summary, ''), '\\s+', ' ', 'g')), '');
BEGIN
    IF p_summary_state IS NULL OR jsonb_typeof(p_summary_state) <> 'object' THEN
        RAISE EXCEPTION 'summary_state must be a JSON object';
    END IF;

    UPDATE ${s}.sessions
    SET summary_state = p_summary_state,
        short_summary = LEFT(COALESCE(v_short_summary, NULLIF(BTRIM(regexp_replace(COALESCE(p_summary_state->>'summary', ''), '\\s+', ' ', 'g')), '')), 240),
        summary_updated_at = now(),
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, owner, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, p_owner, COALESCE(p_metadata, '{}'::jsonb));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() s
    WHERE s.group_id = p_group_id
    ORDER BY s.updated_at DESC, s.session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0017: System Session Restart Archive ──────────────

function migration_0017_system_session_restart_archive(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0017_system_session_restart_archive: privileged archive/reset for deterministic system-session restarts.

CREATE OR REPLACE FUNCTION ${s}.cms_archive_system_session_for_restart(
    p_session_id TEXT,
    p_state      TEXT,
    p_last_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF NOT v_is_system THEN
        RAISE EXCEPTION 'Cannot archive non-system session for system restart';
    END IF;

    IF p_state NOT IN ('completed', 'cancelled', 'failed') THEN
        RAISE EXCEPTION 'Invalid system restart archive state: %', p_state;
    END IF;

    DELETE FROM ${s}.session_events
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_turn_metrics
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_metric_summaries
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_child_outcomes
    WHERE child_session_id = p_session_id
       OR parent_session_id = p_session_id;

    UPDATE ${s}.sessions
    SET state             = p_state,
        last_error        = p_last_error,
        wait_reason       = NULL,
        orchestration_id  = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        short_summary     = NULL,
        summary_state     = NULL,
        summary_updated_at = NULL,
        deleted_at        = now(),
        updated_at        = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0018: Session Group Assignment Update ─────────────

function migration_0018_session_group_assignment_update(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0018_session_group_assignment_update: allow management/UI to assign sessions to groups.

CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0019: Session Group Owner Enforcement ────────────

function migration_0019_session_group_owner_enforcement(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0019_session_group_owner_enforcement: give groups the same normalized owner schema as sessions.

CREATE TABLE IF NOT EXISTS ${s}.session_group_owners (
    group_id    TEXT PRIMARY KEY REFERENCES ${s}.session_groups(group_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_session_group_owners_user
    ON ${s}.session_group_owners(user_id);

INSERT INTO ${s}.users (provider, subject, email, display_name)
SELECT DISTINCT
    NULLIF(BTRIM(g.owner->>'provider'), ''),
    NULLIF(BTRIM(g.owner->>'subject'), ''),
    NULLIF(BTRIM(g.owner->>'email'), ''),
    NULLIF(BTRIM(g.owner->>'displayName'), '')
FROM ${s}.session_groups g
WHERE g.owner IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'provider'), '') IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'subject'), '') IS NOT NULL
ON CONFLICT (provider, subject) DO NOTHING;

INSERT INTO ${s}.session_group_owners (group_id, user_id)
SELECT g.group_id, u.user_id
FROM ${s}.session_groups g
JOIN ${s}.users u
  ON u.provider = NULLIF(BTRIM(g.owner->>'provider'), '')
 AND u.subject = NULLIF(BTRIM(g.owner->>'subject'), '')
WHERE g.owner IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'provider'), '') IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'subject'), '') IS NOT NULL
ON CONFLICT (group_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ${s}.cms_set_session_group_owner(
    p_group_id      TEXT,
    p_provider      TEXT,
    p_subject       TEXT,
    p_email         TEXT,
    p_display_name  TEXT
) RETURNS VOID AS $$
DECLARE
    v_user_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ${s}.session_groups WHERE group_id = p_group_id) THEN
        RETURN;
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    INSERT INTO ${s}.session_group_owners (group_id, user_id)
    VALUES (p_group_id, v_user_id)
    ON CONFLICT (group_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, COALESCE(p_metadata, '{}'::jsonb));

    IF p_owner IS NOT NULL
       AND NULLIF(BTRIM(p_owner->>'provider'), '') IS NOT NULL
       AND NULLIF(BTRIM(p_owner->>'subject'), '') IS NOT NULL THEN
        PERFORM ${s}.cms_set_session_group_owner(
            p_group_id,
            p_owner->>'provider',
            p_owner->>'subject',
            p_owner->>'email',
            p_owner->>'displayName'
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_session_groups()
RETURNS TABLE (
    group_id                  TEXT,
    title                     TEXT,
    description               TEXT,
    owner                     JSONB,
    metadata                  JSONB,
    member_count              INT,
    running_count             INT,
    waiting_count             INT,
    completed_count           INT,
    failed_count              INT,
    cancelled_count           INT,
    latest_activity_at        TIMESTAMPTZ,
    latest_summary_updated_at TIMESTAMPTZ,
    created_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        g.group_id,
        g.title,
        g.description,
        CASE WHEN u.user_id IS NULL THEN NULL ELSE jsonb_build_object(
            'provider', u.provider,
            'subject', u.subject,
            'email', u.email,
            'displayName', u.display_name
        ) END AS owner,
        g.metadata,
        COUNT(sess.session_id)::INT AS member_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('running', 'idle', 'pending'))::INT AS running_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('waiting', 'input_required'))::INT AS waiting_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'completed')::INT AS completed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('failed', 'error'))::INT AS failed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'cancelled')::INT AS cancelled_count,
        MAX(COALESCE(sess.last_active_at, sess.updated_at)) AS latest_activity_at,
        MAX(sess.summary_updated_at) AS latest_summary_updated_at,
        g.created_at,
        g.updated_at
    FROM ${s}.session_groups g
    LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
    LEFT JOIN ${s}.users u ON u.user_id = go.user_id
    LEFT JOIN ${s}.sessions sess ON sess.group_id = g.group_id AND sess.deleted_at IS NULL
    GROUP BY g.group_id, g.title, g.description, u.user_id, u.provider, u.subject, u.email, u.display_name, g.metadata, g.created_at, g.updated_at
    ORDER BY MAX(sess.summary_updated_at) DESC NULLS LAST, g.updated_at DESC, g.group_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_assign_session_group(
    p_session_id TEXT,
    p_group_id   TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_is_system BOOLEAN;
    v_session_owner_provider TEXT;
    v_session_owner_subject TEXT;
    v_group_owner_provider TEXT;
    v_group_owner_subject TEXT;
BEGIN
    SELECT sess.is_system, u.provider, u.subject
    INTO v_is_system, v_session_owner_provider, v_session_owner_subject
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id
      AND sess.deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    IF v_group_id IS NOT NULL THEN
        SELECT u.provider, u.subject
        INTO v_group_owner_provider, v_group_owner_subject
        FROM ${s}.session_groups g
        LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
        LEFT JOIN ${s}.users u ON u.user_id = go.user_id
        WHERE g.group_id = v_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Session group % was not found', v_group_id;
        END IF;

        IF v_session_owner_provider IS DISTINCT FROM v_group_owner_provider
           OR v_session_owner_subject IS DISTINCT FROM v_group_owner_subject THEN
            RAISE EXCEPTION 'Session % owner does not match session group % owner', p_session_id, v_group_id;
        END IF;
    END IF;

    UPDATE ${s}.sessions
    SET group_id = v_group_id,
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0020: Session Group Owner Adoption ───────────────

function migration_0020_session_group_owner_adoption(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0020_session_group_owner_adoption: let empty unowned groups adopt the first moved session owner.

CREATE OR REPLACE FUNCTION ${s}.cms_assign_session_group(
    p_session_id TEXT,
    p_group_id   TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_is_system BOOLEAN;
    v_session_owner_user_id BIGINT;
    v_session_owner_provider TEXT;
    v_session_owner_subject TEXT;
    v_group_owner_provider TEXT;
    v_group_owner_subject TEXT;
    v_group_member_count INT;
BEGIN
    SELECT sess.is_system, u.user_id, u.provider, u.subject
    INTO v_is_system, v_session_owner_user_id, v_session_owner_provider, v_session_owner_subject
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id
      AND sess.deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    IF v_group_id IS NOT NULL THEN
        SELECT u.provider, u.subject
        INTO v_group_owner_provider, v_group_owner_subject
        FROM ${s}.session_groups g
        LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
        LEFT JOIN ${s}.users u ON u.user_id = go.user_id
        WHERE g.group_id = v_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Session group % was not found', v_group_id;
        END IF;

        IF v_group_owner_provider IS NULL
           AND v_group_owner_subject IS NULL
           AND v_session_owner_user_id IS NOT NULL THEN
            SELECT COUNT(*)::INT INTO v_group_member_count
            FROM ${s}.sessions
            WHERE group_id = v_group_id
              AND deleted_at IS NULL;

            IF COALESCE(v_group_member_count, 0) = 0 THEN
                INSERT INTO ${s}.session_group_owners (group_id, user_id)
                VALUES (v_group_id, v_session_owner_user_id)
                ON CONFLICT (group_id) DO NOTHING;

                v_group_owner_provider := v_session_owner_provider;
                v_group_owner_subject := v_session_owner_subject;
            END IF;
        END IF;

        IF v_session_owner_provider IS DISTINCT FROM v_group_owner_provider
           OR v_session_owner_subject IS DISTINCT FROM v_group_owner_subject THEN
            RAISE EXCEPTION 'Session % owner does not match session group % owner', p_session_id, v_group_id;
        END IF;
    END IF;

    UPDATE ${s}.sessions
    SET group_id = v_group_id,
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0021: Retrieval Usage Procs ──────────────────────

function migration_0021_retrieval_usage_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0021_retrieval_usage_procs: count-only fact/search/graph retrieval usage from session_events.

CREATE INDEX IF NOT EXISTS idx_${schema}_events_retrieval_usage
    ON ${s}.session_events (session_id, created_at DESC)
    WHERE event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched', 'graph.node_searched', 'graph.node_loaded');

CREATE INDEX IF NOT EXISTS idx_${schema}_events_graph_node_usage
    ON ${s}.session_events ((data->>'nodeKey'), created_at DESC)
    WHERE event_type IN ('graph.node_searched', 'graph.node_loaded');

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_retrieval_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3
    ORDER BY calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_retrieval_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    session_id        TEXT,
    agent_id          TEXT,
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT s0.session_id, s0.agent_id FROM ${s}.sessions s0 WHERE s0.session_id = p_session_id
        UNION ALL
        SELECT s1.session_id, s1.agent_id FROM ${s}.sessions s1
        INNER JOIN tree t ON s1.parent_session_id = t.session_id
    )
    SELECT
        e.session_id AS session_id,
        t.agent_id AS agent_id,
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN tree t ON e.session_id = t.session_id
    WHERE e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY e.session_id, t.agent_id, surface, operation, namespace
    ORDER BY e.session_id, calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_retrieval_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN
) RETURNS TABLE (
    agent_id          TEXT,
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    session_count     BIGINT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id AS agent_id,
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(DISTINCT e.session_id)::BIGINT AS session_count,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY s.agent_id, surface, operation, namespace
    ORDER BY calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_graph_node_usage(
    p_session_id    TEXT,
    p_since         TIMESTAMPTZ,
    p_limit         INT,
    p_node_key_like TEXT,
    p_kind          TEXT
) RETURNS TABLE (
    node_key      TEXT,
    namespace     TEXT,
    operation     TEXT,
    kind          TEXT,
    count         BIGINT,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.data->>'nodeKey' AS node_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE WHEN e.event_type = 'graph.node_loaded' THEN 'graph_neighbourhood' ELSE 'graph_search_nodes' END
        )::TEXT AS operation,
        CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END::TEXT AS kind,
        COUNT(*)::BIGINT AS count,
        MIN(e.created_at) AS first_seen_at,
        MAX(e.created_at) AS last_seen_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('graph.node_searched', 'graph.node_loaded')
      AND NULLIF(e.data->>'nodeKey', '') IS NOT NULL
      AND (p_since IS NULL OR e.created_at >= p_since)
      AND (p_kind IS NULL OR p_kind = '' OR (CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END) = p_kind)
      AND (p_node_key_like IS NULL OR p_node_key_like = '' OR e.data->>'nodeKey' ILIKE ('%' || p_node_key_like || '%'))
    GROUP BY 1, 2, 3, 4
    ORDER BY count DESC, last_seen_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_graph_node_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN,
    p_limit           INT,
    p_node_key_like   TEXT,
    p_kind            TEXT
) RETURNS TABLE (
    agent_id      TEXT,
    node_key      TEXT,
    namespace     TEXT,
    operation     TEXT,
    kind          TEXT,
    session_count BIGINT,
    count         BIGINT,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id AS agent_id,
        e.data->>'nodeKey' AS node_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE WHEN e.event_type = 'graph.node_loaded' THEN 'graph_neighbourhood' ELSE 'graph_search_nodes' END
        )::TEXT AS operation,
        CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END::TEXT AS kind,
        COUNT(DISTINCT e.session_id)::BIGINT AS session_count,
        COUNT(*)::BIGINT AS count,
        MIN(e.created_at) AS first_seen_at,
        MAX(e.created_at) AS last_seen_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('graph.node_searched', 'graph.node_loaded')
      AND NULLIF(e.data->>'nodeKey', '') IS NOT NULL
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
      AND (p_kind IS NULL OR p_kind = '' OR (CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END) = p_kind)
      AND (p_node_key_like IS NULL OR p_node_key_like = '' OR e.data->>'nodeKey' ILIKE ('%' || p_node_key_like || '%'))
    GROUP BY s.agent_id, node_key, namespace, operation, kind
    ORDER BY count DESC, last_seen_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_graph_edge_search_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ,
    p_limit      INT
) RETURNS TABLE (
    predicate_key     TEXT,
    from_key          TEXT,
    to_key            TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    first_searched_at TIMESTAMPTZ,
    last_searched_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        NULLIF(e.data->>'predicateKey', '')::TEXT AS predicate_key,
        NULLIF(e.data->>'fromKey', '')::TEXT AS from_key,
        NULLIF(e.data->>'toKey', '')::TEXT AS to_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        MIN(e.created_at) AS first_searched_at,
        MAX(e.created_at) AS last_searched_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type = 'graph.searched'
      AND COALESCE(NULLIF(e.data->>'operation', ''), NULLIF(e.data->>'kind', '')) IN ('graph_search_edges', 'search_edges')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3, 4
    ORDER BY calls DESC, last_searched_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0022: Turn Metrics Reasoning Effort ──────────────

function migration_0022_turn_metrics_reasoning_effort(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0022_turn_metrics_reasoning_effort:
--   - Add reasoning_effort to per-turn metrics so token attribution aligns with
--     the session row model:effort convention and survives mid-session switches.
--   - Add model+effort composite indexes for by-model aggregation.
--   - Extend insert/read procs; add per-session by-model rollup with turn count.

DO $$
BEGIN
    IF to_regclass('${schema}.session_metrics') IS NULL
       AND to_regclass('${schema}.session_metric_summaries') IS NOT NULL THEN
        ALTER TABLE ${s}.session_metric_summaries RENAME TO session_metrics;
    END IF;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF to_regclass('${schema}.session_metric_summaries') IS NULL
       AND to_regclass('${schema}.session_metrics') IS NOT NULL THEN
        EXECUTE 'CREATE VIEW ${s}.session_metric_summaries AS SELECT * FROM ${s}.session_metrics';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_agent_model
    ON ${s}.session_metrics(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_agent_model_effort
    ON ${s}.session_metrics(agent_id, model, reasoning_effort);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_parent
    ON ${s}.session_metrics(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_updated
    ON ${s}.session_metrics(updated_at DESC);

DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_agent_model;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_agent_model_reasoning;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_parent;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_updated;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_group(
    p_group_id TEXT,
    p_patch    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.session_groups
    SET title = CASE WHEN p_patch ? 'title' THEN NULLIF(BTRIM(p_patch->>'title'), '') ELSE title END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        owner = CASE WHEN p_patch ? 'owner' THEN p_patch->'owner' ELSE owner END,
        metadata = CASE WHEN p_patch ? 'metadataPatch' THEN metadata || COALESCE(p_patch->'metadataPatch', '{}'::jsonb) ELSE metadata END,
        updated_at = now()
    WHERE group_id = p_group_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_metric_summary(
    p_session_id TEXT
) RETURNS SETOF ${s}.session_metrics AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_metrics
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        group_id          = EXCLUDED.group_id,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metrics
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metrics.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metrics.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metrics.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_upsert_session_metric_summary(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
DECLARE
    v_snapshot       BIGINT  := COALESCE((p_updates->>'snapshotSizeBytes')::BIGINT, 0);
    v_dehydration    INT     := COALESCE((p_updates->>'dehydrationCountIncrement')::INT, 0);
    v_hydration      INT     := COALESCE((p_updates->>'hydrationCountIncrement')::INT, 0);
    v_lossy          INT     := COALESCE((p_updates->>'lossyHandoffCountIncrement')::INT, 0);
    v_tokens_in      BIGINT  := COALESCE((p_updates->>'tokensInputIncrement')::BIGINT, 0);
    v_tokens_out     BIGINT  := COALESCE((p_updates->>'tokensOutputIncrement')::BIGINT, 0);
    v_tokens_cread   BIGINT  := COALESCE((p_updates->>'tokensCacheReadIncrement')::BIGINT, 0);
    v_tokens_cwrite  BIGINT  := COALESCE((p_updates->>'tokensCacheWriteIncrement')::BIGINT, 0);
    v_set_dehydrated BOOLEAN := COALESCE((p_updates->>'lastDehydratedAt')::BOOLEAN, FALSE);
    v_set_hydrated   BOOLEAN := COALESCE((p_updates->>'lastHydratedAt')::BOOLEAN, FALSE);
    v_set_checkpoint BOOLEAN := COALESCE((p_updates->>'lastCheckpointAt')::BOOLEAN, FALSE);
BEGIN
    INSERT INTO ${s}.session_metrics (
        session_id, snapshot_size_bytes,
        dehydration_count, hydration_count, lossy_handoff_count,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, v_snapshot,
        v_dehydration, v_hydration, v_lossy,
        v_tokens_in, v_tokens_out, v_tokens_cread, v_tokens_cwrite
    )
    ON CONFLICT (session_id) DO UPDATE SET
        snapshot_size_bytes = CASE
            WHEN p_updates ? 'snapshotSizeBytes'
            THEN v_snapshot
            ELSE ${s}.session_metrics.snapshot_size_bytes
        END,
        dehydration_count   = ${s}.session_metrics.dehydration_count   + v_dehydration,
        hydration_count     = ${s}.session_metrics.hydration_count     + v_hydration,
        lossy_handoff_count = ${s}.session_metrics.lossy_handoff_count + v_lossy,
        tokens_input        = ${s}.session_metrics.tokens_input        + v_tokens_in,
        tokens_output       = ${s}.session_metrics.tokens_output       + v_tokens_out,
        tokens_cache_read   = ${s}.session_metrics.tokens_cache_read   + v_tokens_cread,
        tokens_cache_write  = ${s}.session_metrics.tokens_cache_write  + v_tokens_cwrite,
        last_dehydrated_at  = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metrics.last_dehydrated_at END,
        last_hydrated_at    = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metrics.last_hydrated_at   END,
        last_checkpoint_at  = CASE WHEN v_set_checkpoint  THEN now() ELSE ${s}.session_metrics.last_checkpoint_at  END,
        updated_at          = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_prune_deleted_summaries(
    p_older_than TIMESTAMPTZ
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${s}.session_metrics
    WHERE deleted_at IS NOT NULL AND deleted_at < p_older_than;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE ${s}.session_turn_metrics ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
)
SELECT
        m.session_id,
        m.agent_id,
        m.model,
        m.reasoning_effort,
        0,
        COALESCE(m.created_at, now()),
        GREATEST(COALESCE(m.updated_at, m.created_at, now()), COALESCE(m.created_at, now())),
        LEAST(2147483647, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (GREATEST(COALESCE(m.updated_at, m.created_at, now()), COALESCE(m.created_at, now())) - COALESCE(m.created_at, now()))) * 1000)))::INT,
        m.tokens_input,
        m.tokens_output,
        m.tokens_cache_read,
        m.tokens_cache_write,
        0,
        0,
        'legacy_summary',
        NULL,
        NULL
FROM ${s}.session_metrics m
WHERE (COALESCE(m.tokens_input, 0) <> 0
        OR COALESCE(m.tokens_output, 0) <> 0
        OR COALESCE(m.tokens_cache_read, 0) <> 0
        OR COALESCE(m.tokens_cache_write, 0) <> 0)
    AND NOT EXISTS (
            SELECT 1
            FROM ${s}.session_turn_metrics t
            WHERE t.session_id = m.session_id
    );

CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_session_model
    ON ${s}.session_turn_metrics(session_id, model, reasoning_effort);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_model_effort_started
    ON ${s}.session_turn_metrics(model, reasoning_effort, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_agent_model_started
    ON ${s}.session_turn_metrics(agent_id, model, reasoning_effort, started_at DESC);

-- Signature/return-type changes require drop-then-create.
DROP FUNCTION IF EXISTS ${s}.cms_insert_turn_metric(
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER,
    BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS ${s}.cms_get_session_turn_metrics(TEXT, TIMESTAMPTZ, INT);

CREATE OR REPLACE FUNCTION ${s}.cms_insert_turn_metric(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, NULLIF(BTRIM(p_reasoning_effort), ''), p_turn_index,
        p_started_at, p_ended_at, p_duration_ms,
        p_tokens_input, p_tokens_output, p_tokens_cache_read, p_tokens_cache_write,
        p_tool_calls, p_tool_errors, p_result_type, p_error_message, p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_turn_metrics(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ DEFAULT NULL,
    p_limit      INT         DEFAULT 200
) RETURNS TABLE (
    id                  BIGINT,
    session_id          TEXT,
    agent_id            TEXT,
    model               TEXT,
    reasoning_effort    TEXT,
    turn_index          INT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_ms         INT,
    tokens_input        BIGINT,
    tokens_output       BIGINT,
    tokens_cache_read   BIGINT,
    tokens_cache_write  BIGINT,
    tool_calls          INT,
    tool_errors         INT,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
    RETURN QUERY
    SELECT
        t.id, t.session_id, t.agent_id, t.model, t.reasoning_effort, t.turn_index,
        t.started_at, t.ended_at, t.duration_ms,
        t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write,
        t.tool_calls, t.tool_errors, t.result_type, t.error_message,
        t.worker_node_id, t.created_at
    FROM ${s}.session_turn_metrics t
    WHERE t.session_id = p_session_id
      AND (p_since IS NULL OR t.started_at >= p_since)
    ORDER BY t.turn_index DESC, t.id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- Per-session token totals grouped by model:effort label, with per-bucket turn count.
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tokens_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                    TEXT,
    turn_count               BIGINT,
    total_tokens_input       BIGINT,
    total_tokens_output      BIGINT,
    total_tokens_cache_read  BIGINT,
    total_tokens_cache_write BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        norm.label                                          AS model,
        COUNT(*)::bigint                                     AS turn_count,
        COALESCE(SUM(norm.tokens_input), 0)::bigint         AS total_tokens_input,
        COALESCE(SUM(norm.tokens_output), 0)::bigint        AS total_tokens_output,
        COALESCE(SUM(norm.tokens_cache_read), 0)::bigint    AS total_tokens_cache_read,
        COALESCE(SUM(norm.tokens_cache_write), 0)::bigint   AS total_tokens_cache_write
    FROM (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS label,
            t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        WHERE t.session_id = p_session_id
    ) norm
    GROUP BY norm.label
    ORDER BY COALESCE(SUM(norm.tokens_input), 0) DESC, norm.label;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session_tree_stats_by_model(TEXT);
CREATE FUNCTION ${s}.cms_get_session_tree_stats_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                       TEXT,
    session_count               INT,
    turn_count                  BIGINT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metrics m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metrics m
        INNER JOIN tree tr ON m.parent_session_id = tr.session_id
    ), token_rows AS (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input,
            t.tokens_output,
            t.tokens_cache_read,
            t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN tree tr ON tr.session_id = t.session_id
        UNION ALL
        SELECT
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN tree tr ON tr.session_id = m.session_id
        WHERE NOT EXISTS (
            SELECT 1 FROM ${s}.session_turn_metrics existing
            WHERE existing.session_id = m.session_id
        )
    ), token_rollup AS (
        SELECT
            model_label,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY model_label
    ), metric_rollup AS (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes
        FROM ${s}.session_metrics m
        INNER JOIN tree tr ON tr.session_id = m.session_id
        GROUP BY model_label
    )
    SELECT
        COALESCE(t.model_label, m.model_label) AS model,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m ON m.model_label = t.model_label
    ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    turn_count                  BIGINT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH token_rows AS (
        SELECT
            COALESCE(t.agent_id, m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input,
            t.tokens_output,
            t.tokens_cache_read,
            t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN ${s}.sessions sess ON sess.session_id = t.session_id
        LEFT JOIN ${s}.session_metrics m ON m.session_id = t.session_id
        WHERE (p_include_deleted OR sess.deleted_at IS NULL)
          AND (p_since IS NULL OR t.started_at >= p_since)
        UNION ALL
        SELECT
            COALESCE(m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
          AND NOT EXISTS (
              SELECT 1 FROM ${s}.session_turn_metrics existing
              WHERE existing.session_id = m.session_id
          )
    ), token_rollup AS (
        SELECT
            agent_id_value,
            model_label,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY agent_id_value, model_label
    ), metric_rollup AS (
        SELECT
            m.agent_id AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes,
            COALESCE(SUM(m.dehydration_count), 0)::INT AS total_dehydration_count,
            COALESCE(SUM(m.hydration_count), 0)::INT AS total_hydration_count,
            COALESCE(SUM(m.lossy_handoff_count), 0)::INT AS total_lossy_handoff_count
        FROM ${s}.session_metrics m
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
        GROUP BY m.agent_id, model_label
    )
    SELECT
        COALESCE(t.agent_id_value, m.agent_id_value) AS agent_id,
        COALESCE(t.model_label, m.model_label) AS model,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes,
        COALESCE(m.total_dehydration_count, 0)::INT AS total_dehydration_count,
        COALESCE(m.total_hydration_count, 0)::INT AS total_hydration_count,
        COALESCE(m.total_lossy_handoff_count, 0)::INT AS total_lossy_handoff_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m
    ON m.agent_id_value IS NOT DISTINCT FROM t.agent_id_value
      AND m.model_label = t.model_label
     ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_user_stats_by_model(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_user_stats_by_model(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    owner_kind                  TEXT,
    owner_provider              TEXT,
    owner_subject               TEXT,
    owner_email                 TEXT,
    owner_display_name          TEXT,
    model                       TEXT,
    session_ids                 TEXT[],
    session_count               INT,
    turn_count                  BIGINT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    earliest_session_created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH session_owner AS (
        SELECT
            sess.session_id,
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::TEXT AS owner_kind_value,
            u.provider AS owner_provider_value,
            u.subject AS owner_subject_value,
            u.email AS owner_email_value,
            u.display_name AS owner_display_name_value
        FROM ${s}.sessions sess
        LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    ), token_rows AS (
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN ${s}.sessions sess ON sess.session_id = t.session_id
        INNER JOIN session_owner so ON so.session_id = t.session_id
        WHERE (p_include_deleted OR sess.deleted_at IS NULL)
          AND (p_since IS NULL OR t.started_at >= p_since)
        UNION ALL
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input, m.tokens_output, m.tokens_cache_read, m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        INNER JOIN session_owner so ON so.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
          AND NOT EXISTS (
              SELECT 1 FROM ${s}.session_turn_metrics existing
              WHERE existing.session_id = m.session_id
          )
    ), token_rollup AS (
        SELECT
            owner_kind_value, owner_provider_value, owner_subject_value, owner_email_value, owner_display_name_value, model_label,
            ARRAY_AGG(DISTINCT session_id ORDER BY session_id) AS session_ids,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY owner_kind_value, owner_provider_value, owner_subject_value, owner_email_value, owner_display_name_value, model_label
    ), metric_rollup AS (
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            ARRAY_AGG(DISTINCT m.session_id ORDER BY m.session_id) AS session_ids,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes,
            COALESCE(SUM(m.dehydration_count), 0)::INT AS total_dehydration_count,
            COALESCE(SUM(m.hydration_count), 0)::INT AS total_hydration_count,
            COALESCE(SUM(m.lossy_handoff_count), 0)::INT AS total_lossy_handoff_count,
            MIN(m.created_at) AS earliest_session_created_at
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        INNER JOIN session_owner so ON so.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
        GROUP BY so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value, model_label
    )
    SELECT
        COALESCE(t.owner_kind_value, m.owner_kind_value) AS owner_kind,
        COALESCE(t.owner_provider_value, m.owner_provider_value) AS owner_provider,
        COALESCE(t.owner_subject_value, m.owner_subject_value) AS owner_subject,
        COALESCE(t.owner_email_value, m.owner_email_value) AS owner_email,
        COALESCE(t.owner_display_name_value, m.owner_display_name_value) AS owner_display_name,
        COALESCE(t.model_label, m.model_label) AS model,
        ARRAY(SELECT DISTINCT unnest(COALESCE(t.session_ids, ARRAY[]::TEXT[]) || COALESCE(m.session_ids, ARRAY[]::TEXT[])) ORDER BY 1) AS session_ids,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes,
        COALESCE(m.total_dehydration_count, 0)::INT AS total_dehydration_count,
        COALESCE(m.total_hydration_count, 0)::INT AS total_hydration_count,
        COALESCE(m.total_lossy_handoff_count, 0)::INT AS total_lossy_handoff_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write,
        m.earliest_session_created_at AS earliest_session_created_at
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m
    ON m.owner_kind_value = t.owner_kind_value
     AND m.owner_provider_value IS NOT DISTINCT FROM t.owner_provider_value
     AND m.owner_subject_value IS NOT DISTINCT FROM t.owner_subject_value
      AND m.model_label = t.model_label
     ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0023: Turn Metrics Stats Fallbacks And Group Owner Patch ───
function migration_0023_turn_metrics_stats_fallbacks_and_group_owner_patch(schema: string): string {
    // Migration 0022 was deployed before these stored-procedure fixes landed.
    // Its SQL is idempotent, so reapplying the corrected procedure layer under
    // a new version updates already-migrated schemas without requiring a reset.
    return migration_0022_turn_metrics_reasoning_effort(schema);
}

// ─── Migration 0024: Stop Turn Active Turn Index ──────────────────
function migration_0024_stop_turn_active_turn_index(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0024_stop_turn_active_turn_index: track the in-flight turn index on the
-- sessions row so stopSessionTurn() can address the turn-scoped stop queue
-- (stopTurn.<turnIndex>). Written by the runTurn activity's pre-turn
-- writeback; cleared by the post-turn writeback and by any state transition
-- away from 'running' (stop-turn plan, docs/proposals-impl/stop-button-turn-abort-plan.md).

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS active_turn_index INTEGER;

-- ── cms_set_active_turn_index ─────────────────────────────────────
-- Pre-turn: publish the in-flight turn index.
CREATE OR REPLACE FUNCTION ${s}.cms_set_active_turn_index(
    p_session_id TEXT,
    p_turn_index INTEGER
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions
    SET active_turn_index = p_turn_index,
        updated_at = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session ──────────────────────────────────────────────
-- Same as the owner-join version, plus active_turn_index in the returned
-- column set (RETURNS TABLE is a fixed list — new table columns are not
-- returned automatically). stopSessionTurn() reads it for the pre-check and
-- the turn-scoped stop queue name.
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    active_turn_index  INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.active_turn_index
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
-- Same as 0022/0023, plus: any state transition away from 'running' clears
-- active_turn_index, so the orchestration's authoritative stop bookkeeping
-- (updateCmsState idle) and error transitions retire the stop-queue target.
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL                       ELSE active_turn_index END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── cms_complete_turn_writeback ───────────────────────────────────
-- Same as 0022/0023, plus: the turn ended, so always clear active_turn_index.
CREATE OR REPLACE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        active_turn_index = NULL,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0025: Session events type filter ──────────────────

function migration_0025_session_events_type_filter(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0025_session_events_type_filter: server-side event-type filtering for
-- history paging. Chat history is sparse in the raw event stream (a busy
-- session can have thousands of tool/orchestration events between chat
-- messages), so clients paging backward for chat had to drain raw pages.
-- These 4-arg OVERLOADS of cms_get_session_events / _before accept
-- p_event_types TEXT[] (NULL = unfiltered); the 3-arg versions stay in
-- place so older workers/portals keep working mid-rollout.
--
-- Index note: a partial index cannot serve a parameterized
-- "event_type = ANY($4)" (the planner can't prove the predicate implies
-- the index predicate), so this uses a composite btree instead.

CREATE INDEX IF NOT EXISTS idx_${schema}_events_session_type_seq
    ON ${s}.session_events (session_id, event_type, seq);

-- ── cms_get_session_events (type-filtered overload) ──────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id  TEXT,
    p_after_seq   BIGINT,
    p_limit       INT,
    p_event_types TEXT[]
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
BEGIN
    IF p_after_seq IS NOT NULL AND p_after_seq > 0 THEN
        RETURN QUERY
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq > p_after_seq
          AND (p_event_types IS NULL OR event_type = ANY(p_event_types))
        ORDER BY seq ASC LIMIT v_limit;
    ELSE
        RETURN QUERY
        SELECT * FROM (
            SELECT * FROM ${s}.session_events
            WHERE session_id = p_session_id
              AND (p_event_types IS NULL OR event_type = ANY(p_event_types))
            ORDER BY seq DESC LIMIT v_limit
        ) t ORDER BY seq ASC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events_before (type-filtered overload) ───────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT,
    p_event_types TEXT[]
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
          AND (p_event_types IS NULL OR event_type = ANY(p_event_types))
        ORDER BY seq DESC LIMIT v_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0026: Session splash mobile ────────────────────────

function migration_0026_session_splash_mobile(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0026_session_splash_mobile: narrow-viewport splash variant. Agents can ship
-- a splashMobile banner that the UI swaps in when the main splash art is wider
-- than the pane (mobile portal, narrow terminals). Nullable column + a 9-arg
-- overload of cms_create_session (the 8-arg version stays for old workers),
-- a splashMobile rule in cms_update_session (spawn paths set splash via the
-- jsonb meta update), and the fixed-column read procs recreated with the new
-- column. cms_list_group_sessions does SELECT * FROM cms_list_sessions() into
-- its own fixed column list, so both must move together or it breaks at
-- runtime. (An earlier revision of this note claimed cms_list_sessions_page
-- "needs no change" because it returns SETOF sessions — that was exactly the
-- bug: SETOF sessions carries no owner columns, so every paged list row
-- reached clients with owner=null and the UI rendered "?" initials.
-- Migration 0028 recreates it with the owner join.)

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS splash_mobile TEXT;

-- ── cms_create_session (splash_mobile overload) ──────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT,
    p_splash_mobile     TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, splash_mobile, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, p_splash_mobile, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        splash_mobile     = EXCLUDED.splash_mobile,
        group_id          = EXCLUDED.group_id,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
-- Same as 0024, plus the splashMobile column rule.
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        splash_mobile     = CASE WHEN p_updates ? 'splashMobile'    THEN (p_updates->>'splashMobile')                              ELSE splash_mobile     END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL                       ELSE active_turn_index END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session ──────────────────────────────────────────────
-- Same as 0024, plus splash_mobile in the fixed column list.
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    active_turn_index  INTEGER,
    splash_mobile      TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.active_turn_index,
        sess.splash_mobile
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── cms_list_sessions / cms_list_group_sessions ──────────────────
-- Recreated together: the group variant is SELECT * over cms_list_sessions()
-- into its own fixed column list, so their shapes must stay identical.
DROP FUNCTION IF EXISTS ${s}.cms_list_group_sessions(TEXT);
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() s
    WHERE s.group_id = p_group_id
    ORDER BY s.updated_at DESC, s.session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0027: Session Raw (Uncompressed) Snapshot Size ────
//
// Under the brotli-4 switch the stored snapshot size drops ~10-15x for
// JSONL-heavy sessions. `raw_size_bytes` records the uncompressed
// tar-stream size alongside the compressed `snapshot_size_bytes`, so
// capacity trends stay continuous across the codec change and the Stats
// pane can show stored/raw/ratio. Fed by the runTurn commit summary write
// (and the legacy dehydrate path); read per-session (SELECT *) and rolled
// up in the session-tree + fleet totals.
function migration_0027_session_raw_size_bytes(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0027_session_raw_size_bytes: uncompressed snapshot size for the
-- compression-ratio stat. All statements idempotent.

ALTER TABLE ${s}.session_metrics
    ADD COLUMN IF NOT EXISTS raw_size_bytes BIGINT NOT NULL DEFAULT 0;

-- Recreate the backward-compat view so its frozen SELECT * column list
-- picks up the new column (Postgres views do not auto-track base columns).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.views
        WHERE table_schema = '${schema}' AND table_name = 'session_metric_summaries'
    ) THEN
        EXECUTE 'DROP VIEW ${s}.session_metric_summaries';
        EXECUTE 'CREATE VIEW ${s}.session_metric_summaries AS SELECT * FROM ${s}.session_metrics';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Upsert: set raw_size_bytes when provided (absolute, like snapshotSizeBytes).
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_session_metric_summary(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
DECLARE
    v_snapshot       BIGINT  := COALESCE((p_updates->>'snapshotSizeBytes')::BIGINT, 0);
    v_raw            BIGINT  := COALESCE((p_updates->>'rawSizeBytes')::BIGINT, 0);
    v_dehydration    INT     := COALESCE((p_updates->>'dehydrationCountIncrement')::INT, 0);
    v_hydration      INT     := COALESCE((p_updates->>'hydrationCountIncrement')::INT, 0);
    v_lossy          INT     := COALESCE((p_updates->>'lossyHandoffCountIncrement')::INT, 0);
    v_tokens_in      BIGINT  := COALESCE((p_updates->>'tokensInputIncrement')::BIGINT, 0);
    v_tokens_out     BIGINT  := COALESCE((p_updates->>'tokensOutputIncrement')::BIGINT, 0);
    v_tokens_cread   BIGINT  := COALESCE((p_updates->>'tokensCacheReadIncrement')::BIGINT, 0);
    v_tokens_cwrite  BIGINT  := COALESCE((p_updates->>'tokensCacheWriteIncrement')::BIGINT, 0);
    v_set_dehydrated BOOLEAN := COALESCE((p_updates->>'lastDehydratedAt')::BOOLEAN, FALSE);
    v_set_hydrated   BOOLEAN := COALESCE((p_updates->>'lastHydratedAt')::BOOLEAN, FALSE);
    v_set_checkpoint BOOLEAN := COALESCE((p_updates->>'lastCheckpointAt')::BOOLEAN, FALSE);
BEGIN
    INSERT INTO ${s}.session_metrics (
        session_id, snapshot_size_bytes, raw_size_bytes,
        dehydration_count, hydration_count, lossy_handoff_count,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, v_snapshot, v_raw,
        v_dehydration, v_hydration, v_lossy,
        v_tokens_in, v_tokens_out, v_tokens_cread, v_tokens_cwrite
    )
    ON CONFLICT (session_id) DO UPDATE SET
        snapshot_size_bytes = CASE
            WHEN p_updates ? 'snapshotSizeBytes'
            THEN v_snapshot
            ELSE ${s}.session_metrics.snapshot_size_bytes
        END,
        raw_size_bytes = CASE
            WHEN p_updates ? 'rawSizeBytes'
            THEN v_raw
            ELSE ${s}.session_metrics.raw_size_bytes
        END,
        dehydration_count   = ${s}.session_metrics.dehydration_count   + v_dehydration,
        hydration_count     = ${s}.session_metrics.hydration_count     + v_hydration,
        lossy_handoff_count = ${s}.session_metrics.lossy_handoff_count + v_lossy,
        tokens_input        = ${s}.session_metrics.tokens_input        + v_tokens_in,
        tokens_output       = ${s}.session_metrics.tokens_output       + v_tokens_out,
        tokens_cache_read   = ${s}.session_metrics.tokens_cache_read   + v_tokens_cread,
        tokens_cache_write  = ${s}.session_metrics.tokens_cache_write  + v_tokens_cwrite,
        last_dehydrated_at  = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metrics.last_dehydrated_at END,
        last_hydrated_at    = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metrics.last_hydrated_at   END,
        last_checkpoint_at  = CASE WHEN v_set_checkpoint  THEN now() ELSE ${s}.session_metrics.last_checkpoint_at  END,
        updated_at          = now();
END;
$$ LANGUAGE plpgsql;

-- Session-tree rollup (+ total_raw_size_bytes). Feeds the Stats pane TREE block.
DROP FUNCTION IF EXISTS ${s}.cms_get_session_tree_stats(TEXT);
CREATE FUNCTION ${s}.cms_get_session_tree_stats(
    p_session_id TEXT
) RETURNS TABLE (
    session_count              INT,
    total_tokens_input         BIGINT,
    total_tokens_output        BIGINT,
    total_tokens_cache_read    BIGINT,
    total_tokens_cache_write   BIGINT,
    total_dehydration_count    INT,
    total_hydration_count      INT,
    total_lossy_handoff_count  INT,
    total_snapshot_size_bytes   BIGINT,
    total_raw_size_bytes        BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metrics m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metrics m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.dehydration_count), 0)::int      AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int        AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int    AS total_lossy_handoff_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes,
        COALESCE(SUM(m.raw_size_bytes), 0)::bigint       AS total_raw_size_bytes
    FROM ${s}.session_metrics m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree);
END;
$$ LANGUAGE plpgsql;

-- Fleet totals rollup (+ total_raw_size_bytes). Feeds the Stats pane Fleet tab.
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_totals(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_raw_size_bytes          BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    total_tokens_cache_read      BIGINT,
    total_tokens_cache_write     BIGINT,
    earliest_session_created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.raw_size_bytes), 0)::bigint             AS total_raw_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(m.created_at)                                      AS earliest_session_created_at
    FROM ${s}.session_metrics m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0028: paged session listing carries the owner ────────────────

function migration_0028_list_sessions_page_owner(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0028_list_sessions_page_owner: recreate cms_list_sessions_page with the
-- session_owners/users LEFT JOIN that cms_list_sessions already performs.
--
-- The original (0013) declared RETURNS SETOF sessions — the raw table, which
-- has no owner columns (ownership lives in session_owners + users). The
-- portal's session list always loads through this paged path, so every listed
-- row reached rowToSessionRow with owner_provider absent → owner: null → the
-- UI rendered "?" initials, and a paged refresh clobbered initials fetched
-- earlier via cms_get_session. Ownership was always persisted correctly; only
-- this read path dropped it.
--
-- Column list mirrors the 0026 revision of cms_list_sessions exactly (owner
-- columns before splash_mobile, matching that function's wire order) so
-- rowToSessionRow handles both paths identically. Keyset semantics, ordering,
-- clamps, and parameters are unchanged. PostgreSQL refuses CREATE OR REPLACE
-- across a return-shape change, so drop first (callers retry on next request;
-- the migration runs inside the startup migration transaction).

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_page(INT, TIMESTAMPTZ, TEXT, BOOL);
CREATE FUNCTION ${s}.cms_list_sessions_page(
    p_limit             INT         DEFAULT 51,
    p_cursor_updated_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id TEXT        DEFAULT NULL,
    p_include_deleted   BOOL        DEFAULT FALSE
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider     AS owner_provider,
        u.subject      AS owner_subject,
        u.email        AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE
        (p_include_deleted OR sess.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR sess.updated_at < p_cursor_updated_at
            OR (sess.updated_at = p_cursor_updated_at AND sess.session_id < p_cursor_session_id)
        )
    ORDER BY sess.updated_at DESC, sess.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0029: session visibility, shares, root stamping, authz audit ─

function migration_0029_session_visibility_shares(schema: string): string[] {
    const s = `"${schema}"`;

    // Non-transactional steps (see MigrationEntry.steps). The original
    // single-transaction shape held the ALTER's ACCESS EXCLUSIVE lock on
    // `sessions` through a full-table backfill and a non-CONCURRENT index
    // build — on a large, busy table that freezes every live reader/writer
    // for the whole migration. Hardened shape:
    //   1. The two ALTERs commit alone under a 5s lock_timeout (metadata-only:
    //      constant default, no rewrite). A blocked ALTER fails fast and the
    //      worker's CMS-init retry re-attempts, instead of queueing the fleet
    //      behind the lock request.
    //   2. The backfill runs level-by-level in a DO block, COMMITting between
    //      passes (PG11+), so it takes only brief row locks — never a table
    //      lock. Cycles self-exhaust (their members never gain a root);
    //      orphans and cycle members fall back to self-rooted, matching the
    //      original recursive-CTE semantics.
    //   3. The sessions index builds with CREATE INDEX CONCURRENTLY (writes
    //      proceed during the build), with an invalid-leftover sweep first —
    //      a died CIC leaves an INVALID index that IF NOT EXISTS would
    //      otherwise treat as present.
    //   4. The new tables + all function DDL stay one atomic step, so
    //      DROP+CREATE proc swaps expose no missing-function window.
    // Every step is idempotent: a mid-way failure re-runs all steps.

    const step_columns = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS root_session_id TEXT;
COMMIT;
`;

    const step_backfill = `
DO $harden$
DECLARE
    affected BIGINT;
    passes   INT := 0;
BEGIN
    -- Roots: parentless rows own their tree.
    UPDATE ${s}.sessions
    SET root_session_id = session_id
    WHERE parent_session_id IS NULL AND root_session_id IS NULL;
    COMMIT;

    -- Propagate one tree level per pass, committing between passes.
    LOOP
        UPDATE ${s}.sessions AS child
        SET root_session_id = parent.root_session_id
        FROM ${s}.sessions AS parent
        WHERE child.parent_session_id = parent.session_id
          AND child.root_session_id IS NULL
          AND parent.root_session_id IS NOT NULL;
        GET DIAGNOSTICS affected = ROW_COUNT;
        EXIT WHEN affected = 0;
        COMMIT;
        passes := passes + 1;
        EXIT WHEN passes >= 128;
    END LOOP;

    -- Orphans (hard-deleted parents) and cycle members fall back to self.
    UPDATE ${s}.sessions
    SET root_session_id = session_id
    WHERE root_session_id IS NULL;
END
$harden$;
`;

    const step_drop_invalid_index = `
DO $harden$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}'
          AND c.relname = 'idx_${schema}_sessions_root'
          AND NOT i.indisvalid
    ) THEN
        EXECUTE 'DROP INDEX ${s}.idx_${schema}_sessions_root';
    END IF;
END
$harden$;
`;

    const step_index = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${schema}_sessions_root
    ON ${s}.sessions(root_session_id);
`;

    const step_tables_and_functions = `
-- 0029_session_visibility_shares: the security-model schema
-- (docs/proposals/user-admin-security-model.md).
--
-- Adds:
--   sessions.visibility        'private' | 'shared_read' | 'shared_write'.
--                              Meaningful on ROOT sessions only — access for a
--                              child always resolves through its root.
--   sessions.root_session_id   Denormalized tree root, stamped at create so
--                              list filtering is one join, not a recursive
--                              walk. Backfilled here for existing rows.
--   session_shares             Targeted per-user grants (read|write), keyed on
--                              the ROOT session id.
--   authz_audit                Denials, break-glass reads, share changes.
--
-- Access predicate (evaluated in cms_get_session_access / list filtering):
--   canRead  := admin || root.owner == viewer || root.visibility in
--               (shared_read, shared_write) || share(root, viewer) is set
--   canWrite := admin || root.owner == viewer || root.visibility ==
--               shared_write || share(root, viewer) == write
-- Role (admin or not) is the caller's concern; these procs only report facts.

CREATE TABLE IF NOT EXISTS ${s}.session_shares (
    session_id  TEXT   NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    access      TEXT   NOT NULL,
    granted_by  BIGINT REFERENCES ${s}.users(user_id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_${schema}_session_shares_user
    ON ${s}.session_shares(user_id);

CREATE TABLE IF NOT EXISTS ${s}.authz_audit (
    audit_id       BIGSERIAL PRIMARY KEY,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_provider TEXT,
    actor_subject  TEXT,
    actor_display  TEXT,
    action         TEXT NOT NULL,
    session_id     TEXT,
    target         TEXT,
    decision       TEXT NOT NULL,
    reason         TEXT,
    details        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_${schema}_authz_audit_session
    ON ${s}.authz_audit(session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_authz_audit_occurred
    ON ${s}.authz_audit(occurred_at DESC);

-- ── cms_resolve_root_session ─────────────────────────────────────
-- Root id for a live session; falls back to the session itself when the
-- recorded root row is gone (hard-delete edge). NULL when the session does
-- not exist or is soft-deleted.
CREATE OR REPLACE FUNCTION ${s}.cms_resolve_root_session(
    p_session_id TEXT
) RETURNS TEXT AS $$
DECLARE
    v_root TEXT;
BEGIN
    SELECT COALESCE(sess.root_session_id, sess.session_id) INTO v_root
    FROM ${s}.sessions sess
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
    IF v_root IS NULL THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ${s}.sessions r WHERE r.session_id = v_root) THEN
        RETURN p_session_id;
    END IF;
    RETURN v_root;
END;
$$ LANGUAGE plpgsql;

-- ── cms_create_session (visibility + root overload) ──────────────
-- 10-arg overload: 0026's 9-arg body plus p_visibility, root stamping.
-- No parameter defaults — defaults would make 9-arg calls ambiguous against
-- the 0026 overload, which stays for older writers during rolling deploys.
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT,
    p_splash_mobile     TEXT,
    p_visibility        TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_root TEXT;
    v_visibility TEXT := CASE
        WHEN p_visibility IN ('private', 'shared_read', 'shared_write') THEN p_visibility
        ELSE 'private'
    END;
BEGIN
    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id), COALESCE(v_group_id, parent.group_id)
        INTO v_root, v_group_id
        FROM ${s}.sessions parent
        WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, splash_mobile, group_id, root_session_id, visibility)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, p_splash_mobile, v_group_id, v_root, v_visibility)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        splash_mobile     = EXCLUDED.splash_mobile,
        group_id          = EXCLUDED.group_id,
        root_session_id   = EXCLUDED.root_session_id,
        visibility        = EXCLUDED.visibility,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_session_visibility ───────────────────────────────────
-- Applies to the ROOT of the given session; refuses system trees.
CREATE OR REPLACE FUNCTION ${s}.cms_set_session_visibility(
    p_session_id TEXT,
    p_visibility TEXT
) RETURNS VOID AS $$
DECLARE
    v_root TEXT;
    v_is_system BOOLEAN;
BEGIN
    IF p_visibility NOT IN ('private', 'shared_read', 'shared_write') THEN
        RAISE EXCEPTION 'Invalid visibility "%" (expected private|shared_read|shared_write)', p_visibility;
    END IF;
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RAISE EXCEPTION 'Session not found';
    END IF;
    SELECT sess.is_system INTO v_is_system FROM ${s}.sessions sess WHERE sess.session_id = v_root;
    IF COALESCE(v_is_system, FALSE) THEN
        RAISE EXCEPTION 'Cannot change visibility of a system session';
    END IF;
    UPDATE ${s}.sessions SET visibility = p_visibility, updated_at = now()
    WHERE session_id = v_root;
END;
$$ LANGUAGE plpgsql;

-- ── cms_grant_session_share ──────────────────────────────────────
-- Grants (or updates) a targeted share on the ROOT of the given session.
CREATE OR REPLACE FUNCTION ${s}.cms_grant_session_share(
    p_session_id     TEXT,
    p_provider       TEXT,
    p_subject        TEXT,
    p_email          TEXT,
    p_display_name   TEXT,
    p_access         TEXT,
    p_granted_by_provider TEXT,
    p_granted_by_subject  TEXT
) RETURNS VOID AS $$
DECLARE
    v_root TEXT;
    v_is_system BOOLEAN;
    v_user_id BIGINT;
    v_granted_by BIGINT;
BEGIN
    IF p_access NOT IN ('read', 'write') THEN
        RAISE EXCEPTION 'Invalid share access "%" (expected read|write)', p_access;
    END IF;
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RAISE EXCEPTION 'Session not found';
    END IF;
    SELECT sess.is_system INTO v_is_system FROM ${s}.sessions sess WHERE sess.session_id = v_root;
    IF COALESCE(v_is_system, FALSE) THEN
        RAISE EXCEPTION 'Cannot share a system session';
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);
    IF p_granted_by_provider IS NOT NULL AND p_granted_by_subject IS NOT NULL THEN
        SELECT u.user_id INTO v_granted_by FROM ${s}.users u
        WHERE u.provider = BTRIM(p_granted_by_provider) AND u.subject = BTRIM(p_granted_by_subject);
    END IF;

    INSERT INTO ${s}.session_shares (session_id, user_id, access, granted_by)
    VALUES (v_root, v_user_id, p_access, v_granted_by)
    ON CONFLICT (session_id, user_id) DO UPDATE
    SET access = EXCLUDED.access,
        granted_by = EXCLUDED.granted_by,
        granted_at = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_revoke_session_share ─────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_revoke_session_share(
    p_session_id TEXT,
    p_provider   TEXT,
    p_subject    TEXT
) RETURNS VOID AS $$
DECLARE
    v_root TEXT;
BEGIN
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RAISE EXCEPTION 'Session not found';
    END IF;
    DELETE FROM ${s}.session_shares sh
    USING ${s}.users u
    WHERE sh.session_id = v_root
      AND u.user_id = sh.user_id
      AND u.provider = BTRIM(p_provider)
      AND u.subject = BTRIM(p_subject);
END;
$$ LANGUAGE plpgsql;

-- ── cms_list_session_shares ──────────────────────────────────────
DROP FUNCTION IF EXISTS ${s}.cms_list_session_shares(TEXT);
CREATE FUNCTION ${s}.cms_list_session_shares(
    p_session_id TEXT
) RETURNS TABLE (
    provider     TEXT,
    subject      TEXT,
    email        TEXT,
    display_name TEXT,
    access       TEXT,
    granted_at   TIMESTAMPTZ,
    granted_by_display TEXT
) AS $$
DECLARE
    v_root TEXT;
BEGIN
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT u.provider, u.subject, u.email, u.display_name, sh.access, sh.granted_at,
           gb.display_name AS granted_by_display
    FROM ${s}.session_shares sh
    JOIN ${s}.users u ON u.user_id = sh.user_id
    LEFT JOIN ${s}.users gb ON gb.user_id = sh.granted_by
    WHERE sh.session_id = v_root
    ORDER BY sh.granted_at ASC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_access ───────────────────────────────────────
-- One round-trip access snapshot for the enforcement predicate: the root's
-- system flag, visibility, owner, and the viewer's targeted share. Reports
-- facts only; the caller combines them with the caller's role.
DROP FUNCTION IF EXISTS ${s}.cms_get_session_access(TEXT, TEXT, TEXT);
CREATE FUNCTION ${s}.cms_get_session_access(
    p_session_id      TEXT,
    p_viewer_provider TEXT,
    p_viewer_subject  TEXT
) RETURNS TABLE (
    root_session_id    TEXT,
    is_system          BOOLEAN,
    visibility         TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    viewer_is_owner    BOOLEAN,
    viewer_share_access TEXT
) AS $$
DECLARE
    v_root TEXT;
BEGIN
    v_root := ${s}.cms_resolve_root_session(p_session_id);
    IF v_root IS NULL THEN
        RETURN; -- zero rows: session missing or soft-deleted
    END IF;
    RETURN QUERY
    SELECT
        v_root,
        COALESCE(r.is_system, FALSE),
        COALESCE(r.visibility, 'private'),
        u.provider,
        u.subject,
        u.email,
        u.display_name,
        (u.provider IS NOT NULL
            AND u.provider = BTRIM(p_viewer_provider)
            AND u.subject = BTRIM(p_viewer_subject)),
        (SELECT sh.access
         FROM ${s}.session_shares sh
         JOIN ${s}.users vu ON vu.user_id = sh.user_id
         WHERE sh.session_id = v_root
           AND vu.provider = BTRIM(p_viewer_provider)
           AND vu.subject = BTRIM(p_viewer_subject))
    FROM ${s}.sessions r
    LEFT JOIN ${s}.session_owners so ON so.session_id = r.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE r.session_id = v_root;
END;
$$ LANGUAGE plpgsql;

-- ── cms_record_authz_audit / cms_list_authz_audit ────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_record_authz_audit(
    p_actor_provider TEXT,
    p_actor_subject  TEXT,
    p_actor_display  TEXT,
    p_action         TEXT,
    p_session_id     TEXT,
    p_target         TEXT,
    p_decision       TEXT,
    p_reason         TEXT,
    p_details        JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.authz_audit
        (actor_provider, actor_subject, actor_display, action, session_id, target, decision, reason, details)
    VALUES
        (p_actor_provider, p_actor_subject, p_actor_display, p_action, p_session_id, p_target, p_decision, p_reason, COALESCE(p_details, '{}'::JSONB));
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_list_authz_audit(INT, TEXT);
CREATE FUNCTION ${s}.cms_list_authz_audit(
    p_limit      INT,
    p_session_id TEXT
) RETURNS TABLE (
    audit_id       BIGINT,
    occurred_at    TIMESTAMPTZ,
    actor_provider TEXT,
    actor_subject  TEXT,
    actor_display  TEXT,
    action         TEXT,
    session_id     TEXT,
    target         TEXT,
    decision       TEXT,
    reason         TEXT,
    details        JSONB
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
BEGIN
    RETURN QUERY
    SELECT a.audit_id, a.occurred_at, a.actor_provider, a.actor_subject, a.actor_display,
           a.action, a.session_id, a.target, a.decision, a.reason, a.details
    FROM ${s}.authz_audit a
    WHERE p_session_id IS NULL
       OR a.session_id = p_session_id
       OR a.session_id IN (
            SELECT sess.session_id FROM ${s}.sessions sess
            WHERE COALESCE(sess.root_session_id, sess.session_id) = ${s}.cms_resolve_root_session(p_session_id)
       )
    ORDER BY a.occurred_at DESC, a.audit_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- ── Read procs: append visibility + root_session_id ──────────────
-- All four session read procs gain the two new columns AT THE END of the
-- return shape (after splash_mobile) so rowToSessionRow handles every path
-- identically. Return-shape changes require drop-then-create.

-- cms_get_session
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    active_turn_index  INTEGER,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.active_turn_index,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions / cms_list_group_sessions (shapes must stay identical)
DROP FUNCTION IF EXISTS ${s}.cms_list_group_sessions(TEXT);
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() sess
    WHERE sess.group_id = p_group_id
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions_page: viewer-aware. p_viewer_provider NULL = unfiltered
-- (admin / internal callers). Non-NULL viewer sees: own trees, trees shared
-- deployment-wide or granted to them, and system sessions when
-- p_viewer_system_visible.
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_page(INT, TIMESTAMPTZ, TEXT, BOOL);
CREATE FUNCTION ${s}.cms_list_sessions_page(
    p_limit                 INT         DEFAULT 51,
    p_cursor_updated_at     TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id     TEXT        DEFAULT NULL,
    p_include_deleted       BOOL        DEFAULT FALSE,
    p_viewer_provider       TEXT        DEFAULT NULL,
    p_viewer_subject        TEXT        DEFAULT NULL,
    p_viewer_system_visible BOOL        DEFAULT TRUE
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider     AS owner_provider,
        u.subject      AS owner_subject,
        u.email        AS owner_email,
        u.display_name AS owner_display_name,
        sess.splash_mobile,
        sess.visibility,
        sess.root_session_id
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE
        (p_include_deleted OR sess.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR sess.updated_at < p_cursor_updated_at
            OR (sess.updated_at = p_cursor_updated_at AND sess.session_id < p_cursor_session_id)
        )
        AND (
            p_viewer_provider IS NULL
            OR EXISTS (
                SELECT 1
                FROM ${s}.sessions r
                LEFT JOIN ${s}.session_owners rso ON rso.session_id = r.session_id
                LEFT JOIN ${s}.users ru ON ru.user_id = rso.user_id
                WHERE r.session_id = COALESCE(sess.root_session_id, sess.session_id)
                  AND (
                    (r.is_system AND p_viewer_system_visible)
                    OR (ru.provider = BTRIM(p_viewer_provider) AND ru.subject = BTRIM(p_viewer_subject))
                    OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
                    OR EXISTS (
                        SELECT 1 FROM ${s}.session_shares sh
                        JOIN ${s}.users vu ON vu.user_id = sh.user_id
                        WHERE sh.session_id = r.session_id
                          AND vu.provider = BTRIM(p_viewer_provider)
                          AND vu.subject = BTRIM(p_viewer_subject)
                    )
                  )
            )
        )
    ORDER BY sess.updated_at DESC, sess.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- cms_list_sessions_visible: non-paged viewer-scoped listing, same shape and
-- predicate as the paged variant. Used by the plain listSessions op for
-- non-admin callers.
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_visible(TEXT, TEXT, BOOL);
CREATE FUNCTION ${s}.cms_list_sessions_visible(
    p_viewer_provider       TEXT,
    p_viewer_subject        TEXT,
    p_viewer_system_visible BOOL
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    splash_mobile      TEXT,
    visibility         TEXT,
    root_session_id    TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() sess
    WHERE EXISTS (
        SELECT 1
        FROM ${s}.sessions r
        LEFT JOIN ${s}.session_owners rso ON rso.session_id = r.session_id
        LEFT JOIN ${s}.users ru ON ru.user_id = rso.user_id
        WHERE r.session_id = COALESCE(sess.root_session_id, sess.session_id)
          AND (
            (r.is_system AND p_viewer_system_visible)
            OR (ru.provider = BTRIM(p_viewer_provider) AND ru.subject = BTRIM(p_viewer_subject))
            OR COALESCE(r.visibility, 'private') IN ('shared_read', 'shared_write')
            OR EXISTS (
                SELECT 1 FROM ${s}.session_shares sh
                JOIN ${s}.users vu ON vu.user_id = sh.user_id
                WHERE sh.session_id = r.session_id
                  AND vu.provider = BTRIM(p_viewer_provider)
                  AND vu.subject = BTRIM(p_viewer_subject)
            )
          )
    )
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;

    return [step_columns, step_backfill, step_drop_invalid_index, step_index, step_tables_and_functions];
}

// ─── Migration 0041: agent-package owner identity ────────────────
//
// An agent package stored only its owner PRINCIPAL (provider + subject —
// an opaque directory id) plus a created_by email, so the UI had no human
// name to render and fell back to the email's local part: "ada@…"
// became "DA" where the same person's sessions correctly showed "AD" for
// "Affan Dar".
//
// The identity was never missing — it lives in the users table, which the
// session view has always joined (u.display_name AS owner_display_name).
// These procs simply never did. Joining it here means packages and
// sessions resolve the same person the same way, for every row that
// already exists, with no new columns and nothing to backfill.
function migration_0041_agent_package_owner_identity(schema: string): string {
    const s = schema;
    return `
-- Adding OUT columns CHANGES the return type, and CREATE OR REPLACE cannot
-- do that ("cannot change return type of existing function"). Both functions
-- must be dropped first. The migrator runs this in a transaction, so callers
-- never observe the gap.
DROP FUNCTION IF EXISTS ${s}.cms_list_agent_packages(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_get_agent_package(TEXT, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_packages(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, semver TEXT, sha256 TEXT, size_bytes BIGINT,
    artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.scope = 'shared'
        OR p_is_admin
        OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
     ORDER BY p.scope, p.name;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, version_id TEXT, semver TEXT, sha256 TEXT,
    size_bytes BIGINT, artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at, p.active_version_id,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.package_id = p.package_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.name = p_name
       AND (p.scope = 'shared' OR p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject)))
     ORDER BY v.created_at DESC;
$$ LANGUAGE sql;
`;
}

// ─── Migration 0042: persist the authorization role at sign-in ───
//
// The worker had no way to know whether a session's owner is an admin.
// The portal resolves the role from the request JWT (Entra app roles, or the
// email allowlist) and never persisted it, so a worker — which holds an
// owner, not a token, and runs turns on the far side of a durable queue where
// no request exists at all (cron, sub-agent turns, crash recovery, replay) —
// had nothing to read. Agent inspect tools were therefore user-scoped for
// everyone, admins included.
//
// This stores the LAST OBSERVED role for a principal, refreshed on every
// authenticated portal request. Two properties make that safe to rely on:
//
//   - `role` is OVERWRITTEN, never COALESCE'd. A demotion (admin → user) must
//     land, and a COALESCE-style merge like cms_register_user's display-field
//     rule would silently preserve the higher privilege forever. This is why
//     the role does NOT ride along on cms_register_user: that function is
//     called by sightings which carry no role at all (share grants, session
//     creates), and any of them would either wipe a good role or force the
//     merge semantics we must not have here.
//
//   - `role_seen_at` records when the value was last CONFIRMED, not when it
//     last changed, so readers can fail closed on a stale row. It is bumped
//     on every write even when the role is unchanged.
//
// Unrecognized role text normalizes to NULL rather than being stored verbatim:
// an unknown role must read as "no privilege", never as an opaque value some
// later caller might compare loosely.
function migration_0042_user_role_from_signin(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0042_user_role_from_signin: last-observed authorization role per user.

ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS role_seen_at TIMESTAMPTZ;

-- ── cms_set_user_role ────────────────────────────────────────────
-- Upserts the user (reusing the standard sighting path so email/display_name
-- stay fresh) and then REPLACES the role outright.
--
-- Returns the stored role so the caller can cheaply detect a change without a
-- second round-trip.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_role(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_role         TEXT
) RETURNS TEXT AS $$
DECLARE
    v_user_id BIGINT;
    v_role    TEXT := LOWER(NULLIF(BTRIM(p_role), ''));
BEGIN
    -- Anything outside the known vocabulary is stored as NULL (= no
    -- privilege). 'anonymous' is a real value: it is what an auth-disabled
    -- deployment issues, and the portal treats it as full access, so the
    -- worker must be able to see the same thing rather than guess.
    IF v_role IS NOT NULL AND v_role NOT IN ('admin', 'user', 'anonymous') THEN
        v_role := NULL;
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    UPDATE ${s}.users
    SET role         = v_role,
        role_seen_at = now(),
        updated_at   = now()
    WHERE user_id = v_user_id;

    RETURN v_role;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_user_role ────────────────────────────────────────────
-- Narrow read for the worker's viewer resolver. Deliberately NOT folded into
-- cms_get_user_profile: that would change an existing return type (requiring
-- a DROP) and would hand the role to every profile reader, including the
-- management surface, where it has no business being.
--
-- Returns no row for an unknown principal — the caller must treat "no row"
-- and "NULL role" alike, as no privilege.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_role(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS TABLE (
    role         TEXT,
    role_seen_at TIMESTAMPTZ
) AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT u.role, u.role_seen_at
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0043: per-user agent package namespaces ───────────
//
// Package identity was globally unique on `name` alone, so the first person
// to publish "triager" owned that word for the whole deployment. Identity
// becomes the triple (scope, owner, name): every user gets their own
// namespace, and `shared` is the deployment-wide one.
//
// Two rules carry the whole design:
//
//   1. RESOLUTION — a viewer's own ENABLED copy shadows the shared copy.
//      That single rule delivers download-modify-independently, and doubles
//      as recovery: disable a broken personal copy and the shared one takes
//      over again with no other action.
//
//   2. PROMOTION IS EXCLUSIVE — user→shared refuses when a shared package
//      already holds the name, because `shared` is the one namespace that
//      still has to be globally unique.
//
// Every mutation proc previously keyed off `p_name` alone, which is now
// ambiguous (your "triager" and mine). They all gain an explicit SELECTOR —
// (scope, owner_provider, owner_subject) — where a NULL scope means "resolve
// it for the actor the same way resolution works everywhere else". Adding
// parameters creates an OVERLOAD rather than replacing the function, so each
// old signature is dropped explicitly first.
//
// The install manifest also starts returning `package_id`. Workers install
// every enabled package to disk, and with namespaces two packages can share
// a name — a stable per-row key is what keeps them from colliding in the
// cache directory.
function migration_0043_agent_package_namespaces(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0043_agent_package_namespaces: identity becomes (scope, owner, name).

-- ── The uniqueness swap ──────────────────────────────────────────
--
-- The old constraint came from \`name TEXT NOT NULL UNIQUE\` in the 0038
-- CREATE TABLE, so PostgreSQL named it. Look it up by DEFINITION rather than
-- by guessing the generated name: a schema restored from a dump, or created
-- by a different PostgreSQL version, may not have named it identically.
DO $mig$
DECLARE
    v_con TEXT;
BEGIN
    SELECT c.conname INTO v_con
      FROM pg_constraint c
     WHERE c.conrelid = '${s}.agent_packages'::regclass
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (name)';
    IF v_con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE ${s}.agent_packages DROP CONSTRAINT %I', v_con);
    END IF;
END
$mig$;

-- Shared is still globally unique — it is the deployment's own namespace.
CREATE UNIQUE INDEX IF NOT EXISTS agent_packages_shared_name_uniq
    ON ${s}.agent_packages (name) WHERE scope = 'shared';

-- User scope is unique PER OWNER. Existing rows were globally unique, so this
-- index cannot conflict on the way in — there is nothing to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS agent_packages_user_name_uniq
    ON ${s}.agent_packages (owner_provider, owner_subject, name) WHERE scope = 'user';

-- ── The resolver ─────────────────────────────────────────────────
--
-- One place decides which copy a name refers to, so reads, writes and the
-- worker's agent lookup can never disagree about it.
--
-- p_sel_scope NULL  → resolve: the viewer's own copy, else shared.
-- p_sel_scope given → pin exactly that copy (this is what an FQN compiles to).
--
-- p_require_enabled exists because SHADOWING IS ENABLE-SENSITIVE: a disabled
-- personal copy must fall through to shared (that is the recovery path),
-- while a mutation has to find the disabled row in order to re-enable it.
CREATE OR REPLACE FUNCTION ${s}.cms_resolve_agent_package_id(
    p_name             TEXT,
    p_viewer_provider  TEXT,
    p_viewer_subject   TEXT,
    p_sel_scope        TEXT,
    p_sel_owner_provider TEXT,
    p_sel_owner_subject  TEXT,
    p_require_enabled  BOOLEAN
) RETURNS TEXT AS $$
DECLARE
    v_viewer_p TEXT := NULLIF(BTRIM(p_viewer_provider), '');
    v_viewer_s TEXT := NULLIF(BTRIM(p_viewer_subject), '');
    v_sel_p    TEXT := NULLIF(BTRIM(p_sel_owner_provider), '');
    v_sel_s    TEXT := NULLIF(BTRIM(p_sel_owner_subject), '');
    v_id       TEXT;
BEGIN
    IF p_sel_scope = 'shared' THEN
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'shared'
           AND (NOT p_require_enabled OR p.enabled);
        RETURN v_id;
    END IF;

    IF p_sel_scope = 'user' THEN
        -- An explicit user-scope selection with no owner named means "mine".
        IF v_sel_p IS NULL OR v_sel_s IS NULL THEN
            v_sel_p := v_viewer_p;
            v_sel_s := v_viewer_s;
        END IF;
        IF v_sel_p IS NULL OR v_sel_s IS NULL THEN
            RETURN NULL;
        END IF;
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'user'
           AND p.owner_provider = v_sel_p AND p.owner_subject = v_sel_s
           AND (NOT p_require_enabled OR p.enabled);
        RETURN v_id;
    END IF;

    -- Unpinned: own copy shadows shared.
    IF v_viewer_p IS NOT NULL AND v_viewer_s IS NOT NULL THEN
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'user'
           AND p.owner_provider = v_viewer_p AND p.owner_subject = v_viewer_s
           AND (NOT p_require_enabled OR p.enabled);
        IF v_id IS NOT NULL THEN
            RETURN v_id;
        END IF;
    END IF;

    SELECT p.package_id INTO v_id FROM ${s}.agent_packages p
     WHERE p.name = p_name AND p.scope = 'shared'
       AND (NOT p_require_enabled OR p.enabled);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ── Mutations: every one now takes a selector ────────────────────
--
-- Dropped first because the argument lists grew; CREATE OR REPLACE would
-- leave the old arity behind as a live overload, and a caller that missed
-- the update would silently keep hitting the name-only version.
DROP FUNCTION IF EXISTS ${s}.cms_agent_package_authz(TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_set_agent_package_scope(TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_set_agent_package_enabled(TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_pin_agent_package_version(TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_delete_agent_package(TEXT, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION ${s}.cms_agent_package_authz(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS ${s}.agent_packages AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_id  TEXT;
    v_count INT;
BEGIN
    -- require_enabled = FALSE: a disabled copy must still be reachable, or
    -- disabling one would be irreversible.
    v_id := ${s}.cms_resolve_agent_package_id(
        p_name, p_actor_provider, p_actor_subject,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, FALSE);

    -- ADMIN FALLBACK, and it is load-bearing rather than a convenience.
    --
    -- Ordinary resolution walks "my copy, then shared", which is right for a
    -- user: a name they do not own and that is not shared genuinely does not
    -- exist in their namespace. But that rule would strand two real classes
    -- of row with no owner triple to select them by:
    --
    --   * NULL-owner packages, which pre-date owner stamping or were minted
    --     by an admin in a no-auth deployment;
    --   * another user's private package, which an admin must still be able
    --     to disable or delete during an incident.
    --
    -- Without this they would be invisible AND undeletable after 0043 — a
    -- migration that quietly orphans existing data. Ambiguity is refused
    -- rather than guessed: if several copies share the name, the admin has
    -- to say which one.
    IF v_id IS NULL AND p_is_admin AND p_sel_scope IS NULL THEN
        SELECT count(*) INTO v_count FROM ${s}.agent_packages p WHERE p.name = p_name;
        IF v_count > 1 THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_AMBIGUOUS: % copies of "%" exist; name an owner or scope to pick one', v_count, p_name;
        END IF;
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p WHERE p.name = p_name;
    END IF;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
    END IF;

    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id = v_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
    END IF;

    IF NOT p_is_admin AND (
        v_pkg.owner_provider IS NULL
        OR v_pkg.owner_provider IS DISTINCT FROM NULLIF(BTRIM(p_actor_provider), '')
        OR v_pkg.owner_subject IS DISTINCT FROM NULLIF(BTRIM(p_actor_subject), '')
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can modify "%"', p_name;
    END IF;
    RETURN v_pkg;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_scope(
    p_name TEXT, p_scope TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_clash TEXT;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);

    IF p_scope = 'shared' AND v_pkg.scope <> 'shared' THEN
        -- Promotion is exclusive: shared is the one namespace still globally
        -- unique, so refuse with a legible error rather than letting the
        -- partial unique index raise a raw constraint violation.
        SELECT p.package_id INTO v_clash FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'shared';
        IF v_clash IS NOT NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NAME_TAKEN: a shared package named "%" already exists; rename before promoting', p_name;
        END IF;
    END IF;

    IF p_scope = 'user' AND v_pkg.scope <> 'user' THEN
        -- Demotion needs an owner to land on, and must not collide with a
        -- copy that owner already has.
        IF v_pkg.owner_provider IS NULL OR v_pkg.owner_subject IS NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NO_OWNER: "%" has no owner identity to demote to', p_name;
        END IF;
        SELECT p.package_id INTO v_clash FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'user'
           AND p.owner_provider = v_pkg.owner_provider
           AND p.owner_subject = v_pkg.owner_subject;
        IF v_clash IS NOT NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NAME_TAKEN: that owner already has a user-scope package named "%"', p_name;
        END IF;
    END IF;

    UPDATE ${s}.agent_packages SET scope = p_scope WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_enabled(
    p_name TEXT, p_enabled BOOLEAN, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);
    UPDATE ${s}.agent_packages SET enabled = p_enabled WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_pin_agent_package_version(
    p_name TEXT, p_semver TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_version_id TEXT;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);
    SELECT version_id INTO v_version_id FROM ${s}.agent_package_versions
     WHERE package_id = v_pkg.package_id AND semver = p_semver;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_VERSION_NOT_FOUND: %@% is not a published version', p_name, p_semver;
    END IF;
    UPDATE ${s}.agent_packages SET active_version_id = v_version_id WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_delete_agent_package(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(artifact_filename TEXT) AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);
    RETURN QUERY
        SELECT v.artifact_filename FROM ${s}.agent_package_versions v
         WHERE v.package_id = v_pkg.package_id;
    DELETE FROM ${s}.agent_packages WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- ── Publish: locks the (name, scope, owner) row, not the name ────
--
-- The scope-mismatch error from 0038 is deliberately GONE. Publishing
-- \`user\` when a \`shared\` package holds the name is no longer a conflict —
-- it is exactly how a user takes a personal copy of a shared package, which
-- is the headline feature of this migration.
DROP FUNCTION IF EXISTS ${s}.cms_publish_agent_package(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, JSONB, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION ${s}.cms_publish_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_name TEXT, p_scope TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT, p_source_id TEXT,
    p_semver TEXT, p_sha256 TEXT, p_size_bytes BIGINT, p_artifact_filename TEXT,
    p_commit_sha TEXT, p_manifest JSONB, p_created_by TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(status TEXT, package_id TEXT, version_id TEXT) AS $$
DECLARE
    v_pkg RECORD;
    v_ver RECORD;
    v_owner_provider TEXT := NULLIF(BTRIM(p_owner_provider), '');
    v_owner_subject  TEXT := NULLIF(BTRIM(p_owner_subject), '');

BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;

    -- The "__" prefix is reserved for platform sentinels (\`__shared\`, and
    -- whatever comes later). Enforced HERE, in the database, because it is the
    -- one gate every publish path goes through — CLI push, portal upload and
    -- the manager's own import all land on this function. A TypeScript-only
    -- check would be one forgotten caller away from letting somebody mint a
    -- package that captures every reference meaning "the deployment's copy".
    IF LOWER(BTRIM(p_name)) LIKE '\\_\\_%' THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_RESERVED_NAME: "%" uses the reserved "__" prefix', p_name;
    END IF;

    -- An owner-less publish is admin-only: a NULL-owner package would be
    -- unmanageable by its (anonymous) creator afterwards.
    IF NOT p_is_admin AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: publishing without an owner identity requires the admin role';
    END IF;

    <<retry>>
    LOOP
        SELECT * INTO v_pkg FROM ${s}.agent_packages p
         WHERE p.name = p_name
           AND p.scope = p_scope
           AND (p_scope = 'shared'
                OR (p.owner_provider IS NOT DISTINCT FROM v_owner_provider
                    AND p.owner_subject IS NOT DISTINCT FROM v_owner_subject))
         FOR UPDATE;
        IF NOT FOUND THEN
            -- FOR UPDATE on a missing row takes no lock, so a concurrent first
            -- publish can beat this INSERT — catch the unique violation and
            -- loop back to lock the winner's row.
            BEGIN
                INSERT INTO ${s}.agent_packages
                    (package_id, source_id, name, scope, owner_provider, owner_subject, created_by)
                VALUES (p_package_id, p_source_id, p_name, p_scope,
                        v_owner_provider, v_owner_subject, p_created_by);
            EXCEPTION WHEN unique_violation THEN
                CONTINUE retry;
            END;
            INSERT INTO ${s}.agent_package_versions
                (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
            VALUES (p_version_id, p_package_id, p_semver, p_sha256, p_size_bytes,
                    p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
            UPDATE ${s}.agent_packages SET active_version_id = p_version_id WHERE ${s}.agent_packages.package_id = p_package_id;
            PERFORM ${s}.cms_agent_registry_bump();
            RETURN QUERY SELECT 'published'::TEXT, p_package_id, p_version_id;
            RETURN;
        END IF;
        EXIT retry;
    END LOOP;

    IF NOT p_is_admin AND (
        v_pkg.owner_provider IS NULL
        OR v_pkg.owner_provider IS DISTINCT FROM v_owner_provider
        OR v_pkg.owner_subject IS DISTINCT FROM v_owner_subject
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can publish new versions of "%"', p_name;
    END IF;

    SELECT * INTO v_ver FROM ${s}.agent_package_versions v
     WHERE v.package_id = v_pkg.package_id AND v.semver = p_semver;
    IF FOUND THEN
        IF v_ver.sha256 = p_sha256 THEN
            RETURN QUERY SELECT 'noop'::TEXT, v_pkg.package_id, v_ver.version_id;
            RETURN;
        END IF;
        RAISE EXCEPTION 'AGENT_PACKAGE_SEMVER_CONFLICT: %@% is already published with different content — published versions are immutable, bump the version', p_name, p_semver;
    END IF;

    INSERT INTO ${s}.agent_package_versions
        (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
    VALUES (p_version_id, v_pkg.package_id, p_semver, p_sha256, p_size_bytes,
            p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
    UPDATE ${s}.agent_packages
       SET active_version_id = p_version_id,
           source_id = COALESCE(p_source_id, ${s}.agent_packages.source_id)
     WHERE ${s}.agent_packages.package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
    RETURN QUERY SELECT 'published'::TEXT, v_pkg.package_id, p_version_id;
END;
$$ LANGUAGE plpgsql;

-- ── Reads: a name can now legitimately return two rows ───────────
--
-- \`shadowed\` tells a UI that this shared package is currently overridden by
-- the viewer's own copy, which is the difference between "you have two
-- packages" and "you have one package with a fallback".
DROP FUNCTION IF EXISTS ${s}.cms_list_agent_packages(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_get_agent_package(TEXT, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_packages(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, semver TEXT, sha256 TEXT, size_bytes BIGINT,
    artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT,
    shadowed BOOLEAN
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by,
           (p.scope = 'shared' AND EXISTS (
                SELECT 1 FROM ${s}.agent_packages o
                 WHERE o.name = p.name AND o.scope = 'user' AND o.enabled
                   AND o.owner_provider = BTRIM(p_viewer_provider)
                   AND o.owner_subject  = BTRIM(p_viewer_subject)
           )) AS shadowed
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.scope = 'shared'
        OR p_is_admin
        OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
     ORDER BY p.name, p.scope, p.owner_provider, p.owner_subject;
$$ LANGUAGE sql;

-- Selector-aware single read. With no selector it returns the copy the viewer
-- would actually GET, which is what makes "show me package X" agree with
-- "run agent from package X".
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, version_id TEXT, semver TEXT, sha256 TEXT,
    size_bytes BIGINT, artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT
) AS $$
DECLARE
    v_id TEXT;
    v_count INT;
BEGIN
    -- Two-pass on purpose. A read should answer "which copy do I actually
    -- GET", and shadowing is enable-sensitive — so try the live-resolution
    -- rule first (enabled only). Falling back to the disabled row second
    -- means a package whose ONLY copy is disabled is still inspectable;
    -- without that, disabling your one copy would make it invisible as well
    -- as inert, and there would be no way back through this API.
    v_id := ${s}.cms_resolve_agent_package_id(
        p_name, p_viewer_provider, p_viewer_subject,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, TRUE);
    IF v_id IS NULL THEN
        v_id := ${s}.cms_resolve_agent_package_id(
            p_name, p_viewer_provider, p_viewer_subject,
            p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, FALSE);
    END IF;

    -- Same admin fallback the mutation path uses, and for the same reason:
    -- an admin must be able to READ the row they are allowed to delete.
    -- Keeping the two in step matters more than the duplication — a package
    -- an admin can destroy but cannot inspect is the worse outcome.
    IF v_id IS NULL AND p_is_admin AND p_sel_scope IS NULL THEN
        SELECT count(*) INTO v_count FROM ${s}.agent_packages p WHERE p.name = p_name;
        IF v_count = 1 THEN
            SELECT p.package_id INTO v_id FROM ${s}.agent_packages p WHERE p.name = p_name;
        END IF;
    END IF;

    IF v_id IS NULL THEN
        RETURN;
    END IF;

    -- Re-apply the visibility rule against the RESOLVED row. The resolver is
    -- about which copy a name means, never about whether you may see it —
    -- keeping those separate is what stops a selector from being a way to
    -- read someone else's private package by naming their owner triple.
    RETURN QUERY
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at, p.active_version_id,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.package_id = p.package_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.package_id = v_id
       AND (p.scope = 'shared' OR p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject)))
     ORDER BY v.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── Install manifest: carries package_id so disk keys stay unique ─
DROP FUNCTION IF EXISTS ${s}.cms_get_agent_packages_install_manifest();

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_install_manifest()
RETURNS TABLE(
    package_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB
) AS $$
    SELECT p.package_id, p.name, p.scope, p.owner_provider, p.owner_subject,
           v.semver, v.sha256, v.size_bytes, v.artifact_filename, v.manifest
      FROM ${s}.agent_packages p
      JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
     WHERE p.enabled
     ORDER BY p.name, p.scope, p.owner_provider, p.owner_subject;
$$ LANGUAGE sql;
`;
}


/**
 * 0045 — session_canvases: one row per (session, slot).
 *
 * The canvas revision has always been DERIVED from the session.canvas_updated
 * event log by scanning a small trailing window. With one canvas per session
 * that window always contained the latest rev; with five interleaved slots it
 * does not — slot 2's latest draw falls outside the window after slot 1 draws
 * a few times. This table is the per-slot authority-cache: written on every
 * draw, read for the next rev, and joinable from the sessions list so a row
 * can say "this session has canvases" without replaying events.
 *
 * The event log REMAINS the durable source; a missed upsert self-heals on the
 * next draw via the event-scan fallback. Backfill seeds slot 1 (and any slot
 * already present in event data) from the latest valid event per slot.
 */
function migration_0045_session_canvases(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.session_canvases (
    session_id  TEXT     NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    slot        SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 5),
    name        TEXT     NOT NULL DEFAULT '',
    latest_rev  INTEGER  NOT NULL DEFAULT 0,
    size_bytes  INTEGER,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, slot)
);

INSERT INTO ${s}.session_canvases (session_id, slot, name, latest_rev, size_bytes, updated_at)
SELECT e.session_id,
       e.slot,
       COALESCE(e.data->>'name', ''),
       (e.data->>'rev')::int,
       NULLIF(e.data->>'sizeBytes', '')::int,
       e.created_at
FROM (
    SELECT DISTINCT ON (session_id, COALESCE(NULLIF(data->>'slot', '')::smallint, 1))
           session_id,
           COALESCE(NULLIF(data->>'slot', '')::smallint, 1) AS slot,
           data,
           created_at
    FROM ${s}.session_events
    WHERE event_type = 'session.canvas_updated'
      AND (data->>'rev') ~ '^[0-9]+$'
      AND COALESCE(NULLIF(data->>'slot', ''), '1') ~ '^[1-5]$'
    ORDER BY session_id,
             COALESCE(NULLIF(data->>'slot', '')::smallint, 1),
             (data->>'rev')::int DESC
) e
WHERE EXISTS (SELECT 1 FROM ${s}.sessions ss WHERE ss.session_id = e.session_id)
ON CONFLICT (session_id, slot) DO NOTHING;
`;
}

/**
 * 0046 — delete only ORPHANED blobs, never a still-referenced one.
 *
 * Package blob files are content-addressed: the filename is
 * `name@semver.sha`, with no scope or owner in it. So a shared package and a
 * user-scope copy that carry identical bytes — the normal result of testing a
 * version privately then publishing it to shared, or two users publishing the
 * same package — reference the SAME blob file. The 0043 delete proc returned
 * every filename of the deleted package's versions, and the caller deleted
 * each blob. Deleting one copy therefore destroyed the OTHER copy's bytes:
 * its active version pointed at a now-missing blob, and every worker
 * quarantined it fleet-wide on the next install.
 *
 * This redefinition returns only filenames that NO surviving version row
 * still references — computed after the cascade, so "surviving" already
 * excludes the deleted package. A shared blob is kept; a genuinely orphaned
 * one is returned for cleanup. CREATE OR REPLACE, no table lock.
 */
function migration_0046_agent_package_delete_blob_refcount(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_delete_agent_package(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(artifact_filename TEXT) AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_filenames TEXT[];
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);

    -- Capture this package's blob filenames BEFORE the cascade removes its
    -- version rows.
    SELECT array_agg(DISTINCT v.artifact_filename) INTO v_filenames
      FROM ${s}.agent_package_versions v
     WHERE v.package_id = v_pkg.package_id;

    DELETE FROM ${s}.agent_packages WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();

    -- Return only blobs no SURVIVING version references — never a file a
    -- same-bytes copy in the other scope still points at.
    RETURN QUERY
        SELECT fn FROM unnest(COALESCE(v_filenames, ARRAY[]::TEXT[])) AS fn
         WHERE NOT EXISTS (
             SELECT 1 FROM ${s}.agent_package_versions v2
              WHERE v2.artifact_filename = fn
         );
END;
$$ LANGUAGE plpgsql;
`;
}

/**
 * 0047 — the canvas data plane: canvas_live + jsonb_merge_patch.
 *
 * One UNLOGGED row per (session, slot) holding the LATEST canvas state:
 * the last data tick (merged whole state) and the current document pointer.
 * update_canvas ticks stop being durable events — they overwrite this row
 * and NOTIFY; the relay LISTENs and fans out. UNLOGGED is deliberate:
 * no WAL cost, survives relay restarts, truncated only on a PG crash —
 * and ticks are whole-state, so the next tick heals the surface.
 *
 * doc_rev/doc_sha and payload are SEPARATE columns: a redraw must not wipe
 * the data mirror's shape, and the subscribe-time burst needs both. A draw
 * DOES reset payload to {} — the new document starts from its own initial
 * state and the stale mirror of the old page must not replay into it.
 *
 * jsonb_merge_patch is RFC 7386: objects deep-merge, null DELETES a key,
 * arrays and scalars replace. plpgsql (not sql) so recursion is legal.
 * The merge runs inside the UPSERT's DO UPDATE against the LOCKED row —
 * concurrent patches serialize on the row lock and compose instead of
 * clobbering.
 */
function migration_0047_canvas_live_plane(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE UNLOGGED TABLE IF NOT EXISTS ${s}.canvas_live (
    session_id  TEXT     NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    slot        SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 5),
    seq         BIGINT   NOT NULL DEFAULT 1,
    doc_rev     INTEGER  NOT NULL DEFAULT 0,
    doc_sha     TEXT     NOT NULL DEFAULT '',
    payload     JSONB    NOT NULL DEFAULT '{}'::jsonb,
    updated_by  TEXT     NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, slot)
);

CREATE OR REPLACE FUNCTION ${s}.jsonb_merge_patch(target JSONB, patch JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    result JSONB;
    k TEXT;
    v JSONB;
BEGIN
    -- RFC 7386: a non-object patch replaces the target wholesale.
    IF patch IS NULL OR jsonb_typeof(patch) <> 'object' THEN
        RETURN COALESCE(patch, 'null'::jsonb);
    END IF;
    result := CASE
        WHEN target IS NOT NULL AND jsonb_typeof(target) = 'object' THEN target
        ELSE '{}'::jsonb
    END;
    FOR k, v IN SELECT key, value FROM jsonb_each(patch) LOOP
        IF jsonb_typeof(v) = 'null' THEN
            result := result - k;
        ELSIF jsonb_typeof(v) = 'object' THEN
            result := jsonb_set(result, ARRAY[k], ${s}.jsonb_merge_patch(result -> k, v), true);
        ELSE
            result := jsonb_set(result, ARRAY[k], v, true);
        END IF;
    END LOOP;
    RETURN result;
END
$fn$;
`;
}

/**
 * 0048 — canvas share links: ONE live view token per (session, slot).
 *
 * "Anyone with link can view": the URL carries a random capability token;
 * this table stores its HASH. Exactly one row per canvas — minting again
 * (reset) replaces the row and the old link dies the moment the new one
 * exists; remove deletes the row. Token bearers are validated by hash
 * lookup at exactly two doors (the canvas WS subscribe and the share doc
 * fetch) and hold no other capability. Durable (NOT unlogged): a link
 * must survive restarts and failovers.
 */
function migration_0048_canvas_share_links(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.canvas_share_links (
    session_id  TEXT     NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    slot        SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 5),
    token_hash  TEXT     NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT     NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, slot)
);

CREATE UNIQUE INDEX IF NOT EXISTS canvas_share_links_token_hash
    ON ${s}.canvas_share_links (token_hash);
`;
}

/**
 * 0049 — provider budgets. See docs/proposals/providers-and-budgets.md.
 *
 * A PROVIDER is a credential with a budget policy, and it is the only object:
 * shared (admin-made, anyone may spend, carries a per-person allowance) or
 * personal (user-made, owner-only). A session runs `provider:model` and is
 * charged to that provider. There are no pools, no payers, no grants and no
 * fallbacks — resolution scope is the whole access story: for user U the
 * namespace is every shared provider plus U's own, and another user's
 * personal provider is indistinguishable from a name that was never created.
 *
 * Three properties this schema is built around:
 *
 * 1. EXACTLY-ONCE ACCOUNTING. provider_usage_ledger PK (session_id,
 *    turn_index) is the claim: counters move only when the ledger row is
 *    first inserted, so an activity retry cannot double-charge.
 *
 * 2. HISTORY OUTLIVES THE PROVIDER. The ledger stores provider_name as a
 *    plain string with NO foreign key. Deleting a provider (a hard DELETE —
 *    a provider is there or not there, there is no retired state) cascades
 *    its rules and counters and leaves every past row intact; re-creating
 *    the name later reports under the one name.
 *
 * 3. WINDOWS ARE PLAIN UTC CALENDAR WINDOWS. Day = midnight UTC, week =
 *    Monday 00:00 UTC (date_trunc('week') is Monday-based), month = the 1st.
 *    There are no anchors, which is what keeps this pinned to
 *    quota-windows.ts by arithmetic rather than by hope. date_trunc is
 *    always applied to a UTC-projected PLAIN timestamp: date_trunc on a
 *    timestamptz truncates in the SESSION timezone, which would move every
 *    boundary on a connection whose TimeZone is not UTC.
 */
function migration_0049_provider_budgets(schema: string): string {
    const s = `"${schema}"`;
    return `
-- ── tables ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ${s}.provider_instances (
    name            TEXT PRIMARY KEY,
    type_id         TEXT NOT NULL,
    class           TEXT NOT NULL CHECK (class IN ('shared','personal')),
    owner_user_id   BIGINT REFERENCES ${s}.users(user_id) ON DELETE CASCADE,
    secret_ref      JSONB NOT NULL DEFAULT '{}'::jsonb,
    base_url        TEXT,
    allowance_pct   SMALLINT NOT NULL DEFAULT 100 CHECK (allowance_pct BETWEEN 1 AND 100),
    hold_until_utc  TIMESTAMPTZ,
    hold_indefinite BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A shared provider has no owner; a personal one always has one.
    CONSTRAINT provider_instances_owner_matches_class CHECK (
        (class = 'shared'   AND owner_user_id IS NULL) OR
        (class = 'personal' AND owner_user_id IS NOT NULL)),
    -- An allowance divides a shared budget between people. A personal
    -- provider has exactly one person, so there is nothing to divide.
    CONSTRAINT provider_instances_allowance_shared_only CHECK (
        class = 'shared' OR allowance_pct = 100),
    -- No colon: a model reference is 'provider:model' and splits on the
    -- first one, so a colon in a name would make references ambiguous.
    CONSTRAINT provider_instances_name_shape CHECK (
        name ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS provider_instances_owner
    ON ${s}.provider_instances (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.provider_budget_rules (
    rule_id         TEXT PRIMARY KEY,
    provider_name   TEXT NOT NULL REFERENCES ${s}.provider_instances(name) ON DELETE CASCADE,
    period          TEXT NOT NULL CHECK (period IN ('day','week','month')),
    model_qualified TEXT,
    limit_tokens    BIGINT NOT NULL CHECK (limit_tokens > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One limit per (period, scope). An overall limit and a per-model limit are
-- different scopes and coexist; saving the same combination replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_rules_scope
    ON ${s}.provider_budget_rules (provider_name, period, COALESCE(model_qualified, '*'));

CREATE TABLE IF NOT EXISTS ${s}.provider_quota_counters (
    rule_id          TEXT NOT NULL REFERENCES ${s}.provider_budget_rules(rule_id) ON DELETE CASCADE,
    window_key_utc   TEXT NOT NULL,
    used_tokens      BIGINT NOT NULL DEFAULT 0,
    window_start_utc TIMESTAMPTZ NOT NULL,
    resets_at_utc    TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, window_key_utc)
);

-- The allowance's per-person mirror. Maintained for EVERY rule, not only
-- those under a reduced allowance, so changing an allowance never needs a
-- ledger scan to discover what each person had already spent.
CREATE TABLE IF NOT EXISTS ${s}.provider_quota_counters_user (
    rule_id          TEXT NOT NULL REFERENCES ${s}.provider_budget_rules(rule_id) ON DELETE CASCADE,
    user_id          BIGINT NOT NULL,
    window_key_utc   TEXT NOT NULL,
    used_tokens      BIGINT NOT NULL DEFAULT 0,
    window_start_utc TIMESTAMPTZ NOT NULL,
    resets_at_utc    TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, user_id, window_key_utc)
);

CREATE TABLE IF NOT EXISTS ${s}.provider_usage_ledger (
    session_id         TEXT    NOT NULL,
    turn_index         INTEGER NOT NULL,
    provider_name      TEXT,
    model_qualified    TEXT,
    owner_user_id      BIGINT,
    charge_class       TEXT NOT NULL DEFAULT 'user'
                       CHECK (charge_class IN ('user','system','unattributed')),
    tokens_input       BIGINT NOT NULL DEFAULT 0,
    tokens_output      BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read  BIGINT NOT NULL DEFAULT 0,
    tokens_cache_write BIGINT NOT NULL DEFAULT 0,
    tokens_total       BIGINT NOT NULL DEFAULT 0,
    agent_id           TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS provider_usage_ledger_created
    ON ${s}.provider_usage_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS provider_usage_ledger_provider
    ON ${s}.provider_usage_ledger (provider_name, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_usage_ledger_owner
    ON ${s}.provider_usage_ledger (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ${s}.provider_cluster_settings (
    singleton         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    default_provider  TEXT,
    default_model     TEXT,
    default_reasoning TEXT,
    default_context   TEXT,
    bootstrapped_at   TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ${s}.provider_cluster_settings (singleton) VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING;

-- A person's default is a COLUMN, not a profile_settings key: the portal
-- replaces profile_settings wholesale on every preference save, which would
-- erase anything stored beside it.
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS default_provider  TEXT;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS default_model     TEXT;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS default_reasoning TEXT;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS default_context   TEXT;

ALTER TABLE ${s}.session_turn_metrics ADD COLUMN IF NOT EXISTS provider_name TEXT;
ALTER TABLE ${s}.session_turn_metrics ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;
ALTER TABLE ${s}.session_turn_metrics ADD COLUMN IF NOT EXISTS charge_class  TEXT;

-- The structured pause record. The paused-sessions reader reads THIS; it
-- never parses wait_reason prose, which is written for a human.
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS pause_state JSONB;

-- ── window bounds (parity-pinned to quota-windows.ts) ────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_window_bounds(
    p_kind TEXT, p_now TIMESTAMPTZ
) RETURNS TABLE(window_start TIMESTAMPTZ, resets_at TIMESTAMPTZ, window_key TEXT) AS $$
DECLARE
    v_now   TIMESTAMP := p_now AT TIME ZONE 'UTC';
    v_step  INTERVAL  := CASE p_kind WHEN 'day'  THEN interval '1 day'
                                     WHEN 'week' THEN interval '7 days'
                                     ELSE interval '1 month' END;
    v_start TIMESTAMP;
BEGIN
    IF p_kind NOT IN ('day','week','month') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: unknown period %', p_kind;
    END IF;
    v_start      := date_trunc(p_kind, v_now);
    window_start := v_start AT TIME ZONE 'UTC';
    resets_at    := (v_start + v_step) AT TIME ZONE 'UTC';
    window_key   := to_char(v_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── helpers ──────────────────────────────────────────────────────────

-- Principal → user_id, WITHOUT creating the row. cms_register_user is the
-- creating path; a read must not mint users as a side effect of looking.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_user_id(
    p_provider TEXT, p_subject TEXT
) RETURNS BIGINT AS $$
    SELECT u.user_id FROM ${s}.users u
     WHERE u.provider = p_provider AND u.subject = p_subject;
$$ LANGUAGE sql STABLE;

-- The namespace rule, in one place: every shared provider, plus the
-- viewer's own. A name outside it returns NO ROW — the same answer a name
-- that was never created gets, which is what makes another user's personal
-- provider indistinguishable from nonexistent.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_in_namespace(
    p_name TEXT, p_viewer BIGINT
) RETURNS TABLE(
    name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT,
    secret_ref JSONB, base_url TEXT, allowance_pct SMALLINT,
    hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN
) AS $$
    SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id,
           pi.secret_ref, pi.base_url, pi.allowance_pct,
           pi.hold_until_utc, pi.hold_indefinite
      FROM ${s}.provider_instances pi
     WHERE pi.name = p_name
       AND (pi.class = 'shared'
            OR (p_viewer IS NOT NULL AND pi.owner_user_id = p_viewer));
$$ LANGUAGE sql STABLE;

-- The per-person ceiling. GREATEST(1, ...) so a tiny limit under a small
-- allowance still lets a first turn run: every pause in this system is
-- "the turn that crossed completed, the next one waits", and a zero
-- ceiling would be the one exception that blocks before any work at all.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_ceiling(
    p_limit BIGINT, p_pct SMALLINT
) RETURNS BIGINT AS $$
    -- Through numeric, not bigint. A limit near the top of bigint times a
    -- percentage overflows before the division brings it back down, and the
    -- error surfaces from the ADMISSION gate — which fails open — and from
    -- the status read, which then dies for every provider in the list, not
    -- just the one carrying the absurd number.
    SELECT GREATEST(1::BIGINT, ((p_limit::numeric * p_pct) / 100)::BIGINT);
$$ LANGUAGE sql IMMUTABLE;

-- Split a model reference. 'azure-prod:gpt-5.4' → ('azure-prod','gpt-5.4').
-- An unqualified reference has no provider and resolves to nothing: this
-- model requires every session to name the provider that pays for it.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_split_ref(
    p_ref TEXT
) RETURNS TABLE(provider_name TEXT, model_name TEXT) AS $$
    SELECT CASE WHEN position(':' in COALESCE(p_ref,'')) > 1
                THEN split_part(p_ref, ':', 1) END,
           CASE WHEN position(':' in COALESCE(p_ref,'')) > 1
                THEN substring(p_ref from position(':' in p_ref) + 1) END;
$$ LANGUAGE sql IMMUTABLE;
`;
}

/**
 * 0050 — the read/write surface over 0049's tables.
 *
 * AUTHORITY, in one sentence: a shared provider is managed by cluster
 * admins, a personal provider by its owner, and everything else is open.
 * There are no grants and no per-provider roles to consult.
 *
 * REFUSALS TELL YOU AS MUCH AS YOU CAN ALREADY SEE. A name outside your
 * namespace is PROVIDER_NOT_FOUND — the same words a typo gets, because
 * saying "forbidden" would confirm that someone else's personal provider
 * exists. A name you CAN see but may not manage is PROVIDER_FORBIDDEN,
 * which tells you nothing you did not already know.
 */
function migration_0050_provider_budget_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- ── management: providers ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_create(
    p_name TEXT, p_type_id TEXT, p_class TEXT, p_owner BIGINT,
    p_secret JSONB, p_base_url TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
DECLARE v_name TEXT := NULLIF(BTRIM(p_name), '');
BEGIN
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a provider needs a name';
    END IF;
    IF p_class NOT IN ('shared','personal') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: class must be shared or personal';
    END IF;
    IF p_class = 'shared' AND NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can add a shared provider';
    END IF;
    IF p_class = 'personal' AND p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to add a provider of your own';
    END IF;
    -- A personal provider belongs to the person MAKING it, never to whoever
    -- the caller names. p_owner is an argument, and an argument is a wish:
    -- honouring it let anyone plant a credential and a base_url inside
    -- someone else's namespace, where that person's sessions would resolve
    -- it and spend through it.
    IF p_class = 'personal' AND p_owner IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: a provider of your own is created in your own name';
    END IF;
    -- The name is the identity every session reference resolves through, so
    -- a collision is reported as a collision. It says a name is taken and
    -- nothing else: not the class, not the owner, not the type.
    IF EXISTS (SELECT 1 FROM ${s}.provider_instances pi WHERE pi.name = v_name) THEN
        RAISE EXCEPTION 'PROVIDER_CONFLICT: the name "%" is already taken', v_name;
    END IF;
    INSERT INTO ${s}.provider_instances
        (name, type_id, class, owner_user_id, secret_ref, base_url)
    VALUES (v_name, p_type_id, p_class,
            CASE WHEN p_class = 'personal' THEN p_actor END,
            COALESCE(p_secret, '{}'::jsonb), NULLIF(BTRIM(p_base_url), ''));
    RETURN QUERY SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id
                   FROM ${s}.provider_instances pi WHERE pi.name = v_name;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- May the actor manage this provider? Raises rather than returning false,
-- so every mutation gets the same refusal wording for free.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_assert_manage(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS ${s}.provider_instances AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;

    -- A personal provider answers to its owner and to NOBODY else — an
    -- administrator included. Being an administrator is authority over the
    -- cluster's own credentials, not over a credential someone brought from
    -- home: an admin who could set limits on, hold, or delete a person's own
    -- key would be reaching into a namespace the whole design says is
    -- theirs. It reads as absent, the same as any name outside a namespace,
    -- so this refusal cannot be used to discover that it exists either.
    IF v_row.class = 'personal' THEN
        IF p_actor IS NULL OR v_row.owner_user_id IS DISTINCT FROM p_actor THEN
            RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
        END IF;
        RETURN v_row;
    END IF;

    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: "%" is a shared provider; only an administrator can change it', p_name;
    END IF;
    RETURN v_row;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_delete(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE
    v_row ${s}.provider_instances;
    v_waiting BIGINT;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    -- Sessions naming it are not touched: they resolve nothing at their next
    -- turn and wait, which is the whole no-fallback rule. Report how many so
    -- the caller can say it.
    SELECT count(*) INTO v_waiting
      FROM ${s}.sessions ss
      CROSS JOIN LATERAL ${s}.cms_provider_split_ref(ss.model) sp
     WHERE ss.deleted_at IS NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND sp.provider_name = p_name;
    -- Rules and counters cascade. The ledger keeps its rows: provider_name
    -- there is a record of what happened, not a reference to a live row.
    DELETE FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    UPDATE ${s}.provider_cluster_settings SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL, updated_at = now()
     WHERE singleton AND default_provider = p_name;
    UPDATE ${s}.users u SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL
     WHERE u.default_provider = p_name;
    RETURN v_waiting;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── management: limits, allowance, holds ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_limit(
    p_name TEXT, p_period TEXT, p_model TEXT, p_tokens BIGINT,
    p_rule_id TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(rule_id TEXT, seeded_tokens BIGINT) AS $$
-- The OUT parameter rule_id would otherwise shadow the COLUMN of the same
-- name, and an ON CONFLICT target that resolves to a variable is rejected
-- as ambiguous. Inside this body a bare column name means the column.
#variable_conflict use_column
DECLARE
    v_model  TEXT := NULLIF(BTRIM(p_model), '');
    v_rule   TEXT;
    v_bounds RECORD;
    v_seed   BIGINT;
BEGIN
    PERFORM ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF p_period NOT IN ('day','week','month') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: period must be day, week or month';
    END IF;
    IF p_tokens IS NULL OR p_tokens <= 0 THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a limit must be a positive number of tokens';
    END IF;
    -- A limit scoped to one model matches the QUALIFIED reference a session
    -- runs, so a bare model name matches nothing — the limit saves, shows in
    -- the report as a live cap, and silently never fires. Refuse it and say
    -- what to write instead.
    IF v_model IS NOT NULL AND v_model NOT LIKE p_name || ':%' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a limit on one model names it as "%:<model>", not "%"', p_name, v_model;
    END IF;

    INSERT INTO ${s}.provider_budget_rules (rule_id, provider_name, period, model_qualified, limit_tokens)
    VALUES (p_rule_id, p_name, p_period, v_model, p_tokens)
    ON CONFLICT (provider_name, period, COALESCE(model_qualified, '*'))
    DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens, updated_at = now()
    RETURNING ${s}.provider_budget_rules.rule_id INTO v_rule;

    -- A new limit counts from what this window has ALREADY spent; it does
    -- not hand out a fresh allocation. The count is re-derived from the
    -- ledger rather than carried forward, which makes saving a limit twice
    -- idempotent.
    --
    -- ORDER MATTERS, and this is the whole reason the counter rows are
    -- claimed before the sum is taken. Re-deriving is a read followed by a
    -- write, and a turn that settles between the two used to have its charge
    -- ASSIGNED away — the settle incremented a row, then this UPDATE
    -- overwrote it with a total computed before that increment existed. A
    -- provider then ran past a hard cap with the gate still answering
    -- 'clear', and the two counters disagreed for the rest of the window.
    -- Claiming the rows first makes a concurrent settle either commit ahead
    -- of the sum (and be counted) or block until after it (and add on top).
    SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(p_period, now());

    INSERT INTO ${s}.provider_quota_counters
        (rule_id, window_key_utc, used_tokens, window_start_utc, resets_at_utc)
    VALUES (v_rule, v_bounds.window_key, 0, v_bounds.window_start, v_bounds.resets_at)
    ON CONFLICT (rule_id, window_key_utc) DO UPDATE SET updated_at = now();

    -- Only this provider's OWN history. The ledger keeps a name, not a
    -- reference, so a name that was deleted and made again would otherwise
    -- inherit the spend of the provider that used to hold it — and be born
    -- at a limit it never spent a token against. Its own creation instant is
    -- the line between the two.
    SELECT COALESCE(sum(l.tokens_total), 0) INTO v_seed
      FROM ${s}.provider_usage_ledger l
      JOIN ${s}.provider_instances pi ON pi.name = p_name
     WHERE l.provider_name = p_name
       AND l.charge_class = 'user'
       AND (v_model IS NULL OR l.model_qualified = v_model)
       AND l.created_at >= GREATEST(v_bounds.window_start, pi.created_at)
       AND l.created_at <  v_bounds.resets_at;

    UPDATE ${s}.provider_quota_counters c
       SET used_tokens = v_seed, updated_at = now()
     WHERE c.rule_id = v_rule AND c.window_key_utc = v_bounds.window_key;

    -- The per-person mirror, same reasoning: claim every row that could be
    -- touched, then recompute. A person with no spend this window gets no
    -- row, which reads as zero.
    INSERT INTO ${s}.provider_quota_counters_user
        (rule_id, user_id, window_key_utc, used_tokens, window_start_utc, resets_at_utc)
    SELECT v_rule, l.owner_user_id, v_bounds.window_key, 0,
           v_bounds.window_start, v_bounds.resets_at
      FROM ${s}.provider_usage_ledger l
      JOIN ${s}.provider_instances pi ON pi.name = p_name
     WHERE l.provider_name = p_name
       AND l.charge_class = 'user'
       AND l.owner_user_id IS NOT NULL
       AND (v_model IS NULL OR l.model_qualified = v_model)
       AND l.created_at >= GREATEST(v_bounds.window_start, pi.created_at)
       AND l.created_at <  v_bounds.resets_at
     GROUP BY l.owner_user_id
    ON CONFLICT (rule_id, user_id, window_key_utc) DO UPDATE SET updated_at = now();

    UPDATE ${s}.provider_quota_counters_user cu
       SET used_tokens = agg.total, updated_at = now()
      FROM (
        SELECT l.owner_user_id AS uid, COALESCE(sum(l.tokens_total), 0) AS total
          FROM ${s}.provider_usage_ledger l
          JOIN ${s}.provider_instances pi ON pi.name = p_name
         WHERE l.provider_name = p_name
           AND l.charge_class = 'user'
           AND l.owner_user_id IS NOT NULL
           AND (v_model IS NULL OR l.model_qualified = v_model)
           AND l.created_at >= GREATEST(v_bounds.window_start, pi.created_at)
           AND l.created_at <  v_bounds.resets_at
         GROUP BY l.owner_user_id
      ) agg
     WHERE cu.rule_id = v_rule AND cu.window_key_utc = v_bounds.window_key
       AND cu.user_id = agg.uid;

    RETURN QUERY SELECT v_rule, v_seed;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_remove_limit(
    p_name TEXT, p_period TEXT, p_model TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE v_deleted INTEGER;
BEGIN
    PERFORM ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    -- Without this a mistyped period answered "nothing was there" while the
    -- limit it meant to remove stayed in force.
    IF p_period NOT IN ('day','week','month') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: period must be day, week or month';
    END IF;
    DELETE FROM ${s}.provider_budget_rules r
     WHERE r.provider_name = p_name AND r.period = p_period
       AND COALESCE(r.model_qualified, '*') = COALESCE(NULLIF(BTRIM(p_model), ''), '*');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_allowance(
    p_name TEXT, p_pct SMALLINT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS SMALLINT AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF v_row.class <> 'shared' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: "%" is your own provider; an allowance divides a shared budget between people', p_name;
    END IF;
    IF p_pct IS NULL OR p_pct < 1 OR p_pct > 100 THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: an allowance is a percentage between 1 and 100';
    END IF;
    UPDATE ${s}.provider_instances pi
       SET allowance_pct = p_pct, updated_at = now()
     WHERE pi.name = p_name;
    RETURN p_pct;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_hold(
    p_name TEXT, p_until TIMESTAMPTZ, p_indefinite BOOLEAN,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
BEGIN
    PERFORM ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    UPDATE ${s}.provider_instances pi
       SET hold_until_utc = p_until,
           hold_indefinite = COALESCE(p_indefinite, FALSE),
           updated_at = now()
     WHERE pi.name = p_name;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── defaults ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_cluster_default(
    p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can set the cluster default';
    END IF;
    -- Both halves or neither. A tuple with a provider and no model is not a
    -- default anybody can start a session from, and reporting success for it
    -- left the caller believing something had been set.
    IF NULLIF(BTRIM(COALESCE(p_provider, '')), '') IS NULL
       OR NULLIF(BTRIM(COALESCE(p_model, '')), '') IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the cluster default needs a provider and a model';
    END IF;
    SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = p_provider;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_provider;
    END IF;
    -- The cluster default is what system sessions run on. Machinery on one
    -- person's own credential would stop the moment they removed it.
    IF v_row.class <> 'shared' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the cluster default must be a shared provider';
    END IF;
    -- Both halves must agree. A session runs the MODEL reference, so a tuple
    -- naming a shared provider beside somebody's personal model reference
    -- would put the machinery on a private credential — through the half
    -- nobody was checking.
    IF p_model NOT LIKE p_provider || ':%' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the model must belong to "%": write it as "%:<model>"', p_provider, p_provider;
    END IF;
    UPDATE ${s}.provider_cluster_settings
       SET default_provider = p_provider, default_model = p_model,
           default_reasoning = NULLIF(BTRIM(COALESCE(p_reasoning, '')), ''),
           default_context = NULLIF(BTRIM(COALESCE(p_context, '')), ''),
           updated_at = now()
     WHERE singleton;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_user_default(
    p_actor BIGINT, p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT
) RETURNS BOOLEAN AS $$
DECLARE v_name TEXT := NULLIF(BTRIM(COALESCE(p_provider, '')), '');
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to set a default';
    END IF;
    IF v_name IS NOT NULL THEN
        -- Your default must be something you can actually run.
        IF NOT EXISTS (SELECT 1 FROM ${s}.cms_provider_in_namespace(v_name, p_actor)) THEN
            RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', v_name;
        END IF;
        IF NULLIF(BTRIM(COALESCE(p_model, '')), '') IS NULL THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: a default needs a provider and a model';
        END IF;
        IF p_model NOT LIKE v_name || ':%' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the model must belong to "%": write it as "%:<model>"', v_name, v_name;
        END IF;
    END IF;
    UPDATE ${s}.users u
       SET default_provider = v_name,
           default_model = CASE WHEN v_name IS NULL THEN NULL ELSE p_model END,
           default_reasoning = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_reasoning, '')), '') END,
           default_context = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_context, '')), '') END
     WHERE u.user_id = p_actor;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_get_defaults(
    p_actor BIGINT
) RETURNS TABLE(
    cluster_provider TEXT, cluster_model TEXT, cluster_reasoning TEXT, cluster_context TEXT,
    my_provider TEXT, my_model TEXT, my_reasoning TEXT, my_context TEXT
) AS $$
    SELECT c.default_provider, c.default_model, c.default_reasoning, c.default_context,
           u.default_provider, u.default_model, u.default_reasoning, u.default_context
      FROM ${s}.provider_cluster_settings c
      LEFT JOIN ${s}.users u ON u.user_id = p_actor
     WHERE c.singleton;
$$ LANGUAGE sql STABLE;

-- ── bootstrap: the one-time deployment seed ──────────────────────────
-- Claims the flag atomically, so several fresh pods racing at first boot
-- seed exactly once. After the claim the declaration is never read again:
-- an administrator who deletes a seeded provider has deleted it, and no
-- restart brings it back.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_bootstrap(
    p_instances JSONB, p_default JSONB
) RETURNS TABLE(claimed BOOLEAN, created INTEGER) AS $$
DECLARE
    v_claimed BOOLEAN := FALSE;
    v_created INTEGER := 0;
    v_item    JSONB;
BEGIN
    UPDATE ${s}.provider_cluster_settings
       SET bootstrapped_at = now(), updated_at = now()
     WHERE singleton AND bootstrapped_at IS NULL;
    GET DIAGNOSTICS v_created = ROW_COUNT;
    v_claimed := v_created > 0;
    v_created := 0;
    IF NOT v_claimed THEN
        RETURN QUERY SELECT FALSE, 0;
        RETURN;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_instances, '[]'::jsonb)) LOOP
        BEGIN
            PERFORM ${s}.cms_provider_create(
                v_item->>'name', v_item->>'typeId', 'shared', NULL,
                COALESCE(v_item->'secretRef', '{}'::jsonb), v_item->>'baseUrl',
                NULL, TRUE);
            v_created := v_created + 1;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'provider bootstrap skipped %: %', v_item->>'name', SQLERRM;
        END;
    END LOOP;

    -- The default is NOT best-effort. It names what system sessions run, and
    -- a cluster that seeded without one has no machinery and no fallback for
    -- anybody who never set a default of their own. Raising rolls back the
    -- claim along with everything else, so the next pod to boot tries again
    -- and the operator sees the same loud error until the file is fixed —
    -- which is the opposite of the quiet, permanent half-seeded cluster a
    -- swallowed error leaves behind.
    IF p_default IS NOT NULL AND p_default->>'provider' IS NOT NULL THEN
        PERFORM ${s}.cms_provider_set_cluster_default(
            p_default->>'provider', p_default->>'model',
            p_default->>'reasoning', p_default->>'context', TRUE);
    END IF;

    RETURN QUERY SELECT TRUE, v_created;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}


/**
 * 0052 — a pause record is a snapshot, so check it before reporting it.
 *
 * `sessions.pause_state` is written by the admission gate and cleared by the
 * same gate on the session's next turn. That makes it a CACHE of a decision,
 * and it is only as fresh as the session is busy. Release a hold on a session
 * that is slow, stopped, or waiting on a durable timer and the record sits
 * there unchanged — so the surface keeps naming a cause that no longer
 * exists, and the very action taken to fix it appears to have done nothing.
 * That was observed live: a released hold, and a session still reported as
 * held by it.
 *
 * The fix is to check the record against live truth at READ time. The
 * database already holds everything needed to say whether the recorded cause
 * still applies, and a stale record is then simply not reported.
 *
 * NOT the wake query. cms_provider_paused_for exists to find the sessions
 * that must be nudged when a cause disappears, and it finds them BY the
 * record — so filtering it on liveness would find nothing at the exact
 * moment it is needed, and the session would never be told to look again.
 * One reads the record as history to act on; the other reads it as a claim
 * about now. Only the second needs checking.
 */
function migration_0052_provider_pause_liveness(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_pause_is_live(
    p_pause JSONB, p_owner BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_kind   TEXT := p_pause->>'kind';
    v_name   TEXT := p_pause->>'provider';
    v_inst   RECORD;
    v_rule   RECORD;
    v_bounds RECORD;
    v_used   BIGINT;
    v_you    BIGINT;
BEGIN
    IF p_pause IS NULL OR v_kind IS NULL THEN RETURN FALSE; END IF;

    -- A name that does not resolve is exactly what this pause reports, so it
    -- is live while the name is still missing and dead the moment it is not.
    IF v_kind = 'no_provider' THEN
        RETURN NOT EXISTS (SELECT 1 FROM ${s}.cms_provider_in_namespace(COALESCE(v_name, ''), p_owner));
    END IF;

    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(COALESCE(v_name, ''), p_owner);
    -- The provider went away under a session that was paused for some other
    -- reason. It is still stuck, so the record still stands.
    IF NOT FOUND THEN RETURN TRUE; END IF;

    IF v_kind = 'hold' THEN
        RETURN COALESCE(v_inst.hold_indefinite, FALSE)
            OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now());
    END IF;

    SELECT * INTO v_rule FROM ${s}.provider_budget_rules r
     WHERE r.rule_id = p_pause->>'ruleId';
    -- The limit that stopped it was removed.
    IF NOT FOUND THEN RETURN FALSE; END IF;

    SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
    SELECT COALESCE(c.used_tokens, 0) INTO v_used
      FROM ${s}.provider_quota_counters c
     WHERE c.rule_id = v_rule.rule_id AND c.window_key_utc = v_bounds.window_key;
    v_used := COALESCE(v_used, 0);

    IF v_kind = 'limit' THEN
        RETURN v_used >= v_rule.limit_tokens;
    END IF;

    IF v_kind = 'allowance' THEN
        IF v_inst.allowance_pct >= 100 OR p_owner IS NULL THEN RETURN FALSE; END IF;
        SELECT COALESCE(cu.used_tokens, 0) INTO v_you
          FROM ${s}.provider_quota_counters_user cu
         WHERE cu.rule_id = v_rule.rule_id AND cu.user_id = p_owner
           AND cu.window_key_utc = v_bounds.window_key;
        RETURN COALESCE(v_you, 0) >= ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
    END IF;

    -- A kind this version does not know about is reported rather than hidden:
    -- silence would be the one failure mode worse than a stale record.
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

-- Report only the pauses whose cause still holds.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_list_paused(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_limit INTEGER
) RETURNS TABLE(
    session_id TEXT, title TEXT, model TEXT, owner_user_id BIGINT,
    owner_email TEXT, state TEXT, pause_state JSONB, updated_at TIMESTAMPTZ
) AS $$
    SELECT ss.session_id, ss.title, ss.model, so.user_id, ou.email, ss.state,
           ss.pause_state, ss.updated_at
      FROM ${s}.sessions ss
      LEFT JOIN ${s}.session_owners so ON so.session_id = ss.session_id
      LEFT JOIN ${s}.users ou ON ou.user_id = so.user_id
     WHERE ss.deleted_at IS NULL
       AND ss.pause_state IS NOT NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND (COALESCE(p_is_admin, FALSE) OR so.user_id = p_viewer)
       AND ${s}.cms_provider_pause_is_live(ss.pause_state, so.user_id)
     ORDER BY ss.updated_at DESC
     LIMIT COALESCE(p_limit, 100);
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0051 — the runtime pair, plus the readers behind every surface.
 *
 * cms_provider_check_turn is THE admission call: one round trip that
 * resolves the payer, applies the hold, the limits and the allowance, and
 * records the structured pause. cms_provider_settle_turn is its
 * counterpart: one call that writes the ledger row and moves the counters,
 * exactly once, no matter how many times an activity retries.
 *
 * The decision lives HERE rather than in TypeScript on purpose. The
 * counters are in this database; splitting "read the numbers" from "judge
 * the numbers" across a process boundary buys a testable pure function and
 * pays for it with two implementations that can disagree about whether a
 * session may run. The TypeScript side keeps only presentation logic.
 */
function migration_0051_provider_budget_runtime(schema: string): string {
    const s = `"${schema}"`;
    return `
-- ── admission ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_check_turn(
    p_session_id TEXT, p_model TEXT
) RETURNS TABLE(
    verdict TEXT, provider_name TEXT, model_qualified TEXT,
    exempt BOOLEAN, pause JSONB, rules JSONB
) AS $$
DECLARE
    v_sess    RECORD;
    v_owner   BIGINT;
    v_ref     TEXT;
    v_split   RECORD;
    v_inst    RECORD;
    v_rule    RECORD;
    v_bounds  RECORD;
    v_used    BIGINT;
    v_you     BIGINT;
    v_ceiling BIGINT;
    v_rules   JSONB := '[]'::jsonb;
    v_block   JSONB := NULL;
    v_kind    TEXT  := NULL;
    v_reset   TIMESTAMPTZ := NULL;
    v_pause   JSONB := NULL;
BEGIN
    SELECT ss.is_system, ss.model, ss.pause_state INTO v_sess
      FROM ${s}.sessions ss WHERE ss.session_id = p_session_id;
    IF NOT FOUND THEN
        -- Nothing to admit and nothing to charge. The gate's posture is
        -- fail-open, so say clear rather than inventing a refusal.
        RETURN QUERY SELECT 'clear'::TEXT, NULL::TEXT, NULL::TEXT, FALSE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    SELECT so.user_id INTO v_owner FROM ${s}.session_owners so
     WHERE so.session_id = p_session_id;

    -- The catalog row is authoritative for the model, exactly as the turn
    -- runtime treats it; the argument is only the turn's own override.
    v_ref := COALESCE(NULLIF(BTRIM(COALESCE(p_model, '')), ''), v_sess.model);
    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);

    -- Assigned unconditionally. A RECORD that was never assigned raises
    -- "record is not assigned yet" the moment a field is read, and the read
    -- below sits behind an OR whose short-circuiting Postgres does not
    -- promise — so an unqualified model reference could throw instead of
    -- answering, and the gate's fail-open posture would run the turn.
    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(
        COALESCE(v_split.provider_name, ''), v_owner);

    IF v_inst.name IS NULL THEN
        v_pause := jsonb_build_object(
            'kind', 'no_provider',
            'provider', v_split.provider_name,
            'modelRef', v_ref);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'no_provider'::TEXT, v_split.provider_name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    -- System sessions are never paused: a limit that could stop the
    -- machinery would leave nobody able to raise the limit that stopped it.
    -- They still resolve a provider, because their spend is still recorded.
    IF COALESCE(v_sess.is_system, FALSE) THEN
        IF v_sess.pause_state IS NOT NULL THEN
            UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
        END IF;
        RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, TRUE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_inst.hold_indefinite, FALSE)
       OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now()) THEN
        v_pause := jsonb_build_object(
            'kind', 'hold',
            'provider', v_inst.name,
            'resetsAtUtc', CASE WHEN COALESCE(v_inst.hold_indefinite, FALSE)
                                THEN NULL ELSE to_char(v_inst.hold_until_utc AT TIME ZONE 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    FOR v_rule IN
        SELECT r.* FROM ${s}.provider_budget_rules r
         WHERE r.provider_name = v_inst.name
           AND (r.model_qualified IS NULL OR r.model_qualified = v_ref)
    LOOP
        SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
        SELECT COALESCE(c.used_tokens, 0) INTO v_used
          FROM ${s}.provider_quota_counters c
         WHERE c.rule_id = v_rule.rule_id AND c.window_key_utc = v_bounds.window_key;
        v_used := COALESCE(v_used, 0);

        v_ceiling := NULL;
        v_you := NULL;
        IF v_inst.allowance_pct < 100 AND v_owner IS NOT NULL THEN
            v_ceiling := ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
            SELECT COALESCE(cu.used_tokens, 0) INTO v_you
              FROM ${s}.provider_quota_counters_user cu
             WHERE cu.rule_id = v_rule.rule_id AND cu.user_id = v_owner
               AND cu.window_key_utc = v_bounds.window_key;
            v_you := COALESCE(v_you, 0);
        END IF;

        v_rules := v_rules || jsonb_build_object(
            'ruleId', v_rule.rule_id,
            'providerName', v_inst.name,
            'period', v_rule.period,
            'modelQualified', v_rule.model_qualified,
            'limitTokens', v_rule.limit_tokens,
            'usedTokens', v_used,
            'ceilingTokens', v_ceiling,
            'yourUsedTokens', v_you,
            'windowStartUtc', to_char(v_bounds.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'resetsAtUtc', to_char(v_bounds.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

        IF v_used >= v_rule.limit_tokens THEN
            -- A limit stops everyone. It outranks an allowance in the
            -- report because raising the allowance would not help.
            IF v_kind IS DISTINCT FROM 'limit' THEN
                v_kind := 'limit';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens, 'usedTokens', v_used);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        ELSIF v_ceiling IS NOT NULL AND v_you >= v_ceiling THEN
            IF v_kind IS NULL THEN
                v_kind := 'allowance';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens,
                                              'ceilingTokens', v_ceiling, 'yourUsedTokens', v_you);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        END IF;
    END LOOP;

    IF v_kind IS NOT NULL THEN
        -- The LATEST reset among blocking rules: a session blocked by a
        -- daily and a monthly does not resume when the daily turns over.
        v_pause := v_block
            || jsonb_build_object('kind', v_kind, 'provider', v_inst.name,
                                  'resetsAtUtc', to_char(v_reset AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, v_rules;
        RETURN;
    END IF;

    IF v_sess.pause_state IS NOT NULL THEN
        UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
    END IF;
    RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, FALSE, NULL::JSONB, v_rules;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── settlement ───────────────────────────────────────────────────────
-- Exactly once. The ledger's (session_id, turn_index) primary key IS the
-- claim: a second call for the same turn inserts nothing, moves no
-- counter, and returns false. Everything downstream of accounting depends
-- on this one ON CONFLICT.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_turn(
    p_session_id TEXT, p_turn_index INTEGER, p_provider TEXT, p_model TEXT,
    p_owner BIGINT, p_charge_class TEXT, p_agent_id TEXT,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_total  BIGINT := COALESCE(p_in,0) + COALESCE(p_out,0)
                     + COALESCE(p_cache_read,0) + COALESCE(p_cache_write,0);
    v_class  TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_charge_class,'')), ''), 'user');
    v_rule   RECORD;
    v_bounds RECORD;
    v_first  INTEGER;
BEGIN
    IF p_provider IS NULL THEN v_class := 'unattributed'; END IF;

    INSERT INTO ${s}.provider_usage_ledger
        (session_id, turn_index, provider_name, model_qualified, owner_user_id,
         charge_class, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_write, tokens_total, agent_id)
    VALUES (p_session_id, p_turn_index, p_provider, p_model, p_owner,
            v_class, COALESCE(p_in,0), COALESCE(p_out,0), COALESCE(p_cache_read,0),
            COALESCE(p_cache_write,0), v_total, p_agent_id)
    ON CONFLICT (session_id, turn_index) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    -- System spend is recorded and shown, but never consumes a budget that
    -- people plan around. Unattributed spend has no provider to consume.
    IF v_class <> 'user' OR p_provider IS NULL OR v_total <= 0 THEN
        RETURN TRUE;
    END IF;

    -- FOR UPDATE: an administrator removing this limit at the same instant
    -- would otherwise let the loop reach an INSERT whose foreign key has
    -- just gone, and settlement would fail on a turn that was already paid
    -- for. Locking the rule makes the delete wait; the counters cascade away
    -- immediately afterwards, which is the right answer either way.
    FOR v_rule IN
        SELECT r.* FROM ${s}.provider_budget_rules r
         WHERE r.provider_name = p_provider
           AND (r.model_qualified IS NULL OR r.model_qualified = p_model)
         FOR UPDATE
    LOOP
        SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
        INSERT INTO ${s}.provider_quota_counters
            (rule_id, window_key_utc, used_tokens, window_start_utc, resets_at_utc)
        VALUES (v_rule.rule_id, v_bounds.window_key, v_total, v_bounds.window_start, v_bounds.resets_at)
        ON CONFLICT (rule_id, window_key_utc) DO UPDATE
            SET used_tokens = ${s}.provider_quota_counters.used_tokens + EXCLUDED.used_tokens,
                updated_at = now();

        -- Kept for EVERY rule, not only those under a reduced allowance, so
        -- lowering an allowance never has to scan the ledger to find out
        -- what each person had already spent this window.
        IF p_owner IS NOT NULL THEN
            INSERT INTO ${s}.provider_quota_counters_user
                (rule_id, user_id, window_key_utc, used_tokens, window_start_utc, resets_at_utc)
            VALUES (v_rule.rule_id, p_owner, v_bounds.window_key, v_total,
                    v_bounds.window_start, v_bounds.resets_at)
            ON CONFLICT (rule_id, user_id, window_key_utc) DO UPDATE
                SET used_tokens = ${s}.provider_quota_counters_user.used_tokens + EXCLUDED.used_tokens,
                    updated_at = now();
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── readers ──────────────────────────────────────────────────────────

-- The caller's namespace, plus (for an administrator) everyone else's
-- personal providers, flagged. Two different questions — "what may I run?"
-- and "what exists?" — answered by one row set with usable_by_me.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_list(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT, owner_email TEXT,
    owner_display_name TEXT, base_url TEXT, allowance_pct SMALLINT,
    hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN, has_credential BOOLEAN,
    usable_by_me BOOLEAN, is_cluster_default BOOLEAN, is_my_default BOOLEAN,
    rule_count BIGINT, created_at TIMESTAMPTZ
) AS $$
    SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id, ou.email, ou.display_name,
           pi.base_url, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
           (pi.secret_ref IS NOT NULL AND pi.secret_ref <> '{}'::jsonb),
           (pi.class = 'shared' OR pi.owner_user_id = p_viewer),
           (cs.default_provider = pi.name),
           (vu.default_provider = pi.name),
           (SELECT count(*) FROM ${s}.provider_budget_rules r WHERE r.provider_name = pi.name),
           pi.created_at
      FROM ${s}.provider_instances pi
      LEFT JOIN ${s}.users ou ON ou.user_id = pi.owner_user_id
      LEFT JOIN ${s}.users vu ON vu.user_id = p_viewer
      CROSS JOIN ${s}.provider_cluster_settings cs
     WHERE cs.singleton
       AND (pi.class = 'shared'
            OR pi.owner_user_id = p_viewer
            OR COALESCE(p_is_admin, FALSE))
     ORDER BY (pi.class = 'shared') DESC, pi.name;
$$ LANGUAGE sql STABLE;

-- Per-provider budget state: the limits, what the provider has spent
-- against them, and the viewer's own usage and ceiling where an allowance
-- applies. Shared totals are open to everyone who may spend — a limit
-- people cannot measure themselves against is not one they can plan for.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_status(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_names TEXT[]
) RETURNS TABLE(
    name TEXT, class TEXT, allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ,
    hold_indefinite BOOLEAN, rules JSONB
) AS $$
    SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
           COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                   'ruleId', r.rule_id,
                   'period', r.period,
                   'modelQualified', r.model_qualified,
                   'limitTokens', r.limit_tokens,
                   'usedTokens', COALESCE(c.used_tokens, 0),
                   'ceilingTokens', CASE WHEN pi.allowance_pct < 100
                                         THEN ${s}.cms_provider_ceiling(r.limit_tokens, pi.allowance_pct) END,
                   'yourUsedTokens', CASE WHEN p_viewer IS NOT NULL
                                          THEN COALESCE(cu.used_tokens, 0) END,
                   'windowStartUtc', to_char(wb.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'resetsAtUtc', to_char(wb.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   ORDER BY r.period, COALESCE(r.model_qualified, ''))
                 FROM ${s}.provider_budget_rules r
                 CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(r.period, now()) wb
                 LEFT JOIN ${s}.provider_quota_counters c
                        ON c.rule_id = r.rule_id AND c.window_key_utc = wb.window_key
                 LEFT JOIN ${s}.provider_quota_counters_user cu
                        ON cu.rule_id = r.rule_id AND cu.window_key_utc = wb.window_key
                       AND cu.user_id = p_viewer
                WHERE r.provider_name = pi.name
           ), '[]'::jsonb)
      FROM ${s}.provider_instances pi
     WHERE (pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE))
       AND (p_names IS NULL OR pi.name = ANY(p_names))
     ORDER BY (pi.class = 'shared') DESC, pi.name;
$$ LANGUAGE sql STABLE;

-- Sessions waiting on a budget, read from the structured record the gate
-- wrote. Row-scoped: an administrator sees the fleet, everyone else sees
-- the sessions they own — including, deliberately, their own paused ones.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_list_paused(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_limit INTEGER
) RETURNS TABLE(
    session_id TEXT, title TEXT, model TEXT, owner_user_id BIGINT,
    owner_email TEXT, state TEXT, pause_state JSONB, updated_at TIMESTAMPTZ
) AS $$
    SELECT ss.session_id, ss.title, ss.model, so.user_id, ou.email, ss.state,
           ss.pause_state, ss.updated_at
      FROM ${s}.sessions ss
      LEFT JOIN ${s}.session_owners so ON so.session_id = ss.session_id
      LEFT JOIN ${s}.users ou ON ou.user_id = so.user_id
     WHERE ss.deleted_at IS NULL
       AND ss.pause_state IS NOT NULL
       -- A session that ENDED while paused is not waiting for anything. Its
       -- pause record is history, and leaving it in this list kept finished
       -- work in "Paused now" for ever.
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND (COALESCE(p_is_admin, FALSE) OR so.user_id = p_viewer)
     ORDER BY ss.updated_at DESC
     LIMIT COALESCE(p_limit, 100);
$$ LANGUAGE sql STABLE;

-- ── usage reporting ──────────────────────────────────────────────────
-- One filter shape, three questions. A non-administrator is clamped to
-- their own rows: attribution is the one thing this design keeps private.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_totals(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(tokens_total BIGINT, turns BIGINT, sessions BIGINT) AS $$
    SELECT COALESCE(sum(l.tokens_total), 0), count(*)::BIGINT,
           count(DISTINCT l.session_id)::BIGINT
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            -- A named SHARED provider's TOTAL is open to everyone who may
            -- spend from it: a limit people cannot measure themselves
            -- against is not a limit they can plan around.
            --
            -- Only the total. The moment an attribution filter is present
            -- the question stops being "what has this provider spent" and
            -- becomes "what did THAT PERSON spend on it" — which is
            -- admin-only, and which this disjunct happily answered until
            -- the two were separated: naming a shared provider opened every
            -- row, and p_owner then narrowed the open set to one person.
            -- User ids are small integers, so the whole cluster was
            -- enumerable in a loop.
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_daily(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(day_utc DATE, tokens_total BIGINT, turns BIGINT) AS $$
    SELECT (l.created_at AT TIME ZONE 'UTC')::date, COALESCE(sum(l.tokens_total), 0), count(*)::BIGINT
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            -- A named SHARED provider's TOTAL is open to everyone who may
            -- spend from it: a limit people cannot measure themselves
            -- against is not a limit they can plan around.
            --
            -- Only the total. The moment an attribution filter is present
            -- the question stops being "what has this provider spent" and
            -- becomes "what did THAT PERSON spend on it" — which is
            -- admin-only, and which this disjunct happily answered until
            -- the two were separated: naming a shared provider opened every
            -- row, and p_owner then narrowed the open set to one person.
            -- User ids are small integers, so the whole cluster was
            -- enumerable in a loop.
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class)
     GROUP BY 1 ORDER BY 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH rows AS (
        SELECT l.*,
               CASE p_dim
                   WHEN 'session'  THEN l.session_id
                   WHEN 'provider' THEN COALESCE(l.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(l.model_qualified, '(none)')
                   WHEN 'agent'    THEN COALESCE(l.agent_id, '(none)')
                   WHEN 'user'     THEN COALESCE(l.owner_user_id::TEXT,
                                          CASE WHEN l.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(l.provider_name, '(none)')
               END AS dim_key
          FROM ${s}.provider_usage_ledger l
         WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR l.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR l.owner_user_id = p_owner)
           AND (p_provider IS NULL OR l.provider_name = p_provider)
           AND (p_model IS NULL OR l.model_qualified = p_model)
           AND (p_session IS NULL OR l.session_id = p_session)
           AND (p_class IS NULL OR l.charge_class = p_class)
    )
    SELECT g.dim_key,
           CASE p_dim
               WHEN 'session' THEN COALESCE((SELECT ss.title FROM ${s}.sessions ss
                                              WHERE ss.session_id = g.dim_key), g.dim_key)
               WHEN 'user'    THEN COALESCE((SELECT COALESCE(uu.display_name, uu.email, uu.subject)
                                               FROM ${s}.users uu
                                              WHERE uu.user_id::TEXT = g.dim_key), g.dim_key)
               ELSE g.dim_key
           END,
           sum(g.tokens_total)::BIGINT, count(*)::BIGINT
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;

-- The wake query: which sessions are waiting on THIS provider. Called
-- whenever the thing that paused them stops being true — a limit raised or
-- removed, an allowance raised, a hold released, or the provider's name
-- created again after it went missing.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_paused_for(
    p_name TEXT
) RETURNS TABLE(session_id TEXT) AS $$
    SELECT ss.session_id FROM ${s}.sessions ss
     WHERE ss.deleted_at IS NULL
       AND ss.pause_state IS NOT NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND ss.pause_state->>'provider' = p_name;
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0053 — a meter is not a limit.
 *
 * A usage counter used to exist only because a limit existed: its key was the
 * budget rule's id. A period with no limit therefore had no counter and no
 * number, and saving a limit had to rebuild the window's spend from the ledger
 * before it could enforce anything.
 *
 * The counter is now keyed by what it measures:
 *
 *   provider_meters      (provider_name, period, scope, window_key_utc)
 *   provider_meters_user (provider_name, period, scope, window_key_utc, user_id)
 *
 *     period  day | week | month
 *     scope   a qualified model reference, or '*' for all models
 *
 * Every settled turn moves twelve rows — three periods x (all models, the
 * model that ran), for the provider's total and for the person who ran it —
 * whether or not a limit exists. Two things fall out of that:
 *
 * 1. NOTHING SEEDS. cms_provider_set_limit saves a limit and stops. The meter
 *    the limit reads has been running since the provider's first turn.
 *
 * 2. THE LOST-UPDATE RACE IS GONE BY CONSTRUCTION. Seeding was a read and
 *    then an assign, so a turn that settled between the two had its charge
 *    overwritten — a hard limit stopped enforcing and the two counters
 *    disagreed for the rest of the window. Every write to a meter is now an
 *    increment, and there is no read-then-assign left to lose one.
 *
 * WINDOWS ARE NOW FIXED BY STRUCTURE. Day is 00:00 UTC, week is Monday 00:00
 * UTC, month is the 1st. That was already true — 0049 removed per-rule
 * anchors — but one meter key per (provider, period) makes it permanent:
 * every rule of a period on a provider reads the same row, so they must agree
 * on the window. If a billing cycle starting on the 15th is ever needed, the
 * anchor belongs on the PROVIDER, so all its month limits share one boundary.
 *
 * provider_quota_counters and provider_quota_counters_user are dropped.
 * Nothing is deployed, so there is no compatibility shape to keep.
 *
 * ORDER INSIDE THIS MIGRATION MATTERS: the new tables, then every procedure
 * that named the old ones, then the drop. A procedure still pointing at a
 * table being dropped is the one way this can fail halfway.
 */
function migration_0053_provider_meters(schema: string): string {
    const s = `"${schema}"`;
    return `
-- ── the meters ───────────────────────────────────────────────────────

-- provider_name REFERENCES provider_instances so deleting a provider takes
-- its meters with it, and a name created again starts from zero. That is the
-- same rule the ledger already follows by holding a name rather than a
-- reference: the history stays, the running total does not.
CREATE TABLE IF NOT EXISTS ${s}.provider_meters (
    provider_name    TEXT NOT NULL REFERENCES ${s}.provider_instances(name) ON DELETE CASCADE,
    period           TEXT NOT NULL CHECK (period IN ('day','week','month')),
    scope            TEXT NOT NULL,
    window_key_utc   TEXT NOT NULL,
    used_tokens      BIGINT NOT NULL DEFAULT 0,
    window_start_utc TIMESTAMPTZ NOT NULL,
    resets_at_utc    TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_name, period, scope, window_key_utc)
);

-- The per-person mirror, kept for EVERY turn rather than only where an
-- allowance is reduced, so lowering an allowance never has to scan the ledger
-- to discover what each person had already spent this window.
CREATE TABLE IF NOT EXISTS ${s}.provider_meters_user (
    provider_name    TEXT NOT NULL REFERENCES ${s}.provider_instances(name) ON DELETE CASCADE,
    period           TEXT NOT NULL CHECK (period IN ('day','week','month')),
    scope            TEXT NOT NULL,
    window_key_utc   TEXT NOT NULL,
    user_id          BIGINT NOT NULL,
    used_tokens      BIGINT NOT NULL DEFAULT 0,
    window_start_utc TIMESTAMPTZ NOT NULL,
    resets_at_utc    TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_name, period, scope, window_key_utc, user_id)
);

-- ── settlement ───────────────────────────────────────────────────────
-- Exactly once, unchanged: the ledger's (session_id, turn_index) primary key
-- IS the claim. A second call for the same turn inserts nothing, moves no
-- meter, and returns false. What changed below the claim is only WHICH rows
-- move — meters keyed by what they measure, not by a rule that may not exist.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_turn(
    p_session_id TEXT, p_turn_index INTEGER, p_provider TEXT, p_model TEXT,
    p_owner BIGINT, p_charge_class TEXT, p_agent_id TEXT,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_total BIGINT := COALESCE(p_in,0) + COALESCE(p_out,0)
                    + COALESCE(p_cache_read,0) + COALESCE(p_cache_write,0);
    v_class TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_charge_class,'')), ''), 'user');
    v_scope TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_model,'')), ''), '*');
    v_first INTEGER;
BEGIN
    IF p_provider IS NULL THEN v_class := 'unattributed'; END IF;

    INSERT INTO ${s}.provider_usage_ledger
        (session_id, turn_index, provider_name, model_qualified, owner_user_id,
         charge_class, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_write, tokens_total, agent_id)
    VALUES (p_session_id, p_turn_index, p_provider, p_model, p_owner,
            v_class, COALESCE(p_in,0), COALESCE(p_out,0), COALESCE(p_cache_read,0),
            COALESCE(p_cache_write,0), v_total, p_agent_id)
    ON CONFLICT (session_id, turn_index) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    -- System spend is recorded and shown, but never consumes a budget that
    -- people plan around. Unattributed spend has no provider to consume.
    IF v_class <> 'user' OR p_provider IS NULL OR v_total <= 0 THEN
        RETURN TRUE;
    END IF;

    -- A meter references its provider, so a name deleted while this turn was
    -- running has nothing left to move. Taking the parent row's key lock here
    -- makes a delete arriving NOW wait until this turn is counted, and a
    -- delete that already committed report itself as a missing row rather
    -- than as a foreign key violation on a turn that has already been paid
    -- for and written to the ledger.
    PERFORM 1 FROM ${s}.provider_instances pi
     WHERE pi.name = p_provider FOR KEY SHARE;
    IF NOT FOUND THEN RETURN TRUE; END IF;

    -- Three periods x (all models, the model that ran). A turn that named no
    -- model has one scope, not two, so it writes three rows rather than six.
    --
    -- ORDER BY is not cosmetic: a multi-row upsert takes its row locks in the
    -- order the rows arrive, and two settles on one provider touch the same
    -- six keys. A fixed order is what stops them deadlocking each other.
    INSERT INTO ${s}.provider_meters
        (provider_name, period, scope, window_key_utc, used_tokens,
         window_start_utc, resets_at_utc)
    SELECT p_provider, per.period, sc.scope, wb.window_key, v_total,
           wb.window_start, wb.resets_at
      FROM (VALUES ('day'),('week'),('month')) AS per(period)
      CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
      CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
     ORDER BY per.period, sc.scope
    ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
        SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
            updated_at = now();

    IF p_owner IS NOT NULL THEN
        INSERT INTO ${s}.provider_meters_user
            (provider_name, period, scope, window_key_utc, user_id, used_tokens,
             window_start_utc, resets_at_utc)
        SELECT p_provider, per.period, sc.scope, wb.window_key, p_owner, v_total,
               wb.window_start, wb.resets_at
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
          CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
         ORDER BY per.period, sc.scope
        ON CONFLICT (provider_name, period, scope, window_key_utc, user_id) DO UPDATE
            SET used_tokens = ${s}.provider_meters_user.used_tokens + EXCLUDED.used_tokens,
                updated_at = now();
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── saving a limit saves a limit ─────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_limit(
    p_name TEXT, p_period TEXT, p_model TEXT, p_tokens BIGINT,
    p_rule_id TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(rule_id TEXT, seeded_tokens BIGINT) AS $$
-- The OUT parameter rule_id would otherwise shadow the COLUMN of the same
-- name, and an ON CONFLICT target that resolves to a variable is rejected as
-- ambiguous. Inside this body a bare column name means the column.
#variable_conflict use_column
DECLARE
    v_model  TEXT := NULLIF(BTRIM(p_model), '');
    v_rule   TEXT;
    v_bounds RECORD;
    v_used   BIGINT;
BEGIN
    PERFORM ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF p_period NOT IN ('day','week','month') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: period must be day, week or month';
    END IF;
    IF p_tokens IS NULL OR p_tokens <= 0 THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a limit must be a positive number of tokens';
    END IF;
    -- A limit scoped to one model matches the QUALIFIED reference a session
    -- runs, so a bare model name matches nothing — the limit saves, shows in
    -- the report as a live cap, and silently never fires. Refuse it and say
    -- what to write instead.
    IF v_model IS NOT NULL AND v_model NOT LIKE p_name || ':%' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a limit on one model names it as "%:<model>", not "%"', p_name, v_model;
    END IF;

    INSERT INTO ${s}.provider_budget_rules (rule_id, provider_name, period, model_qualified, limit_tokens)
    VALUES (p_rule_id, p_name, p_period, v_model, p_tokens)
    ON CONFLICT (provider_name, period, COALESCE(model_qualified, '*'))
    DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens, updated_at = now()
    RETURNING ${s}.provider_budget_rules.rule_id INTO v_rule;

    -- Nothing is seeded and nothing is reset. The meter for this period and
    -- scope has been counting since the provider's first turn, so the limit
    -- simply starts being compared against a number that already exists.
    --
    -- What comes back is what this limit ALREADY counts, so the editor can
    -- say "sessions pause on their next turn" before the save rather than
    -- after it. It is a read: no write derives a counter from the ledger any
    -- more, which is what the settle-during-save race used to overwrite.
    SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(p_period, now());
    SELECT COALESCE(m.used_tokens, 0) INTO v_used
      FROM ${s}.provider_meters m
     WHERE m.provider_name = p_name
       AND m.period = p_period
       AND m.scope = COALESCE(v_model, '*')
       AND m.window_key_utc = v_bounds.window_key;

    RETURN QUERY SELECT v_rule, COALESCE(v_used, 0);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── admission, re-pointed ────────────────────────────────────────────
-- Every verdict below is the one 0051 gave. The only change is where the
-- number comes from: the meter at (provider, period, scope, window) instead
-- of a counter keyed by the rule's id.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_check_turn(
    p_session_id TEXT, p_model TEXT
) RETURNS TABLE(
    verdict TEXT, provider_name TEXT, model_qualified TEXT,
    exempt BOOLEAN, pause JSONB, rules JSONB
) AS $$
DECLARE
    v_sess    RECORD;
    v_owner   BIGINT;
    v_ref     TEXT;
    v_split   RECORD;
    v_inst    RECORD;
    v_rule    RECORD;
    v_bounds  RECORD;
    v_scope   TEXT;
    v_used    BIGINT;
    v_you     BIGINT;
    v_ceiling BIGINT;
    v_rules   JSONB := '[]'::jsonb;
    v_block   JSONB := NULL;
    v_kind    TEXT  := NULL;
    v_reset   TIMESTAMPTZ := NULL;
    v_pause   JSONB := NULL;
BEGIN
    SELECT ss.is_system, ss.model, ss.pause_state INTO v_sess
      FROM ${s}.sessions ss WHERE ss.session_id = p_session_id;
    IF NOT FOUND THEN
        -- Nothing to admit and nothing to charge. The gate's posture is
        -- fail-open, so say clear rather than inventing a refusal.
        RETURN QUERY SELECT 'clear'::TEXT, NULL::TEXT, NULL::TEXT, FALSE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    SELECT so.user_id INTO v_owner FROM ${s}.session_owners so
     WHERE so.session_id = p_session_id;

    -- The catalog row is authoritative for the model, exactly as the turn
    -- runtime treats it; the argument is only the turn's own override.
    v_ref := COALESCE(NULLIF(BTRIM(COALESCE(p_model, '')), ''), v_sess.model);
    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);

    -- Assigned unconditionally. A RECORD that was never assigned raises
    -- "record is not assigned yet" the moment a field is read, and the read
    -- below sits behind an OR whose short-circuiting Postgres does not
    -- promise — so an unqualified model reference could throw instead of
    -- answering, and the gate's fail-open posture would run the turn.
    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(
        COALESCE(v_split.provider_name, ''), v_owner);

    IF v_inst.name IS NULL THEN
        v_pause := jsonb_build_object(
            'kind', 'no_provider',
            'provider', v_split.provider_name,
            'modelRef', v_ref);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'no_provider'::TEXT, v_split.provider_name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    -- System sessions are never paused: a limit that could stop the
    -- machinery would leave nobody able to raise the limit that stopped it.
    -- They still resolve a provider, because their spend is still recorded.
    IF COALESCE(v_sess.is_system, FALSE) THEN
        IF v_sess.pause_state IS NOT NULL THEN
            UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
        END IF;
        RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, TRUE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_inst.hold_indefinite, FALSE)
       OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now()) THEN
        v_pause := jsonb_build_object(
            'kind', 'hold',
            'provider', v_inst.name,
            'resetsAtUtc', CASE WHEN COALESCE(v_inst.hold_indefinite, FALSE)
                                THEN NULL ELSE to_char(v_inst.hold_until_utc AT TIME ZONE 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    FOR v_rule IN
        SELECT r.* FROM ${s}.provider_budget_rules r
         WHERE r.provider_name = v_inst.name
           AND (r.model_qualified IS NULL OR r.model_qualified = v_ref)
    LOOP
        SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
        v_scope := COALESCE(v_rule.model_qualified, '*');

        SELECT COALESCE(m.used_tokens, 0) INTO v_used
          FROM ${s}.provider_meters m
         WHERE m.provider_name = v_inst.name AND m.period = v_rule.period
           AND m.scope = v_scope AND m.window_key_utc = v_bounds.window_key;
        v_used := COALESCE(v_used, 0);

        v_ceiling := NULL;
        v_you := NULL;
        IF v_inst.allowance_pct < 100 AND v_owner IS NOT NULL THEN
            v_ceiling := ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
            SELECT COALESCE(mu.used_tokens, 0) INTO v_you
              FROM ${s}.provider_meters_user mu
             WHERE mu.provider_name = v_inst.name AND mu.period = v_rule.period
               AND mu.scope = v_scope AND mu.window_key_utc = v_bounds.window_key
               AND mu.user_id = v_owner;
            v_you := COALESCE(v_you, 0);
        END IF;

        v_rules := v_rules || jsonb_build_object(
            'ruleId', v_rule.rule_id,
            'providerName', v_inst.name,
            'period', v_rule.period,
            'modelQualified', v_rule.model_qualified,
            'limitTokens', v_rule.limit_tokens,
            'usedTokens', v_used,
            'ceilingTokens', v_ceiling,
            'yourUsedTokens', v_you,
            'windowStartUtc', to_char(v_bounds.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'resetsAtUtc', to_char(v_bounds.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

        IF v_used >= v_rule.limit_tokens THEN
            -- A limit stops everyone. It outranks an allowance in the
            -- report because raising the allowance would not help.
            IF v_kind IS DISTINCT FROM 'limit' THEN
                v_kind := 'limit';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens, 'usedTokens', v_used);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        ELSIF v_ceiling IS NOT NULL AND v_you >= v_ceiling THEN
            IF v_kind IS NULL THEN
                v_kind := 'allowance';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens,
                                              'ceilingTokens', v_ceiling, 'yourUsedTokens', v_you);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        END IF;
    END LOOP;

    IF v_kind IS NOT NULL THEN
        -- The LATEST reset among blocking rules: a session blocked by a
        -- daily and a monthly does not resume when the daily turns over.
        v_pause := v_block
            || jsonb_build_object('kind', v_kind, 'provider', v_inst.name,
                                  'resetsAtUtc', to_char(v_reset AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, v_rules;
        RETURN;
    END IF;

    IF v_sess.pause_state IS NOT NULL THEN
        UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
    END IF;
    RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, FALSE, NULL::JSONB, v_rules;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── the readers, re-pointed ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_provider_status(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_names TEXT[]
) RETURNS TABLE(
    name TEXT, class TEXT, allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ,
    hold_indefinite BOOLEAN, rules JSONB
) AS $$
    SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
           COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                   'ruleId', r.rule_id,
                   'period', r.period,
                   'modelQualified', r.model_qualified,
                   'limitTokens', r.limit_tokens,
                   'usedTokens', COALESCE(m.used_tokens, 0),
                   'ceilingTokens', CASE WHEN pi.allowance_pct < 100
                                         THEN ${s}.cms_provider_ceiling(r.limit_tokens, pi.allowance_pct) END,
                   'yourUsedTokens', CASE WHEN p_viewer IS NOT NULL
                                          THEN COALESCE(mu.used_tokens, 0) END,
                   'windowStartUtc', to_char(wb.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'resetsAtUtc', to_char(wb.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   ORDER BY r.period, COALESCE(r.model_qualified, ''))
                 FROM ${s}.provider_budget_rules r
                 CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(r.period, now()) wb
                 LEFT JOIN ${s}.provider_meters m
                        ON m.provider_name = r.provider_name AND m.period = r.period
                       AND m.scope = COALESCE(r.model_qualified, '*')
                       AND m.window_key_utc = wb.window_key
                 LEFT JOIN ${s}.provider_meters_user mu
                        ON mu.provider_name = r.provider_name AND mu.period = r.period
                       AND mu.scope = COALESCE(r.model_qualified, '*')
                       AND mu.window_key_utc = wb.window_key
                       AND mu.user_id = p_viewer
                WHERE r.provider_name = pi.name
           ), '[]'::jsonb)
      FROM ${s}.provider_instances pi
     WHERE (pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE))
       AND (p_names IS NULL OR pi.name = ANY(p_names))
     ORDER BY (pi.class = 'shared') DESC, pi.name;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_pause_is_live(
    p_pause JSONB, p_owner BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_kind   TEXT := p_pause->>'kind';
    v_name   TEXT := p_pause->>'provider';
    v_inst   RECORD;
    v_rule   RECORD;
    v_bounds RECORD;
    v_scope  TEXT;
    v_used   BIGINT;
    v_you    BIGINT;
BEGIN
    IF p_pause IS NULL OR v_kind IS NULL THEN RETURN FALSE; END IF;

    -- A name that does not resolve is exactly what this pause reports, so it
    -- is live while the name is still missing and dead the moment it is not.
    IF v_kind = 'no_provider' THEN
        RETURN NOT EXISTS (SELECT 1 FROM ${s}.cms_provider_in_namespace(COALESCE(v_name, ''), p_owner));
    END IF;

    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(COALESCE(v_name, ''), p_owner);
    -- The provider went away under a session that was paused for some other
    -- reason. It is still stuck, so the record still stands.
    IF NOT FOUND THEN RETURN TRUE; END IF;

    IF v_kind = 'hold' THEN
        RETURN COALESCE(v_inst.hold_indefinite, FALSE)
            OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now());
    END IF;

    SELECT * INTO v_rule FROM ${s}.provider_budget_rules r
     WHERE r.rule_id = p_pause->>'ruleId';
    -- The limit that stopped it was removed.
    IF NOT FOUND THEN RETURN FALSE; END IF;

    SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
    v_scope := COALESCE(v_rule.model_qualified, '*');
    SELECT COALESCE(m.used_tokens, 0) INTO v_used
      FROM ${s}.provider_meters m
     WHERE m.provider_name = v_rule.provider_name AND m.period = v_rule.period
       AND m.scope = v_scope AND m.window_key_utc = v_bounds.window_key;
    v_used := COALESCE(v_used, 0);

    IF v_kind = 'limit' THEN
        RETURN v_used >= v_rule.limit_tokens;
    END IF;

    IF v_kind = 'allowance' THEN
        IF v_inst.allowance_pct >= 100 OR p_owner IS NULL THEN RETURN FALSE; END IF;
        SELECT COALESCE(mu.used_tokens, 0) INTO v_you
          FROM ${s}.provider_meters_user mu
         WHERE mu.provider_name = v_rule.provider_name AND mu.period = v_rule.period
           AND mu.scope = v_scope AND mu.window_key_utc = v_bounds.window_key
           AND mu.user_id = p_owner;
        RETURN COALESCE(v_you, 0) >= ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
    END IF;

    -- A kind this version does not know about is reported rather than hidden:
    -- silence would be the one failure mode worse than a stale record.
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── the table, in one call ───────────────────────────────────────────
--
-- One row per line the screen draws: a provider, then one row for each model
-- it has a limit on. Every row carries the same three cells — day, week,
-- month — so a model limit reads exactly like the provider above it, which is
-- what makes "the model is capped while the provider still has room" visible.
--
-- Each cell carries FOUR numbers, because the screen shows two of them at a
-- time and must never mix them up:
--
--   usedTokens / quotaTokens          what everyone spent, against the limit
--   yourUsedTokens / yourQuotaTokens  what you spent, against your share
--
-- A null quota is no limit for that period, and the used number beside it is
-- still real: the meter runs whether or not anybody capped it. A null
-- yourUsedTokens means nobody is signed in — which is not the same as zero,
-- and the screen must not draw it as zero.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_grid(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    provider_name TEXT, row_kind TEXT, scope TEXT, class TEXT,
    allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN,
    model_row_count INTEGER, periods JSONB
) AS $$
    WITH visible AS (
        SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
               (SELECT count(DISTINCT r.model_qualified)::INTEGER
                  FROM ${s}.provider_budget_rules r
                 WHERE r.provider_name = pi.name AND r.model_qualified IS NOT NULL) AS model_rows
          FROM ${s}.provider_instances pi
         WHERE pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE)
    ),
    grid_rows AS (
        SELECT v.*, 'provider'::TEXT AS row_kind, '*'::TEXT AS scope FROM visible v
        UNION ALL
        SELECT v.*, 'model'::TEXT, mr.model_qualified
          FROM visible v
          JOIN (SELECT DISTINCT r.provider_name, r.model_qualified
                  FROM ${s}.provider_budget_rules r
                 WHERE r.model_qualified IS NOT NULL) mr ON mr.provider_name = v.name
    ),
    windows AS (
        SELECT per.period, wb.window_start, wb.resets_at, wb.window_key
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
    )
    SELECT g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
           g.hold_until_utc, g.hold_indefinite,
           CASE WHEN g.row_kind = 'provider' THEN g.model_rows ELSE 0 END,
           jsonb_object_agg(w.period, jsonb_build_object(
               'ruleId', r.rule_id,
               'quotaTokens', r.limit_tokens,
               'usedTokens', COALESCE(m.used_tokens, 0),
               'yourQuotaTokens', CASE
                   WHEN r.limit_tokens IS NULL OR p_viewer IS NULL THEN NULL
                   WHEN g.allowance_pct < 100
                        THEN ${s}.cms_provider_ceiling(r.limit_tokens, g.allowance_pct)
                   ELSE r.limit_tokens END,
               'yourUsedTokens', CASE WHEN p_viewer IS NULL THEN NULL
                                      ELSE COALESCE(mu.used_tokens, 0) END,
               'windowStartUtc', to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'resetsAtUtc', to_char(w.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM grid_rows g
      CROSS JOIN windows w
      LEFT JOIN ${s}.provider_budget_rules r
             ON r.provider_name = g.name AND r.period = w.period
            AND COALESCE(r.model_qualified, '*') = g.scope
      LEFT JOIN ${s}.provider_meters m
             ON m.provider_name = g.name AND m.period = w.period
            AND m.scope = g.scope AND m.window_key_utc = w.window_key
      LEFT JOIN ${s}.provider_meters_user mu
             ON mu.provider_name = g.name AND mu.period = w.period
            AND mu.scope = g.scope AND mu.window_key_utc = w.window_key
            AND mu.user_id = p_viewer
     GROUP BY g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
              g.hold_until_utc, g.hold_indefinite, g.model_rows
     ORDER BY (g.class = 'shared') DESC, g.name, (g.row_kind = 'model'), g.scope;
$$ LANGUAGE sql STABLE;

-- ── the counters keyed by a rule are gone ────────────────────────────
-- Last, so nothing above is still pointing at them.

DROP TABLE IF EXISTS ${s}.provider_quota_counters_user;
DROP TABLE IF EXISTS ${s}.provider_quota_counters;
`;
}


// ─── Migration 0054: the grid says whose row it is ───────────────
//
// An administrator sees every personal provider, and the grid said nothing
// about whose they were. The screen then treated one of somebody else's
// providers as an ordinary row of its own: unmarked, priced into the reader's
// own headroom, called "your provider" by the Delete sheet — and then refused
// by the database, correctly, when they acted on it.
//
// Two booleans fix all of it at the source, because the answer is the
// database's to give and not the client's to guess:
//
//   owned_by_me    this row is yours (or it is shared, which is everyone's)
//   manageable     you may change it — admin on a shared one, owner on a
//                  personal one, exactly what cms_provider_assert_manage
//                  already enforces
//
// The RETURNS TABLE widens, which CREATE OR REPLACE cannot do, so the old
// function is dropped first. Its argument list is unchanged.

function migration_0054_provider_grid_owner(schema: string): string {
    const s = schema;
    return `
DROP FUNCTION IF EXISTS ${s}.cms_provider_usage_grid(BIGINT, BOOLEAN);

CREATE FUNCTION ${s}.cms_provider_usage_grid(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    provider_name TEXT, row_kind TEXT, scope TEXT, class TEXT,
    allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN,
    model_row_count INTEGER, owned_by_me BOOLEAN, manageable BOOLEAN, periods JSONB
) AS $$
    WITH visible AS (
        SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
               -- Shared is everyone's, so it is nobody's to be marked as.
               (pi.class = 'shared' OR pi.owner_user_id IS NOT DISTINCT FROM p_viewer) AS owned_by_me,
               (CASE WHEN pi.class = 'shared' THEN COALESCE(p_is_admin, FALSE)
                     ELSE pi.owner_user_id IS NOT DISTINCT FROM p_viewer END) AS manageable,
               (SELECT count(DISTINCT r.model_qualified)::INTEGER
                  FROM ${s}.provider_budget_rules r
                 WHERE r.provider_name = pi.name AND r.model_qualified IS NOT NULL) AS model_rows
          FROM ${s}.provider_instances pi
         WHERE pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE)
    ),
    grid_rows AS (
        SELECT v.*, 'provider'::TEXT AS row_kind, '*'::TEXT AS scope FROM visible v
        UNION ALL
        SELECT v.*, 'model'::TEXT, mr.model_qualified
          FROM visible v
          JOIN (SELECT DISTINCT r.provider_name, r.model_qualified
                  FROM ${s}.provider_budget_rules r
                 WHERE r.model_qualified IS NOT NULL) mr ON mr.provider_name = v.name
    ),
    windows AS (
        SELECT per.period, wb.window_start, wb.resets_at, wb.window_key
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
    )
    SELECT g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
           g.hold_until_utc, g.hold_indefinite,
           CASE WHEN g.row_kind = 'provider' THEN g.model_rows ELSE 0 END,
           g.owned_by_me, g.manageable,
           jsonb_object_agg(w.period, jsonb_build_object(
               'ruleId', r.rule_id,
               'quotaTokens', r.limit_tokens,
               'usedTokens', COALESCE(m.used_tokens, 0),
               -- Somebody else's personal provider has no share for YOU: its
               -- whole budget is theirs, and pricing it as the reader's own
               -- headroom is the arithmetic that made an admin's table lie.
               'yourQuotaTokens', CASE
                   WHEN r.limit_tokens IS NULL OR p_viewer IS NULL THEN NULL
                   WHEN NOT g.owned_by_me THEN NULL
                   WHEN g.allowance_pct < 100
                        THEN ${s}.cms_provider_ceiling(r.limit_tokens, g.allowance_pct)
                   ELSE r.limit_tokens END,
               'yourUsedTokens', CASE WHEN p_viewer IS NULL THEN NULL
                                      ELSE COALESCE(mu.used_tokens, 0) END,
               'windowStartUtc', to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'resetsAtUtc', to_char(w.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM grid_rows g
      CROSS JOIN windows w
      LEFT JOIN ${s}.provider_budget_rules r
             ON r.provider_name = g.name AND r.period = w.period
            AND COALESCE(r.model_qualified, '*') = g.scope
      LEFT JOIN ${s}.provider_meters m
             ON m.provider_name = g.name AND m.period = w.period
            AND m.scope = g.scope AND m.window_key_utc = w.window_key
      LEFT JOIN ${s}.provider_meters_user mu
             ON mu.provider_name = g.name AND mu.period = w.period
            AND mu.scope = g.scope AND mu.window_key_utc = w.window_key
            AND mu.user_id = p_viewer
     GROUP BY g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
              g.hold_until_utc, g.hold_indefinite, g.model_rows,
              g.owned_by_me, g.manageable
     ORDER BY (g.class = 'shared') DESC, g.name, (g.row_kind = 'model'), g.scope;
$$ LANGUAGE sql STABLE;

-- ── a recycled name does not inherit the old provider's chart ────────
--
-- The meters are keyed to provider_instances ON DELETE CASCADE, so deleting
-- and re-creating a name starts them at zero. The LEDGER has no such key —
-- it keeps the name on purpose, so history outlives the provider — and the
-- chart read it by name alone. So a fresh provider's row said 0 while the
-- chart under it drew the previous holder's spend, across owners and across
-- shared/personal, under one heading.
--
-- Bounded at the current instance's created_at when a provider is NAMED: the
-- chart then describes the provider now on screen, which is the row it sits
-- under. An unfiltered report is untouched and still carries the whole
-- history, which is where that history belongs.

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_daily(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(day_utc DATE, tokens_total BIGINT, turns BIGINT) AS $$
    SELECT (l.created_at AT TIME ZONE 'UTC')::date, COALESCE(sum(l.tokens_total), 0), count(*)::BIGINT
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       -- Nothing from before THIS provider took the name.
       AND (p_provider IS NULL OR l.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class)
     GROUP BY 1 ORDER BY 1;
$$ LANGUAGE sql STABLE;
`;
}


// ─── Migration 0055: a user provider says WHOSE it is ────────────────
//
// 0054 gave the grid `owned_by_me`, which answers "may I touch this" but not
// "whose is it". On an administrator's screen every user provider then read
// as an anonymous row: `carol-azure  USER` says nothing an admin can act on,
// and two people's providers are told apart only by whatever they happened to
// name them.
//
// So the grid carries the owner's display name (falling back to the email,
// then the id — a user row can be sparse). Only for a provider that has an
// owner: a shared provider is everybody's and has no name to print.
//
// RETURNS TABLE widens again, so DROP + CREATE. Argument list unchanged.

function migration_0055_provider_grid_owner_label(schema: string): string {
    const s = schema;
    return `
DROP FUNCTION IF EXISTS ${s}.cms_provider_usage_grid(BIGINT, BOOLEAN);

CREATE FUNCTION ${s}.cms_provider_usage_grid(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    provider_name TEXT, row_kind TEXT, scope TEXT, class TEXT,
    allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN,
    model_row_count INTEGER, owned_by_me BOOLEAN, manageable BOOLEAN,
    owner_label TEXT, periods JSONB
) AS $$
    WITH visible AS (
        SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
               (pi.class = 'shared' OR pi.owner_user_id IS NOT DISTINCT FROM p_viewer) AS owned_by_me,
               (CASE WHEN pi.class = 'shared' THEN COALESCE(p_is_admin, FALSE)
                     ELSE pi.owner_user_id IS NOT DISTINCT FROM p_viewer END) AS manageable,
               -- Whose it is. A shared provider is everybody's, so it has no
               -- owner to name; a user row can be sparse, so fall back down
               -- to something that still identifies a person.
               (CASE WHEN pi.class = 'shared' OR pi.owner_user_id IS NULL THEN NULL
                     ELSE COALESCE(
                         NULLIF(BTRIM(u.display_name), ''),
                         NULLIF(BTRIM(u.email), ''),
                         'user ' || pi.owner_user_id::text) END) AS owner_label,
               (SELECT count(DISTINCT r.model_qualified)::INTEGER
                  FROM ${s}.provider_budget_rules r
                 WHERE r.provider_name = pi.name AND r.model_qualified IS NOT NULL) AS model_rows
          FROM ${s}.provider_instances pi
          LEFT JOIN ${s}.users u ON u.user_id = pi.owner_user_id
         WHERE pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE)
    ),
    grid_rows AS (
        SELECT v.*, 'provider'::TEXT AS row_kind, '*'::TEXT AS scope FROM visible v
        UNION ALL
        SELECT v.*, 'model'::TEXT, mr.model_qualified
          FROM visible v
          JOIN (SELECT DISTINCT r.provider_name, r.model_qualified
                  FROM ${s}.provider_budget_rules r
                 WHERE r.model_qualified IS NOT NULL) mr ON mr.provider_name = v.name
    ),
    windows AS (
        SELECT per.period, wb.window_start, wb.resets_at, wb.window_key
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
    )
    SELECT g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
           g.hold_until_utc, g.hold_indefinite,
           CASE WHEN g.row_kind = 'provider' THEN g.model_rows ELSE 0 END,
           g.owned_by_me, g.manageable,
           CASE WHEN g.row_kind = 'provider' THEN g.owner_label ELSE NULL END,
           jsonb_object_agg(w.period, jsonb_build_object(
               'ruleId', r.rule_id,
               'quotaTokens', r.limit_tokens,
               'usedTokens', COALESCE(m.used_tokens, 0),
               'yourQuotaTokens', CASE
                   WHEN r.limit_tokens IS NULL OR p_viewer IS NULL THEN NULL
                   WHEN NOT g.owned_by_me THEN NULL
                   WHEN g.allowance_pct < 100
                        THEN ${s}.cms_provider_ceiling(r.limit_tokens, g.allowance_pct)
                   ELSE r.limit_tokens END,
               'yourUsedTokens', CASE WHEN p_viewer IS NULL THEN NULL
                                      ELSE COALESCE(mu.used_tokens, 0) END,
               'windowStartUtc', to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'resetsAtUtc', to_char(w.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM grid_rows g
      CROSS JOIN windows w
      LEFT JOIN ${s}.provider_budget_rules r
             ON r.provider_name = g.name AND r.period = w.period
            AND COALESCE(r.model_qualified, '*') = g.scope
      LEFT JOIN ${s}.provider_meters m
             ON m.provider_name = g.name AND m.period = w.period
            AND m.scope = g.scope AND m.window_key_utc = w.window_key
      LEFT JOIN ${s}.provider_meters_user mu
             ON mu.provider_name = g.name AND mu.period = w.period
            AND mu.scope = g.scope AND mu.window_key_utc = w.window_key
            AND mu.user_id = p_viewer
     GROUP BY g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
              g.hold_until_utc, g.hold_indefinite, g.model_rows,
              g.owned_by_me, g.manageable, g.owner_label
     ORDER BY (g.class = 'shared') DESC, g.name, (g.row_kind = 'model'), g.scope;
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0060 — model rows describe spend, not only limits.
 *
 * provider_meters already records all user-charged model usage for day, week,
 * and month. The grid previously sourced model rows only from limit rules, so
 * an uncapped Luna/Sol model was invisible even while its spend rolled into the
 * provider total. Include every model metered in a current window, plus every
 * model with a rule (including an unused one).
 */
function migration_0060_provider_grid_metered_models(schema: string): string {
    const s = schema;
    return `
DROP FUNCTION IF EXISTS ${s}.cms_provider_usage_grid(BIGINT, BOOLEAN);

CREATE FUNCTION ${s}.cms_provider_usage_grid(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    provider_name TEXT, row_kind TEXT, scope TEXT, class TEXT,
    allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN,
    model_row_count INTEGER, owned_by_me BOOLEAN, manageable BOOLEAN,
    owner_label TEXT, periods JSONB
) AS $$
    WITH windows AS (
        SELECT per.period, wb.window_start, wb.resets_at, wb.window_key
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
    ),
    model_scopes AS (
        SELECT r.provider_name, r.model_qualified AS scope
          FROM ${s}.provider_budget_rules r
         WHERE r.model_qualified IS NOT NULL
        UNION
        SELECT m.provider_name, m.scope
          FROM ${s}.provider_meters m
          JOIN windows w ON w.period = m.period AND w.window_key = m.window_key_utc
         WHERE m.scope <> '*'
    ),
    visible AS (
        SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
               (pi.class = 'shared' OR pi.owner_user_id IS NOT DISTINCT FROM p_viewer) AS owned_by_me,
               (CASE WHEN pi.class = 'shared' THEN COALESCE(p_is_admin, FALSE)
                     ELSE pi.owner_user_id IS NOT DISTINCT FROM p_viewer END) AS manageable,
               (CASE WHEN pi.class = 'shared' OR pi.owner_user_id IS NULL THEN NULL
                     ELSE COALESCE(
                         NULLIF(BTRIM(u.display_name), ''),
                         NULLIF(BTRIM(u.email), ''),
                         'user ' || pi.owner_user_id::text) END) AS owner_label,
               (SELECT count(*)::INTEGER FROM model_scopes ms WHERE ms.provider_name = pi.name) AS model_rows
          FROM ${s}.provider_instances pi
          LEFT JOIN ${s}.users u ON u.user_id = pi.owner_user_id
         WHERE pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE)
    ),
    grid_rows AS (
        SELECT v.*, 'provider'::TEXT AS row_kind, '*'::TEXT AS scope FROM visible v
        UNION ALL
        SELECT v.*, 'model'::TEXT, ms.scope
          FROM visible v
          JOIN model_scopes ms ON ms.provider_name = v.name
    )
    SELECT g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
           g.hold_until_utc, g.hold_indefinite,
           CASE WHEN g.row_kind = 'provider' THEN g.model_rows ELSE 0 END,
           g.owned_by_me, g.manageable,
           CASE WHEN g.row_kind = 'provider' THEN g.owner_label ELSE NULL END,
           jsonb_object_agg(w.period, jsonb_build_object(
               'ruleId', r.rule_id,
               'quotaTokens', r.limit_tokens,
               'usedTokens', COALESCE(m.used_tokens, 0),
               'yourQuotaTokens', CASE
                   WHEN r.limit_tokens IS NULL OR p_viewer IS NULL THEN NULL
                   WHEN NOT g.owned_by_me THEN NULL
                   WHEN g.allowance_pct < 100
                        THEN ${s}.cms_provider_ceiling(r.limit_tokens, g.allowance_pct)
                   ELSE r.limit_tokens END,
               'yourUsedTokens', CASE WHEN p_viewer IS NULL THEN NULL
                                      ELSE COALESCE(mu.used_tokens, 0) END,
               'windowStartUtc', to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'resetsAtUtc', to_char(w.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM grid_rows g
      CROSS JOIN windows w
      LEFT JOIN ${s}.provider_budget_rules r
             ON r.provider_name = g.name AND r.period = w.period
            AND COALESCE(r.model_qualified, '*') = g.scope
      LEFT JOIN ${s}.provider_meters m
             ON m.provider_name = g.name AND m.period = w.period
            AND m.scope = g.scope AND m.window_key_utc = w.window_key
      LEFT JOIN ${s}.provider_meters_user mu
             ON mu.provider_name = g.name AND mu.period = w.period
            AND mu.scope = g.scope AND mu.window_key_utc = w.window_key
            AND mu.user_id = p_viewer
     GROUP BY g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
              g.hold_until_utc, g.hold_indefinite, g.model_rows,
              g.owned_by_me, g.manageable, g.owner_label
     ORDER BY (g.class = 'shared') DESC, g.name, (g.row_kind = 'model'), g.scope;
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0056 — admission resolves the same effective default as session execution.
 *
 * Sessions created without an explicit model intentionally store NULL; the
 * worker resolves that to the owner's default, then the cluster default. The
 * provider gate runs before the worker, so it must use the same precedence or
 * every default-model session is parked as `no_provider` forever.
 */
function migration_0056_provider_admission_defaults(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_check_turn(
    p_session_id TEXT, p_model TEXT
) RETURNS TABLE(
    verdict TEXT, provider_name TEXT, model_qualified TEXT,
    exempt BOOLEAN, pause JSONB, rules JSONB
) AS $$
DECLARE
    v_sess    RECORD;
    v_owner   BIGINT;
    v_ref     TEXT;
    v_split   RECORD;
    v_inst    RECORD;
    v_rule    RECORD;
    v_bounds  RECORD;
    v_scope   TEXT;
    v_used    BIGINT;
    v_you     BIGINT;
    v_ceiling BIGINT;
    v_rules   JSONB := '[]'::jsonb;
    v_block   JSONB := NULL;
    v_kind    TEXT  := NULL;
    v_reset   TIMESTAMPTZ := NULL;
    v_pause   JSONB := NULL;
BEGIN
    SELECT ss.is_system, ss.model, ss.pause_state INTO v_sess
      FROM ${s}.sessions ss WHERE ss.session_id = p_session_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'clear'::TEXT, NULL::TEXT, NULL::TEXT, FALSE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    SELECT so.user_id INTO v_owner FROM ${s}.session_owners so
     WHERE so.session_id = p_session_id;

    SELECT COALESCE(
               NULLIF(BTRIM(COALESCE(p_model, '')), ''),
               NULLIF(BTRIM(COALESCE(v_sess.model, '')), ''),
               NULLIF(BTRIM(COALESCE(u.default_model, '')), ''),
               NULLIF(BTRIM(COALESCE(cs.default_model, '')), ''))
      INTO v_ref
      FROM ${s}.provider_cluster_settings cs
      LEFT JOIN ${s}.users u ON u.user_id = v_owner
     WHERE cs.singleton;
    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);

    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(
        COALESCE(v_split.provider_name, ''), v_owner);

    IF v_inst.name IS NULL THEN
        v_pause := jsonb_build_object(
            'kind', 'no_provider',
            'provider', v_split.provider_name,
            'modelRef', v_ref);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'no_provider'::TEXT, v_split.provider_name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_sess.is_system, FALSE) THEN
        IF v_sess.pause_state IS NOT NULL THEN
            UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
        END IF;
        RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, TRUE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_inst.hold_indefinite, FALSE)
       OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now()) THEN
        v_pause := jsonb_build_object(
            'kind', 'hold',
            'provider', v_inst.name,
            'resetsAtUtc', CASE WHEN COALESCE(v_inst.hold_indefinite, FALSE)
                                THEN NULL ELSE to_char(v_inst.hold_until_utc AT TIME ZONE 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    FOR v_rule IN
        SELECT r.* FROM ${s}.provider_budget_rules r
         WHERE r.provider_name = v_inst.name
           AND (r.model_qualified IS NULL OR r.model_qualified = v_ref)
    LOOP
        SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
        v_scope := COALESCE(v_rule.model_qualified, '*');

        SELECT COALESCE(m.used_tokens, 0) INTO v_used
          FROM ${s}.provider_meters m
         WHERE m.provider_name = v_inst.name AND m.period = v_rule.period
           AND m.scope = v_scope AND m.window_key_utc = v_bounds.window_key;
        v_used := COALESCE(v_used, 0);

        v_ceiling := NULL;
        v_you := NULL;
        IF v_inst.allowance_pct < 100 AND v_owner IS NOT NULL THEN
            v_ceiling := ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
            SELECT COALESCE(mu.used_tokens, 0) INTO v_you
              FROM ${s}.provider_meters_user mu
             WHERE mu.provider_name = v_inst.name AND mu.period = v_rule.period
               AND mu.scope = v_scope AND mu.window_key_utc = v_bounds.window_key
               AND mu.user_id = v_owner;
            v_you := COALESCE(v_you, 0);
        END IF;

        v_rules := v_rules || jsonb_build_object(
            'ruleId', v_rule.rule_id,
            'providerName', v_inst.name,
            'period', v_rule.period,
            'modelQualified', v_rule.model_qualified,
            'limitTokens', v_rule.limit_tokens,
            'usedTokens', v_used,
            'ceilingTokens', v_ceiling,
            'yourUsedTokens', v_you,
            'windowStartUtc', to_char(v_bounds.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'resetsAtUtc', to_char(v_bounds.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

        IF v_used >= v_rule.limit_tokens THEN
            IF v_kind IS DISTINCT FROM 'limit' THEN
                v_kind := 'limit';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens, 'usedTokens', v_used);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        ELSIF v_ceiling IS NOT NULL AND v_you >= v_ceiling THEN
            IF v_kind IS NULL THEN
                v_kind := 'allowance';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                                              'modelQualified', v_rule.model_qualified,
                                              'limitTokens', v_rule.limit_tokens,
                                              'ceilingTokens', v_ceiling, 'yourUsedTokens', v_you);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        END IF;
    END LOOP;

    IF v_kind IS NOT NULL THEN
        v_pause := v_block
            || jsonb_build_object('kind', v_kind, 'provider', v_inst.name,
                                  'resetsAtUtc', to_char(v_reset AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        UPDATE ${s}.sessions ss SET pause_state = v_pause
         WHERE ss.session_id = p_session_id
           AND ss.pause_state IS DISTINCT FROM v_pause;
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.name, v_ref, FALSE, v_pause, v_rules;
        RETURN;
    END IF;

    IF v_sess.pause_state IS NOT NULL THEN
        UPDATE ${s}.sessions ss SET pause_state = NULL WHERE ss.session_id = p_session_id;
    END IF;
    RETURN QUERY SELECT 'clear'::TEXT, v_inst.name, v_ref, FALSE, NULL::JSONB, v_rules;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}

/**
 * 0057 — runtime provider routing for system sessions.
 *
 * Ordinary-session defaults remain on the existing cluster/user columns.
 * System machinery gets an independent default plus persistent per-agent
 * overrides. A personal provider remains private to its owner; an admin owner
 * may explicitly allow only system sessions to consume it.
 */
function migration_0057_provider_system_routing(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.provider_instances
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS system_use_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS system_use_enabled_by BIGINT REFERENCES ${s}.users(user_id),
    ADD COLUMN IF NOT EXISTS system_use_enabled_at TIMESTAMPTZ;

ALTER TABLE ${s}.provider_cluster_settings
    ADD COLUMN IF NOT EXISTS system_default_provider TEXT,
    ADD COLUMN IF NOT EXISTS system_default_model TEXT,
    ADD COLUMN IF NOT EXISTS system_default_reasoning TEXT,
    ADD COLUMN IF NOT EXISTS system_default_context TEXT,
    ADD COLUMN IF NOT EXISTS system_default_updated_by BIGINT,
    ADD COLUMN IF NOT EXISTS system_default_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ${s}.system_agent_model_overrides (
    agent_id          TEXT PRIMARY KEY,
    provider_name     TEXT NOT NULL REFERENCES ${s}.provider_instances(name),
    model_qualified   TEXT NOT NULL,
    reasoning_effort  TEXT,
    context_tier      TEXT,
    updated_by        BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_agent_model_overrides_provider
    ON ${s}.system_agent_model_overrides(provider_name);

CREATE OR REPLACE FUNCTION ${s}.cms_provider_assert_system_eligible(
    p_name TEXT, p_actor BIGINT
) RETURNS ${s}.provider_instances AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
    IF v_row.class = 'shared' THEN
        RETURN v_row;
    END IF;
    IF p_actor IS NULL OR v_row.owner_user_id IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
    IF NOT COALESCE(v_row.system_use_enabled, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: "%" is your own provider but is not enabled for system sessions', p_name;
    END IF;
    RETURN v_row;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_for_system(
    p_name TEXT
) RETURNS TABLE(
    name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT,
    secret_ref JSONB, base_url TEXT, allowance_pct SMALLINT,
    hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN
) AS $$
    SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id,
           pi.secret_ref, pi.base_url, pi.allowance_pct,
           pi.hold_until_utc, pi.hold_indefinite
      FROM ${s}.provider_instances pi
     WHERE pi.name = p_name
       AND (pi.class = 'shared' OR pi.system_use_enabled);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_display_name(
    p_name TEXT, p_display_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
BEGIN
    PERFORM ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    UPDATE ${s}.provider_instances pi
       SET display_name = NULLIF(BTRIM(COALESCE(p_display_name, '')), ''),
           updated_at = now()
     WHERE pi.name = p_name;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_system_use(
    p_name TEXT, p_enabled BOOLEAN, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to change system use';
    END IF;
    SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    IF NOT FOUND OR v_row.class <> 'personal' OR v_row.owner_user_id IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
    IF COALESCE(p_enabled, FALSE) AND NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator may enable their own provider for system sessions';
    END IF;
    IF NOT COALESCE(p_enabled, FALSE) THEN
        IF EXISTS (
            SELECT 1 FROM ${s}.provider_cluster_settings cs
             WHERE cs.singleton AND cs.system_default_provider = p_name
        ) OR EXISTS (
            SELECT 1 FROM ${s}.system_agent_model_overrides o
             WHERE o.provider_name = p_name
        ) THEN
            RAISE EXCEPTION 'PROVIDER_IN_USE: "%" is still selected for system sessions', p_name;
        END IF;
    END IF;
    UPDATE ${s}.provider_instances pi
       SET system_use_enabled = COALESCE(p_enabled, FALSE),
           system_use_enabled_by = CASE WHEN COALESCE(p_enabled, FALSE) THEN p_actor ELSE NULL END,
           system_use_enabled_at = CASE WHEN COALESCE(p_enabled, FALSE) THEN now() ELSE NULL END,
           updated_at = now()
     WHERE pi.name = p_name;
    RETURN COALESCE(p_enabled, FALSE);
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_system_default(
    p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(COALESCE(p_provider, '')), '');
    v_model TEXT := NULLIF(BTRIM(COALESCE(p_model, '')), '');
BEGIN
    IF p_actor IS NULL OR NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can set the system default';
    END IF;
    IF (v_name IS NULL) <> (v_model IS NULL) THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the system default needs both a provider and model, or neither to clear it';
    END IF;
    IF v_name IS NOT NULL THEN
        PERFORM ${s}.cms_provider_assert_system_eligible(v_name, p_actor);
        IF v_model NOT LIKE v_name || ':%' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the model must belong to "%": write it as "%:<model>"', v_name, v_name;
        END IF;
    END IF;
    UPDATE ${s}.provider_cluster_settings
       SET system_default_provider = v_name,
           system_default_model = v_model,
           system_default_reasoning = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_reasoning, '')), '') END,
           system_default_context = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_context, '')), '') END,
           system_default_updated_by = p_actor,
           system_default_updated_at = now(),
           updated_at = now()
     WHERE singleton;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_system_agent_model(
    p_agent_id TEXT, p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_agent TEXT := NULLIF(BTRIM(COALESCE(p_agent_id, '')), '');
    v_name TEXT := NULLIF(BTRIM(COALESCE(p_provider, '')), '');
    v_model TEXT := NULLIF(BTRIM(COALESCE(p_model, '')), '');
BEGIN
    IF p_actor IS NULL OR NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can set a system-agent model';
    END IF;
    IF v_agent IS NULL OR v_name IS NULL OR v_model IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a system-agent override needs agent, provider and model';
    END IF;
    PERFORM ${s}.cms_provider_assert_system_eligible(v_name, p_actor);
    IF v_model NOT LIKE v_name || ':%' THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the model must belong to "%": write it as "%:<model>"', v_name, v_name;
    END IF;
    INSERT INTO ${s}.system_agent_model_overrides
        (agent_id, provider_name, model_qualified, reasoning_effort, context_tier, updated_by)
    VALUES (
        v_agent, v_name, v_model,
        NULLIF(BTRIM(COALESCE(p_reasoning, '')), ''),
        NULLIF(BTRIM(COALESCE(p_context, '')), ''), p_actor)
    ON CONFLICT (agent_id) DO UPDATE
       SET provider_name = EXCLUDED.provider_name,
           model_qualified = EXCLUDED.model_qualified,
           reasoning_effort = EXCLUDED.reasoning_effort,
           context_tier = EXCLUDED.context_tier,
           updated_by = EXCLUDED.updated_by,
           updated_at = now();
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_clear_system_agent_model(
    p_agent_id TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE v_deleted INTEGER;
BEGIN
    IF p_actor IS NULL OR NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can clear a system-agent model';
    END IF;
    DELETE FROM ${s}.system_agent_model_overrides o
     WHERE o.agent_id = NULLIF(BTRIM(COALESCE(p_agent_id, '')), '');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_list_system_agent_models()
RETURNS TABLE(
    agent_id TEXT, provider_name TEXT, model_qualified TEXT,
    reasoning_effort TEXT, context_tier TEXT,
    updated_by BIGINT, updated_at TIMESTAMPTZ
) AS $$
    SELECT o.agent_id, o.provider_name, o.model_qualified,
           o.reasoning_effort, o.context_tier, o.updated_by, o.updated_at
      FROM ${s}.system_agent_model_overrides o
     ORDER BY o.agent_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_delete(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE
    v_row ${s}.provider_instances;
    v_waiting BIGINT;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF EXISTS (
        SELECT 1 FROM ${s}.provider_cluster_settings cs
         WHERE cs.singleton
           AND (cs.default_provider = p_name OR cs.system_default_provider = p_name)
    ) OR EXISTS (
        SELECT 1 FROM ${s}.users u WHERE u.default_provider = p_name
    ) OR EXISTS (
        SELECT 1 FROM ${s}.system_agent_model_overrides o WHERE o.provider_name = p_name
    ) THEN
        RAISE EXCEPTION 'PROVIDER_IN_USE: "%" is selected by a default or system-agent override; clear that routing first', p_name;
    END IF;
    SELECT count(*) INTO v_waiting
      FROM ${s}.sessions ss
      CROSS JOIN LATERAL ${s}.cms_provider_split_ref(ss.model) sp
     WHERE ss.deleted_at IS NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND sp.provider_name = p_name;
    DELETE FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    RETURN v_waiting;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_cluster_default(
    p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(COALESCE(p_provider, '')), '');
    v_model TEXT := NULLIF(BTRIM(COALESCE(p_model, '')), '');
    v_row ${s}.provider_instances;
BEGIN
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can set the cluster default';
    END IF;
    IF (v_name IS NULL) <> (v_model IS NULL) THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the cluster default needs both a provider and model, or neither to clear it';
    END IF;
    IF v_name IS NOT NULL THEN
        SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = v_name;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', v_name;
        END IF;
        IF v_row.class <> 'shared' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the cluster default must be a shared provider';
        END IF;
        IF v_model NOT LIKE v_name || ':%' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the model must belong to "%": write it as "%:<model>"', v_name, v_name;
        END IF;
    END IF;
    UPDATE ${s}.provider_cluster_settings
       SET default_provider = v_name,
           default_model = v_model,
           default_reasoning = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_reasoning, '')), '') END,
           default_context = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_context, '')), '') END,
           updated_at = now()
     WHERE singleton;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

DROP FUNCTION IF EXISTS ${s}.cms_provider_list(BIGINT, BOOLEAN);
CREATE FUNCTION ${s}.cms_provider_list(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT, owner_email TEXT,
    owner_display_name TEXT, display_name TEXT, base_url TEXT, allowance_pct SMALLINT,
    hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN, has_credential BOOLEAN,
    usable_by_me BOOLEAN, system_use_enabled BOOLEAN, system_eligible BOOLEAN,
    is_cluster_default BOOLEAN, is_my_default BOOLEAN, is_system_default BOOLEAN,
    rule_count BIGINT, created_at TIMESTAMPTZ
) AS $$
    SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id, ou.email, ou.display_name,
           pi.display_name, pi.base_url, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
           (pi.secret_ref IS NOT NULL AND pi.secret_ref <> '{}'::jsonb),
           (pi.class = 'shared' OR pi.owner_user_id = p_viewer),
           pi.system_use_enabled,
           (pi.class = 'shared' OR (pi.owner_user_id = p_viewer AND pi.system_use_enabled)),
           (cs.default_provider = pi.name),
           (vu.default_provider = pi.name),
           (cs.system_default_provider = pi.name),
           (SELECT count(*) FROM ${s}.provider_budget_rules r WHERE r.provider_name = pi.name),
           pi.created_at
      FROM ${s}.provider_instances pi
      LEFT JOIN ${s}.users ou ON ou.user_id = pi.owner_user_id
      LEFT JOIN ${s}.users vu ON vu.user_id = p_viewer
      CROSS JOIN ${s}.provider_cluster_settings cs
     WHERE cs.singleton
       AND (pi.class = 'shared'
            OR pi.owner_user_id = p_viewer
            OR COALESCE(p_is_admin, FALSE))
     ORDER BY (pi.class = 'shared') DESC, pi.name;
$$ LANGUAGE sql STABLE;

DROP FUNCTION IF EXISTS ${s}.cms_provider_get_defaults(BIGINT);
CREATE FUNCTION ${s}.cms_provider_get_defaults(
    p_actor BIGINT
) RETURNS TABLE(
    cluster_provider TEXT, cluster_model TEXT, cluster_reasoning TEXT, cluster_context TEXT,
    my_provider TEXT, my_model TEXT, my_reasoning TEXT, my_context TEXT,
    system_provider TEXT, system_model TEXT, system_reasoning TEXT, system_context TEXT,
    system_updated_by BIGINT, system_updated_at TIMESTAMPTZ
) AS $$
    SELECT c.default_provider, c.default_model, c.default_reasoning, c.default_context,
           u.default_provider, u.default_model, u.default_reasoning, u.default_context,
           c.system_default_provider, c.system_default_model,
           c.system_default_reasoning, c.system_default_context,
           c.system_default_updated_by, c.system_default_updated_at
      FROM ${s}.provider_cluster_settings c
      LEFT JOIN ${s}.users u ON u.user_id = p_actor
     WHERE c.singleton;
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0058 — turn legacy per-user GHCP keys into private provider instances.
 *
 * Keys never leave PostgreSQL. Regular users migrate automatically and keep
 * the legacy column for dual-read rollback. The synthetic System key requires
 * an authenticated admin to claim it into their own personal provider.
 */
function migration_0058_legacy_github_provider_migration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.provider_legacy_key_migrations (
    source_kind      TEXT NOT NULL CHECK (source_kind IN ('user','system')),
    source_user_id   BIGINT NOT NULL REFERENCES ${s}.users(user_id) ON DELETE CASCADE,
    provider_name    TEXT UNIQUE REFERENCES ${s}.provider_instances(name) ON DELETE SET NULL,
    migrated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_kind, source_user_id)
);

CREATE TABLE IF NOT EXISTS ${s}.provider_legacy_session_models (
    session_id       TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    original_model   TEXT NOT NULL,
    migrated_model   TEXT NOT NULL,
    migrated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
    v_user RECORD;
    v_name TEXT;
    v_existing RECORD;
BEGIN
    FOR v_user IN
        SELECT u.user_id, u.github_copilot_key
          FROM ${s}.users u
         WHERE NOT (u.provider = 'system' AND u.subject = 'system')
           AND NULLIF(BTRIM(u.github_copilot_key), '') IS NOT NULL
         ORDER BY u.user_id
    LOOP
        IF EXISTS (
            SELECT 1 FROM ${s}.provider_legacy_key_migrations m
             WHERE m.source_kind = 'user' AND m.source_user_id = v_user.user_id
        ) THEN
            CONTINUE;
        END IF;
        v_name := 'ghcp-u' || v_user.user_id::text;
        SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id INTO v_existing
          FROM ${s}.provider_instances pi WHERE pi.name = v_name;
        IF FOUND THEN
            IF v_existing.type_id <> 'github-copilot'
               OR v_existing.class <> 'personal'
               OR v_existing.owner_user_id IS DISTINCT FROM v_user.user_id THEN
                RAISE EXCEPTION 'PROVIDER_CONFLICT: legacy GHCP migration name "%" is already used by another provider', v_name;
            END IF;
        ELSE
            INSERT INTO ${s}.provider_instances
                (name, type_id, class, owner_user_id, secret_ref, display_name)
            VALUES (
                v_name, 'github-copilot', 'personal', v_user.user_id,
                jsonb_build_object(
                    'kind', 'githubToken',
                    'value', v_user.github_copilot_key,
                    'migratedFrom', 'users.github_copilot_key'),
                'My GitHub Copilot');
        END IF;
        INSERT INTO ${s}.provider_legacy_key_migrations(source_kind, source_user_id, provider_name)
        VALUES ('user', v_user.user_id, v_name)
        ON CONFLICT (source_kind, source_user_id) DO NOTHING;
    END LOOP;

     INSERT INTO ${s}.provider_legacy_session_models(session_id, original_model, migrated_model)
     SELECT ss.session_id, ss.model,
              m.provider_name || substring(ss.model from position(':' in ss.model))
      FROM ${s}.session_owners so
      JOIN ${s}.provider_legacy_key_migrations m
        ON m.source_kind = 'user' AND m.source_user_id = so.user_id
        JOIN ${s}.sessions ss ON ss.session_id = so.session_id
      WHERE m.provider_name IS NOT NULL
       AND ss.is_system = FALSE
         AND ss.deleted_at IS NULL
         AND ss.state NOT IN ('completed','failed','error','cancelled')
         AND ss.model LIKE 'github-copilot:%'
     ON CONFLICT (session_id) DO NOTHING;

     UPDATE ${s}.sessions ss
         SET model = sm.migrated_model
        FROM ${s}.provider_legacy_session_models sm
      WHERE sm.session_id = ss.session_id
         AND ss.model = sm.original_model
         AND EXISTS (
              SELECT 1 FROM ${s}.provider_instances pi
                WHERE sm.migrated_model LIKE pi.name || ':%'
         );
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_adopt_system_github_key(
    p_name TEXT, p_display_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(COALESCE(p_name, '')), '');
    v_system_user BIGINT;
    v_key TEXT;
    v_adopted_name TEXT;
BEGIN
    IF p_actor IS NULL OR NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an authenticated administrator may adopt the System GitHub Copilot key';
    END IF;
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the adopted provider needs a name';
    END IF;
    SELECT u.user_id, u.github_copilot_key INTO v_system_user, v_key
      FROM ${s}.users u
         WHERE u.provider = 'system' AND u.subject = 'system'
         FOR UPDATE;
    IF v_system_user IS NULL OR NULLIF(BTRIM(v_key), '') IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: no legacy System GitHub Copilot key is configured';
    END IF;

    SELECT m.provider_name INTO v_adopted_name
      FROM ${s}.provider_legacy_key_migrations m
     WHERE m.source_kind = 'system' AND m.source_user_id = v_system_user;
    IF FOUND THEN
        IF v_adopted_name IS NULL THEN
            RAISE EXCEPTION 'PROVIDER_CONFLICT: the legacy System key was already adopted and that provider was deleted';
        END IF;
        IF v_adopted_name <> v_name OR NOT EXISTS (
            SELECT 1 FROM ${s}.provider_instances pi
             WHERE pi.name = v_adopted_name
               AND pi.class = 'personal'
               AND pi.owner_user_id = p_actor
        ) THEN
            RAISE EXCEPTION 'PROVIDER_CONFLICT: the legacy System key has already been adopted';
        END IF;
        RETURN QUERY
        SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id
          FROM ${s}.provider_instances pi WHERE pi.name = v_adopted_name;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM ${s}.provider_instances pi WHERE pi.name = v_name) THEN
        RAISE EXCEPTION 'PROVIDER_CONFLICT: the name "%" is already taken', v_name;
    END IF;
    INSERT INTO ${s}.provider_instances
        (name, type_id, class, owner_user_id, secret_ref, display_name,
         system_use_enabled, system_use_enabled_by, system_use_enabled_at)
    VALUES (
        v_name, 'github-copilot', 'personal', p_actor,
        jsonb_build_object(
            'kind', 'githubToken',
            'value', v_key,
            'migratedFrom', 'system.github_copilot_key'),
        COALESCE(NULLIF(BTRIM(p_display_name), ''), 'System GitHub Copilot'),
        TRUE, p_actor, now());

    INSERT INTO ${s}.provider_legacy_key_migrations(source_kind, source_user_id, provider_name)
    VALUES ('system', v_system_user, v_name)
    ON CONFLICT (source_kind, source_user_id) DO NOTHING;

    RETURN QUERY
    SELECT pi.name, pi.type_id, pi.class, pi.owner_user_id
      FROM ${s}.provider_instances pi WHERE pi.name = v_name;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_legacy_key_migration_status()
RETURNS TABLE(
    regular_keys BIGINT,
    migrated_regular_keys BIGINT,
    system_key_present BOOLEAN,
    system_key_adopted BOOLEAN
) AS $$
    SELECT
        (SELECT count(*) FROM ${s}.users u
          WHERE NOT (u.provider = 'system' AND u.subject = 'system')
            AND NULLIF(BTRIM(u.github_copilot_key), '') IS NOT NULL),
        (SELECT count(*) FROM ${s}.provider_legacy_key_migrations m WHERE m.source_kind = 'user'),
        EXISTS (SELECT 1 FROM ${s}.users u
                 WHERE u.provider = 'system' AND u.subject = 'system'
                   AND NULLIF(BTRIM(u.github_copilot_key), '') IS NOT NULL),
        EXISTS (SELECT 1 FROM ${s}.provider_legacy_key_migrations m WHERE m.source_kind = 'system');
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0059 — make the stamped CMS model authoritative end to end.
 *
 * Creation validates and locks the provider in the same transaction as the
 * session insert. Admission uses the system namespace for machinery. Legacy
 * bootstrap records one receipt per provider, so a credential-poor process
 * cannot permanently block a better-provisioned worker from adding the rest.
 */
function migration_0059_provider_authoritative_routing(schema: string): string {
    const s = `"${schema}"`;
    const systemAwareCheck = migration_0056_provider_admission_defaults(schema)
        .replace(
            "SELECT ss.is_system, ss.model, ss.pause_state INTO v_sess",
            "SELECT ss.is_system, ss.model, ss.pause_state, ss.agent_id INTO v_sess",
        )
        .replace(
`    IF NOT FOUND THEN
        RETURN QUERY SELECT 'clear'::TEXT, NULL::TEXT, NULL::TEXT, FALSE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;`,
`    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: session "%" does not exist', p_session_id;
    END IF;`,
        )
        .replace(
`    SELECT COALESCE(
               NULLIF(BTRIM(COALESCE(p_model, '')), ''),
               NULLIF(BTRIM(COALESCE(v_sess.model, '')), ''),
               NULLIF(BTRIM(COALESCE(u.default_model, '')), ''),
               NULLIF(BTRIM(COALESCE(cs.default_model, '')), ''))
      INTO v_ref
      FROM ${s}.provider_cluster_settings cs
      LEFT JOIN ${s}.users u ON u.user_id = v_owner
     WHERE cs.singleton;`,
`    SELECT CASE WHEN COALESCE(v_sess.is_system, FALSE) THEN COALESCE(
               NULLIF(BTRIM(COALESCE(v_sess.model, '')), ''),
               NULLIF(BTRIM(COALESCE(o.model_qualified, '')), ''),
               NULLIF(BTRIM(COALESCE(cs.system_default_model, '')), ''),
               NULLIF(BTRIM(COALESCE(cs.default_model, '')), ''))
           ELSE COALESCE(
               NULLIF(BTRIM(COALESCE(v_sess.model, '')), ''),
               NULLIF(BTRIM(COALESCE(u.default_model, '')), ''),
               NULLIF(BTRIM(COALESCE(cs.default_model, '')), '')) END
      INTO v_ref
      FROM ${s}.provider_cluster_settings cs
      LEFT JOIN ${s}.users u ON u.user_id = v_owner
      LEFT JOIN ${s}.system_agent_model_overrides o ON o.agent_id = v_sess.agent_id
     WHERE cs.singleton;`,
        )
        .replace(
`    SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(
        COALESCE(v_split.provider_name, ''), v_owner);`,
`    IF COALESCE(v_sess.is_system, FALSE) THEN
        SELECT * INTO v_inst FROM ${s}.cms_provider_for_system(
            COALESCE(v_split.provider_name, ''));
    ELSE
        SELECT * INTO v_inst FROM ${s}.cms_provider_in_namespace(
            COALESCE(v_split.provider_name, ''), v_owner);
    END IF;`,
        );
    const authoritativeCheck = systemAwareCheck.replace(
`    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);

    IF COALESCE(v_sess.is_system, FALSE) THEN`,
`    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);

    IF v_sess.model IS NULL AND v_ref IS NOT NULL THEN
        UPDATE ${s}.sessions ss
           SET model = v_ref,
               reasoning_effort = CASE WHEN COALESCE(v_sess.is_system, FALSE) THEN COALESCE(
                   (SELECT o.reasoning_effort FROM ${s}.system_agent_model_overrides o WHERE o.agent_id = v_sess.agent_id),
                   (SELECT cs.system_default_reasoning FROM ${s}.provider_cluster_settings cs WHERE cs.singleton),
                   (SELECT cs.default_reasoning FROM ${s}.provider_cluster_settings cs WHERE cs.singleton))
                 ELSE COALESCE(
                   (SELECT u.default_reasoning FROM ${s}.users u WHERE u.user_id = v_owner),
                   (SELECT cs.default_reasoning FROM ${s}.provider_cluster_settings cs WHERE cs.singleton)) END,
               context_tier = CASE WHEN COALESCE(v_sess.is_system, FALSE) THEN COALESCE(
                   (SELECT o.context_tier FROM ${s}.system_agent_model_overrides o WHERE o.agent_id = v_sess.agent_id),
                   (SELECT cs.system_default_context FROM ${s}.provider_cluster_settings cs WHERE cs.singleton),
                   (SELECT cs.default_context FROM ${s}.provider_cluster_settings cs WHERE cs.singleton))
                 ELSE COALESCE(
                   (SELECT u.default_context FROM ${s}.users u WHERE u.user_id = v_owner),
                   (SELECT cs.default_context FROM ${s}.provider_cluster_settings cs WHERE cs.singleton)) END,
               model_resolution_source = CASE WHEN COALESCE(v_sess.is_system, FALSE) THEN
                   CASE WHEN EXISTS (SELECT 1 FROM ${s}.system_agent_model_overrides o WHERE o.agent_id = v_sess.agent_id)
                        THEN 'agent_override'
                        WHEN (SELECT cs.system_default_model FROM ${s}.provider_cluster_settings cs WHERE cs.singleton) IS NOT NULL
                        THEN 'system_default' ELSE 'cluster_default' END
                 ELSE CASE WHEN (SELECT u.default_model FROM ${s}.users u WHERE u.user_id = v_owner) IS NOT NULL
                           THEN 'user_default' ELSE 'cluster_default' END END,
               updated_at = now()
         WHERE ss.session_id = p_session_id AND ss.model IS NULL;
    END IF;

    IF COALESCE(v_sess.is_system, FALSE) THEN`,
    );
    return `
ALTER TABLE ${s}.sessions
    ADD COLUMN IF NOT EXISTS context_tier TEXT,
    ADD COLUMN IF NOT EXISTS model_resolution_source TEXT;

CREATE TABLE IF NOT EXISTS ${s}.provider_bootstrap_receipts (
    provider_name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${s}.system_agent_restart_rollouts (
    agent_id          TEXT PRIMARY KEY,
    operation_id      TEXT NOT NULL,
    claim_id          TEXT NOT NULL,
    target_model      TEXT NOT NULL,
    target_reasoning  TEXT,
    target_context    TEXT,
    disposition       TEXT NOT NULL CHECK (disposition IN ('complete','terminate','hard_delete')),
    status            TEXT NOT NULL CHECK (status IN ('in_progress','failed','complete')),
    claimed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    last_error        TEXT
);

INSERT INTO ${s}.provider_bootstrap_receipts(provider_name)
SELECT pi.name FROM ${s}.provider_instances pi
 WHERE pi.secret_ref->>'source' = 'config-file'
ON CONFLICT (provider_name) DO NOTHING;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_assert_session_model(
    p_model TEXT,
    p_owner_provider TEXT,
    p_owner_subject TEXT,
    p_is_system BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_split RECORD;
    v_owner BIGINT;
    v_found BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(p_model);
    IF v_split.provider_name IS NULL OR v_split.model_name IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: a session model must be an exact provider:model reference';
    END IF;
    IF COALESCE(p_is_system, FALSE) THEN
        SELECT TRUE INTO v_found
          FROM ${s}.provider_instances pi
         WHERE pi.name = v_split.provider_name
           AND (pi.class = 'shared' OR pi.system_use_enabled)
         FOR KEY SHARE;
    ELSE
        SELECT u.user_id INTO v_owner FROM ${s}.users u
         WHERE u.provider = NULLIF(BTRIM(p_owner_provider), '')
           AND u.subject = NULLIF(BTRIM(p_owner_subject), '');
        SELECT TRUE INTO v_found
          FROM ${s}.provider_instances pi
         WHERE pi.name = v_split.provider_name
           AND (pi.class = 'shared' OR (v_owner IS NOT NULL AND pi.owner_user_id = v_owner))
         FOR KEY SHARE;
    END IF;
    IF NOT COALESCE(v_found, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no usable provider named "%"', v_split.provider_name;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_claim_system_restart(
    p_agent_id TEXT, p_operation_id TEXT, p_claim_id TEXT,
    p_model TEXT, p_reasoning TEXT, p_context TEXT, p_disposition TEXT
) RETURNS TEXT AS $$
DECLARE v_row ${s}.system_agent_restart_rollouts;
BEGIN
    IF NULLIF(BTRIM(p_agent_id), '') IS NULL
       OR NULLIF(BTRIM(p_operation_id), '') IS NULL
       OR NULLIF(BTRIM(p_claim_id), '') IS NULL
       OR NULLIF(BTRIM(p_model), '') IS NULL
       OR p_disposition NOT IN ('complete','terminate','hard_delete') THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: invalid system restart claim';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('system-restart:' || p_agent_id));

    SELECT * INTO v_row FROM ${s}.system_agent_restart_rollouts r
     WHERE r.agent_id = p_agent_id FOR UPDATE;
    IF FOUND THEN
        IF v_row.operation_id = p_operation_id AND v_row.status = 'complete' THEN
            RETURN 'complete';
        END IF;
        IF v_row.status = 'in_progress'
           AND v_row.claimed_at > now() - interval '10 minutes' THEN
            RETURN 'busy';
        END IF;
        UPDATE ${s}.system_agent_restart_rollouts r
           SET operation_id = p_operation_id, claim_id = p_claim_id,
               target_model = p_model,
               target_reasoning = NULLIF(BTRIM(COALESCE(p_reasoning, '')), ''),
               target_context = NULLIF(BTRIM(COALESCE(p_context, '')), ''),
               disposition = p_disposition, status = 'in_progress',
               claimed_at = now(), completed_at = NULL, last_error = NULL
         WHERE r.agent_id = p_agent_id;
    ELSE
        INSERT INTO ${s}.system_agent_restart_rollouts
            (agent_id, operation_id, claim_id, target_model, target_reasoning,
             target_context, disposition, status)
        VALUES (
            p_agent_id, p_operation_id, p_claim_id, p_model,
            NULLIF(BTRIM(COALESCE(p_reasoning, '')), ''),
            NULLIF(BTRIM(COALESCE(p_context, '')), ''),
            p_disposition, 'in_progress');
    END IF;
    RETURN 'claimed';
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_finish_system_restart(
    p_agent_id TEXT, p_claim_id TEXT, p_error TEXT
) RETURNS BOOLEAN AS $$
DECLARE v_updated INTEGER;
BEGIN
    UPDATE ${s}.system_agent_restart_rollouts r
       SET status = CASE WHEN NULLIF(BTRIM(COALESCE(p_error, '')), '') IS NULL
                         THEN 'complete' ELSE 'failed' END,
           completed_at = now(),
           last_error = NULLIF(BTRIM(COALESCE(p_error, '')), '')
     WHERE r.agent_id = p_agent_id AND r.claim_id = p_claim_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_get_system_restart(
    p_agent_id TEXT
) RETURNS TABLE(
    agent_id TEXT, operation_id TEXT, target_model TEXT,
    target_reasoning TEXT, target_context TEXT,
    disposition TEXT, status TEXT, claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ, last_error TEXT
) AS $$
    SELECT r.agent_id, r.operation_id, r.target_model,
           r.target_reasoning, r.target_context,
           r.disposition, r.status, r.claimed_at,
           r.completed_at, r.last_error
      FROM ${s}.system_agent_restart_rollouts r
     WHERE r.agent_id = p_agent_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_bootstrap(
    p_instances JSONB, p_default JSONB
) RETURNS TABLE(claimed BOOLEAN, created INTEGER) AS $$
DECLARE
    v_item JSONB;
    v_receipt TEXT;
    v_created INTEGER := 0;
    v_claimed BOOLEAN := FALSE;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_instances, '[]'::jsonb)) LOOP
        v_receipt := NULL;
        IF COALESCE(v_item->>'name', '') !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: invalid provider name "%"', v_item->>'name';
        END IF;
        INSERT INTO ${s}.provider_bootstrap_receipts(provider_name)
        VALUES (v_item->>'name')
        ON CONFLICT (provider_name) DO NOTHING
        RETURNING provider_name INTO v_receipt;
        IF v_receipt IS NULL THEN CONTINUE; END IF;

        -- Fail closed: any malformed entry rolls back every provider and
        -- receipt in this call, leaving a later process free to retry.
        PERFORM ${s}.cms_provider_create(
            v_item->>'name', v_item->>'typeId', 'shared', NULL,
            COALESCE(v_item->'secretRef', '{}'::jsonb), v_item->>'baseUrl',
            NULL, TRUE);
        v_created := v_created + 1;
        v_claimed := TRUE;
    END LOOP;

    IF p_default IS NOT NULL AND p_default->>'provider' IS NOT NULL
       AND EXISTS (SELECT 1 FROM ${s}.provider_cluster_settings cs
                    WHERE cs.singleton AND cs.bootstrapped_at IS NULL) THEN
        PERFORM ${s}.cms_provider_set_cluster_default(
            p_default->>'provider', p_default->>'model',
            p_default->>'reasoning', p_default->>'context', TRUE);
        UPDATE ${s}.provider_cluster_settings
           SET bootstrapped_at = now(), updated_at = now()
         WHERE singleton AND bootstrapped_at IS NULL;
        v_claimed := TRUE;
    END IF;

    RETURN QUERY SELECT v_claimed, v_created;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_rollback_legacy_session_models(
    p_is_admin BOOLEAN
) RETURNS INTEGER AS $$
DECLARE v_count INTEGER;
BEGIN
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can roll back migrated session models';
    END IF;
    UPDATE ${s}.sessions ss
       SET model = sm.original_model
      FROM ${s}.provider_legacy_session_models sm
     WHERE sm.session_id = ss.session_id
       AND ss.model = sm.migrated_model;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_clear_routing_dependencies(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS JSONB AS $$
DECLARE
    v_row ${s}.provider_instances;
    v_cluster INTEGER := 0;
    v_system INTEGER := 0;
    v_users INTEGER := 0;
    v_overrides INTEGER := 0;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF v_row.class = 'shared' AND NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can clear shared-provider routing';
    END IF;

    UPDATE ${s}.provider_cluster_settings cs
       SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL,
           updated_at = now()
     WHERE cs.singleton AND cs.default_provider = p_name;
    GET DIAGNOSTICS v_cluster = ROW_COUNT;

    UPDATE ${s}.provider_cluster_settings cs
       SET system_default_provider = NULL, system_default_model = NULL,
           system_default_reasoning = NULL, system_default_context = NULL,
           system_default_updated_by = p_actor,
           system_default_updated_at = now(), updated_at = now()
     WHERE cs.singleton AND cs.system_default_provider = p_name;
    GET DIAGNOSTICS v_system = ROW_COUNT;

    UPDATE ${s}.users u
       SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL
     WHERE u.default_provider = p_name
       AND (v_row.class = 'shared' OR u.user_id = p_actor);
    GET DIAGNOSTICS v_users = ROW_COUNT;

    DELETE FROM ${s}.system_agent_model_overrides o WHERE o.provider_name = p_name;
    GET DIAGNOSTICS v_overrides = ROW_COUNT;

    RETURN jsonb_build_object(
        'clusterDefault', v_cluster,
        'systemDefault', v_system,
        'userDefaults', v_users,
        'systemOverrides', v_overrides);
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId') ELSE orchestration_id END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title') ELSE title END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'      THEN (p_updates->>'titleLocked')::BOOLEAN ELSE title_locked END,
        state             = CASE WHEN p_updates ? 'state'            THEN (p_updates->>'state') ELSE state END,
        model             = CASE WHEN p_updates ? 'model'            THEN (p_updates->>'model') ELSE model END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort'  THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        context_tier      = CASE WHEN p_updates ? 'contextTier'      THEN NULLIF(BTRIM(p_updates->>'contextTier'), '') ELSE context_tier END,
        model_resolution_source = CASE WHEN p_updates ? 'modelResolutionSource' THEN NULLIF(BTRIM(p_updates->>'modelResolutionSource'), '') ELSE model_resolution_source END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'     THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ ELSE last_active_at END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'        THEN (p_updates->>'lastError') ELSE last_error END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'       THEN (p_updates->>'waitReason') ELSE wait_reason END,
        is_system         = CASE WHEN p_updates ? 'isSystem'         THEN (p_updates->>'isSystem')::BOOLEAN ELSE is_system END,
        agent_id          = CASE WHEN p_updates ? 'agentId'          THEN (p_updates->>'agentId') ELSE agent_id END,
        splash            = CASE WHEN p_updates ? 'splash'           THEN (p_updates->>'splash') ELSE splash END,
        splash_mobile     = CASE WHEN p_updates ? 'splashMobile'     THEN (p_updates->>'splashMobile') ELSE splash_mobile END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL ELSE active_turn_index END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metrics
       SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
           reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
           updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
     WHERE session_id = p_session_id
       AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql VOLATILE;

${authoritativeCheck}
`;
}

// ─── Migration 0061: provider correctness fixes ──────────────────────
//
// Two defects from the 2026-08-24 campaign, both in code that already
// shipped in this lineage — so both land as REPLACEMENTS here, never as
// edits to an applied migration.
//
// 1. A recycled provider NAME must not inherit the old holder's spend in
//    ANY section of the usage report. The bound landed on the daily series
//    (the chart the portal draws) and nowhere else, so one response
//    contradicted itself: totals and breakdown counted ledger rows from
//    before the current instance existed while daily excluded them. The
//    same provider-epoch bound now applies to all three.
//
// 2. cms_provider_next_turn_index: the ledger PK (session_id, turn_index)
//    is the exactly-once settlement claim. A restarted system session
//    keeps its session_id while its fresh orchestration counts turns from
//    zero again, so once the new lifetime reached an index the old one had
//    written, settle's ON CONFLICT DO NOTHING read every turn as a replay
//    and the spend vanished. The restart path now seeds the new lifetime's
//    first index from this function.

function migration_0061_provider_correctness_fixes(schema: string): string {
    const s = schema;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_totals(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(tokens_total BIGINT, turns BIGINT, sessions BIGINT) AS $$
    SELECT COALESCE(sum(l.tokens_total), 0), count(*)::BIGINT,
           count(DISTINCT l.session_id)::BIGINT
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            -- A named SHARED provider's TOTAL is open to everyone who may
            -- spend from it; the moment an attribution filter is present
            -- the question becomes admin-only. (Unchanged from 0051.)
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       -- Nothing from before THIS provider took the name.
       AND (p_provider IS NULL OR l.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH rows AS (
        SELECT l.*,
               CASE p_dim
                   WHEN 'session'  THEN l.session_id
                   WHEN 'provider' THEN COALESCE(l.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(l.model_qualified, '(none)')
                   WHEN 'agent'    THEN COALESCE(l.agent_id, '(none)')
                   WHEN 'user'     THEN COALESCE(l.owner_user_id::TEXT,
                                          CASE WHEN l.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(l.provider_name, '(none)')
               END AS dim_key
          FROM ${s}.provider_usage_ledger l
         WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR l.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR l.owner_user_id = p_owner)
           AND (p_provider IS NULL OR l.provider_name = p_provider)
           -- Nothing from before THIS provider took the name.
           AND (p_provider IS NULL OR l.created_at >= COALESCE(
                   (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
                   '-infinity'::timestamptz))
           AND (p_model IS NULL OR l.model_qualified = p_model)
           AND (p_session IS NULL OR l.session_id = p_session)
           AND (p_class IS NULL OR l.charge_class = p_class)
    )
    SELECT g.dim_key,
           CASE p_dim
               WHEN 'session' THEN COALESCE((SELECT ss.title FROM ${s}.sessions ss
                                              WHERE ss.session_id = g.dim_key), g.dim_key)
               WHEN 'user'    THEN COALESCE((SELECT COALESCE(uu.display_name, uu.email, uu.subject)
                                               FROM ${s}.users uu
                                              WHERE uu.user_id::TEXT = g.dim_key), g.dim_key)
               ELSE g.dim_key
           END,
           sum(g.tokens_total)::BIGINT, count(*)::BIGINT
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;

-- The next free settlement index for a session, across every lifetime the
-- ledger has seen. -1+1 = 0 for a session with no spend at all.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_next_turn_index(
    p_session_id TEXT
) RETURNS INTEGER AS $$
    SELECT (COALESCE(MAX(l.turn_index), -1) + 1)::INTEGER
      FROM ${s}.provider_usage_ledger l
     WHERE l.session_id = p_session_id;
$$ LANGUAGE sql STABLE;
`;
}

// ─── Migration 0062: the ledger survives a retained session id ───────
//
// The ledger PK (session_id, turn_index) is the exactly-once settlement
// claim. A restarted system session keeps its session_id while its fresh
// orchestration counts turns from zero, so the new lifetime's indexes
// collide with the old lifetime's rows and ON CONFLICT DO NOTHING reads
// every one as a replay — the spend silently vanishes (live-proved: a
// 31K-token sweeper turn wrote no row).
//
// The orchestration input cannot carry the correction: input.iteration is
// the resume/bootstrap discriminator, and seeding it makes a fresh
// lifetime try to resume a session file it does not have (also
// live-proved — an unbroken resume fail-loop). So the base lives on the
// SESSION ROW, the restart path advances it past every existing row, and
// the settle proc applies it. The orchestration keeps counting from zero;
// only the ledger key moves.

function migration_0062_provider_ledger_base(schema: string): string {
    const s = schema;
    return `
ALTER TABLE ${s}.sessions
    ADD COLUMN IF NOT EXISTS provider_ledger_base INTEGER NOT NULL DEFAULT 0;

-- Advance the base past every ledger row the session id already has.
-- Idempotent: with no new spend, a second bump computes the same base.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_bump_ledger_base(
    p_session_id TEXT
) RETURNS INTEGER AS $$
DECLARE v_base INTEGER;
BEGIN
    SELECT ${s}.cms_provider_next_turn_index(p_session_id) INTO v_base;
    UPDATE ${s}.sessions
       SET provider_ledger_base = v_base
     WHERE session_id = p_session_id;
    RETURN v_base;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_turn(
    p_session_id TEXT, p_turn_index INTEGER, p_provider TEXT, p_model TEXT,
    p_owner BIGINT, p_charge_class TEXT, p_agent_id TEXT,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_total BIGINT := COALESCE(p_in,0) + COALESCE(p_out,0)
                    + COALESCE(p_cache_read,0) + COALESCE(p_cache_write,0);
    v_class TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_charge_class,'')), ''), 'user');
    v_scope TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_model,'')), ''), '*');
    -- The lifetime offset. Stable for the whole turn: only a restart moves
    -- it, and a restart deletes the orchestration mid-turn anyway.
    v_index INTEGER := COALESCE(p_turn_index, 0) + COALESCE(
        (SELECT ss.provider_ledger_base FROM ${s}.sessions ss
          WHERE ss.session_id = p_session_id), 0);
    v_first INTEGER;
BEGIN
    IF p_provider IS NULL THEN v_class := 'unattributed'; END IF;

    INSERT INTO ${s}.provider_usage_ledger
        (session_id, turn_index, provider_name, model_qualified, owner_user_id,
         charge_class, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_write, tokens_total, agent_id)
    VALUES (p_session_id, v_index, p_provider, p_model, p_owner,
            v_class, COALESCE(p_in,0), COALESCE(p_out,0), COALESCE(p_cache_read,0),
            COALESCE(p_cache_write,0), v_total, p_agent_id)
    ON CONFLICT (session_id, turn_index) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    IF v_class <> 'user' OR p_provider IS NULL OR v_total <= 0 THEN
        RETURN TRUE;
    END IF;

    PERFORM 1 FROM ${s}.provider_instances pi
     WHERE pi.name = p_provider FOR KEY SHARE;
    IF NOT FOUND THEN RETURN TRUE; END IF;

    INSERT INTO ${s}.provider_meters
        (provider_name, period, scope, window_key_utc, used_tokens,
         window_start_utc, resets_at_utc)
    SELECT p_provider, per.period, sc.scope, wb.window_key, v_total,
           wb.window_start, wb.resets_at
      FROM (VALUES ('day'),('week'),('month')) AS per(period)
      CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
      CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
     ORDER BY per.period, sc.scope
    ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
        SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
            updated_at = now();

    IF p_owner IS NOT NULL THEN
        INSERT INTO ${s}.provider_meters_user
            (provider_name, period, scope, window_key_utc, user_id, used_tokens,
             window_start_utc, resets_at_utc)
        SELECT p_provider, per.period, sc.scope, wb.window_key, p_owner, v_total,
               wb.window_start, wb.resets_at
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
          CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
         ORDER BY per.period, sc.scope
        ON CONFLICT (provider_name, period, scope, window_key_utc, user_id) DO UPDATE
            SET used_tokens = ${s}.provider_meters_user.used_tokens + EXCLUDED.used_tokens,
                updated_at = now();
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}

// ─── Migration 0063: package editors, and everyone in the picker ─────
//
// Two things, one migration, because they ship together.
//
// EDITORS. A shared package's owner can grant named users WRITE access:
// publish a new version, republish into it, pin, enable/disable. Never
// scope changes, delete, or the editor list itself — those stay with the
// owner (or an admin). The grant lives on the SHARED row only, and it is
// deleted when that row is demoted to user scope: unsharing revokes. A
// personal copy is a different row and never inherits a grant.
//
// The table keys on users.user_id like session_shares does, and the grant
// path creates the grantee row create-only (0033's rule): a person who has
// never signed in can be granted, and the 0032 email adoption folds them
// into the real principal on first login.
//
// THE PICKER. cms_list_users hid every row whose display_name was NULL —
// which is every Entra sign-in whose access token carries no `name` claim.
// The user exists (0042 registers them at login) and is invisible to every
// share dialog. Widen to "has a name OR an email"; a row with neither is
// still the raw-id-grant placeholder the original filter meant to hide.
//
// Every function below that already existed is CREATE OR REPLACE'd here in
// full: editing an applied migration in place is a silent no-op.

function migration_0063_agent_package_editors(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.agent_package_editors (
    package_id TEXT        NOT NULL REFERENCES ${s}.agent_packages(package_id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES ${s}.users(user_id),
    granted_by BIGINT      REFERENCES ${s}.users(user_id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (package_id, user_id)
);
CREATE INDEX IF NOT EXISTS agent_package_editors_user_idx ON ${s}.agent_package_editors (user_id);

-- Is this principal an editor of this package row?
CREATE OR REPLACE FUNCTION ${s}.cms_agent_package_is_editor(
    p_package_id TEXT, p_provider TEXT, p_subject TEXT
) RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
          FROM ${s}.agent_package_editors e
          JOIN ${s}.users u ON u.user_id = e.user_id
         WHERE e.package_id = p_package_id
           AND u.provider = NULLIF(BTRIM(p_provider), '')
           AND u.subject  = NULLIF(BTRIM(p_subject), '')
    );
$$ LANGUAGE sql STABLE;

-- ── Authz gains an editor mode ───────────────────────────────────
--
-- One new trailing argument with a default, so the existing seven-argument
-- callers (delete, and anything else that must stay owner-only) keep
-- resolving to this function unchanged. The seven-argument overload is
-- dropped first: leaving it would make every seven-argument call ambiguous.
DROP FUNCTION IF EXISTS ${s}.cms_agent_package_authz(TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION ${s}.cms_agent_package_authz(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT,
    p_allow_editor BOOLEAN DEFAULT FALSE
) RETURNS ${s}.agent_packages AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_id  TEXT;
    v_count INT;
    v_is_owner BOOLEAN;
BEGIN
    v_id := ${s}.cms_resolve_agent_package_id(
        p_name, p_actor_provider, p_actor_subject,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, FALSE);

    -- Editors do not own a copy, so "my copy, then shared" finds nothing for
    -- them when they omit the selector. Fall through to the shared copy,
    -- which is the only row an editor grant can exist on.
    IF v_id IS NULL AND p_allow_editor AND p_sel_scope IS NULL THEN
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'shared';
    END IF;

    -- Admin fallback (0043): NULL-owner rows and other users' private rows
    -- have no owner triple to select by; refuse ambiguity rather than guess.
    IF v_id IS NULL AND p_is_admin AND p_sel_scope IS NULL THEN
        SELECT count(*) INTO v_count FROM ${s}.agent_packages p WHERE p.name = p_name;
        IF v_count > 1 THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_AMBIGUOUS: % copies of "%" exist; name an owner or scope to pick one', v_count, p_name;
        END IF;
        SELECT p.package_id INTO v_id FROM ${s}.agent_packages p WHERE p.name = p_name;
    END IF;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
    END IF;

    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id = v_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
    END IF;

    v_is_owner := v_pkg.owner_provider IS NOT NULL
        AND v_pkg.owner_provider IS NOT DISTINCT FROM NULLIF(BTRIM(p_actor_provider), '')
        AND v_pkg.owner_subject  IS NOT DISTINCT FROM NULLIF(BTRIM(p_actor_subject), '');

    IF p_is_admin OR v_is_owner THEN
        RETURN v_pkg;
    END IF;
    IF p_allow_editor AND ${s}.cms_agent_package_is_editor(v_pkg.package_id, p_actor_provider, p_actor_subject) THEN
        RETURN v_pkg;
    END IF;
    IF p_allow_editor THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator, an editor, or an admin can modify "%"', p_name;
    END IF;
    RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can modify "%"', p_name;
END;
$$ LANGUAGE plpgsql;

-- ── Editor-level mutations: enable/disable and pin ───────────────
CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_enabled(
    p_name TEXT, p_enabled BOOLEAN, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, TRUE);
    UPDATE ${s}.agent_packages SET enabled = p_enabled WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_pin_agent_package_version(
    p_name TEXT, p_semver TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_version_id TEXT;
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, TRUE);
    SELECT version_id INTO v_version_id FROM ${s}.agent_package_versions
     WHERE package_id = v_pkg.package_id AND semver = p_semver;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_VERSION_NOT_FOUND: %@% is not a published version', p_name, p_semver;
    END IF;
    UPDATE ${s}.agent_packages SET active_version_id = v_version_id WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- ── Scope change stays owner-only; demotion revokes every editor ─
CREATE OR REPLACE FUNCTION ${s}.cms_set_agent_package_scope(
    p_name TEXT, p_scope TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_clash TEXT;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);

    IF p_scope = 'shared' AND v_pkg.scope <> 'shared' THEN
        SELECT p.package_id INTO v_clash FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'shared';
        IF v_clash IS NOT NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NAME_TAKEN: a shared package named "%" already exists; rename before promoting', p_name;
        END IF;
    END IF;

    IF p_scope = 'user' AND v_pkg.scope <> 'user' THEN
        IF v_pkg.owner_provider IS NULL OR v_pkg.owner_subject IS NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NO_OWNER: "%" has no owner identity to demote to', p_name;
        END IF;
        SELECT p.package_id INTO v_clash FROM ${s}.agent_packages p
         WHERE p.name = p_name AND p.scope = 'user'
           AND p.owner_provider = v_pkg.owner_provider
           AND p.owner_subject = v_pkg.owner_subject;
        IF v_clash IS NOT NULL THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_NAME_TAKEN: that owner already has a user-scope package named "%"', p_name;
        END IF;
        -- Unsharing revokes. Same statement, same transaction: a failed
        -- demotion above leaves the grants exactly as they were.
        DELETE FROM ${s}.agent_package_editors WHERE package_id = v_pkg.package_id;
    END IF;

    UPDATE ${s}.agent_packages SET scope = p_scope WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- ── Publish: an editor may add versions to the shared package ────
--
-- Body is 0043's, with one change at the existing-package gate. The row
-- keeps its owner: an editor's publish never reassigns the package.
CREATE OR REPLACE FUNCTION ${s}.cms_publish_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_name TEXT, p_scope TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT, p_source_id TEXT,
    p_semver TEXT, p_sha256 TEXT, p_size_bytes BIGINT, p_artifact_filename TEXT,
    p_commit_sha TEXT, p_manifest JSONB, p_created_by TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(status TEXT, package_id TEXT, version_id TEXT) AS $$
DECLARE
    v_pkg RECORD;
    v_ver RECORD;
    v_owner_provider TEXT := NULLIF(BTRIM(p_owner_provider), '');
    v_owner_subject  TEXT := NULLIF(BTRIM(p_owner_subject), '');
    v_is_owner BOOLEAN;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;

    IF LOWER(BTRIM(p_name)) LIKE '\\_\\_%' THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_RESERVED_NAME: "%" uses the reserved "__" prefix', p_name;
    END IF;

    IF NOT p_is_admin AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: publishing without an owner identity requires the admin role';
    END IF;

    <<retry>>
    LOOP
        SELECT * INTO v_pkg FROM ${s}.agent_packages p
         WHERE p.name = p_name
           AND p.scope = p_scope
           AND (p_scope = 'shared'
                OR (p.owner_provider IS NOT DISTINCT FROM v_owner_provider
                    AND p.owner_subject IS NOT DISTINCT FROM v_owner_subject))
         FOR UPDATE;
        IF NOT FOUND THEN
            BEGIN
                INSERT INTO ${s}.agent_packages
                    (package_id, source_id, name, scope, owner_provider, owner_subject, created_by)
                VALUES (p_package_id, p_source_id, p_name, p_scope,
                        v_owner_provider, v_owner_subject, p_created_by);
            EXCEPTION WHEN unique_violation THEN
                CONTINUE retry;
            END;
            INSERT INTO ${s}.agent_package_versions
                (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
            VALUES (p_version_id, p_package_id, p_semver, p_sha256, p_size_bytes,
                    p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
            UPDATE ${s}.agent_packages SET active_version_id = p_version_id WHERE ${s}.agent_packages.package_id = p_package_id;
            PERFORM ${s}.cms_agent_registry_bump();
            RETURN QUERY SELECT 'published'::TEXT, p_package_id, p_version_id;
            RETURN;
        END IF;
        EXIT retry;
    END LOOP;

    v_is_owner := v_pkg.owner_provider IS NOT NULL
        AND v_pkg.owner_provider IS NOT DISTINCT FROM v_owner_provider
        AND v_pkg.owner_subject  IS NOT DISTINCT FROM v_owner_subject;
    IF NOT p_is_admin AND NOT v_is_owner
       AND NOT ${s}.cms_agent_package_is_editor(v_pkg.package_id, v_owner_provider, v_owner_subject) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: only the package creator, an editor, or an admin can publish new versions of "%"', p_name;
    END IF;

    SELECT * INTO v_ver FROM ${s}.agent_package_versions v
     WHERE v.package_id = v_pkg.package_id AND v.semver = p_semver;
    IF FOUND THEN
        IF v_ver.sha256 = p_sha256 THEN
            RETURN QUERY SELECT 'noop'::TEXT, v_pkg.package_id, v_ver.version_id;
            RETURN;
        END IF;
        RAISE EXCEPTION 'AGENT_PACKAGE_SEMVER_CONFLICT: %@% is already published with different content — published versions are immutable, bump the version', p_name, p_semver;
    END IF;

    INSERT INTO ${s}.agent_package_versions
        (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
    VALUES (p_version_id, v_pkg.package_id, p_semver, p_sha256, p_size_bytes,
            p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
    UPDATE ${s}.agent_packages
       SET active_version_id = p_version_id,
           source_id = COALESCE(p_source_id, ${s}.agent_packages.source_id)
     WHERE ${s}.agent_packages.package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
    RETURN QUERY SELECT 'published'::TEXT, v_pkg.package_id, p_version_id;
END;
$$ LANGUAGE plpgsql;

-- ── Grant / revoke / list ────────────────────────────────────────
--
-- All three pin the SHARED copy: editors only exist there. Grant and revoke
-- are owner-or-admin (authz without editor mode). No registry epoch bump:
-- who may edit changes nothing a worker installs.
-- The shared copy of a name, or a legible refusal. Resolving with the
-- selector pinned to 'shared' returns nothing when only a private copy
-- exists, and "does not exist" is the wrong answer to give the person who
-- owns that copy. So: no shared copy AND the actor can see a copy → NOT_SHARED;
-- no copy the actor can see → NOT_FOUND.
CREATE OR REPLACE FUNCTION ${s}.cms_agent_package_require_shared(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM ${s}.agent_packages p WHERE p.name = p_name AND p.scope = 'shared') THEN
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM ${s}.agent_packages p
         WHERE p.name = p_name
           AND (p_is_admin
                OR (p.owner_provider = NULLIF(BTRIM(p_actor_provider), '')
                    AND p.owner_subject = NULLIF(BTRIM(p_actor_subject), '')))
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_SHARED: "%" is not shared; editors exist only on a shared package — promote it first', p_name;
    END IF;
    RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: package "%" does not exist', p_name;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_grant_agent_package_editor(
    p_name TEXT, p_provider TEXT, p_subject TEXT,
    p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_user_id BIGINT;
    v_granted_by BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'Grantee provider and subject are required';
    END IF;
    PERFORM ${s}.cms_agent_package_require_shared(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin, 'shared', NULL, NULL);
    IF v_pkg.owner_provider = v_provider AND v_pkg.owner_subject = v_subject THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_EDITOR_IS_OWNER: the owner of "%" already has full access', p_name;
    END IF;

    -- Create-only (0033): a grant never rewrites a sighted user's identity.
    INSERT INTO ${s}.users (provider, subject)
    VALUES (v_provider, v_subject)
    ON CONFLICT (provider, subject) DO NOTHING;
    SELECT u.user_id INTO v_user_id FROM ${s}.users u
     WHERE u.provider = v_provider AND u.subject = v_subject;

    SELECT u.user_id INTO v_granted_by FROM ${s}.users u
     WHERE u.provider = NULLIF(BTRIM(p_actor_provider), '')
       AND u.subject  = NULLIF(BTRIM(p_actor_subject), '');

    INSERT INTO ${s}.agent_package_editors (package_id, user_id, granted_by)
    VALUES (v_pkg.package_id, v_user_id, v_granted_by)
    ON CONFLICT (package_id, user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_revoke_agent_package_editor(
    p_name TEXT, p_provider TEXT, p_subject TEXT,
    p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE
    v_pkg ${s}.agent_packages;
BEGIN
    PERFORM ${s}.cms_agent_package_require_shared(p_name, p_actor_provider, p_actor_subject, p_is_admin);
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin, 'shared', NULL, NULL);
    DELETE FROM ${s}.agent_package_editors e
     USING ${s}.users u
     WHERE e.package_id = v_pkg.package_id
       AND u.user_id = e.user_id
       AND u.provider = NULLIF(BTRIM(p_provider), '')
       AND u.subject  = NULLIF(BTRIM(p_subject), '');
END;
$$ LANGUAGE plpgsql;

-- Anyone who can see the shared package can see its editors: this is a
-- trusted system, and who may edit a shared agent is not a secret.
CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_package_editors(
    p_name TEXT
) RETURNS TABLE(
    provider TEXT, subject TEXT, email TEXT, display_name TEXT,
    granted_at TIMESTAMPTZ, granted_by_display TEXT
) AS $$
BEGIN
    -- "No editors" and "no such shared package" must not look the same.
    IF NOT EXISTS (SELECT 1 FROM ${s}.agent_packages p WHERE p.name = p_name AND p.scope = 'shared') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_NOT_FOUND: there is no shared package named "%"', p_name;
    END IF;
    RETURN QUERY
    SELECT u.provider, u.subject, u.email, u.display_name,
           e.granted_at,
           COALESCE(g.display_name, g.email, g.subject) AS granted_by_display
      FROM ${s}.agent_packages p
      JOIN ${s}.agent_package_editors e ON e.package_id = p.package_id
      JOIN ${s}.users u ON u.user_id = e.user_id
      LEFT JOIN ${s}.users g ON g.user_id = e.granted_by
     WHERE p.name = p_name AND p.scope = 'shared'
     ORDER BY e.granted_at, u.user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── Reads carry can_edit ─────────────────────────────────────────
DROP FUNCTION IF EXISTS ${s}.cms_list_agent_packages(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS ${s}.cms_get_agent_package(TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION ${s}.cms_list_agent_packages(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, semver TEXT, sha256 TEXT, size_bytes BIGINT,
    artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT,
    shadowed BOOLEAN, can_edit BOOLEAN
) AS $$
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by,
           (p.scope = 'shared' AND EXISTS (
                SELECT 1 FROM ${s}.agent_packages o
                 WHERE o.name = p.name AND o.scope = 'user' AND o.enabled
                   AND o.owner_provider = BTRIM(p_viewer_provider)
                   AND o.owner_subject  = BTRIM(p_viewer_subject)
           )) AS shadowed,
           (p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
            OR ${s}.cms_agent_package_is_editor(p.package_id, p_viewer_provider, p_viewer_subject)
           ) AS can_edit
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.scope = 'shared'
        OR p_is_admin
        OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
     ORDER BY p.name, p.scope, p.owner_provider, p.owner_subject;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(
    package_id TEXT, source_id TEXT, name TEXT, scope TEXT,
    owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT,
    enabled BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ,
    active_version_id TEXT, version_id TEXT, semver TEXT, sha256 TEXT,
    size_bytes BIGINT, artifact_filename TEXT, commit_sha TEXT, manifest JSONB,
    version_created_at TIMESTAMPTZ, version_created_by TEXT,
    can_edit BOOLEAN
) AS $$
DECLARE
    v_id TEXT;
    v_count INT;
BEGIN
    v_id := ${s}.cms_resolve_agent_package_id(
        p_name, p_viewer_provider, p_viewer_subject,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, TRUE);
    IF v_id IS NULL THEN
        v_id := ${s}.cms_resolve_agent_package_id(
            p_name, p_viewer_provider, p_viewer_subject,
            p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, FALSE);
    END IF;

    IF v_id IS NULL AND p_is_admin AND p_sel_scope IS NULL THEN
        SELECT count(*) INTO v_count FROM ${s}.agent_packages p WHERE p.name = p_name;
        IF v_count = 1 THEN
            SELECT p.package_id INTO v_id FROM ${s}.agent_packages p WHERE p.name = p_name;
        END IF;
    END IF;

    IF v_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT p.package_id, p.source_id, p.name, p.scope,
           p.owner_provider, p.owner_subject,
           u.email, u.display_name,
           p.enabled, p.created_by, p.created_at, p.active_version_id,
           v.version_id, v.semver, v.sha256, v.size_bytes,
           v.artifact_filename, v.commit_sha, v.manifest, v.created_at, v.created_by,
           (p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject))
            OR ${s}.cms_agent_package_is_editor(p.package_id, p_viewer_provider, p_viewer_subject)
           ) AS can_edit
      FROM ${s}.agent_packages p
      LEFT JOIN ${s}.agent_package_versions v ON v.package_id = p.package_id
      LEFT JOIN ${s}.users u
             ON u.provider = p.owner_provider AND u.subject = p.owner_subject
     WHERE p.package_id = v_id
       AND (p.scope = 'shared' OR p_is_admin
            OR (p.owner_provider = BTRIM(p_viewer_provider) AND p.owner_subject = BTRIM(p_viewer_subject)))
     ORDER BY v.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── The picker: a name OR an email makes a user findable ─────────
CREATE OR REPLACE FUNCTION ${s}.cms_list_users(
    p_limit INT
) RETURNS TABLE (
    provider     TEXT,
    subject      TEXT,
    email        TEXT,
    display_name TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
BEGIN
    RETURN QUERY
    SELECT u.provider, u.subject, u.email, u.display_name
    FROM ${s}.users u
    WHERE NOT (u.provider = 'system' AND u.subject = 'system')
      AND NOT (u.provider = 'local' AND u.subject = 'default')
      -- The no-auth provider's anonymous principal is not a person either.
      AND NOT (u.provider = 'none')
      -- Sighted members carry a name or an email (0042 writes both from the
      -- token when present). A row with neither is a raw-id grant
      -- placeholder and stays hidden until that person signs in.
      AND (u.display_name IS NOT NULL OR u.email IS NOT NULL)
    ORDER BY u.updated_at DESC, u.user_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

-- ── Ghost adoption must carry editor grants across ───────────────
--
-- 0032's cms_register_user adopts email-keyed placeholder rows on a real
-- user's first sighting: shares move to the real user and the placeholder
-- is deleted. agent_package_editors also references users(user_id), so a
-- placeholder that was granted an editor row blocked that DELETE with an FK
-- violation — and the whole registration rolled back, which meant the
-- person could not sign in. Same body as 0032 plus the editor re-pointing.
CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_email    TEXT := NULLIF(BTRIM(p_email), '');
    v_display  TEXT := NULLIF(BTRIM(p_display_name), '');
    v_user_id  BIGINT;
    v_ghost    BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;

    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (v_provider, v_subject, v_email, v_display)
    ON CONFLICT (provider, subject) DO UPDATE
    SET email        = COALESCE(EXCLUDED.email, ${s}.users.email),
        display_name = COALESCE(EXCLUDED.display_name, ${s}.users.display_name),
        updated_at   = now()
    WHERE COALESCE(EXCLUDED.email, ${s}.users.email) IS DISTINCT FROM ${s}.users.email
       OR COALESCE(EXCLUDED.display_name, ${s}.users.display_name) IS DISTINCT FROM ${s}.users.display_name;

    SELECT user_id INTO v_user_id
    FROM ${s}.users
    WHERE provider = v_provider AND subject = v_subject;

    IF v_email IS NOT NULL THEN
        FOR v_ghost IN
            SELECT u.user_id FROM ${s}.users u
            WHERE u.provider = v_provider
              AND LOWER(u.subject) = LOWER(v_email)
              AND u.user_id <> v_user_id
        LOOP
            UPDATE ${s}.session_shares ss SET user_id = v_user_id
            WHERE ss.user_id = v_ghost
              AND NOT EXISTS (
                  SELECT 1 FROM ${s}.session_shares e
                  WHERE e.session_id = ss.session_id AND e.user_id = v_user_id
              );
            UPDATE ${s}.session_shares e SET access = 'write'
            FROM ${s}.session_shares g
            WHERE g.user_id = v_ghost AND g.session_id = e.session_id
              AND e.user_id = v_user_id AND g.access = 'write' AND e.access <> 'write';
            DELETE FROM ${s}.session_shares WHERE user_id = v_ghost;
            UPDATE ${s}.session_shares SET granted_by = v_user_id WHERE granted_by = v_ghost;
            -- Editor grants: move the ones the real user does not already
            -- hold, drop the duplicates, re-point granted_by.
            UPDATE ${s}.agent_package_editors ge SET user_id = v_user_id
            WHERE ge.user_id = v_ghost
              AND NOT EXISTS (
                  SELECT 1 FROM ${s}.agent_package_editors e
                  WHERE e.package_id = ge.package_id AND e.user_id = v_user_id
              );
            DELETE FROM ${s}.agent_package_editors WHERE user_id = v_ghost;
            UPDATE ${s}.agent_package_editors SET granted_by = v_user_id WHERE granted_by = v_ghost;
            UPDATE ${s}.session_owners SET user_id = v_user_id WHERE user_id = v_ghost;
            UPDATE ${s}.session_group_owners SET user_id = v_user_id WHERE user_id = v_ghost;
            DELETE FROM ${s}.users WHERE user_id = v_ghost;
        END LOOP;
    END IF;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0064: the canvas KV store ─────────────────────────────
//
// Shared, durable, per-key state for interactive canvas apps
// (docs/proposals/interactive-canvas-apps.md Part C). One row per
// (session, slot, key); the value is the envelope {v, by, at}; `rev` is the
// compare-and-swap token; deletes are tombstones (rev still advances, so a
// live viewer drops the key and a late joiner never sees it).
//
// The rows live HERE, in the CMS, not in the facts table the proposal first
// named: the facts store can be a different database (HorizonDB), and the
// write must be atomic with its NOTIFY on the CMS connection. One statement
// does the CAS check, the quota check, the upsert and the notify, so two
// writers on one key serialize on the row and two viewers never see a
// write without its ping.
//
// session_canvases gains the per-canvas access policy (Part D: who may
// write) and the manifest's `kv` block cached at draw time (the app's half
// of the switch), so a write never has to re-read the document.

function migration_0064_canvas_kv(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.session_canvases
    ADD COLUMN IF NOT EXISTS kv_access TEXT NOT NULL DEFAULT 'owner'
        CHECK (kv_access IN ('owner', 'readers', 'link'));
ALTER TABLE ${s}.session_canvases
    ADD COLUMN IF NOT EXISTS kv_manifest JSONB;

CREATE TABLE IF NOT EXISTS ${s}.canvas_kv (
    session_id TEXT        NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    slot       SMALLINT    NOT NULL CHECK (slot BETWEEN 1 AND 5),
    key        TEXT        NOT NULL,
    value      JSONB       NOT NULL,
    rev        BIGINT      NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, slot, key)
);

-- Policy + manifest switch, upserting the 0045 row when the canvas has
-- never been drawn (an owner may set the policy before the first draw).
CREATE OR REPLACE FUNCTION ${s}.cms_set_canvas_kv_access(
    p_session_id TEXT, p_slot INT, p_access TEXT
) RETURNS VOID AS $$
BEGIN
    IF p_access NOT IN ('owner', 'readers', 'link') THEN
        RAISE EXCEPTION 'CANVAS_KV_BAD_ACCESS: kv-access must be owner, readers or link, got "%"', p_access;
    END IF;
    INSERT INTO ${s}.session_canvases (session_id, slot, name, latest_rev, size_bytes, kv_access, updated_at)
    VALUES (p_session_id, p_slot, '', 0, NULL, p_access, now())
    ON CONFLICT (session_id, slot) DO UPDATE SET kv_access = EXCLUDED.kv_access, updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_set_canvas_kv_manifest(
    p_session_id TEXT, p_slot INT, p_manifest JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_canvases (session_id, slot, name, latest_rev, size_bytes, kv_manifest, updated_at)
    VALUES (p_session_id, p_slot, '', 0, NULL, p_manifest, now())
    ON CONFLICT (session_id, slot) DO UPDATE SET kv_manifest = EXCLUDED.kv_manifest, updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_canvas_kv_settings(
    p_session_id TEXT, p_slot INT
) RETURNS TABLE(kv_access TEXT, kv_manifest JSONB, latest_rev INTEGER) AS $$
    SELECT c.kv_access, c.kv_manifest, c.latest_rev
      FROM ${s}.session_canvases c
     WHERE c.session_id = p_session_id AND c.slot = p_slot;
$$ LANGUAGE sql STABLE;

-- The write. p_value NULL = delete. p_if_match NULL = no CAS; 0 = the key
-- must not be live (claim); N = the live rev must be N. Statuses:
--   written | deleted | not_found | conflict | too_large | quota_keys | quota_bytes
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_kv_write(
    p_session_id TEXT, p_slot INT, p_key TEXT, p_value JSONB, p_if_match BIGINT,
    p_max_keys INT, p_max_bytes BIGINT, p_max_value_bytes INT, p_schema TEXT
) RETURNS TABLE(status TEXT, rev BIGINT, size_bytes INT) AS $$
DECLARE
    v_rev BIGINT;
    v_deleted TIMESTAMPTZ;
    v_found BOOLEAN;
    v_live BOOLEAN;
    v_size INT;
    v_keys BIGINT;
    v_bytes BIGINT;
    v_new_rev BIGINT;
BEGIN
    SELECT k.rev, k.deleted_at INTO v_rev, v_deleted
      FROM ${s}.canvas_kv k
     WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.key = p_key
       FOR UPDATE;
    v_found := FOUND;
    v_live := v_found AND v_deleted IS NULL;

    IF p_if_match IS NOT NULL THEN
        IF (p_if_match = 0 AND v_live) OR (p_if_match <> 0 AND (NOT v_live OR v_rev <> p_if_match)) THEN
            RETURN QUERY SELECT 'conflict'::TEXT, COALESCE(v_rev, 0)::BIGINT, NULL::INT;
            RETURN;
        END IF;
    END IF;

    IF p_value IS NULL THEN
        IF NOT v_live THEN
            RETURN QUERY SELECT 'not_found'::TEXT, COALESCE(v_rev, 0)::BIGINT, NULL::INT;
            RETURN;
        END IF;
        UPDATE ${s}.canvas_kv k SET deleted_at = now(), rev = k.rev + 1, updated_at = now()
         WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.key = p_key
         RETURNING k.rev INTO v_new_rev;
        PERFORM pg_notify('pilotswarm_canvas_live', json_build_object(
            'schema', p_schema, 'sessionId', p_session_id, 'slot', p_slot,
            'kind', 'kv', 'key', p_key, 'rev', v_new_rev, 'op', 'delete')::text);
        RETURN QUERY SELECT 'deleted'::TEXT, v_new_rev, 0;
        RETURN;
    END IF;

    v_size := octet_length(p_value::text);
    IF v_size > p_max_value_bytes THEN
        RETURN QUERY SELECT 'too_large'::TEXT, COALESCE(v_rev, 0)::BIGINT, v_size;
        RETURN;
    END IF;

    -- Budget check against every OTHER live key of this canvas.
    SELECT count(*), COALESCE(sum(octet_length(k.value::text)), 0) INTO v_keys, v_bytes
      FROM ${s}.canvas_kv k
     WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.deleted_at IS NULL AND k.key <> p_key;
    IF NOT v_live AND v_keys + 1 > p_max_keys THEN
        RETURN QUERY SELECT 'quota_keys'::TEXT, COALESCE(v_rev, 0)::BIGINT, v_size;
        RETURN;
    END IF;
    IF v_bytes + v_size > p_max_bytes THEN
        RETURN QUERY SELECT 'quota_bytes'::TEXT, COALESCE(v_rev, 0)::BIGINT, v_size;
        RETURN;
    END IF;

    -- A claim (if_match = 0) must not become an update under a concurrent
    -- first insert: the upsert only resurrects a tombstone, never overwrites
    -- a live row, and a missing RETURNING row is reported as a conflict.
    IF p_if_match = 0 THEN
        INSERT INTO ${s}.canvas_kv (session_id, slot, key, value, rev, deleted_at, updated_at)
        VALUES (p_session_id, p_slot, p_key, p_value, 1, NULL, now())
        ON CONFLICT (session_id, slot, key) DO UPDATE SET
            value = EXCLUDED.value, rev = ${s}.canvas_kv.rev + 1, deleted_at = NULL, updated_at = now()
        WHERE ${s}.canvas_kv.deleted_at IS NOT NULL
        RETURNING ${s}.canvas_kv.rev INTO v_new_rev;
        IF v_new_rev IS NULL THEN
            RETURN QUERY SELECT 'conflict'::TEXT, COALESCE(v_rev, 0)::BIGINT, v_size;
            RETURN;
        END IF;
    ELSE
        INSERT INTO ${s}.canvas_kv (session_id, slot, key, value, rev, deleted_at, updated_at)
        VALUES (p_session_id, p_slot, p_key, p_value, 1, NULL, now())
        ON CONFLICT (session_id, slot, key) DO UPDATE SET
            value = EXCLUDED.value, rev = ${s}.canvas_kv.rev + 1, deleted_at = NULL, updated_at = now()
        RETURNING ${s}.canvas_kv.rev INTO v_new_rev;
    END IF;

    -- The value rides the ping when the envelope is small; a bigger value
    -- ships a pointer and the viewer fetches that one key. pg_notify hard
    -- errors past 8000 bytes and that would roll back the write.
    PERFORM pg_notify('pilotswarm_canvas_live', (
        SELECT CASE WHEN octet_length(m.with_value) <= 7000 THEN m.with_value ELSE m.pointer END
          FROM (SELECT
                json_build_object('schema', p_schema, 'sessionId', p_session_id, 'slot', p_slot,
                    'kind', 'kv', 'key', p_key, 'rev', v_new_rev, 'op', 'put', 'value', p_value)::text AS with_value,
                json_build_object('schema', p_schema, 'sessionId', p_session_id, 'slot', p_slot,
                    'kind', 'kv', 'key', p_key, 'rev', v_new_rev, 'op', 'put')::text AS pointer) m));
    RETURN QUERY SELECT 'written'::TEXT, v_new_rev, v_size;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_kv_get(
    p_session_id TEXT, p_slot INT, p_key TEXT
) RETURNS TABLE(key TEXT, value JSONB, rev BIGINT, updated_at TIMESTAMPTZ) AS $$
    SELECT k.key, k.value, k.rev, k.updated_at
      FROM ${s}.canvas_kv k
     WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.key = p_key AND k.deleted_at IS NULL;
$$ LANGUAGE sql STABLE;

-- Prefix listing, key-ordered, cursor = the last key of the previous page.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_kv_list(
    p_session_id TEXT, p_slot INT, p_prefix TEXT, p_limit INT, p_after_key TEXT
) RETURNS TABLE(key TEXT, value JSONB, rev BIGINT, updated_at TIMESTAMPTZ) AS $$
    SELECT k.key, k.value, k.rev, k.updated_at
      FROM ${s}.canvas_kv k
     WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.deleted_at IS NULL
       AND (p_prefix IS NULL OR p_prefix = '' OR left(k.key, length(p_prefix)) = p_prefix)
       AND (p_after_key IS NULL OR k.key > p_after_key)
     ORDER BY k.key
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 200));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_kv_stats(
    p_session_id TEXT, p_slot INT
) RETURNS TABLE(keys BIGINT, bytes BIGINT) AS $$
    SELECT count(*)::BIGINT, COALESCE(sum(octet_length(k.value::text)), 0)::BIGINT
      FROM ${s}.canvas_kv k
     WHERE k.session_id = p_session_id AND k.slot = p_slot AND k.deleted_at IS NULL;
$$ LANGUAGE sql STABLE;
`;
}

function migration_0065_personal_provider_credential_update(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_update_personal_credential(
    p_name TEXT, p_secret JSONB, p_actor BIGINT
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to update a provider of your own';
    END IF;

    RETURN QUERY
    UPDATE ${s}.provider_instances pi
       SET secret_ref = p_secret
     WHERE pi.name = p_name
       AND pi.class = 'personal'
       AND pi.owner_user_id = p_actor
    RETURNING pi.name, pi.type_id, pi.class, pi.owner_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}

/**
 * 0066: an update must not throw away the provider's API version, and must
 * mark the row as touched.
 *
 * 0065 replaced the whole secret_ref blob with what the caller sent. The
 * caller is a credential form, so it sends one field — {apiKey} or
 * {githubToken} — and normalizeCallerSecret only keeps apiVersion if it is
 * handed one. Anything pinned on the provider was silently dropped.
 *
 * That matters for azure-openai, the type most likely to be pinned:
 * provider-catalog reads secret_ref.apiVersion and otherwise falls back to
 * the type default (or "2024-10-21"), so rotating an expired key quietly
 * moved the provider to a different API version with nothing said anywhere.
 * The delete-and-recreate workflow this feature replaces did not have that
 * problem, because create carries the whole credentials object.
 *
 * So: carry the stored apiVersion forward unless the caller states one. A
 * caller who sends apiVersion still wins, which is how you change it.
 *
 * updated_at was also never set, so a rotation left created_at == updated_at
 * and no trace of the change on the row at all.
 */
function migration_0066_personal_credential_update_preserves_api_version(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_update_personal_credential(
    p_name TEXT, p_secret JSONB, p_actor BIGINT
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to update a provider of your own';
    END IF;

    RETURN QUERY
    UPDATE ${s}.provider_instances pi
       SET secret_ref = CASE
               -- The caller stated a version: they win, that is how it changes.
               WHEN p_secret ? 'apiVersion' THEN p_secret
               -- They did not, and one is pinned: carry it forward.
               WHEN pi.secret_ref ? 'apiVersion'
                   THEN p_secret || jsonb_build_object('apiVersion', pi.secret_ref -> 'apiVersion')
               ELSE p_secret
           END,
           updated_at = now()
     WHERE pi.name = p_name
       AND pi.class = 'personal'
       AND pi.owner_user_id = p_actor
    RETURNING pi.name, pi.type_id, pi.class, pi.owner_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}

/**
 * 0067: rotate a SHARED provider's key, and stop both update paths stomping
 * anything but the key.
 *
 * Two things.
 *
 * 1. Shared providers had no way to rotate a credential at all — Update Key
 *    was personal-only, so an expired cluster key meant delete-and-recreate,
 *    which drops the CLUSTER DEFAULT flag, the allowance, any hold, the
 *    system-use routing and the usage history. Exactly what the feature exists
 *    to preserve. Admin-only, via the same cms_provider_assert_manage the
 *    other shared mutations use: a personal name reads as absent even to an
 *    admin, and a non-admin gets PROVIDER_FORBIDDEN on a shared one.
 *
 * 2. Both paths now MERGE rather than replace. 0066 special-cased apiVersion
 *    because that was the field observed getting lost, but the shape of the
 *    bug was general: the caller is a credential form, it sends one field, and
 *    a whole-blob replace drops every other thing stored beside it — apiVersion
 *    yesterday, whatever gets added tomorrow. `stored || incoming` keeps
 *    everything and still lets a caller change any field by stating it.
 *
 * The row itself was never at risk on either path: the UPDATE only ever
 * touched secret_ref, so base_url, class, owner, allowance, holds, defaults
 * and system-use routing were always preserved. This is about the blob.
 */
function migration_0067_shared_provider_credential_update(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_update_personal_credential(
    p_name TEXT, p_secret JSONB, p_actor BIGINT
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: sign in to update a provider of your own';
    END IF;

    RETURN QUERY
    UPDATE ${s}.provider_instances pi
       -- Merge, do not replace: metadata already stored survives unless the
       -- caller states it. Supersedes 0066's apiVersion-only carry-forward.
       --
       -- But strip every credential-bearing key from the preserved side first.
       -- A rotation must not leave the OLD secret sitting in the blob under
       -- whatever name it was originally stored as. Merging naively kept
       -- token/apiKey/githubToken from creation beside the new value, which is
       -- a rotated key that did not actually retire.
       SET secret_ref = (COALESCE(pi.secret_ref, '{}'::jsonb)
                           - 'value' - 'kind' - 'token' - 'apiKey' - 'githubToken' - 'key' - 'ref' - 'source')
                        || p_secret,
           updated_at = now()
     WHERE pi.name = p_name
       AND pi.class = 'personal'
       AND pi.owner_user_id = p_actor
    RETURNING pi.name, pi.type_id, pi.class, pi.owner_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_update_shared_credential(
    p_name TEXT, p_secret JSONB, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(name TEXT, type_id TEXT, class TEXT, owner_user_id BIGINT) AS $$
DECLARE v_row ${s}.provider_instances;
BEGIN
    -- Reuses the shared manage gate, so the refusals match every other shared
    -- mutation exactly: personal reads as NOT_FOUND even for an admin, and a
    -- non-admin gets FORBIDDEN on a shared name.
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);

    IF v_row.class <> 'shared' THEN
        RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', p_name;
    END IF;

    -- A provider seeded from the deployment's model-providers file holds a
    -- POINTER to its secret (ref: env:AZURE_KEY, source: config-file), not the
    -- secret. That is the one arrangement under which no key is ever copied
    -- into the database, and rotating it here would silently replace the
    -- pointer with a literal value: from then on rotating the environment
    -- variable would do nothing for this provider. Refuse, and say where the
    -- key actually lives.
    IF v_row.secret_ref ->> 'source' = 'config-file' THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: "%" takes its key from the deployment configuration (%); rotate that variable instead',
            p_name, COALESCE(v_row.secret_ref ->> 'ref', 'the model-providers file');
    END IF;

    RETURN QUERY
    UPDATE ${s}.provider_instances pi
       -- Same strip-then-merge as the personal path above: keep the metadata,
       -- never carry the retired secret forward.
       SET secret_ref = (COALESCE(pi.secret_ref, '{}'::jsonb)
                           - 'value' - 'kind' - 'token' - 'apiKey' - 'githubToken' - 'key' - 'ref' - 'source')
                        || p_secret,
           updated_at = now()
     WHERE pi.name = p_name
       AND pi.class = 'shared'
    RETURNING pi.name, pi.type_id, pi.class, pi.owner_user_id;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}

/**
 * 0068: the cluster summary — every provider at once, pivoted by model.
 *
 * The Providers tab answers "how much of THIS provider's limit is used",
 * one provider at a time, from the meters. This answers the other question:
 * how many tokens the cluster burned today / this week / this month, per
 * UTC day for a chart, and per MODEL — folded across providers, reasoning
 * efforts and context tiers, because a person planning capacity thinks in
 * models, not in the routes tokens took to reach them.
 *
 * Read from the ledger, not the meters. The meters count only 'user'
 * charges (system sessions are exempt from limits by design), so a summary
 * built on them would silently omit the sweeper, the token manager and
 * every other system agent — on a real cluster the larger half. The ledger
 * has every turn; `classes` says how the total splits so nobody has to
 * wonder why this number is bigger than the Providers tab's.
 *
 * Scope: an admin sees the cluster; anyone else sees their own turns. The
 * provider filter is a plain list of names — the portal turns "Shared" and
 * "Users" into names before asking, so the database never has to guess
 * what a preset meant.
 */
function migration_0068_provider_usage_summary(schema: string): string {
    const s = schema;
    return `
-- The rows every aggregate below reads: one place for the scope and the
-- provider filter, so the KPIs, the chart and the model table can never
-- disagree about which turns were counted.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary_rows(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_since TIMESTAMPTZ, p_providers TEXT[]
) RETURNS SETOF ${s}.provider_usage_ledger AS $$
    SELECT l.*
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= p_since
       AND (COALESCE(p_is_admin, FALSE) OR l.owner_user_id IS NOT DISTINCT FROM p_viewer)
       AND (p_providers IS NULL OR cardinality(p_providers) = 0 OR l.provider_name = ANY(p_providers));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary_window(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_since TIMESTAMPTZ, p_providers TEXT[]
) RETURNS JSONB AS $$
    SELECT jsonb_build_object(
        'input', COALESCE(sum(r.tokens_input), 0),
        'output', COALESCE(sum(r.tokens_output), 0),
        'cacheRead', COALESCE(sum(r.tokens_cache_read), 0),
        'cacheWrite', COALESCE(sum(r.tokens_cache_write), 0),
        'total', COALESCE(sum(r.tokens_total), 0),
        'turns', count(*),
        'sessions', count(DISTINCT r.session_id))
      FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, p_since, p_providers) r;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER, p_providers TEXT[]
) RETURNS JSONB AS $$
DECLARE
    v_days    INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 365);
    -- UTC days, today included: the ledger stores UTC and the meters' day /
    -- week / month windows are UTC, so "today" here is the same today.
    v_today   DATE := (now() AT TIME ZONE 'UTC')::date;
    v_from    TIMESTAMPTZ := ((v_today - (v_days - 1)) :: timestamp) AT TIME ZONE 'UTC';
    v_month   TIMESTAMPTZ := ((v_today - 29) :: timestamp) AT TIME ZONE 'UTC';
    v_since   TIMESTAMPTZ := LEAST(v_from, v_month);
    v_windows JSONB;
    v_daily   JSONB;
    v_models  JSONB;
    v_classes JSONB;
BEGIN
    -- Today / last 7 UTC days / last 30 UTC days, each with the four-way
    -- split. The month window is what the ledger is read for at minimum.
    SELECT jsonb_build_object(
        'day',   ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, ((v_today)::timestamp) AT TIME ZONE 'UTC', p_providers),
        'week',  ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, ((v_today - 6)::timestamp) AT TIME ZONE 'UTC', p_providers),
        'month', ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, v_month, p_providers))
      INTO v_windows;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'),
               'input', d.i, 'output', d.o, 'cacheRead', d.cr, 'cacheWrite', d.cw,
               'total', d.t, 'turns', d.n) ORDER BY d.day), '[]'::jsonb)
      INTO v_daily
      FROM (
        SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day,
               sum(r.tokens_input) i, sum(r.tokens_output) o,
               sum(r.tokens_cache_read) cr, sum(r.tokens_cache_write) cw,
               sum(r.tokens_total) t, count(*) n
          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
         GROUP BY 1) d;

    -- The pivot: the model NAME, whatever provider carried it. model_qualified
    -- is provider:model, and a model name never holds a colon, so the part
    -- after the first colon is the model. Each row carries its own per-day
    -- totals for a sparkline.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'model', m.model, 'providers', m.providers, 'turns', m.n,
               'input', m.i, 'output', m.o, 'cacheRead', m.cr, 'cacheWrite', m.cw, 'total', m.t,
               'daily', m.daily) ORDER BY m.t DESC, m.model), '[]'::jsonb)
      INTO v_models
      FROM (
        SELECT g.model, count(DISTINCT g.provider_name) providers, count(*) n,
               sum(g.tokens_input) i, sum(g.tokens_output) o,
               sum(g.tokens_cache_read) cr, sum(g.tokens_cache_write) cw, sum(g.tokens_total) t,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'total', dd.t) ORDER BY dd.day), '[]'::jsonb)
                  FROM (SELECT (x.created_at AT TIME ZONE 'UTC')::date AS day, sum(x.tokens_total) t
                          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) x
                         WHERE substr(x.model_qualified, position(':' IN x.model_qualified) + 1) = g.model
                         GROUP BY 1) dd) AS daily
          FROM (SELECT r.*, substr(r.model_qualified, position(':' IN r.model_qualified) + 1) AS model
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r) g
         GROUP BY g.model) m;

    -- How the window's total splits by who was charged: people, the
    -- machinery PilotSwarm runs for itself, or turns with no provider.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('chargeClass', c.charge_class, 'total', c.t, 'turns', c.n) ORDER BY c.t DESC), '[]'::jsonb)
      INTO v_classes
      FROM (SELECT r.charge_class, sum(r.tokens_total) t, count(*) n
              FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
             GROUP BY 1) c;

    RETURN jsonb_build_object(
        'days', v_days,
        'today', to_char(v_today, 'YYYY-MM-DD'),
        'scope', CASE WHEN COALESCE(p_is_admin, FALSE) THEN 'cluster' ELSE 'mine' END,
        'windows', v_windows,
        'daily', v_daily,
        'models', v_models,
        'classes', v_classes);
END;
$$ LANGUAGE plpgsql STABLE;

`;
}

/**
 * 0069: the four-way token split on the Providers page.
 *
 * The grid's period cells carried one number per pair (used / quota, yours /
 * your share) because the METERS hold one number: a limit is on the total,
 * and the total is input + output + cache read + cache write
 * (cms_provider_settle_turn, v_total). What went into that total was only
 * visible on the Cluster summary. Each cell now also carries the split, for
 * everyone and for the viewer, read from the ledger over the SAME window
 * and scope the meter covers and over the same 'user' turns the meter
 * counts — so the four parts add up to the number beside them.
 *
 * The per-day series under a selected provider gets the same split, which
 * widens its RETURNS TABLE, hence DROP + CREATE with the same arguments.
 */
function migration_0069_provider_grid_token_split(schema: string): string {
    const s = schema;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_grid(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    provider_name TEXT, row_kind TEXT, scope TEXT, class TEXT,
    allowance_pct SMALLINT, hold_until_utc TIMESTAMPTZ, hold_indefinite BOOLEAN,
    model_row_count INTEGER, owned_by_me BOOLEAN, manageable BOOLEAN,
    owner_label TEXT, periods JSONB
) AS $$
    WITH windows AS (
        SELECT per.period, wb.window_start, wb.resets_at, wb.window_key
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
    ),
    model_scopes AS (
        SELECT r.provider_name, r.model_qualified AS scope
          FROM ${s}.provider_budget_rules r
         WHERE r.model_qualified IS NOT NULL
        UNION
        SELECT m.provider_name, m.scope
          FROM ${s}.provider_meters m
          JOIN windows w ON w.period = m.period AND w.window_key = m.window_key_utc
         WHERE m.scope <> '*'
    ),
    visible AS (
        SELECT pi.name, pi.class, pi.allowance_pct, pi.hold_until_utc, pi.hold_indefinite,
               pi.created_at AS named_at,
               (pi.class = 'shared' OR pi.owner_user_id IS NOT DISTINCT FROM p_viewer) AS owned_by_me,
               (CASE WHEN pi.class = 'shared' THEN COALESCE(p_is_admin, FALSE)
                     ELSE pi.owner_user_id IS NOT DISTINCT FROM p_viewer END) AS manageable,
               (CASE WHEN pi.class = 'shared' OR pi.owner_user_id IS NULL THEN NULL
                     ELSE COALESCE(
                         NULLIF(BTRIM(u.display_name), ''),
                         NULLIF(BTRIM(u.email), ''),
                         'user ' || pi.owner_user_id::text) END) AS owner_label,
               (SELECT count(*)::INTEGER FROM model_scopes ms WHERE ms.provider_name = pi.name) AS model_rows
          FROM ${s}.provider_instances pi
          LEFT JOIN ${s}.users u ON u.user_id = pi.owner_user_id
         WHERE pi.class = 'shared' OR pi.owner_user_id = p_viewer OR COALESCE(p_is_admin, FALSE)
    ),
    grid_rows AS (
        SELECT v.*, 'provider'::TEXT AS row_kind, '*'::TEXT AS scope FROM visible v
        UNION ALL
        SELECT v.*, 'model'::TEXT, ms.scope
          FROM visible v
          JOIN model_scopes ms ON ms.provider_name = v.name
    )
    SELECT g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
           g.hold_until_utc, g.hold_indefinite,
           CASE WHEN g.row_kind = 'provider' THEN g.model_rows ELSE 0 END,
           g.owned_by_me, g.manageable,
           CASE WHEN g.row_kind = 'provider' THEN g.owner_label ELSE NULL END,
           jsonb_object_agg(w.period, jsonb_build_object(
               'ruleId', r.rule_id,
               'quotaTokens', r.limit_tokens,
               'usedTokens', COALESCE(m.used_tokens, 0),
               'yourQuotaTokens', CASE
                   WHEN r.limit_tokens IS NULL OR p_viewer IS NULL THEN NULL
                   WHEN NOT g.owned_by_me THEN NULL
                   WHEN g.allowance_pct < 100
                        THEN ${s}.cms_provider_ceiling(r.limit_tokens, g.allowance_pct)
                   ELSE r.limit_tokens END,
               'yourUsedTokens', CASE WHEN p_viewer IS NULL THEN NULL
                                      ELSE COALESCE(mu.used_tokens, 0) END,
               -- What the used figure is made of. Same window, same scope,
               -- same 'user' turns as the meter, so the four add up to it.
               'inputTokens', COALESCE(ls.i, 0),
               'outputTokens', COALESCE(ls.o, 0),
               'cacheReadTokens', COALESCE(ls.cr, 0),
               'cacheWriteTokens', COALESCE(ls.cw, 0),
               'yourInputTokens', CASE WHEN p_viewer IS NULL THEN NULL ELSE COALESCE(lu.i, 0) END,
               'yourOutputTokens', CASE WHEN p_viewer IS NULL THEN NULL ELSE COALESCE(lu.o, 0) END,
               'yourCacheReadTokens', CASE WHEN p_viewer IS NULL THEN NULL ELSE COALESCE(lu.cr, 0) END,
               'yourCacheWriteTokens', CASE WHEN p_viewer IS NULL THEN NULL ELSE COALESCE(lu.cw, 0) END,
               'windowStartUtc', to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'resetsAtUtc', to_char(w.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM grid_rows g
      CROSS JOIN windows w
      LEFT JOIN ${s}.provider_budget_rules r
             ON r.provider_name = g.name AND r.period = w.period
            AND COALESCE(r.model_qualified, '*') = g.scope
      LEFT JOIN ${s}.provider_meters m
             ON m.provider_name = g.name AND m.period = w.period
            AND m.scope = g.scope AND m.window_key_utc = w.window_key
      LEFT JOIN ${s}.provider_meters_user mu
             ON mu.provider_name = g.name AND mu.period = w.period
            AND mu.scope = g.scope AND mu.window_key_utc = w.window_key
            AND mu.user_id = p_viewer
      LEFT JOIN LATERAL (
            SELECT sum(l.tokens_input) i, sum(l.tokens_output) o,
                   sum(l.tokens_cache_read) cr, sum(l.tokens_cache_write) cw
              FROM ${s}.provider_usage_ledger l
             WHERE l.provider_name = g.name AND l.charge_class = 'user'
               AND l.created_at >= GREATEST(w.window_start, g.named_at) AND l.created_at < w.resets_at
               AND (g.scope = '*' OR l.model_qualified = g.scope)) ls ON TRUE
      LEFT JOIN LATERAL (
            SELECT sum(l.tokens_input) i, sum(l.tokens_output) o,
                   sum(l.tokens_cache_read) cr, sum(l.tokens_cache_write) cw
              FROM ${s}.provider_usage_ledger l
             WHERE l.provider_name = g.name AND l.charge_class = 'user'
               AND l.owner_user_id = p_viewer
               AND l.created_at >= GREATEST(w.window_start, g.named_at) AND l.created_at < w.resets_at
               AND (g.scope = '*' OR l.model_qualified = g.scope)) lu ON TRUE
     GROUP BY g.name, g.row_kind, g.scope, g.class, g.allowance_pct,
              g.hold_until_utc, g.hold_indefinite, g.model_rows,
              g.owned_by_me, g.manageable, g.owner_label
     ORDER BY (g.class = 'shared') DESC, g.name, (g.row_kind = 'model'), g.scope;
$$ LANGUAGE sql STABLE;

DROP FUNCTION IF EXISTS ${s}.cms_provider_usage_daily(BIGINT, BOOLEAN, INTEGER, BIGINT, TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION ${s}.cms_provider_usage_daily(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(
    day_utc DATE, tokens_total BIGINT, turns BIGINT,
    tokens_input BIGINT, tokens_output BIGINT, tokens_cache_read BIGINT, tokens_cache_write BIGINT
) AS $$
    SELECT (l.created_at AT TIME ZONE 'UTC')::date, COALESCE(sum(l.tokens_total), 0), count(*)::BIGINT,
           COALESCE(sum(l.tokens_input), 0), COALESCE(sum(l.tokens_output), 0),
           COALESCE(sum(l.tokens_cache_read), 0), COALESCE(sum(l.tokens_cache_write), 0)
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       AND (p_provider IS NULL OR l.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class)
     GROUP BY 1 ORDER BY 1;
$$ LANGUAGE sql STABLE;
`;
}

/**
 * 0070: a turn's total is input + output. Cache reads and writes are parts
 * of the input, not additions to it.
 *
 * `buildUsageSummaryUpsert` (session-proxy.ts) stores the INCLUSIVE prompt
 * count: `tokens_input` already contains what was served from the cache and
 * what was written to it. The ledger and the meters proved it — in every row
 * on the local database and on chk, across GPT, Claude, Grok and MAI,
 * `tokens_cache_read + tokens_cache_write <= tokens_input`, and when a turn
 * wrote to the cache the two sides were equal. Yet `cms_provider_settle_turn`
 * summed all four into `tokens_total`, so every cached prompt was charged
 * twice: chk's last 30 days read 3.62B tokens for 1.97B consumed. That
 * total is what the meters hold and what every limit is compared against,
 * so quotas were biting at roughly half their stated size.
 *
 * Three things, as separate steps: the function, the ledger backfill, and
 * the meters rebuilt from the corrected ledger for their live windows (the
 * meters are a cache of the ledger; the reconciliation that showed them
 * exact is the same query, so nothing here invents a number). After this,
 * every "used" figure drops by the cached amount — limits that were tuned
 * against the inflated figures are looser in practice from here on.
 */
function migration_0070_token_total_is_input_plus_output(schema: string): string[] {
    const s = schema;
    return [
        `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_turn(
    p_session_id TEXT, p_turn_index INTEGER, p_provider TEXT, p_model TEXT,
    p_owner BIGINT, p_charge_class TEXT, p_agent_id TEXT,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    -- input + output. The cache figures are NOT added: as the Copilot SDK
    -- reports usage, cache_read and cache_write are parts OF the input
    -- (cache_read + cache_write <= input in every row ever recorded, and
    -- equal to it when writes occur), so adding them again charged a
    -- cached prompt twice — chk was over-counting by 84% (0070).
    v_total BIGINT := COALESCE(p_in,0) + COALESCE(p_out,0);
    v_class TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_charge_class,'')), ''), 'user');
    v_scope TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_model,'')), ''), '*');
    -- The lifetime offset. Stable for the whole turn: only a restart moves
    -- it, and a restart deletes the orchestration mid-turn anyway.
    v_index INTEGER := COALESCE(p_turn_index, 0) + COALESCE(
        (SELECT ss.provider_ledger_base FROM ${s}.sessions ss
          WHERE ss.session_id = p_session_id), 0);
    v_first INTEGER;
BEGIN
    IF p_provider IS NULL THEN v_class := 'unattributed'; END IF;

    INSERT INTO ${s}.provider_usage_ledger
        (session_id, turn_index, provider_name, model_qualified, owner_user_id,
         charge_class, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_write, tokens_total, agent_id)
    VALUES (p_session_id, v_index, p_provider, p_model, p_owner,
            v_class, COALESCE(p_in,0), COALESCE(p_out,0), COALESCE(p_cache_read,0),
            COALESCE(p_cache_write,0), v_total, p_agent_id)
    ON CONFLICT (session_id, turn_index) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    IF v_class <> 'user' OR p_provider IS NULL OR v_total <= 0 THEN
        RETURN TRUE;
    END IF;

    PERFORM 1 FROM ${s}.provider_instances pi
     WHERE pi.name = p_provider FOR KEY SHARE;
    IF NOT FOUND THEN RETURN TRUE; END IF;

    INSERT INTO ${s}.provider_meters
        (provider_name, period, scope, window_key_utc, used_tokens,
         window_start_utc, resets_at_utc)
    SELECT p_provider, per.period, sc.scope, wb.window_key, v_total,
           wb.window_start, wb.resets_at
      FROM (VALUES ('day'),('week'),('month')) AS per(period)
      CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
      CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
     ORDER BY per.period, sc.scope
    ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
        SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
            updated_at = now();

    IF p_owner IS NOT NULL THEN
        INSERT INTO ${s}.provider_meters_user
            (provider_name, period, scope, window_key_utc, user_id, used_tokens,
             window_start_utc, resets_at_utc)
        SELECT p_provider, per.period, sc.scope, wb.window_key, p_owner, v_total,
               wb.window_start, wb.resets_at
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
          CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
         ORDER BY per.period, sc.scope
        ON CONFLICT (provider_name, period, scope, window_key_utc, user_id) DO UPDATE
            SET used_tokens = ${s}.provider_meters_user.used_tokens + EXCLUDED.used_tokens,
                updated_at = now();
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;
`,
        `
SET lock_timeout = '5s';
UPDATE ${s}.provider_usage_ledger
   SET tokens_total = tokens_input + tokens_output
 WHERE tokens_total IS DISTINCT FROM tokens_input + tokens_output;
`,
        `
UPDATE ${s}.provider_meters m
   SET used_tokens = COALESCE((
        SELECT sum(l.tokens_total)
          FROM ${s}.provider_usage_ledger l
         WHERE l.provider_name = m.provider_name
           AND l.charge_class = 'user'
           AND l.created_at >= GREATEST(m.window_start_utc,
                 COALESCE((SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = m.provider_name), '-infinity'::timestamptz))
           AND l.created_at < m.resets_at_utc
           AND (m.scope = '*' OR l.model_qualified = m.scope)), 0),
       updated_at = now();
`,
        `
UPDATE ${s}.provider_meters_user m
   SET used_tokens = COALESCE((
        SELECT sum(l.tokens_total)
          FROM ${s}.provider_usage_ledger l
         WHERE l.provider_name = m.provider_name
           AND l.charge_class = 'user'
           AND l.owner_user_id = m.user_id
           AND l.created_at >= GREATEST(m.window_start_utc,
                 COALESCE((SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = m.provider_name), '-infinity'::timestamptz))
           AND l.created_at < m.resets_at_utc
           AND (m.scope = '*' OR l.model_qualified = m.scope)), 0),
       updated_at = now();
`,
    ];
}

/**
 * 0071: the agent pivot for the Cluster summary's "Agents" tab.
 *
 * The ledger has carried agent_id on every settled turn since 0.5.48
 * (session-proxy settleTurn: runConfig.agentIdentity), so tokens-per-agent
 * and tokens-per-turn-per-agent are one GROUP BY away — this function is
 * that GROUP BY, shaped like cms_provider_usage_summary so the portal tab
 * reads one answer: per-agent aggregates (with the model list and a
 * per-day sparkline) plus a flat day×agent series for a stacked chart.
 * A row with no agent_id is a session bound to no agent; it reports as
 * '(none)' rather than vanishing, because its tokens are still real.
 */
/**
 * 0072 — durable creation config.
 *
 * A session's creation config (bound agent, system message, tool names,
 * layering, contract) used to live ONLY in an in-memory map on the API
 * server process that handled the create. The orchestration is started by
 * whichever process handles the first message; behind a load balancer that
 * is routinely a different process, so the durable input started empty and
 * the session ran without its agent (see resolveBoundAgentBackfill). The
 * catalog row is where the rest of the creation-time truth already lives
 * (model, effort, tier, agentId) — this column completes it.
 *
 * Nullable JSONB, no backfill, no proc change: an ADD COLUMN with no
 * default is metadata-only in Postgres, so it is safe on the hot sessions
 * table. Read through a DEDICATED catalog method only — deliberately NOT
 * joined into cms_get_session/rowToSessionRow, because the web getSession
 * op hands that row to any viewer with read access and a stored
 * systemMessage is the owner's business.
 */
function migration_0072_session_creation_config(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS creation_config JSONB;
`;
}

function migration_0071_provider_usage_agents(schema: string): string {
    const s = schema;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_agents(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER, p_providers TEXT[]
) RETURNS JSONB AS $$
DECLARE
    v_days   INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 365);
    v_today  DATE := (now() AT TIME ZONE 'UTC')::date;
    v_from   TIMESTAMPTZ := ((v_today - (v_days - 1)) :: timestamp) AT TIME ZONE 'UTC';
    v_agents JSONB;
    v_daily  JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'agent', a.agent, 'turns', a.n, 'sessions', a.sessions,
               'input', a.i, 'output', a.o, 'cacheRead', a.cr, 'cacheWrite', a.cw, 'total', a.t,
               'models', a.models, 'daily', a.daily) ORDER BY a.t DESC, a.agent), '[]'::jsonb)
      INTO v_agents
      FROM (
        SELECT g.agent, count(*) n, count(DISTINCT g.session_id) sessions,
               sum(g.tokens_input) i, sum(g.tokens_output) o,
               sum(g.tokens_cache_read) cr, sum(g.tokens_cache_write) cw, sum(g.tokens_total) t,
               (SELECT COALESCE(jsonb_agg(DISTINCT substr(x.model_qualified, position(':' IN x.model_qualified) + 1)), '[]'::jsonb)
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) x
                 WHERE COALESCE(x.agent_id, '(none)') = g.agent AND x.model_qualified IS NOT NULL) AS models,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'total', dd.t) ORDER BY dd.day), '[]'::jsonb)
                  FROM (SELECT (y.created_at AT TIME ZONE 'UTC')::date AS day, sum(y.tokens_total) t
                          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) y
                         WHERE COALESCE(y.agent_id, '(none)') = g.agent
                         GROUP BY 1) dd) AS daily
          FROM (SELECT r.*, COALESCE(r.agent_id, '(none)') AS agent
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r) g
         GROUP BY g.agent) a;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'), 'agent', d.agent, 'total', d.t, 'turns', d.n) ORDER BY d.day, d.t DESC), '[]'::jsonb)
      INTO v_daily
      FROM (
        SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day, COALESCE(r.agent_id, '(none)') AS agent,
               sum(r.tokens_total) t, count(*) n
          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
         GROUP BY 1, 2) d;

    RETURN jsonb_build_object(
        'days', v_days,
        'today', to_char(v_today, 'YYYY-MM-DD'),
        'scope', CASE WHEN COALESCE(p_is_admin, FALSE) THEN 'cluster' ELSE 'mine' END,
        'agents', v_agents,
        'daily', v_daily);
END;
$$ LANGUAGE plpgsql STABLE;

`;
}
