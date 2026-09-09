/** Frozen catalog publication. 0076 preserves upstream MoA dashboards. */
export function featureFlagsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.feature_flags (
    feature_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL,
    default_enabled BOOLEAN NOT NULL, default_allow_user_override BOOLEAN NOT NULL,
    required_capability TEXT, revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE TABLE IF NOT EXISTS ${s}.feature_flag_settings (
    setting_id BIGSERIAL PRIMARY KEY,
    feature_key TEXT NOT NULL REFERENCES ${s}.feature_flags(feature_key),
    scope TEXT NOT NULL CHECK (scope IN ('cluster', 'user')),
    user_id BIGINT REFERENCES ${s}.users(user_id), enabled BOOLEAN NOT NULL,
    allow_user_override BOOLEAN, revision BIGINT NOT NULL CHECK (revision > 0),
    updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'cluster' AND user_id IS NULL AND allow_user_override IS NOT NULL)
        OR (scope = 'user' AND user_id IS NOT NULL AND allow_user_override IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_settings_cluster ON ${s}.feature_flag_settings(feature_key) WHERE scope = 'cluster';
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_settings_user ON ${s}.feature_flag_settings(feature_key, user_id) WHERE scope = 'user';
CREATE INDEX IF NOT EXISTS feature_flag_settings_by_user ON ${s}.feature_flag_settings(user_id) WHERE scope = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_audit_request ON ${s}.authz_audit
    ((details->>'actorKey'), (details->>'requestId'))
    WHERE action IN ('feature_flag.set', 'feature_flag.unset') AND decision = 'allow';
INSERT INTO ${s}.feature_flags(feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('copilot.native_tasks', 'Native Copilot tasks',
        'Allow Copilot to delegate local work to native tasks on the same worker.', false, false, 'copilot.native_tasks')
ON CONFLICT (feature_key) DO NOTHING;

CREATE OR REPLACE FUNCTION ${s}.cms_feature_definition_json(f ${s}.feature_flags) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object('featureKey', f.feature_key, 'displayName', f.display_name,
        'description', f.description, 'defaultEnabled', f.default_enabled,
        'defaultAllowUserOverride', f.default_allow_user_override,
        'requiredCapability', f.required_capability, 'revision', f.revision::TEXT);
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_setting_json(r ${s}.feature_flag_settings) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object('settingId', r.setting_id::TEXT, 'featureKey', r.feature_key,
        'scope', r.scope, 'userId', r.user_id, 'enabled', r.enabled, 'allowUserOverride', r.allow_user_override,
        'revision', r.revision::TEXT, 'updatedBy', r.updated_by, 'updatedAt', r.updated_at);
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_revisions() RETURNS TABLE(feature_key TEXT, revision TEXT) LANGUAGE sql STABLE AS $$
    SELECT f.feature_key, f.revision::TEXT FROM ${s}.feature_flags f ORDER BY f.feature_key;
$$;
-- Internal worker read: one statement snapshot, complete settings for each requested key.
CREATE OR REPLACE FUNCTION ${s}.cms_feature_snapshot(p_keys TEXT[]) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'definitions', COALESCE((SELECT jsonb_agg(${s}.cms_feature_definition_json(f) ORDER BY f.feature_key)
            FROM ${s}.feature_flags f WHERE f.feature_key = ANY(p_keys)), '[]'::JSONB),
        'settings', COALESCE((SELECT jsonb_agg(${s}.cms_feature_setting_json(r) ||
            CASE WHEN u.user_id IS NOT NULL THEN jsonb_build_object('owner', jsonb_build_object('provider', u.provider, 'subject', u.subject)) ELSE '{}'::JSONB END)
            FROM ${s}.feature_flag_settings r LEFT JOIN ${s}.users u ON u.user_id = r.user_id
            WHERE r.feature_key = ANY(p_keys)), '[]'::JSONB));
$$;
-- Authenticated surfaces supply the actor; never accept it from request JSON.
CREATE OR REPLACE FUNCTION ${s}.cms_feature_target(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_scope TEXT, p_user BIGINT, p_write BOOLEAN)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE v_actor BIGINT; v_target BIGINT;
BEGIN
    IF COALESCE(p_provider, '') = '' OR COALESCE(p_subject, '') = '' THEN
        RAISE EXCEPTION 'FEATURE_FORBIDDEN: An authenticated actor is required';
    END IF;
    SELECT u.user_id INTO v_actor FROM ${s}.users u WHERE u.provider = p_provider AND u.subject = p_subject;
    IF p_scope = 'cluster' THEN
        IF p_user IS NOT NULL THEN RAISE EXCEPTION 'FEATURE_INVALID: Cluster scope cannot name a user'; END IF;
        IF p_write AND NOT COALESCE(p_admin, false) THEN RAISE EXCEPTION 'FEATURE_FORBIDDEN: Cluster changes require admin'; END IF;
        RETURN NULL;
    END IF;
    IF p_scope IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'FEATURE_INVALID: Invalid feature scope'; END IF;
    v_target := COALESCE(p_user, v_actor);
    IF v_target IS NULL OR (NOT COALESCE(p_admin, false) AND v_target IS DISTINCT FROM v_actor) THEN
        RAISE EXCEPTION 'FEATURE_FORBIDDEN: Only admins can access another user';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ${s}.users WHERE user_id = v_target) THEN RAISE EXCEPTION 'FEATURE_NOT_FOUND: User not found'; END IF;
    RETURN v_target;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_read(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_scope TEXT, p_user BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_user BIGINT; v_result JSONB;
BEGIN
    v_user := ${s}.cms_feature_target(p_provider, p_subject, p_admin, p_scope, p_user, false);
    SELECT jsonb_build_object('userId', v_user,
        'definitions', COALESCE((SELECT jsonb_agg(${s}.cms_feature_definition_json(f) ORDER BY f.feature_key) FROM ${s}.feature_flags f), '[]'::JSONB),
        'settings', COALESCE((SELECT jsonb_agg(${s}.cms_feature_setting_json(r)) FROM ${s}.feature_flag_settings r
            WHERE r.scope = 'cluster' OR r.user_id = v_user), '[]'::JSONB)) INTO v_result;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_mutate(
    p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_scope TEXT, p_user BIGINT,
    p_key TEXT, p_enabled BOOLEAN, p_override BOOLEAN, p_unset BOOLEAN, p_expected BIGINT, p_request TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_user BIGINT; v_actor TEXT; v_hash TEXT; v_before JSONB; v_after JSONB;
    v_revision BIGINT; v_result JSONB; v_receipt JSONB;
BEGIN
    v_user := ${s}.cms_feature_target(p_provider, p_subject, p_admin, p_scope, p_user, true);
    -- Registration locks ghost users before moving their preferences. Take the
    -- same user -> feature lock order, and keep this FK target alive until commit.
    IF v_user IS NOT NULL THEN
        PERFORM 1 FROM ${s}.users WHERE user_id = v_user FOR KEY SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'FEATURE_NOT_FOUND: User not found'; END IF;
    END IF;
    IF p_expected IS NULL OR p_expected < 1 OR COALESCE(length(p_request), 0) NOT BETWEEN 1 AND 128 OR p_unset IS NULL THEN
        RAISE EXCEPTION 'FEATURE_INVALID: Positive expectedRevision and requestId are required';
    END IF;
    IF (NOT p_unset AND (p_enabled IS NULL OR (p_scope = 'cluster' AND p_override IS NULL)))
        OR (p_scope = 'user' AND p_override IS NOT NULL)
        OR (p_unset AND (p_enabled IS NOT NULL OR p_override IS NOT NULL)) THEN
        RAISE EXCEPTION 'FEATURE_INVALID: Invalid setting values for scope';
    END IF;
    v_actor := jsonb_build_array(p_provider, p_subject)::TEXT;
    v_hash := md5(jsonb_build_array(p_scope, v_user, p_key, p_enabled, p_override, p_unset, p_expected)::TEXT);
    -- Serialize receipts across different feature keys using the same actor/request ID.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_actor || ':' || p_request, 7731));
    SELECT a.details INTO v_receipt FROM ${s}.authz_audit a WHERE a.action IN ('feature_flag.set', 'feature_flag.unset')
        AND a.decision = 'allow' AND a.details->>'actorKey' = v_actor AND a.details->>'requestId' = p_request;
    IF v_receipt IS NOT NULL THEN
        IF v_receipt->>'requestHash' IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'FEATURE_CONFLICT: Request ID was used for different input'; END IF;
        RETURN v_receipt->'result';
    END IF;
    SELECT f.revision INTO v_revision FROM ${s}.feature_flags f WHERE f.feature_key = p_key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FEATURE_NOT_FOUND: Feature not found'; END IF;
    IF v_revision <> p_expected THEN RAISE EXCEPTION 'FEATURE_CONFLICT: Feature changed; reload before saving'; END IF;
    SELECT ${s}.cms_feature_setting_json(r) INTO v_before FROM ${s}.feature_flag_settings r
        WHERE r.feature_key = p_key AND r.scope = p_scope AND r.user_id IS NOT DISTINCT FROM v_user;
    UPDATE ${s}.feature_flags SET revision = revision + 1 WHERE feature_key = p_key RETURNING revision INTO v_revision;
    IF p_unset THEN
        DELETE FROM ${s}.feature_flag_settings WHERE feature_key = p_key AND scope = p_scope AND user_id IS NOT DISTINCT FROM v_user;
    ELSE
        UPDATE ${s}.feature_flag_settings SET enabled = p_enabled, allow_user_override = p_override,
            revision = v_revision, updated_by = v_actor, updated_at = now()
            WHERE feature_key = p_key AND scope = p_scope AND user_id IS NOT DISTINCT FROM v_user
            RETURNING ${s}.cms_feature_setting_json(feature_flag_settings) INTO v_after;
        IF NOT FOUND THEN
        INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
        VALUES (p_key, p_scope, v_user, p_enabled, p_override, v_revision, v_actor)
        RETURNING ${s}.cms_feature_setting_json(feature_flag_settings) INTO v_after;
        END IF;
    END IF;
    v_result := jsonb_build_object('featureKey', p_key, 'scope', p_scope, 'userId', v_user, 'revision', v_revision::TEXT, 'setting', v_after);
    INSERT INTO ${s}.authz_audit(actor_provider, actor_subject, action, target, decision, details)
    VALUES (p_provider, p_subject, CASE WHEN p_unset THEN 'feature_flag.unset' ELSE 'feature_flag.set' END,
        p_key, 'allow', jsonb_build_object('actorKey', v_actor, 'requestId', p_request, 'requestHash', v_hash,
            'scope', p_scope, 'userId', v_user, 'featureKey', p_key, 'before', v_before, 'after', v_after,
            'revision', v_revision::TEXT, 'result', v_result));
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_changes(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_limit INT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
BEGIN
    PERFORM ${s}.cms_feature_target(p_provider, p_subject, p_admin, 'cluster', NULL, true);
    RETURN COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM (SELECT audit_id::TEXT, occurred_at, actor_provider, actor_subject, action, target, details
        FROM ${s}.authz_audit WHERE action IN ('feature_flag.set', 'feature_flag.unset', 'feature_flag.user_adopt')
        ORDER BY audit_id DESC LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 50)))) a), '[]'::JSONB);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_feature_users(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_query TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
BEGIN
    PERFORM ${s}.cms_feature_target(p_provider, p_subject, p_admin, 'cluster', NULL, true);
    RETURN COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM (SELECT user_id AS "userId", provider, subject, email, display_name AS "displayName"
        FROM ${s}.users WHERE COALESCE(p_query, '') = '' OR position(lower(p_query) IN lower(COALESCE(display_name, '') || ' ' || COALESCE(email, '') || ' ' || subject)) > 0
        ORDER BY COALESCE(display_name, email, subject), user_id LIMIT 500) u), '[]'::JSONB);
