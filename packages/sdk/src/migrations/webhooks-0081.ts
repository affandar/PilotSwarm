/** Migration 0081: durable webhook control plane; raw provider bodies are never stored. */
export function webhooksMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.webhook_resources (
    resource_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('connector','binding','template')),
    owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    approved_by BIGINT REFERENCES ${s}.users(user_id),
    label TEXT NOT NULL CHECK (octet_length(label) BETWEEN 1 AND 256),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','quarantined','revoked')),
    revision INTEGER NOT NULL DEFAULT 1,
    spec JSONB NOT NULL CHECK (octet_length(spec::text) <= 16384),
    target_owner_id BIGINT REFERENCES ${s}.users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_resources_owner ON ${s}.webhook_resources(owner_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_bindings_connector ON ${s}.webhook_resources((spec->>'connectorId')) WHERE kind='binding';
CREATE TABLE IF NOT EXISTS ${s}.signal_endpoints (
    endpoint_id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    session_id TEXT NOT NULL,
    target_owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    signal_name TEXT NOT NULL CHECK (signal_name ~ '^[a-z0-9_-]{1,64}$'),
    label TEXT NOT NULL,
    hmac_secret_ref TEXT CHECK (hmac_secret_ref ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    wake BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER CHECK (max_uses BETWEEN 1 AND 1000000),
    use_count INTEGER NOT NULL DEFAULT 0,
    rate_limit INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit BETWEEN 1 AND 600),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_endpoints_session ON ${s}.signal_endpoints(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ${s}.webhook_deliveries (
    delivery_pk TEXT PRIMARY KEY,
    origin_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL CHECK (octet_length(delivery_id) BETWEEN 1 AND 128),
    payload_hash TEXT NOT NULL,
    accepted BOOLEAN NOT NULL DEFAULT TRUE,
    rejection_code TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    trace_context JSONB NOT NULL DEFAULT '{}' CHECK (octet_length(trace_context::text)<=256),
    UNIQUE(origin_id, delivery_id)
);
CREATE TABLE IF NOT EXISTS ${s}.webhook_receipts (
    receipt_id TEXT PRIMARY KEY,
    delivery_pk TEXT NOT NULL REFERENCES ${s}.webhook_deliveries(delivery_pk),
    owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    provider TEXT NOT NULL CHECK (provider IN ('github','azure-devops','generic')),
    origin_id TEXT NOT NULL,
    origin_revision INTEGER,
    binding_id TEXT,
    binding_revision INTEGER,
    template_revision INTEGER,
    status TEXT NOT NULL,
    event_type TEXT,
    event_action TEXT,
    session_id TEXT,
    signal_id TEXT NOT NULL,
    coalesced BOOLEAN NOT NULL DEFAULT FALSE,
    attempts INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    replay_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    timeline JSONB NOT NULL DEFAULT '[]',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(delivery_pk, binding_id)
);
CREATE INDEX IF NOT EXISTS webhook_receipts_owner ON ${s}.webhook_receipts(owner_id, received_at DESC, receipt_id);
CREATE INDEX IF NOT EXISTS webhook_receipts_session ON ${s}.webhook_receipts(session_id, received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_receipts_origin ON ${s}.webhook_receipts(origin_id, received_at DESC);
-- Payload storage is separate from receipt metadata; no management read returns it.
-- Provider data is the finite normalized projection only. Generic data is <=32 KiB.
CREATE TABLE IF NOT EXISTS ${s}.webhook_payloads (
    receipt_id TEXT PRIMARY KEY REFERENCES ${s}.webhook_receipts(receipt_id) ON DELETE CASCADE,
    data JSONB NOT NULL CHECK (octet_length(data::text) <= 65536)
);
CREATE TABLE IF NOT EXISTS ${s}.webhook_outbox (
    receipt_id TEXT PRIMARY KEY REFERENCES ${s}.webhook_receipts(receipt_id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL DEFAULT 1,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token TEXT,
    leased_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS webhook_outbox_ready ON ${s}.webhook_outbox(contract_version, next_attempt_at, leased_until);
CREATE TABLE IF NOT EXISTS ${s}.webhook_coalescing (
    binding_id TEXT NOT NULL REFERENCES ${s}.webhook_resources(resource_id),
    coalesce_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    PRIMARY KEY(binding_id, coalesce_key)
);
CREATE TABLE IF NOT EXISTS ${s}.webhook_rate_windows (
    bucket TEXT PRIMARY KEY,
    minute TIMESTAMPTZ NOT NULL,
    uses INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.webhook_ingress_counters (
    owner_id BIGINT NOT NULL,
    provider TEXT NOT NULL,
    outcome TEXT NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_id, provider, outcome)
);
CREATE TABLE IF NOT EXISTS ${s}.session_creation_keys (
    session_id TEXT PRIMARY KEY,
    creation_key TEXT UNIQUE NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    agent_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ${s}.cms_webhook_principal(p_id BIGINT) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('provider',u.provider,'subject',u.subject) FROM ${s}.users u WHERE u.user_id=p_id;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_actor(p_provider TEXT, p_subject TEXT, p_system_read BOOLEAN DEFAULT FALSE) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT;
BEGIN
    SELECT user_id INTO v_id FROM ${s}.users WHERE provider=p_provider AND subject=p_subject
        AND (role IN ('admin','user','anonymous') OR (p_system_read AND provider='system' AND subject='system'));
    IF v_id IS NULL THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: An authenticated registered principal is required'; END IF;
    RETURN v_id;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_user_active(p_id BIGINT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM ${s}.users WHERE user_id=p_id AND role IN ('admin','user','anonymous'));
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_target_owner(p_actor BIGINT, p_session TEXT, p_expected BIGINT DEFAULT NULL)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_owner BIGINT; v_root TEXT; v_visibility TEXT;
BEGIN
    IF NOT ${s}.cms_webhook_user_active(p_actor) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Routing owner is no longer authorized'; END IF;
    SELECT COALESCE(ss.root_session_id,ss.session_id) INTO v_root FROM ${s}.sessions ss
        WHERE ss.session_id=p_session AND ss.deleted_at IS NULL AND NOT ss.is_system AND ss.service_kind IS NULL;
    SELECT so.user_id, ss.visibility INTO v_owner,v_visibility FROM ${s}.sessions ss
        JOIN ${s}.session_owners so ON so.session_id=ss.session_id WHERE ss.session_id=v_root AND ss.deleted_at IS NULL AND NOT ss.is_system;
    IF v_owner IS NULL OR (p_expected IS NOT NULL AND v_owner<>p_expected)
       OR NOT (v_owner=p_actor OR v_visibility='shared_write'
          OR EXISTS(SELECT 1 FROM ${s}.session_shares WHERE session_id=v_root AND user_id=p_actor AND access='write'))
    THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Target is not authorized'; END IF;
    RETURN v_owner;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_audit(p_actor BIGINT, p_action TEXT, p_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO ${s}.authz_audit(actor_provider,actor_subject,action,target,decision,details)
        SELECT provider,subject,'webhook.'||p_action,p_id,'allow','{}'::jsonb FROM ${s}.users WHERE user_id=p_actor;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_resource_json(p_row ${s}.webhook_resources) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_spec JSONB := p_row.spec;
BEGIN
    IF p_row.kind='connector' THEN
        v_spec := (v_spec-'auth') || jsonb_build_object('auth',jsonb_build_object('mode',v_spec->'auth'->>'mode','configured',TRUE));
    END IF;
    RETURN v_spec || jsonb_build_object('id',p_row.resource_id,'label',p_row.label,'owner',${s}.cms_webhook_principal(p_row.owner_id),
        'state',p_row.state,'revision',p_row.revision,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at)
        || CASE WHEN p_row.kind='template' THEN jsonb_build_object('approvedBy',${s}.cms_webhook_principal(p_row.approved_by)) ELSE '{}'::jsonb END;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_endpoint_json(p_row ${s}.signal_endpoints) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('endpointId',p_row.endpoint_id,'sessionId',p_row.session_id,'signalName',p_row.signal_name,
        'label',p_row.label,'owner',${s}.cms_webhook_principal(p_row.owner_id),'wake',p_row.wake,
        'hmacConfigured',p_row.hmac_secret_ref IS NOT NULL,'expiresAt',p_row.expires_at,'maxUses',p_row.max_uses,
        'useCount',p_row.use_count,'revokedAt',p_row.revoked_at,'createdAt',p_row.created_at,'rateLimitPerMinute',p_row.rate_limit);
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_binding_check(p_owner BIGINT,p_spec JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_connector ${s}.webhook_resources; v_template ${s}.webhook_resources; v_action JSONB := p_spec->'action'; v_target BIGINT;
BEGIN
    SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=p_spec->>'connectorId' AND kind='connector';
    IF NOT FOUND OR v_connector.owner_id<>p_owner OR v_connector.state<>'active' THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Source connector is not authorized'; END IF;
    IF NOT ${s}.cms_webhook_user_active(p_owner) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Owner is no longer authorized'; END IF;
    IF v_action->>'type'='create_session' THEN
        SELECT * INTO v_template FROM ${s}.webhook_resources WHERE resource_id=v_action->>'templateId' AND kind='template';
        IF NOT FOUND OR v_template.owner_id<>p_owner OR v_template.state<>'active'
           OR v_template.spec->'source' IS DISTINCT FROM v_connector.spec->'source'
           OR NOT EXISTS(SELECT 1 FROM ${s}.users WHERE user_id=v_template.approved_by AND role IN ('admin','anonymous'))
        THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Template, source or approval is no longer authorized'; END IF;
    ELSIF v_action->>'type' IN ('raise_signal','enqueue_prompt') THEN
        v_target := ${s}.cms_webhook_target_owner(p_owner,v_action->>'sessionId');
    ELSE RAISE EXCEPTION 'WEBHOOK_INVALID: Unsupported binding action';
    END IF;
    RETURN v_target;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_mutate(
    p_kind TEXT,p_id TEXT,p_operation TEXT,p_input JSONB,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN,p_approve BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT; v_owner BIGINT; v_row ${s}.webhook_resources; v_connector ${s}.webhook_resources; v_spec JSONB; v_expected INTEGER; v_target BIGINT; v_can_approve BOOLEAN;
BEGIN
    v_actor := ${s}.cms_webhook_actor(p_provider,p_subject);
    SELECT COALESCE(p_approve,FALSE) AND role IN ('admin','anonymous') INTO v_can_approve FROM ${s}.users WHERE user_id=v_actor;
    IF p_kind NOT IN ('connector','binding','template') OR octet_length(p_input::text)>16384 THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid resource'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('webhook-control-plane',0));
    IF p_operation='create' THEN
        v_owner := v_actor;
        IF p_input ? 'owner' THEN
            v_owner := ${s}.cms_webhook_actor(p_input->'owner'->>'provider',p_input->'owner'->>'subject');
            IF NOT p_admin AND v_owner<>v_actor THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Only unrestricted administrators assign another owner'; END IF;
        END IF;
        IF p_kind IN ('connector','template') AND NOT v_can_approve THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Connector credentials and template approval require an administrator'; END IF;
        v_spec := p_input-'owner'-'label';
        IF p_kind='binding' THEN
            SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=p_input->>'connectorId' AND kind='connector';
            IF NOT FOUND OR (NOT p_admin AND v_connector.owner_id<>v_actor) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Connector not authorized'; END IF;
            v_owner := v_connector.owner_id;
            IF (SELECT count(*) FROM ${s}.webhook_resources WHERE kind='binding' AND state<>'revoked' AND spec->>'connectorId'=p_input->>'connectorId') >= 16
            THEN RAISE EXCEPTION 'WEBHOOK_LIMIT: At most 16 bindings per connector'; END IF;
            v_target := ${s}.cms_webhook_binding_check(v_owner,v_spec);
        END IF;
        IF NOT ${s}.cms_webhook_user_active(v_owner) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Owner has no active membership'; END IF;
        IF (SELECT count(*) FROM ${s}.webhook_resources WHERE kind=p_kind AND owner_id=v_owner AND state<>'revoked')>=100
        THEN RAISE EXCEPTION 'WEBHOOK_LIMIT: Resource limit reached'; END IF;
        INSERT INTO ${s}.webhook_resources(resource_id,kind,owner_id,approved_by,label,spec,target_owner_id)
            VALUES(p_id,p_kind,v_owner,CASE WHEN p_kind='template' THEN v_actor END,p_input->>'label',v_spec,v_target) RETURNING * INTO v_row;
    ELSE
        SELECT * INTO v_row FROM ${s}.webhook_resources WHERE resource_id=p_id AND kind=p_kind FOR UPDATE;
        IF NOT FOUND OR (NOT p_admin AND v_row.owner_id<>v_actor) THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Resource not found'; END IF;
        IF v_row.state='revoked' THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Resource is revoked'; END IF;
        IF p_operation='revoke' THEN
            UPDATE ${s}.webhook_resources SET state='revoked',revision=revision+1,updated_at=now() WHERE resource_id=p_id RETURNING * INTO v_row;
        ELSIF p_operation='update' THEN
            v_expected := (p_input->>'expectedRevision')::int;
            IF v_expected IS NULL OR v_row.revision<>v_expected THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Resource changed'; END IF;
            IF p_input ? 'auth' AND NOT v_can_approve THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Credential rotation requires an administrator'; END IF;
            IF p_kind='template' AND (p_input ? 'config' OR p_input ? 'prompt') AND NOT v_can_approve THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Template changes require approval'; END IF;
            v_spec := v_row.spec || (p_input-'label'-'state'-'expectedRevision'-'owner'-'source'-'provider'-'connectorId');
            IF p_kind='connector' AND ((v_spec->>'provider'='github' AND v_spec->'auth'->>'mode'<>'github-hmac-sha256')
                OR (v_spec->>'provider'='azure-devops' AND v_spec->'auth'->>'mode'<>'ado-basic'))
            THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Authentication mode does not match provider'; END IF;
            IF p_kind='binding' THEN v_target := ${s}.cms_webhook_binding_check(v_row.owner_id,v_spec); ELSE v_target:=v_row.target_owner_id; END IF;
            UPDATE ${s}.webhook_resources SET spec=v_spec,label=COALESCE(p_input->>'label',label),
                state=COALESCE(p_input->>'state',state),revision=revision+1,updated_at=now(),target_owner_id=v_target,
                approved_by=CASE WHEN p_kind='template' AND (p_input ? 'config' OR p_input ? 'prompt') THEN v_actor ELSE approved_by END
                WHERE resource_id=p_id RETURNING * INTO v_row;
        ELSE RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid mutation'; END IF;
    END IF;
    PERFORM ${s}.cms_webhook_audit(v_actor,p_kind||'.'||CASE
        WHEN p_operation='update' AND p_input ? 'auth' THEN 'rotate_secret'
        WHEN p_operation='update' AND p_input->>'state'='quarantined' THEN 'quarantine'
        ELSE p_operation END,p_id);
    RETURN ${s}.cms_webhook_resource_json(v_row);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_list(p_kind TEXT,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(${s}.cms_webhook_resource_json(x)),'[]'::jsonb) INTO v_result
        FROM (SELECT * FROM ${s}.webhook_resources WHERE kind=p_kind AND (p_admin OR owner_id=v_actor)
            ORDER BY (state='revoked'),created_at DESC,resource_id LIMIT 100) x;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_endpoint(
    p_operation TEXT,p_id TEXT,p_input JSONB,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN,p_approve BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_row ${s}.signal_endpoints; v_owner BIGINT; v_expiry TIMESTAMPTZ;
BEGIN
    IF p_operation='create' THEN
        v_owner := ${s}.cms_webhook_target_owner(v_actor,p_input->>'sessionId');
        IF p_input ? 'hmacSecretRef' AND (NOT COALESCE(p_approve,FALSE)
            OR NOT EXISTS(SELECT 1 FROM ${s}.users WHERE user_id=v_actor AND role IN ('admin','anonymous')))
        THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Setting secret references requires an administrator'; END IF;
        v_expiry := COALESCE((p_input->>'expiresAt')::timestamptz,now()+interval '30 days');
        IF v_expiry<=now() OR v_expiry>now()+interval '90 days' THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Endpoint expiry must be within 90 days'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('webhook-endpoints:'||(p_input->>'sessionId'),0));
        IF (SELECT count(*) FROM ${s}.signal_endpoints WHERE session_id=p_input->>'sessionId' AND revoked_at IS NULL AND expires_at>now())>=100
        THEN RAISE EXCEPTION 'WEBHOOK_LIMIT: Endpoint limit reached'; END IF;
        INSERT INTO ${s}.signal_endpoints(endpoint_id,token_hash,owner_id,session_id,target_owner_id,signal_name,label,hmac_secret_ref,wake,expires_at,max_uses,rate_limit)
            VALUES(p_id,p_input->>'tokenHash',v_actor,p_input->>'sessionId',v_owner,p_input->>'signalName',COALESCE(p_input->>'label','Signal endpoint'),
                p_input->>'hmacSecretRef',COALESCE((p_input->>'wake')::boolean,FALSE),v_expiry,(p_input->>'maxUses')::int,COALESCE((p_input->>'rateLimitPerMinute')::int,60))
            RETURNING * INTO v_row;
    ELSIF p_operation='revoke' THEN
        SELECT * INTO v_row FROM ${s}.signal_endpoints WHERE endpoint_id=p_id FOR UPDATE;
        IF NOT FOUND OR (NOT p_admin AND v_row.owner_id<>v_actor) THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Endpoint not found'; END IF;
        UPDATE ${s}.signal_endpoints SET revoked_at=COALESCE(revoked_at,now()) WHERE endpoint_id=p_id RETURNING * INTO v_row;
    ELSE RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid endpoint mutation'; END IF;
    PERFORM ${s}.cms_webhook_audit(v_actor,'endpoint.'||p_operation,p_id);
    RETURN ${s}.cms_webhook_endpoint_json(v_row);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_endpoints(p_session TEXT,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(${s}.cms_webhook_endpoint_json(x)),'[]'::jsonb) INTO v_result
        FROM (SELECT * FROM ${s}.signal_endpoints WHERE session_id=p_session AND (p_admin OR owner_id=v_actor)
            ORDER BY (revoked_at IS NOT NULL OR expires_at<=now()),created_at DESC,endpoint_id LIMIT 100) x;
    RETURN v_result;
END;
$$;
${ingressSql(s)}
${routingSql(s)}
${operationsSql(s)}
${creationSql(s)}
`;
}

function ingressSql(s: string): string {
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_rate(p_bucket TEXT,p_limit INTEGER) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_uses INTEGER; v_minute TIMESTAMPTZ := date_trunc('minute',clock_timestamp());
BEGIN
    INSERT INTO ${s}.webhook_rate_windows(bucket,minute,uses) VALUES(p_bucket,v_minute,1)
        ON CONFLICT(bucket) DO UPDATE SET minute=v_minute,
            uses=CASE WHEN ${s}.webhook_rate_windows.minute=v_minute THEN LEAST(${s}.webhook_rate_windows.uses+1,p_limit+1) ELSE 1 END
        RETURNING uses INTO v_uses;
    RETURN v_uses<=p_limit;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_preflight(p_source_hash TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    IF p_source_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid peer digest'; END IF;
    IF NOT ${s}.cms_webhook_rate('global',600) THEN RETURN FALSE; END IF;
    DELETE FROM ${s}.webhook_rate_windows WHERE bucket IN
        (SELECT bucket FROM ${s}.webhook_rate_windows WHERE minute<now()-interval '1 hour' LIMIT 100);
    RETURN ${s}.cms_webhook_rate('source:'||p_source_hash,120);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_ingress_config(p_kind TEXT,p_key TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_endpoint ${s}.signal_endpoints; v_connector ${s}.webhook_resources;
BEGIN
    IF p_kind='endpoint' THEN
        SELECT * INTO v_endpoint FROM ${s}.signal_endpoints WHERE token_hash=p_key;
        IF NOT FOUND OR v_endpoint.revoked_at IS NOT NULL OR v_endpoint.expires_at<=now()
            OR NOT ${s}.cms_webhook_user_active(v_endpoint.owner_id)
        THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Endpoint not found'; END IF;
        RETURN jsonb_build_object('id',v_endpoint.endpoint_id,'hmacSecretRef',v_endpoint.hmac_secret_ref);
    END IF;
    SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=p_key AND kind='connector';
    IF NOT FOUND OR v_connector.state<>'active' OR NOT ${s}.cms_webhook_user_active(v_connector.owner_id)
    THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Connector not found'; END IF;
    RETURN jsonb_build_object('id',v_connector.resource_id,'revision',v_connector.revision,
        'provider',v_connector.spec->>'provider','source',v_connector.spec->'source','auth',v_connector.spec->'auth');
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_origin_rate(p_origin TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_limit INTEGER;
BEGIN
    SELECT rate_limit INTO v_limit FROM ${s}.signal_endpoints WHERE endpoint_id=p_origin;
    IF v_limit IS NULL THEN SELECT (spec->>'rateLimitPerMinute')::int INTO v_limit FROM ${s}.webhook_resources WHERE resource_id=p_origin AND kind='connector'; END IF;
    IF v_limit IS NULL THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Endpoint not found'; END IF;
    RETURN ${s}.cms_webhook_rate('origin:'||p_origin,v_limit);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_ingress_failure(p_origin TEXT,p_outcome TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_owner BIGINT; v_provider TEXT;
BEGIN
    IF p_outcome NOT IN ('rejected','rate_limited','disabled','expired') THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid outcome'; END IF;
    SELECT owner_id,spec->>'provider' INTO v_owner,v_provider FROM ${s}.webhook_resources WHERE resource_id=p_origin AND kind='connector';
    IF v_owner IS NULL THEN SELECT owner_id,'generic' INTO v_owner,v_provider FROM ${s}.signal_endpoints WHERE endpoint_id=p_origin; END IF;
    INSERT INTO ${s}.webhook_ingress_counters(owner_id,provider,outcome,count) VALUES(COALESCE(v_owner,0),COALESCE(v_provider,'generic'),p_outcome,1)
        ON CONFLICT(owner_id,provider,outcome) DO UPDATE SET count=${s}.webhook_ingress_counters.count+1;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_matches(p_filters JSONB,p_event JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM jsonb_each(p_filters) f
        WHERE CASE WHEN jsonb_typeof(f.value)='array' THEN NOT f.value @> jsonb_build_array(p_event->f.key)
            ELSE f.value IS DISTINCT FROM p_event->f.key END
    );
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_transition(p_id TEXT,p_status TEXT,p_code TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ${s}.webhook_receipts SET status=p_status,last_error_code=p_code,updated_at=now(),
        timeline=(SELECT COALESCE(jsonb_agg(x.value ORDER BY x.ordinality),'[]'::jsonb)
            FROM jsonb_array_elements(timeline) WITH ORDINALITY x(value,ordinality)
            WHERE x.ordinality>GREATEST(jsonb_array_length(timeline)-31,0))
            || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('status',p_status,'at',now(),'code',p_code)))
        WHERE receipt_id=p_id;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_accept(
    p_kind TEXT,p_origin TEXT,p_revision INTEGER,p_delivery_id TEXT,p_payload_hash TEXT,p_data JSONB,p_delivery_pk TEXT,p_trace_context JSONB DEFAULT '{}'
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_endpoint ${s}.signal_endpoints; v_connector ${s}.webhook_resources; v_binding ${s}.webhook_resources;
    v_delivery ${s}.webhook_deliveries; v_owner BIGINT; v_provider TEXT; v_ids TEXT[]:=ARRAY[]::TEXT[];
    v_bindings ${s}.webhook_resources[];
    v_status TEXT; v_id TEXT; v_session TEXT; v_template_revision INTEGER; v_source_match BOOLEAN:=TRUE;
BEGIN
    IF p_kind NOT IN ('endpoint','connector') OR octet_length(p_data::text)>65536 OR p_payload_hash !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(p_trace_context)<>'object' OR octet_length(p_trace_context::text)>256
    THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid ingress contract'; END IF;
    IF p_kind='endpoint' THEN
        SELECT * INTO v_endpoint FROM ${s}.signal_endpoints WHERE endpoint_id=p_origin FOR UPDATE;
        IF NOT FOUND OR v_endpoint.revoked_at IS NOT NULL OR v_endpoint.expires_at<=now() OR NOT ${s}.cms_webhook_user_active(v_endpoint.owner_id)
        THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Endpoint not found'; END IF;
        v_owner:=v_endpoint.owner_id; v_provider:='generic';
    ELSE
        SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=p_origin AND kind='connector' FOR UPDATE;
        IF NOT FOUND OR v_connector.state<>'active' OR v_connector.revision IS DISTINCT FROM p_revision OR NOT ${s}.cms_webhook_user_active(v_connector.owner_id)
        THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Connector not found'; END IF;
        v_owner:=v_connector.owner_id; v_provider:=v_connector.spec->>'provider';
        v_source_match:=p_data->>'repositoryId'=v_connector.spec->'source'->>'repositoryId'
            AND (v_provider<>'azure-devops' OR p_data->>'projectId'=v_connector.spec->'source'->>'projectId')
            AND (p_data->>'eventType'<>'build.completed' OR v_connector.spec->'source'->>'buildDefinitionId' IS NULL
                OR p_data->>'buildDefinitionId'=v_connector.spec->'source'->>'buildDefinitionId')
            AND p_data->>'provider'=v_provider;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('webhook-delivery:'||p_origin||':'||p_delivery_id,0));
    SELECT * INTO v_delivery FROM ${s}.webhook_deliveries WHERE origin_id=p_origin AND delivery_id=p_delivery_id;
    IF FOUND THEN
        IF v_delivery.payload_hash<>p_payload_hash THEN RETURN jsonb_build_object('accepted',FALSE,'code','WEBHOOK_DELIVERY_CONFLICT'); END IF;
        UPDATE ${s}.webhook_receipts SET duplicate_count=duplicate_count+1,updated_at=now(),
            timeline=(SELECT COALESCE(jsonb_agg(x.value ORDER BY x.ordinality),'[]'::jsonb)
                FROM jsonb_array_elements(timeline) WITH ORDINALITY x(value,ordinality)
                WHERE x.ordinality>GREATEST(jsonb_array_length(timeline)-31,0))
                || jsonb_build_array(jsonb_build_object('status','duplicate','at',now()))
            WHERE delivery_pk=v_delivery.delivery_pk;
        RETURN jsonb_build_object('accepted',v_delivery.accepted,'duplicate',TRUE,'code',v_delivery.rejection_code);
    END IF;
    IF p_kind='endpoint' THEN
        IF v_endpoint.max_uses IS NOT NULL AND v_endpoint.use_count>=v_endpoint.max_uses
        THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Endpoint not found'; END IF;
        PERFORM ${s}.cms_webhook_target_owner(v_owner,v_endpoint.session_id,v_endpoint.target_owner_id);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('${s}.webhook-outbox-capacity',0));
    IF (SELECT count(*) FROM ${s}.webhook_outbox)>9984
       OR (SELECT count(*) FROM ${s}.webhook_outbox o JOIN ${s}.webhook_receipts r USING(receipt_id) WHERE r.origin_id=p_origin)>984
    THEN RETURN jsonb_build_object('accepted',FALSE,'code','WEBHOOK_RATE_LIMITED'); END IF;
    -- GitHub's signed setup ping proves endpoint reachability, not a session trigger.
    IF p_kind='connector' AND v_source_match AND p_data->>'eventType'<>'ping' THEN
        SELECT array_agg(x) INTO v_bindings FROM (
            SELECT * FROM ${s}.webhook_resources WHERE kind='binding' AND state='active' AND owner_id=v_owner
                AND spec->>'connectorId'=p_origin AND ${s}.cms_webhook_matches(spec->'filters',p_data)
                ORDER BY resource_id LIMIT 16) x;
        IF v_bindings IS NOT NULL THEN
            FOREACH v_binding IN ARRAY v_bindings LOOP
                IF NOT ${s}.cms_webhook_rate('binding:'||v_binding.resource_id,(v_binding.spec->>'rateLimitPerMinute')::int)
                THEN RETURN jsonb_build_object('accepted',FALSE,'code','WEBHOOK_RATE_LIMITED'); END IF;
            END LOOP;
        END IF;
    END IF;
    INSERT INTO ${s}.webhook_deliveries(delivery_pk,origin_id,delivery_id,payload_hash,trace_context)
        VALUES(p_delivery_pk,p_origin,p_delivery_id,p_payload_hash,p_trace_context);
    IF v_bindings IS NOT NULL THEN
        FOREACH v_binding IN ARRAY v_bindings
        LOOP
            v_status := 'matched';
            v_id:='whr_'||md5(p_delivery_pk||':'||v_binding.resource_id);
            v_session:=CASE WHEN v_binding.spec->'action'->>'type'='create_session' THEN md5('webhook-session:'||v_binding.resource_id||':'||p_delivery_id)::uuid::text
                ELSE v_binding.spec->'action'->>'sessionId' END;
            SELECT revision INTO v_template_revision FROM ${s}.webhook_resources WHERE resource_id=v_binding.spec->'action'->>'templateId' AND kind='template';
            INSERT INTO ${s}.webhook_receipts(receipt_id,delivery_pk,owner_id,provider,origin_id,origin_revision,binding_id,binding_revision,
                template_revision,status,event_type,event_action,session_id,signal_id,timeline)
                VALUES(v_id,p_delivery_pk,v_owner,v_provider,p_origin,v_connector.revision,v_binding.resource_id,v_binding.revision,
                    v_template_revision,v_status,p_data->>'eventType',p_data->>'action',v_session,'whsig_'||md5(v_id),
                    jsonb_build_array(jsonb_build_object('status','received','at',now()),jsonb_build_object('status','authenticated','at',now()),
                        jsonb_build_object('status','normalized','at',now()),jsonb_build_object('status',v_status,'at',now())));
            IF v_status='matched' THEN
                INSERT INTO ${s}.webhook_payloads(receipt_id,data) VALUES(v_id,p_data);
                INSERT INTO ${s}.webhook_outbox(receipt_id) VALUES(v_id);
            END IF;
            v_ids:=array_append(v_ids,v_id);
        END LOOP;
    END IF;
    IF cardinality(v_ids)=0 THEN
        v_id:='whr_'||md5(p_delivery_pk||':endpoint');
        v_status:=CASE WHEN NOT COALESCE(v_source_match,FALSE) THEN 'rejected' WHEN p_kind='endpoint' THEN 'matched' ELSE 'unmatched' END;
        IF p_kind='endpoint' AND EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=v_endpoint.session_id AND state IN ('completed','cancelled','failed','error'))
        THEN v_status:='target_terminal'; END IF;
        INSERT INTO ${s}.webhook_receipts(receipt_id,delivery_pk,owner_id,provider,origin_id,origin_revision,status,event_type,event_action,session_id,signal_id,timeline)
            VALUES(v_id,p_delivery_pk,v_owner,v_provider,p_origin,v_connector.revision,v_status,
                CASE WHEN p_kind='connector' THEN p_data->>'eventType' END,CASE WHEN p_kind='connector' THEN p_data->>'action' END,
                CASE WHEN p_kind='endpoint' THEN v_endpoint.session_id END,'whsig_'||md5(v_id),
                jsonb_build_array(jsonb_build_object('status','received','at',now()),jsonb_build_object('status','authenticated','at',now()),
                    jsonb_build_object('status','normalized','at',now()),jsonb_build_object('status',v_status,'at',now())));
        IF v_status='matched' THEN
            INSERT INTO ${s}.webhook_payloads(receipt_id,data) VALUES(v_id,p_data);
            INSERT INTO ${s}.webhook_outbox(receipt_id) VALUES(v_id);
            UPDATE ${s}.signal_endpoints SET use_count=use_count+1 WHERE endpoint_id=p_origin;
        END IF;
    END IF;
    IF v_status IN ('rejected','target_terminal') THEN
        UPDATE ${s}.webhook_deliveries SET accepted=FALSE,
            rejection_code=CASE WHEN v_status='rejected' THEN 'WEBHOOK_SOURCE_FORBIDDEN' ELSE 'WEBHOOK_TARGET_TERMINAL' END
            WHERE delivery_pk=p_delivery_pk;
    END IF;
    RETURN jsonb_build_object('accepted',v_status IS DISTINCT FROM 'rejected' AND v_status IS DISTINCT FROM 'target_terminal',
        'code',CASE WHEN v_status='rejected' THEN 'WEBHOOK_SOURCE_FORBIDDEN' WHEN v_status='target_terminal' THEN 'WEBHOOK_TARGET_TERMINAL' END);
END;
$$;
`;
}
function routingSql(s: string): string {
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_claim(p_token TEXT,p_limit INTEGER,p_contract INTEGER) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_row RECORD; v_claims JSONB:='[]'::jsonb;
BEGIN
    IF p_contract<>1 OR p_limit NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Unsupported outbox contract'; END IF;
    FOR v_row IN SELECT o.* FROM ${s}.webhook_outbox o
        WHERE o.contract_version=p_contract AND o.next_attempt_at<=now() AND (o.leased_until IS NULL OR o.leased_until<=now())
        ORDER BY o.next_attempt_at,o.receipt_id FOR UPDATE SKIP LOCKED LIMIT p_limit
    LOOP
        IF v_row.attempts>=8 THEN
            PERFORM ${s}.cms_webhook_transition(v_row.receipt_id,'dead_lettered','WEBHOOK_ATTEMPTS_EXHAUSTED');
            DELETE FROM ${s}.webhook_outbox WHERE receipt_id=v_row.receipt_id;
        ELSE
            UPDATE ${s}.webhook_outbox SET lease_token=p_token,leased_until=now()+interval '60 seconds',attempts=attempts+1
                WHERE receipt_id=v_row.receipt_id;
            UPDATE ${s}.webhook_receipts SET attempts=attempts+1,updated_at=now() WHERE receipt_id=v_row.receipt_id;
            v_claims:=v_claims||jsonb_build_array(jsonb_build_object('receiptId',v_row.receipt_id,'leaseToken',p_token));
        END IF;
    END LOOP;
    RETURN v_claims;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_route_context(p_id TEXT,p_token TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_receipt ${s}.webhook_receipts; v_endpoint ${s}.signal_endpoints; v_connector ${s}.webhook_resources;
    v_binding ${s}.webhook_resources; v_template ${s}.webhook_resources; v_payload JSONB; v_action JSONB;
    v_key TEXT; v_session TEXT; v_coalesced BOOLEAN:=FALSE; v_target BIGINT;
BEGIN
    PERFORM 1 FROM ${s}.webhook_outbox WHERE receipt_id=p_id AND lease_token=p_token AND leased_until>now() AND contract_version=1 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_LEASE_LOST: Outbox lease is no longer valid'; END IF;
    SELECT * INTO v_receipt FROM ${s}.webhook_receipts WHERE receipt_id=p_id FOR UPDATE;
    IF NOT ${s}.cms_webhook_user_active(v_receipt.owner_id) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Owner membership was revoked'; END IF;
    SELECT data INTO v_payload FROM ${s}.webhook_payloads WHERE receipt_id=p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_PAYLOAD_UNAVAILABLE: Routing data is unavailable'; END IF;
    v_session:=v_receipt.session_id;
    IF v_receipt.provider='generic' THEN
        SELECT * INTO v_endpoint FROM ${s}.signal_endpoints WHERE endpoint_id=v_receipt.origin_id;
        IF NOT FOUND OR v_endpoint.revoked_at IS NOT NULL OR v_endpoint.owner_id<>v_receipt.owner_id
        THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Endpoint revoked'; END IF;
        IF v_endpoint.expires_at<=now() THEN RAISE EXCEPTION 'WEBHOOK_EXPIRED: Endpoint expired'; END IF;
        PERFORM ${s}.cms_webhook_target_owner(v_receipt.owner_id,v_session,v_endpoint.target_owner_id);
        v_action:=jsonb_build_object('type','raise_signal','sessionId',v_session,'signalName',v_endpoint.signal_name,'wake',v_endpoint.wake);
    ELSE
        SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=v_receipt.origin_id AND kind='connector';
        IF NOT FOUND OR v_connector.state<>'active' OR v_connector.owner_id<>v_receipt.owner_id
            OR v_connector.revision IS DISTINCT FROM v_receipt.origin_revision
        THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Connector revoked or changed'; END IF;
        IF v_payload->>'repositoryId' IS DISTINCT FROM v_connector.spec->'source'->>'repositoryId'
            OR v_payload->>'projectId' IS DISTINCT FROM v_connector.spec->'source'->>'projectId'
            OR v_payload->>'provider' IS DISTINCT FROM v_connector.spec->>'provider'
            OR (v_payload->>'eventType'='build.completed' AND v_connector.spec->'source'->>'buildDefinitionId' IS NOT NULL
                AND v_payload->>'buildDefinitionId' IS DISTINCT FROM v_connector.spec->'source'->>'buildDefinitionId')
        THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Source scope is no longer authorized'; END IF;
        SELECT * INTO v_binding FROM ${s}.webhook_resources WHERE resource_id=v_receipt.binding_id AND kind='binding';
        IF NOT FOUND OR v_binding.state<>'active' OR v_binding.owner_id<>v_receipt.owner_id
            OR v_binding.revision IS DISTINCT FROM v_receipt.binding_revision OR v_binding.spec->>'connectorId'<>v_connector.resource_id
        THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Binding revoked or changed'; END IF;
        v_target:=${s}.cms_webhook_binding_check(v_receipt.owner_id,v_binding.spec);
        IF v_target IS DISTINCT FROM v_binding.target_owner_id THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Target ownership changed'; END IF;
        v_action:=v_binding.spec->'action';
        IF v_action->>'type'='create_session' THEN
            SELECT * INTO v_template FROM ${s}.webhook_resources WHERE resource_id=v_action->>'templateId' AND kind='template';
            IF v_template.revision IS DISTINCT FROM v_receipt.template_revision THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Approved template changed'; END IF;
            IF v_action ? 'coalescing' THEN
                IF v_payload->>'pullRequestNumber' IS NULL THEN RAISE EXCEPTION 'WEBHOOK_COALESCING_KEY: Event has no PR coalescing key'; END IF;
                v_key:=v_receipt.provider||':'||COALESCE(v_payload->>'projectId','')||':'||(v_payload->>'repositoryId')||':'||(v_payload->>'pullRequestNumber');
                PERFORM pg_advisory_xact_lock(hashtextextended('webhook-coalesce:'||v_binding.resource_id||':'||v_key,0));
                SELECT session_id INTO v_session FROM ${s}.webhook_coalescing WHERE binding_id=v_binding.resource_id AND coalesce_key=v_key AND owner_id=v_receipt.owner_id;
                IF v_session IS NOT NULL AND EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=v_session AND
                    (deleted_at IS NOT NULL OR state IN ('completed','cancelled','failed','error'))) THEN v_session:=NULL; END IF;
                IF v_session IS NOT NULL AND EXISTS(SELECT 1 FROM ${s}.session_creation_keys WHERE session_id=v_session)
                    AND NOT EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=v_session) THEN v_session:=NULL; END IF;
                IF v_session IS NULL THEN
                    v_session:=v_receipt.session_id;
                    INSERT INTO ${s}.webhook_coalescing(binding_id,coalesce_key,session_id,owner_id)
                        VALUES(v_binding.resource_id,v_key,v_session,v_receipt.owner_id)
                        ON CONFLICT(binding_id,coalesce_key) DO UPDATE SET session_id=EXCLUDED.session_id,owner_id=EXCLUDED.owner_id;
                ELSE
                    v_coalesced:=v_session<>md5('webhook-session:'||v_binding.resource_id||':'||(SELECT delivery_id FROM ${s}.webhook_deliveries WHERE delivery_pk=v_receipt.delivery_pk))::uuid::text;
                END IF;
            END IF;
            IF EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=v_session) THEN
                PERFORM ${s}.cms_webhook_target_owner(v_receipt.owner_id,v_session,v_receipt.owner_id);
            END IF;
        ELSE
            PERFORM ${s}.cms_webhook_target_owner(v_receipt.owner_id,v_session,v_binding.target_owner_id);
        END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=v_session AND state IN ('completed','cancelled','failed','error'))
    THEN RAISE EXCEPTION 'WEBHOOK_TARGET_TERMINAL: Target session is terminal'; END IF;
    UPDATE ${s}.webhook_receipts SET session_id=v_session,coalesced=v_coalesced WHERE receipt_id=p_id;
    IF v_receipt.status NOT IN ('consumed','dropped') THEN PERFORM ${s}.cms_webhook_transition(p_id,'routed'); END IF;
    UPDATE ${s}.webhook_outbox SET leased_until=now()+interval '60 seconds' WHERE receipt_id=p_id;
    RETURN jsonb_strip_nulls(jsonb_build_object('receiptId',p_id,'leaseToken',p_token,'owner',${s}.cms_webhook_principal(v_receipt.owner_id),
        'action',v_action,'sessionId',v_session,'signalId',v_receipt.signal_id,'coalesced',v_coalesced,
        'traceContext',(SELECT trace_context FROM ${s}.webhook_deliveries WHERE delivery_pk=v_receipt.delivery_pk),
        'template',CASE WHEN v_template.resource_id IS NOT NULL THEN ${s}.cms_webhook_resource_json(v_template) END))
        || jsonb_build_object(CASE WHEN v_receipt.provider='generic' THEN 'data' ELSE 'event' END,v_payload);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_finish(p_id TEXT,p_token TEXT,p_status TEXT,p_code TEXT,p_retry BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_attempts INTEGER; v_status TEXT;
BEGIN
    SELECT attempts INTO v_attempts FROM ${s}.webhook_outbox
        WHERE receipt_id=p_id AND lease_token=p_token AND leased_until>now() AND contract_version=1 FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    SELECT status INTO v_status FROM ${s}.webhook_receipts WHERE receipt_id=p_id FOR UPDATE;
    IF p_status NOT IN ('routed','queued','consumed','disabled','expired','target_terminal','routing_failed','dead_lettered','rejected')
       OR (p_code IS NOT NULL AND p_code !~ '^[A-Z][A-Z0-9_]{0,95}$') THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid route disposition'; END IF;
    IF v_status IN ('consumed','dropped') THEN
        DELETE FROM ${s}.webhook_outbox WHERE receipt_id=p_id;
        RETURN TRUE;
    END IF;
    IF p_retry AND v_attempts<8 THEN
        UPDATE ${s}.webhook_outbox SET lease_token=NULL,leased_until=NULL,
            next_attempt_at=now()+make_interval(secs=>LEAST(300,power(2,v_attempts)::int))
            WHERE receipt_id=p_id;
        PERFORM ${s}.cms_webhook_transition(p_id,'routing_failed',p_code);
    ELSE
        DELETE FROM ${s}.webhook_outbox WHERE receipt_id=p_id;
        PERFORM ${s}.cms_webhook_transition(p_id,CASE WHEN p_retry THEN 'dead_lettered' ELSE p_status END,p_code);
    END IF;
    RETURN TRUE;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_signal_disposition(p_id TEXT,p_session TEXT,p_signal TEXT,p_disposition TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_row ${s}.webhook_receipts;
BEGIN
    IF p_disposition NOT IN ('consumed','dropped') THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid signal disposition'; END IF;
    PERFORM 1 FROM ${s}.webhook_outbox WHERE receipt_id=p_id FOR UPDATE;
    SELECT * INTO v_row FROM ${s}.webhook_receipts
        WHERE receipt_id=p_id AND session_id=p_session AND signal_id=p_signal
            AND attempts>0 FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    IF v_row.status IN ('consumed','dropped') THEN RETURN v_row.status=p_disposition; END IF;
    PERFORM ${s}.cms_webhook_transition(p_id,p_disposition);
    DELETE FROM ${s}.webhook_outbox WHERE receipt_id=p_id;
    RETURN TRUE;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_signal_event_disposition() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_signal TEXT;
BEGIN
    IF NEW.data->'source'->>'kind'='webhook'
        AND octet_length(NEW.data->'source'->>'receiptId') BETWEEN 1 AND 128
        AND octet_length(NEW.data->>'signalId') BETWEEN 1 AND 128 THEN
        PERFORM ${s}.cms_webhook_signal_disposition(NEW.data->'source'->>'receiptId',NEW.session_id,NEW.data->>'signalId',
            CASE WHEN NEW.event_type='session.signal_consumed' THEN 'consumed' ELSE 'dropped' END);
    END IF;
    IF NEW.event_type='session.webhook_prompt_consumed'
        AND NEW.data->>'messageId'='webhook:'||(NEW.data->>'receiptId') THEN
        SELECT signal_id INTO v_signal FROM ${s}.webhook_receipts
            WHERE receipt_id=NEW.data->>'receiptId' AND session_id=NEW.session_id AND attempts>0;
        IF v_signal IS NOT NULL THEN
            PERFORM ${s}.cms_webhook_signal_disposition(NEW.data->>'receiptId',NEW.session_id,v_signal,'consumed');
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS webhook_signal_receipt_disposition ON ${s}.session_events;
CREATE TRIGGER webhook_signal_receipt_disposition AFTER INSERT ON ${s}.session_events
    FOR EACH ROW WHEN (NEW.event_type IN ('session.signal_consumed','session.signal_dropped','session.webhook_prompt_consumed'))
    EXECUTE FUNCTION ${s}.cms_webhook_signal_event_disposition();
`;
}
function operationsSql(s: string): string {
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_receipt_json(p_row ${s}.webhook_receipts) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object('receiptId',p_row.receipt_id,
        CASE WHEN p_row.provider='generic' THEN 'endpointId' ELSE 'connectorId' END,p_row.origin_id,
        'bindingId',p_row.binding_id,'deliveryId',(SELECT delivery_id FROM ${s}.webhook_deliveries WHERE delivery_pk=p_row.delivery_pk),
        'status',p_row.status,'eventType',p_row.event_type,'action',p_row.event_action,'sessionId',p_row.session_id,
        'signalId',p_row.signal_id,'attempts',p_row.attempts,'duplicateCount',p_row.duplicate_count,'replayCount',p_row.replay_count,
        'lastErrorCode',p_row.last_error_code,'receivedAt',p_row.received_at,'updatedAt',p_row.updated_at,'timeline',p_row.timeline,
        'nextAttemptAt',(SELECT next_attempt_at FROM ${s}.webhook_outbox WHERE receipt_id=p_row.receipt_id)));
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_receipts(p_id TEXT,p_query JSONB,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject,p_admin); v_row ${s}.webhook_receipts; v_result JSONB; v_before TIMESTAMPTZ; v_limit INTEGER;
BEGIN
    IF p_id IS NOT NULL THEN
        SELECT * INTO v_row FROM ${s}.webhook_receipts WHERE receipt_id=p_id AND (p_admin OR owner_id=v_actor);
        IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Receipt not found'; END IF;
        RETURN ${s}.cms_webhook_receipt_json(v_row);
    END IF;
    v_limit:=COALESCE((p_query->>'limit')::int,50);
    IF v_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid receipt page size'; END IF;
    IF p_query ? 'before' THEN
        SELECT received_at INTO v_before FROM ${s}.webhook_receipts WHERE receipt_id=p_query->>'before' AND (p_admin OR owner_id=v_actor);
        IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Receipt cursor not found'; END IF;
    END IF;
    SELECT COALESCE(jsonb_agg(${s}.cms_webhook_receipt_json(x)),'[]'::jsonb) INTO v_result FROM (
        SELECT * FROM ${s}.webhook_receipts r WHERE (p_admin OR owner_id=v_actor)
            AND (NOT p_query ? 'connectorId' OR (provider<>'generic' AND origin_id=p_query->>'connectorId'))
            AND (NOT p_query ? 'endpointId' OR (provider='generic' AND origin_id=p_query->>'endpointId'))
            AND (NOT p_query ? 'sessionId' OR session_id=p_query->>'sessionId')
            AND (NOT p_query ? 'status' OR status=p_query->>'status')
            AND (v_before IS NULL OR (received_at,receipt_id)<(v_before,p_query->>'before'))
            ORDER BY received_at DESC,receipt_id DESC LIMIT v_limit) x;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_test(p_id TEXT,p_event JSONB,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_binding ${s}.webhook_resources; v_connector ${s}.webhook_resources; v_matches BOOLEAN;
BEGIN
    SELECT * INTO v_binding FROM ${s}.webhook_resources WHERE resource_id=p_id AND kind='binding' AND (p_admin OR owner_id=v_actor);
    IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Binding not found'; END IF;
    PERFORM ${s}.cms_webhook_binding_check(v_binding.owner_id,v_binding.spec);
    SELECT * INTO v_connector FROM ${s}.webhook_resources WHERE resource_id=v_binding.spec->>'connectorId';
    v_matches:=v_binding.state='active' AND v_connector.state='active'
        AND p_event->>'eventType'<>'ping'
        AND p_event->>'provider'=v_connector.spec->>'provider'
        AND p_event->>'repositoryId'=v_connector.spec->'source'->>'repositoryId'
        AND p_event->>'projectId' IS NOT DISTINCT FROM v_connector.spec->'source'->>'projectId'
        AND (p_event->>'eventType'<>'build.completed' OR v_connector.spec->'source'->>'buildDefinitionId' IS NULL
            OR p_event->>'buildDefinitionId'=v_connector.spec->'source'->>'buildDefinitionId')
        AND ${s}.cms_webhook_matches(v_binding.spec->'filters',p_event);
    RETURN jsonb_build_object('matches',v_matches,'authorized',TRUE,'authorizationScope','persisted_policy',
        'action',v_binding.spec->'action'->>'type','event',p_event);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_replay(p_id TEXT,p_confirmed BOOLEAN,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_row ${s}.webhook_receipts; v_resource ${s}.webhook_resources; v_endpoint ${s}.signal_endpoints;
BEGIN
    IF NOT COALESCE(p_confirmed,FALSE) THEN RAISE EXCEPTION 'WEBHOOK_CONFIRMATION_REQUIRED: Receipt replay must be explicitly confirmed'; END IF;
    PERFORM 1 FROM ${s}.webhook_outbox WHERE receipt_id=p_id FOR UPDATE;
    SELECT * INTO v_row FROM ${s}.webhook_receipts WHERE receipt_id=p_id AND (p_admin OR owner_id=v_actor) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WEBHOOK_NOT_FOUND: Receipt not found'; END IF;
    IF v_row.status NOT IN ('routing_failed','dead_lettered','disabled','expired','target_terminal')
        OR EXISTS(SELECT 1 FROM ${s}.webhook_outbox WHERE receipt_id=p_id AND leased_until>now())
    THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Receipt cannot currently be replayed'; END IF;
    IF v_row.replay_count>=3 THEN RAISE EXCEPTION 'WEBHOOK_LIMIT: At most three explicit replays per receipt'; END IF;
    IF NOT EXISTS(SELECT 1 FROM ${s}.webhook_payloads WHERE receipt_id=p_id)
    THEN RAISE EXCEPTION 'WEBHOOK_PAYLOAD_UNAVAILABLE: Receipt has no retained routing data'; END IF;
    IF NOT ${s}.cms_webhook_user_active(v_row.owner_id) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Owner membership was revoked'; END IF;
    IF v_row.provider='generic' THEN
        SELECT * INTO v_endpoint FROM ${s}.signal_endpoints WHERE endpoint_id=v_row.origin_id;
        IF NOT FOUND OR v_endpoint.revoked_at IS NOT NULL OR v_endpoint.expires_at<=now() THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Endpoint is not active'; END IF;
        PERFORM ${s}.cms_webhook_target_owner(v_row.owner_id,v_endpoint.session_id,v_endpoint.target_owner_id);
    ELSE
        SELECT * INTO v_resource FROM ${s}.webhook_resources WHERE resource_id=v_row.origin_id AND kind='connector';
        IF NOT FOUND OR v_resource.state<>'active' OR v_resource.owner_id<>v_row.owner_id THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Connector is not active'; END IF;
        UPDATE ${s}.webhook_receipts SET origin_revision=v_resource.revision WHERE receipt_id=p_id;
        SELECT * INTO v_resource FROM ${s}.webhook_resources WHERE resource_id=v_row.binding_id AND kind='binding';
        IF NOT FOUND OR v_resource.state<>'active' OR v_resource.revision IS DISTINCT FROM v_row.binding_revision
        THEN RAISE EXCEPTION 'WEBHOOK_DISABLED: Binding changed; create a new delivery rather than retargeting an old one'; END IF;
        IF ${s}.cms_webhook_binding_check(v_row.owner_id,v_resource.spec) IS DISTINCT FROM v_resource.target_owner_id
        THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Target ownership changed'; END IF;
    END IF;
    UPDATE ${s}.webhook_receipts SET replay_count=replay_count+1 WHERE receipt_id=p_id;
    INSERT INTO ${s}.webhook_outbox(receipt_id) VALUES(p_id) ON CONFLICT(receipt_id)
        DO UPDATE SET next_attempt_at=now(),lease_token=NULL,leased_until=NULL,attempts=0,contract_version=1;
    PERFORM ${s}.cms_webhook_transition(p_id,'matched');
    PERFORM ${s}.cms_webhook_audit(v_actor,'receipt.replay',p_id);
    SELECT * INTO v_row FROM ${s}.webhook_receipts WHERE receipt_id=p_id;
    RETURN ${s}.cms_webhook_receipt_json(v_row);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_metrics(p_provider TEXT,p_subject TEXT,p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject,p_admin); v_counts JSONB; v_pending BIGINT; v_dead BIGINT; v_pending_age DOUBLE PRECISION; v_dead_age DOUBLE PRECISION;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('provider',provider,'status',status,'count',n)),'[]'::jsonb) INTO v_counts
    FROM (SELECT provider,status,sum(n)::bigint AS n FROM (
        SELECT provider,status,count(*) AS n FROM ${s}.webhook_receipts WHERE p_admin OR owner_id=v_actor GROUP BY provider,status
        UNION ALL SELECT provider,'duplicate',sum(duplicate_count) FROM ${s}.webhook_receipts WHERE p_admin OR owner_id=v_actor GROUP BY provider
        UNION ALL SELECT provider,outcome,count FROM ${s}.webhook_ingress_counters WHERE p_admin OR owner_id=v_actor
    ) x GROUP BY provider,status) y;
    SELECT count(*),COALESCE(EXTRACT(EPOCH FROM now()-min(r.received_at)),0) INTO v_pending,v_pending_age
        FROM ${s}.webhook_outbox o JOIN ${s}.webhook_receipts r USING(receipt_id) WHERE p_admin OR r.owner_id=v_actor;
    SELECT count(*),COALESCE(EXTRACT(EPOCH FROM now()-min(updated_at)),0) INTO v_dead,v_dead_age
        FROM ${s}.webhook_receipts WHERE status='dead_lettered' AND (p_admin OR owner_id=v_actor);
    RETURN jsonb_build_object('receipts',v_counts,'pending',v_pending,'deadLettered',v_dead,
        'oldestPendingAgeSeconds',v_pending_age,'oldestDeadLetterAgeSeconds',v_dead_age);
END;
$$;
`;
}
function creationSql(s: string): string {
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_create_session_once(
    p_session TEXT,p_key TEXT,p_owner JSONB,p_agent TEXT,p_config JSONB,p_metadata JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_owner BIGINT; v_key ${s}.session_creation_keys;
BEGIN
    v_owner:=${s}.cms_webhook_actor(p_owner->>'provider',p_owner->>'subject');
    IF NOT ${s}.cms_webhook_user_active(v_owner) THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Owner is no longer authorized'; END IF;
    IF octet_length(p_key) NOT BETWEEN 1 AND 256 OR octet_length(p_session) NOT BETWEEN 1 AND 128
    THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Invalid session creation identity'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('session-create-once:'||p_session,0));
    SELECT * INTO v_key FROM ${s}.session_creation_keys WHERE session_id=p_session;
    IF FOUND THEN
        IF v_key.creation_key<>p_key OR v_key.owner_id<>v_owner OR v_key.agent_id IS DISTINCT FROM p_agent
        THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Session creation identity does not match'; END IF;
        IF NOT EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=p_session AND deleted_at IS NULL)
        THEN RAISE EXCEPTION 'WEBHOOK_TARGET_TERMINAL: Reserved session was deleted and will not be recreated'; END IF;
        PERFORM ${s}.cms_webhook_target_owner(v_owner,p_session,v_owner);
        RETURN FALSE;
    END IF;
    IF EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=p_session)
    THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Session ID is already in use'; END IF;
    IF p_metadata->>'modelResolutionSource' IS NOT NULL THEN
        BEGIN
            PERFORM ${s}.cms_provider_assert_session_model(p_config->>'model',p_owner->>'provider',p_owner->>'subject',FALSE);
        EXCEPTION WHEN raise_exception THEN
            RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Session model/provider is not authorized for the routing owner';
        END;
    END IF;
    PERFORM ${s}.cms_create_session(p_session,p_config->>'model',p_config->>'reasoningEffort',NULL,FALSE,p_agent,
        p_metadata->>'splash',NULL,p_metadata->>'splashMobile',COALESCE(p_metadata->>'visibility','private'));
    PERFORM ${s}.cms_set_session_owner(p_session,p_owner->>'provider',p_owner->>'subject',NULL,NULL);
    UPDATE ${s}.sessions SET creation_config=p_config,context_tier=p_config->>'contextTier',
        model_resolution_source=p_metadata->>'modelResolutionSource',title=COALESCE(p_metadata->>'title',title)
        WHERE session_id=p_session;
    INSERT INTO ${s}.session_creation_keys(session_id,creation_key,owner_id,agent_id) VALUES(p_session,p_key,v_owner,p_agent);
    RETURN TRUE;
END;
$$;
`;
}
