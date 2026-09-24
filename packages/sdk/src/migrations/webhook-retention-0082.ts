/** Migration 0082: bounded webhook history; delivery and creation identities never expire. */
export function webhookRetentionMigration(schema: string): string[] {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return [`
CREATE TABLE IF NOT EXISTS ${s}.webhook_retention_policy (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    revision INTEGER NOT NULL DEFAULT 1,
    receipt_days INTEGER NOT NULL DEFAULT 30 CHECK (receipt_days BETWEEN 1 AND 3650),
    replay_days INTEGER NOT NULL DEFAULT 30 CHECK (replay_days BETWEEN 1 AND receipt_days),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sweep_at TIMESTAMPTZ,
    next_sweep_at TIMESTAMPTZ
);
INSERT INTO ${s}.webhook_retention_policy(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${s}.webhook_retention_totals (
    owner_id BIGINT PRIMARY KEY,
    receipts_deleted BIGINT NOT NULL DEFAULT 0,
    payloads_deleted BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE ${s}.webhook_receipts ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE ${s}.webhook_receipts ADD COLUMN IF NOT EXISTS receipt_expires_at TIMESTAMPTZ;
ALTER TABLE ${s}.webhook_receipts ADD COLUMN IF NOT EXISTS replay_expires_at TIMESTAMPTZ;
ALTER TABLE ${s}.webhook_receipts ADD COLUMN IF NOT EXISTS payload_expires_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION ${s}.cms_webhook_retention_policy_json() RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('revision',revision,'receiptRetentionDays',receipt_days,
        'replayRetentionDays',replay_days,'updatedAt',updated_at)
    FROM ${s}.webhook_retention_policy WHERE singleton;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_retention_update(p_patch JSONB,p_provider TEXT,p_subject TEXT,p_approve BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject); v_row ${s}.webhook_retention_policy;
BEGIN
    IF NOT COALESCE(p_approve,FALSE) OR NOT EXISTS(
        SELECT 1 FROM ${s}.users WHERE user_id=v_actor AND role IN ('admin','anonymous'))
    THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN: Retention policy requires an administrator'; END IF;
    IF p_patch IS NULL OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
        OR p_patch-'expectedRevision'-'receiptRetentionDays'-'replayRetentionDays'<>'{}'::jsonb
        OR NOT (p_patch ?& ARRAY['expectedRevision','receiptRetentionDays','replayRetentionDays'])
        OR jsonb_typeof(p_patch->'expectedRevision') IS DISTINCT FROM 'number'
        OR jsonb_typeof(p_patch->'receiptRetentionDays') IS DISTINCT FROM 'number'
        OR jsonb_typeof(p_patch->'replayRetentionDays') IS DISTINCT FROM 'number'
        OR p_patch->>'expectedRevision' !~ '^[0-9]{1,10}$'
        OR p_patch->>'receiptRetentionDays' !~ '^[0-9]{1,4}$' OR p_patch->>'replayRetentionDays' !~ '^[0-9]{1,4}$'
        OR (p_patch->>'receiptRetentionDays')::int NOT BETWEEN 1 AND 3650
        OR (p_patch->>'replayRetentionDays')::int NOT BETWEEN 1 AND (p_patch->>'receiptRetentionDays')::int
    THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Retention days must be 1-3650 and replay cannot outlive receipt history'; END IF;
    SELECT * INTO STRICT v_row FROM ${s}.webhook_retention_policy WHERE singleton FOR UPDATE;
    IF (p_patch->>'expectedRevision')::int IS DISTINCT FROM v_row.revision
    THEN RAISE EXCEPTION 'WEBHOOK_CONFLICT: Retention policy changed'; END IF;
    UPDATE ${s}.webhook_retention_policy SET receipt_days=(p_patch->>'receiptRetentionDays')::int,
        replay_days=(p_patch->>'replayRetentionDays')::int,revision=revision+1,updated_at=now()
        WHERE singleton;
    PERFORM ${s}.cms_webhook_audit(v_actor,'retention.update','webhook-retention');
    RETURN ${s}.cms_webhook_retention_policy_json();
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_webhook_retention_stamp() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_policy ${s}.webhook_retention_policy;
BEGIN
    IF NEW.status IN ('consumed','dropped','unmatched','rejected','disabled','expired','target_terminal','dead_lettered','routed','routing_failed')
        AND NOT EXISTS(SELECT 1 FROM ${s}.webhook_outbox WHERE receipt_id=NEW.receipt_id) THEN
        IF NEW.settled_at IS NULL OR (TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
            SELECT * INTO STRICT v_policy FROM ${s}.webhook_retention_policy WHERE singleton;
            NEW.settled_at:=now();
            NEW.receipt_expires_at:=now()+make_interval(days=>v_policy.receipt_days);
            IF NEW.status IN ('routing_failed','dead_lettered','disabled','expired','target_terminal') THEN
                NEW.replay_expires_at:=COALESCE(NEW.replay_expires_at,now()+make_interval(days=>v_policy.replay_days));
                NEW.payload_expires_at:=NEW.replay_expires_at;
                NEW.receipt_expires_at:=GREATEST(NEW.receipt_expires_at,NEW.replay_expires_at);
            ELSE
                NEW.payload_expires_at:=now();
            END IF;
        END IF;
    ELSE
        NEW.settled_at:=NULL;
        NEW.receipt_expires_at:=NULL;
        NEW.payload_expires_at:=NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS webhook_retention_stamp ON ${s}.webhook_receipts;
CREATE TRIGGER webhook_retention_stamp BEFORE INSERT OR UPDATE OF status ON ${s}.webhook_receipts
    FOR EACH ROW EXECUTE FUNCTION ${s}.cms_webhook_retention_stamp();

-- Some existing transitions precede outbox removal. Stamp only once that work is no longer actionable.
CREATE OR REPLACE FUNCTION ${s}.cms_webhook_outbox_retention() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ${s}.webhook_receipts SET status=status WHERE receipt_id=OLD.receipt_id;
    RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS webhook_outbox_retention ON ${s}.webhook_outbox;
CREATE TRIGGER webhook_outbox_retention AFTER DELETE ON ${s}.webhook_outbox
    FOR EACH ROW EXECUTE FUNCTION ${s}.cms_webhook_outbox_retention();

CREATE OR REPLACE FUNCTION ${s}.cms_webhook_retention_sweep(p_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_policy ${s}.webhook_retention_policy; v_row ${s}.webhook_receipts; v_n INTEGER;
    v_processed INTEGER:=0; v_payloads INTEGER:=0; v_receipts INTEGER:=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'WEBHOOK_INVALID: Retention batch must be 1-500'; END IF;
    SELECT * INTO v_policy FROM ${s}.webhook_retention_policy WHERE singleton FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
        IF NOT EXISTS(SELECT 1 FROM ${s}.webhook_retention_policy WHERE singleton)
        THEN RAISE EXCEPTION 'WEBHOOK_CONFIG_INVALID: Retention policy is missing'; END IF;
        RETURN jsonb_build_object('processed',0,'payloadsDeleted',0,'receiptsDeleted',0,'nextSweepAt',now()+interval '1 second');
    END IF;
    IF v_policy.next_sweep_at>now() THEN RETURN jsonb_build_object('processed',0,'payloadsDeleted',0,'receiptsDeleted',0,
        'nextSweepAt',v_policy.next_sweep_at); END IF;
    FOR v_row IN
        SELECT r.* FROM ${s}.webhook_receipts r
        WHERE r.status IN ('consumed','dropped','unmatched','rejected','disabled','expired','target_terminal','dead_lettered','routed','routing_failed')
            AND COALESCE(LEAST(r.payload_expires_at,r.receipt_expires_at),'-infinity'::timestamptz)<=now()
            AND NOT EXISTS(SELECT 1 FROM ${s}.webhook_outbox o WHERE o.receipt_id=r.receipt_id)
        ORDER BY COALESCE(LEAST(r.payload_expires_at,r.receipt_expires_at),'-infinity'::timestamptz),r.receipt_id
        FOR UPDATE OF r SKIP LOCKED LIMIT p_limit
    LOOP
        IF EXISTS(SELECT 1 FROM ${s}.webhook_outbox WHERE receipt_id=v_row.receipt_id) THEN CONTINUE; END IF;
        v_processed:=v_processed+1;
        IF v_row.settled_at IS NULL THEN
            -- Existing terminal receipts get a full window on upgrade, in bounded batches.
            UPDATE ${s}.webhook_receipts SET status=status WHERE receipt_id=v_row.receipt_id;
            CONTINUE;
        END IF;
        IF v_row.payload_expires_at<=now() THEN
            DELETE FROM ${s}.webhook_payloads WHERE receipt_id=v_row.receipt_id;
            GET DIAGNOSTICS v_n=ROW_COUNT;
            v_payloads:=v_payloads+v_n;
            INSERT INTO ${s}.webhook_retention_totals(owner_id,payloads_deleted) VALUES(v_row.owner_id,v_n)
                ON CONFLICT(owner_id) DO UPDATE SET payloads_deleted=${s}.webhook_retention_totals.payloads_deleted+EXCLUDED.payloads_deleted;
            UPDATE ${s}.webhook_receipts SET payload_expires_at=NULL WHERE receipt_id=v_row.receipt_id;
        END IF;
        IF v_row.receipt_expires_at<=now() AND NOT EXISTS(SELECT 1 FROM ${s}.webhook_payloads WHERE receipt_id=v_row.receipt_id) THEN
            DELETE FROM ${s}.webhook_receipts WHERE receipt_id=v_row.receipt_id;
            GET DIAGNOSTICS v_n=ROW_COUNT;
            v_receipts:=v_receipts+v_n;
            UPDATE ${s}.webhook_deliveries SET trace_context='{}'
                WHERE delivery_pk=v_row.delivery_pk AND trace_context<>'{}'
                    AND NOT EXISTS(SELECT 1 FROM ${s}.webhook_receipts WHERE delivery_pk=v_row.delivery_pk);
            INSERT INTO ${s}.webhook_retention_totals(owner_id,receipts_deleted) VALUES(v_row.owner_id,v_n)
                ON CONFLICT(owner_id) DO UPDATE SET receipts_deleted=${s}.webhook_retention_totals.receipts_deleted+EXCLUDED.receipts_deleted;
        END IF;
    END LOOP;
    UPDATE ${s}.webhook_retention_policy SET last_sweep_at=clock_timestamp(),
        next_sweep_at=clock_timestamp()+make_interval(secs=>CASE WHEN v_processed=p_limit THEN 1 ELSE 60 END)
        WHERE singleton RETURNING * INTO v_policy;
    RETURN jsonb_build_object('processed',v_processed,'payloadsDeleted',v_payloads,'receiptsDeleted',v_receipts,'nextSweepAt',v_policy.next_sweep_at);
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_webhook_receipt_json(p_row ${s}.webhook_receipts) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object('receiptId',p_row.receipt_id,
        CASE WHEN p_row.provider='generic' THEN 'endpointId' ELSE 'connectorId' END,p_row.origin_id,
        'bindingId',p_row.binding_id,'deliveryId',(SELECT delivery_id FROM ${s}.webhook_deliveries WHERE delivery_pk=p_row.delivery_pk),
        'status',p_row.status,'eventType',p_row.event_type,'action',p_row.event_action,'sessionId',p_row.session_id,
        'signalId',p_row.signal_id,'attempts',p_row.attempts,'duplicateCount',p_row.duplicate_count,'replayCount',p_row.replay_count,
        'lastErrorCode',p_row.last_error_code,'receivedAt',p_row.received_at,'updatedAt',p_row.updated_at,'timeline',p_row.timeline,
        'nextAttemptAt',(SELECT next_attempt_at FROM ${s}.webhook_outbox WHERE receipt_id=p_row.receipt_id),
        'settledAt',p_row.settled_at,'receiptExpiresAt',p_row.receipt_expires_at,'replayExpiresAt',p_row.replay_expires_at,
        'payloadRetained',EXISTS(SELECT 1 FROM ${s}.webhook_payloads WHERE receipt_id=p_row.receipt_id),
        'replayAvailable',p_row.status IN ('routing_failed','dead_lettered','disabled','expired','target_terminal')
            AND p_row.replay_count<3 AND (p_row.replay_expires_at IS NULL OR p_row.replay_expires_at>now())
            AND EXISTS(SELECT 1 FROM ${s}.webhook_payloads WHERE receipt_id=p_row.receipt_id)
            AND NOT EXISTS(SELECT 1 FROM ${s}.webhook_outbox WHERE receipt_id=p_row.receipt_id AND leased_until>now())));
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
    IF v_row.replay_expires_at<=now() THEN RAISE EXCEPTION 'WEBHOOK_REPLAY_EXPIRED: Receipt replay window has expired'; END IF;
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
DECLARE v_actor BIGINT := ${s}.cms_webhook_actor(p_provider,p_subject,p_admin); v_counts JSONB; v_pending BIGINT; v_dead BIGINT;
    v_pending_age DOUBLE PRECISION; v_dead_age DOUBLE PRECISION; v_retention JSONB;
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
    SELECT jsonb_build_object('policy',${s}.cms_webhook_retention_policy_json(),
        'lastSweepAt',(SELECT last_sweep_at FROM ${s}.webhook_retention_policy WHERE singleton),
        'nextSweepAt',(SELECT next_sweep_at FROM ${s}.webhook_retention_policy WHERE singleton),
        'receiptsDeleted',COALESCE(sum(receipts_deleted),0),'payloadsDeleted',COALESCE(sum(payloads_deleted),0))
        INTO v_retention FROM ${s}.webhook_retention_totals WHERE p_admin OR owner_id=v_actor;
    RETURN jsonb_build_object('receipts',v_counts,'pending',v_pending,'deadLettered',v_dead,
        'oldestPendingAgeSeconds',v_pending_age,'oldestDeadLetterAgeSeconds',v_dead_age,'retention',v_retention);
END;
$$;
`,
    // A failed concurrent build can leave an invalid index; recreate it on an unrecorded migration retry.
    `DROP INDEX CONCURRENTLY IF EXISTS ${s}.webhook_retention_due`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_retention_due ON ${s}.webhook_receipts
        (COALESCE(LEAST(payload_expires_at,receipt_expires_at),'-infinity'::timestamptz),receipt_id)
        WHERE status IN ('consumed','dropped','unmatched','rejected','disabled','expired','target_terminal','dead_lettered','routed','routing_failed')`,
    ];
}