END;
$$;

-- Frozen replacement of 0063 registration, extended for feature preferences.
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
    v_feature TEXT;
    v_revision BIGINT;
    v_before JSONB;
    v_after JSONB;
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
            ORDER BY u.user_id FOR UPDATE
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
            -- Carry preferences from the email placeholder to the stable login
            -- identity. A real user's explicit preference wins a collision.
            -- Bump even for a collision: worker caches must discard the ghost.
            FOR v_feature IN SELECT feature_key FROM ${s}.feature_flag_settings
                WHERE user_id = v_ghost ORDER BY feature_key
            LOOP
                PERFORM 1 FROM ${s}.feature_flags WHERE feature_key = v_feature FOR UPDATE;
                SELECT ${s}.cms_feature_setting_json(r) INTO v_before
                    FROM ${s}.feature_flag_settings r WHERE feature_key = v_feature AND user_id = v_ghost;
                UPDATE ${s}.feature_flags SET revision = revision + 1 WHERE feature_key = v_feature
                    RETURNING revision INTO v_revision;
                IF EXISTS (SELECT 1 FROM ${s}.feature_flag_settings WHERE feature_key = v_feature AND user_id = v_user_id) THEN
                    DELETE FROM ${s}.feature_flag_settings WHERE feature_key = v_feature AND user_id = v_ghost;
                ELSE
                    UPDATE ${s}.feature_flag_settings SET user_id = v_user_id, revision = v_revision,
                        updated_by = jsonb_build_array('system', 'user-adoption')::TEXT, updated_at = now()
                        WHERE feature_key = v_feature AND user_id = v_ghost;
                END IF;
                SELECT ${s}.cms_feature_setting_json(r) INTO v_after
                    FROM ${s}.feature_flag_settings r WHERE feature_key = v_feature AND user_id = v_user_id;
                INSERT INTO ${s}.authz_audit(actor_provider, actor_subject, action, target, decision, details)
                VALUES ('system', 'user-adoption', 'feature_flag.user_adopt', v_feature, 'allow',
                    jsonb_build_object('scope', 'user', 'userId', v_user_id, 'previousUserId', v_ghost,
                        'featureKey', v_feature, 'before', v_before, 'after', v_after, 'revision', v_revision::TEXT));
            END LOOP;
            DELETE FROM ${s}.users WHERE user_id = v_ghost;
        END LOOP;
    END IF;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}
