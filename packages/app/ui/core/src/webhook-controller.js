import { createWebhookEditor } from "./webhook-forms.js";
import {
    WEBHOOK_TABS, projectWebhookMetrics, projectWebhookResource, projectWebhookSignalState, projectWebhookTest,
    selectWebhookConsole, webhookCanManage, webhookIsOpen, webhookResourceId, webhookViewer,
} from "./webhook-state.js";
import { validateWebhookReceiptQuery, webhookFormInput, webhookText } from "./webhook-validation.js";

const operations = {
    connectors: { list: "listWebhookConnectors", create: "createWebhookConnector", update: "updateWebhookConnector", revoke: "revokeWebhookConnector" },
    bindings: { list: "listWebhookBindings", create: "createWebhookBinding", update: "updateWebhookBinding", revoke: "revokeWebhookBinding" },
    templates: { list: "listWebhookSessionTemplates", create: "createWebhookSessionTemplate", update: "updateWebhookSessionTemplate", revoke: "revokeWebhookSessionTemplate" },
    endpoints: { list: "listSignalEndpoints", create: "createSignalEndpoint", revoke: "revokeSignalEndpoint" },
};
const transient = new WeakMap();
const REQUEST_TIMEOUT_MS = 15_000;

export function initializeWebhookController(controller) {
    const entry = transient.get(controller) || { sequence: 0, capability: null, unsubscribe: null };
    if (entry.unsubscribe) return;
    entry.capability = null;
    transient.set(controller, entry);
    entry.unsubscribe = controller.subscribe(state => {
        if (entry.capability && (!webhookIsOpen(state) || state.admin.webhooks.capabilityId !== entry.capability.id)) entry.capability = null;
    });
}
export function disposeWebhookController(controller) {
    const entry = transient.get(controller);
    if (entry) { entry.capability = null; entry.unsubscribe?.(); entry.unsubscribe = null; }
    controller.dispatch({ type: "admin/webhooks/dispose" });
}
function sequence(controller) {
    const entry = transient.get(controller);
    return ++entry.sequence;
}
function errorMessage(error) {
    const code = error?.code ? `${webhookText(error.code)}: ` : "";
    const message = webhookText(error?.message || "Webhook operation failed.")
        .replace(/(?:https?:\/\/[^\s"'<>]+)?\/hooks\/s\/[^\s"'<>]+/gu, "[redacted endpoint capability]");
    return `${code}${message}`.slice(0, 1000);
}
function conflict(error) {
    return Number(error?.status) === 409 || /REVISION|STALE|CONFLICT/iu.test(String(error?.code || ""));
}
function stillCurrent(controller, generation) {
    return webhookIsOpen(controller.getState()) && controller.getState().admin.webhooks.generation === generation;
}

/** Shared, host-neutral controller commands. Transport methods are canonical in
 * both web/direct modes; no unsafe fallback or automatic mutation retry exists. */
export const webhookControllerMethods = {
    _patchWebhooks(patch, generation) {
        this.dispatch({ type: "admin/webhooks/patch", patch, ...(generation !== undefined ? { generation } : {}) });
    },
    async _webhookRequest(name, ...args) {
        // A host may stop and later reuse its controller. Reinstall the
        // private-memory erasure guard without resetting request serials.
        initializeWebhookController(this);
        if (typeof this.transport[name] !== "function") throw new Error(`${name} is not available on this transport. Refresh after the host is upgraded.`);
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(() => this.transport[name](...args)),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Request timed out. Its outcome may be unknown. Refresh before trying another action; no automatic retry was made.")), REQUEST_TIMEOUT_MS);
                    timer?.unref?.();
                }),
            ]);
        } finally { clearTimeout(timer); }
    },
    async setWebhookTab(tab) {
        if (!WEBHOOK_TABS.some(entry => entry.id === tab) || !webhookIsOpen(this.getState())) return;
        this.dispatch({ type: "admin/webhooks/navigate", tab });
        if (tab === "endpoints" && !this.getState().admin.webhooks.sessionId) {
            const active = this.getState().sessions.byId[this.getState().sessions.activeSessionId];
            if (active && !active.isGroup && !active.isSystem && !active.isService) {
                this.dispatch({ type: "admin/webhooks/navigate", sessionId: active.sessionId });
            }
        }
        await this.refreshAdminWebhooks();
    },
    async setWebhookSession(sessionId) {
        if (!webhookIsOpen(this.getState()) || !String(sessionId || "").trim()) return;
        const id = String(sessionId).trim();
        const session = this.getState().sessions.byId[id];
        if (id.startsWith("group:") || session?.isGroup || session?.isSystem || session?.isService) {
            this._patchWebhooks({ error: "Select an ordinary session. Groups, system and service sessions are not webhook targets." });
            return;
        }
        this.dispatch({ type: "admin/webhooks/navigate", tab: "endpoints", sessionId: id });
        await this.refreshAdminWebhooks();
    },
    async refreshAdminWebhooks() {
        const state = this.getState();
        if (!webhookIsOpen(state)) return;
        // HttpApiTransport exposes the already-loaded getBootstrap DTO. Read
        // only its public metadata, never reach into the API client or infer
        // an origin from env, private transport options or browser location.
        const bootstrap = this.transport.bootstrap?.webhooks;
        const publicOrigin = typeof bootstrap?.publicOrigin === "string" && bootstrap.publicOrigin
            ? bootstrap.publicOrigin : null;
        this._patchWebhooks({
            ingressEnabled: typeof bootstrap?.enabled === "boolean" ? bootstrap.enabled : null,
            publicOrigin,
            ...(publicOrigin !== state.admin.webhooks.publicOrigin ? { copyStatus: null } : {}),
        });
        const tab = state.admin.webhooks.tab;
        if (tab === "health") return this._loadWebhookHealth();
        if (tab === "receipts") return this._loadWebhookReceipts();
        if (tab === "endpoints") {
            if (!state.admin.webhooks.sessionId) return;
            await Promise.all([this._loadWebhookList(tab), this._loadWebhookSignalState()]);
            return;
        }
        return this._loadWebhookList(tab);
    },
    async _loadWebhookList(kind) {
        if (!operations[kind] || !webhookIsOpen(this.getState())) return;
        const { generation, sessionId } = this.getState().admin.webhooks;
        const requestId = sequence(this);
        const previous = this.getState().admin.webhooks[kind];
        this._patchWebhooks({ [kind]: { ...previous, loading: true, error: null, requestId } }, generation);
        try {
            const data = await this._webhookRequest(operations[kind].list, ...(kind === "endpoints" ? [sessionId] : []));
            if (!Array.isArray(data)) throw new Error("The server returned an invalid resource list.");
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks[kind].requestId !== requestId) return;
            const rows = data.map(row => projectWebhookResource(kind, row));
            const currentId = this.getState().admin.webhooks[kind].selectedId;
            const selectedId = rows.some(row => webhookResourceId(kind, row) === currentId)
                ? currentId : webhookResourceId(kind, rows[0]) || null;
            this._patchWebhooks({ [kind]: { rows, selectedId, loading: false, loaded: true, error: null, requestId },
                ...(selectedId !== currentId ? { copyStatus: null } : {}) }, generation);
        } catch (error) {
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks[kind].requestId !== requestId) return;
            // Never retain readable/editable rows after a denied or failed read.
            this._patchWebhooks({ [kind]: { rows: [], selectedId: null, loading: false, loaded: false, requestId, error: errorMessage(error) } }, generation);
        }
    },
    async _loadWebhookHealth() {
        const { generation } = this.getState().admin.webhooks;
        const requestId = sequence(this);
        this._patchWebhooks({ health: { data: null, loading: true, loaded: false, error: null, requestId } }, generation);
        try {
            const data = projectWebhookMetrics(await this._webhookRequest("getWebhookMetrics"));
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.health.requestId !== requestId) return;
            this._patchWebhooks({ health: { data, loading: false, loaded: true, error: null, requestId } }, generation);
        } catch (error) {
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.health.requestId !== requestId) return;
            this._patchWebhooks({ health: { data: null, loading: false, loaded: false, error: errorMessage(error), requestId } }, generation);
        }
    },
    async _loadWebhookSignalState() {
        const { generation, sessionId } = this.getState().admin.webhooks;
        if (!sessionId) return;
        const requestId = sequence(this);
        this._patchWebhooks({ signalState: { data: null, loading: true, loaded: false, error: null, requestId } }, generation);
        try {
            const data = projectWebhookSignalState(await this._webhookRequest("getSessionSignalState", sessionId));
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.signalState.requestId !== requestId) return;
            this._patchWebhooks({ signalState: { data, loading: false, loaded: true, error: null, requestId } }, generation);
        } catch (error) {
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.signalState.requestId !== requestId) return;
            this._patchWebhooks({ signalState: { data: null, loading: false, loaded: false, error: errorMessage(error), requestId } }, generation);
        }
    },
    async _loadWebhookReceipts(query = null, cursors = null) {
        const webhooks = this.getState().admin.webhooks;
        const { generation } = webhooks;
        const requestId = sequence(this);
        const requested = query || webhooks.receipts.query;
        const nextQuery = validateWebhookReceiptQuery({ ...requested, limit: requested.limit ?? 25 });
        const nextCursors = cursors || webhooks.receipts.cursors;
        const previousId = webhooks.receipts.selectedId;
        this._patchWebhooks({ receipts: { ...webhooks.receipts, query: nextQuery, cursors: nextCursors,
            rows: [], selectedId: null, loading: true, loaded: false, error: null, hasMore: false,
            detail: null, detailError: null, detailLoading: false, requestId } }, generation);
        try {
            const data = await this._webhookRequest("listWebhookReceipts", nextQuery);
            if (!Array.isArray(data)) throw new Error("The server returned an invalid receipt list.");
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.receipts.requestId !== requestId) return;
            const rows = data.map(row => projectWebhookResource("receipts", row));
            const selectedId = rows.some(row => row.receiptId === previousId) ? previousId : rows[0]?.receiptId || null;
            this._patchWebhooks({ receipts: { ...this.getState().admin.webhooks.receipts, rows, selectedId,
                loading: false, loaded: true, error: null, hasMore: rows.length === (nextQuery.limit || 25) } }, generation);
            if (selectedId) await this.loadWebhookReceipt(selectedId);
        } catch (error) {
            if (!stillCurrent(this, generation) || this.getState().admin.webhooks.receipts.requestId !== requestId) return;
            this._patchWebhooks({ receipts: { ...this.getState().admin.webhooks.receipts,
                rows: [], selectedId: null, detail: null, hasMore: false, loading: false, loaded: false, error: errorMessage(error) } }, generation);
        }
    },
    async loadWebhookReceipt(receiptId) {
        const { generation, receipts } = this.getState().admin.webhooks;
        if (receipts.selectedId !== receiptId) return;
        const detailRequestId = sequence(this);
        this._patchWebhooks({ receipts: { ...receipts, detail: null, detailError: null, detailLoading: true, detailRequestId } }, generation);
        try {
            const detail = projectWebhookResource("receipts", await this._webhookRequest("getWebhookReceipt", receiptId));
            if (detail.receiptId !== receiptId) throw new Error("Receipt response did not match the requested identity.");
            const current = this.getState().admin.webhooks.receipts;
            if (!stillCurrent(this, generation) || current.detailRequestId !== detailRequestId || current.selectedId !== receiptId) return;
            this._patchWebhooks({ receipts: { ...current, detail, detailLoading: false,
                rows: current.rows.map(row => row.receiptId === receiptId ? detail : row) } }, generation);
        } catch (error) {
            const current = this.getState().admin.webhooks.receipts;
            if (!stillCurrent(this, generation) || current.detailRequestId !== detailRequestId || current.selectedId !== receiptId) return;
            this._patchWebhooks({ receipts: { ...current, detail: null, detailLoading: false, detailError: errorMessage(error) } }, generation);
        }
    },
    async selectWebhookResource(id) {
        const value = this.getState().admin.webhooks;
        if (value.pending || value.editor) return;
        const bucket = value[value.tab];
        if (!bucket?.rows?.some(row => webhookResourceId(value.tab, row) === id)) return;
        this._patchWebhooks({ [value.tab]: { ...bucket, selectedId: id }, detailOffset: 0, capabilityId: null, testResult: null, copyStatus: null });
        if (value.tab === "receipts") await this.loadWebhookReceipt(id);
    },
    stepWebhookResource(delta) {
        const view = selectWebhookConsole(this.getState());
        if (!view.rows.length) return;
        const index = Math.max(0, view.rows.findIndex(row => row.selected));
        return this.selectWebhookResource(view.rows[Math.max(0, Math.min(view.rows.length - 1, index + delta))].rowId);
    },
    scrollWebhookDetails(delta) {
        const value = this.getState().admin.webhooks;
        this._patchWebhooks({ detailOffset: Math.max(0, Math.min(value.detailMaxOffset ?? 10_000, value.detailOffset + delta)) });
    },
    setWebhookScrollLimit(limit) {
        const value = this.getState().admin.webhooks;
        const max = Math.max(0, Number(limit) || 0);
        const offset = Math.min(max, value.detailOffset);
        if (value.detailMaxOffset === max && value.detailOffset === offset) return;
        this._patchWebhooks({ detailMaxOffset: max, detailOffset: offset });
    },
    async pageWebhookReceipts(direction) {
        const { receipts, pending } = this.getState().admin.webhooks;
        if (pending || receipts.loading) return;
        const query = { ...receipts.query };
        const cursors = [...receipts.cursors];
        if (direction > 0) {
            const last = receipts.rows.at(-1)?.receiptId;
            if (!receipts.hasMore || !last || last === query.before) return;
            cursors.push(query.before || null);
            query.before = last;
        } else if (direction < 0) {
            if (!cursors.length) return;
            const before = cursors.pop();
            if (before) query.before = before; else delete query.before;
        } else { delete query.before; cursors.length = 0; }
        await this._loadWebhookReceipts(query, cursors);
    },
    openWebhookEditor(kind = this.getState().admin.webhooks.tab, mode = "create") {
        if (kind === "health" && mode === "edit") kind = "retention";
        const state = this.getState();
        if (!webhookIsOpen(state)) return;
        const view = selectWebhookConsole(state);
        if (view.busy) return;
        const permitted = kind === "session" || kind === "receipts" && view.tab === "receipts"
            || kind === "retention" && view.canEditRetention
            || kind === "signal" && view.tab === "endpoints" && view.canRaise
            || kind === "test" && view.canTest
            || kind === view.tab && (mode === "edit" ? view.canEdit : view.canCreate);
        if (!permitted) { this._patchWebhooks({ error: "This action requires the appropriate owner/admin access and a current selection." }); return; }
        const editor = createWebhookEditor(kind, mode, {
            resource: kind === "retention" ? view.health.data.retention.policy : mode === "edit" || kind === "test" ? view.selected : null,
            isAdmin: view.isAdmin, webhooks: state.admin.webhooks,
            session: state.sessions.byId[state.admin.webhooks.sessionId || state.sessions.activeSessionId],
        });
        if (kind === "session") {
            editor.fields[0].suggestions = view.sessionRows;
            editor.fields[0].help = "↑/↓ chooses a visible ordinary session in the TUI, or type an exact authorized session ID.";
        }
        this._patchWebhooks({ editor, error: null, notice: null, testResult: null, capabilityId: null, copyStatus: null });
    },
    setWebhookEditorField(id, value, cursorIndex = null) {
        const { editor, pending } = this.getState().admin.webhooks;
        if (!editor || pending || !editor.fields.some(field => field.id === id)) return;
        const text = String(value ?? "");
        this._patchWebhooks({ editor: { ...editor, values: { ...editor.values, [id]: text },
            cursorIndex: Math.max(0, Math.min(text.length, cursorIndex ?? text.length)), error: editor.stale ? editor.error : null } });
    },
    stepWebhookEditorField(delta) {
        const { editor, pending } = this.getState().admin.webhooks;
        if (!editor || pending) return;
        const fieldIndex = (editor.fieldIndex + delta + editor.fields.length) % editor.fields.length;
        this._patchWebhooks({ editor: { ...editor, fieldIndex, cursorIndex: editor.values[editor.fields[fieldIndex].id].length } });
    },
    editWebhookFieldInput(action, input = "") {
        const { editor, pending } = this.getState().admin.webhooks;
        if (!editor || pending) return;
        const field = editor.fields[editor.fieldIndex];
        const value = editor.values[field.id];
        const cursor = editor.cursorIndex;
        if (action === "nextChoice" || action === "prevChoice") {
            const options = field.options || field.suggestions?.map(row => row.id);
            if (!options?.length) return;
            const index = Math.max(0, options.indexOf(value));
            this.setWebhookEditorField(field.id, options[(index + (action === "nextChoice" ? 1 : -1) + options.length) % options.length]);
        } else if (action === "insert") {
            if (field.type === "choice") return;
            this.setWebhookEditorField(field.id, value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
        } else if (action === "delete") {
            if (field.type === "choice" || cursor === 0) return;
            this.setWebhookEditorField(field.id, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        } else {
            const next = action === "left" ? cursor - 1 : action === "right" ? cursor + 1 : action === "home" ? 0 : value.length;
            this.setWebhookEditorField(field.id, value, next);
        }
    },
    closeWebhookDialog() {
        this.dispatch({ type: "admin/webhooks/closeDialog" });
    },
    async submitWebhookEditor() {
        const state = this.getState();
        const { editor, pending, generation } = state.admin.webhooks;
        if (!editor || pending || !webhookIsOpen(state)) return;
        try {
            if (editor.stale) throw new Error("This edit has a stale revision. Close it and reopen the refreshed resource; no changes were retried.");
            const { isAdmin } = webhookViewer(state);
            const input = webhookFormInput(editor, { isAdmin });
            if (editor.kind === "session") { await this.setWebhookSession(input.sessionId); return; }
            if (editor.kind === "receipts") {
                this._patchWebhooks({ editor: null });
                await this._loadWebhookReceipts(input, []); return;
            }
            if (editor.kind === "retention") {
                const health = state.admin.webhooks.health;
                if (!isAdmin || health.loading || health.error || health.data?.retention?.policy?.revision !== editor.expectedRevision) {
                    throw new Error("Retention policy or authorization changed. Close and reopen the refreshed policy.");
                }
            } else if (editor.mode === "edit" || editor.kind === "test") {
                const kind = editor.kind === "test" ? "bindings" : editor.kind;
                const bucket = state.admin.webhooks[kind];
                const row = bucket.rows.find(row => row.id === editor.resourceId);
                if (bucket.loading || bucket.error || !row || row.state === "revoked" || !webhookCanManage(state, row)) throw new Error("Current owner/admin access and readable metadata are required. Refresh this resource.");
                if (editor.mode === "edit" && row.revision !== editor.expectedRevision) {
                    this._patchWebhooks({ editor: { ...editor, stale: true } });
                    throw new Error("The resource changed since this edit began. Close and reopen it to use the refreshed revision.");
                }
            }
            if ((editor.kind === "endpoints" || editor.kind === "signal") && editor.sessionId !== state.admin.webhooks.sessionId) throw new Error("The target session changed. Reopen the form.");
            const name = editor.kind === "retention" ? "updateWebhookRetentionPolicy" : editor.kind === "test" ? "testWebhookBinding"
                : editor.kind === "signal" ? "raiseSignal" : operations[editor.kind]?.[editor.mode === "edit" ? "update" : "create"];
            const args = editor.kind === "retention" ? [input] : editor.kind === "test" ? [editor.resourceId, input]
                : editor.kind === "signal" ? [editor.sessionId, input.name, Object.fromEntries(Object.entries(input).filter(([key]) => key !== "name"))]
                    : editor.kind === "endpoints" ? [editor.sessionId, input.signalName, Object.fromEntries(Object.entries(input).filter(([key]) => key !== "signalName"))]
                        : editor.mode === "edit" ? [editor.resourceId, input] : [input];
            this._patchWebhooks({ pending: name, error: null, notice: null, editor: { ...editor, error: null } }, generation);
            try {
                const result = await this._webhookRequest(name, ...args);
                if (!stillCurrent(this, generation)) return;
                if (editor.kind === "endpoints") {
                    const metadata = projectWebhookResource("endpoints", result);
                    if (!metadata.endpointId || metadata.sessionId !== editor.sessionId || metadata.signalName !== input.signalName
                        || typeof result?.token !== "string" || !result.token || typeof result?.url !== "string" || !result.url) {
                        throw new Error("The endpoint may have been created, but the one-time capability response was incomplete. Refresh and revoke it if necessary; no automatic retry was made.");
                    }
                    const id = `capability:${sequence(this)}`;
                    transient.get(this).capability = { id, token: result.token, url: result.url };
                    const bucket = this.getState().admin.webhooks.endpoints;
                    this._patchWebhooks({ pending: null, editor: null, capabilityId: id, copyStatus: null,
                        endpoints: { ...bucket, rows: [metadata, ...bucket.rows.filter(row => row.endpointId !== metadata.endpointId)], selectedId: metadata.endpointId, loaded: true },
                        notice: "Endpoint minted. The capability is shown once; no delivery was sent." }, generation);
                } else if (editor.kind === "test") {
                    this._patchWebhooks({ pending: null, editor: null, testResult: projectWebhookTest(result), notice: "Dry run completed; no action was executed." }, generation);
                } else {
                    if (editor.kind === "signal" && result?.status !== "queued") throw new Error("The server did not confirm that the signal was queued. Refresh signal state; no automatic retry was made.");
                    this._patchWebhooks({ pending: null, editor: null,
                        notice: editor.kind === "signal" ? "Signal queued durably; consumption is not yet confirmed."
                            : editor.kind === "retention" ? "Retention policy saved for future terminal dispositions. Existing deadlines and active work are unchanged."
                                : "Webhook policy saved. Configured does not mean verified delivery." }, generation);
                    await this.refreshAdminWebhooks();
                }
                return { ok: true }; // Never return a capability into generic handlers/loggers.
            } catch (error) {
                if (!stillCurrent(this, generation)) return;
                const stale = editor.mode === "edit" && conflict(error);
                const message = errorMessage(error) + (stale ? " The resource will be refreshed. Close and reopen this edit; it was not retried." : "");
                this._patchWebhooks({ pending: null, error: message, editor: { ...editor, error: message, stale } }, generation);
                if (stale) {
                    if (editor.kind === "retention") await this._loadWebhookHealth();
                    else await this._loadWebhookList(editor.kind);
                }
                return { ok: false, error: message };
            }
        } catch (error) {
            const current = this.getState().admin.webhooks.editor;
            const message = errorMessage(error);
            this._patchWebhooks({ error: message, ...(current ? { editor: { ...current, error: message } } : {}) }, generation);
            return { ok: false, error: message };
        }
    },
    requestWebhookRevoke() {
        const view = selectWebhookConsole(this.getState());
        if (!view.canRevoke) return;
        this.dispatch({ type: "ui/modal", modal: {
            type: "confirm", action: "webhookRevoke", title: "Revoke webhook resource", confirmLabel: "Revoke",
            message: `Revoke ${webhookText(view.selected.label || view.selectedId)} (${webhookText(view.selectedId)})? This invalidates its future webhook use. It does not terminate or delete any session. Revocation is not an editable state.`,
            extras: { kind: view.tab, id: view.selectedId, generation: this.getState().admin.webhooks.generation },
        } });
    },
    requestWebhookReplay() {
        const view = selectWebhookConsole(this.getState());
        if (!view.canReplay) return;
        this.dispatch({ type: "ui/modal", modal: {
            type: "confirm", action: "webhookReplay", title: "Replay webhook receipt", confirmLabel: "Replay once",
            message: `Replay receipt ${webhookText(view.selectedId)}? This explicitly requests another delivery attempt and may create a session, queue a prompt or raise a signal. Current policy, replay limits and authorization still apply. It is not a promise of consumption.`,
            extras: { id: view.selectedId, generation: this.getState().admin.webhooks.generation },
        } });
    },
    async confirmWebhookAction(modal) {
        const state = this.getState();
        // Only the existing confirmation flow can enter this path. There is
        // no "try unconfirmed then fallback" or arbitrary replay command.
        if (state.ui.modal !== modal || modal?.type !== "confirm" || !webhookIsOpen(state)
            || state.admin.webhooks.pending || modal.extras?.generation !== state.admin.webhooks.generation) return;
        const { generation, id, kind } = modal.extras;
        const view = selectWebhookConsole(state);
        if (modal.action === "webhookReplay" && view.selectedId === id && !view.canReplay) {
            this.dispatch({ type: "ui/modal", modal: null });
            this._patchWebhooks({ error: view.replayUnavailable || "Replay is no longer available. Refresh the receipt." }, generation);
            return;
        }
        if (view.selectedId !== id || (modal.action === "webhookReplay" ? !view.canReplay : !view.canRevoke || view.tab !== kind)) return;
        this.dispatch({ type: "ui/modal", modal: null });
        const name = modal.action === "webhookReplay" ? "replayWebhookReceipt" : operations[kind]?.revoke;
        this._patchWebhooks({ pending: name, error: null, notice: null }, generation);
        try {
            await this._webhookRequest(name, id, ...(modal.action === "webhookReplay" ? [{ confirmed: true }] : []));
            if (!stillCurrent(this, generation)) return;
            this._patchWebhooks({ pending: null, notice: modal.action === "webhookReplay"
                ? "Replay requested once. Inspect receipt status; acceptance is not consumption."
                : "Resource revoked. No session was terminated or deleted." }, generation);
            await this.refreshAdminWebhooks();
        } catch (error) {
            if (!stillCurrent(this, generation)) return;
            this._patchWebhooks({ pending: null, error: errorMessage(error) }, generation);
        }
    },
    async showWebhookResourceReceipts() {
        const view = selectWebhookConsole(this.getState());
        const query = { limit: 25 };
        if (view.tab === "connectors" && view.selectedId) query.connectorId = view.selectedId;
        else if (view.tab === "endpoints" && view.selectedId) query.endpointId = view.selectedId;
        else if (view.tab === "endpoints" && view.sessionId) query.sessionId = view.sessionId;
        else return;
        this.dispatch({ type: "admin/webhooks/navigate", tab: "receipts" });
        await this._loadWebhookReceipts(query, []);
    },
    openWebhookReceiptSession() {
        const view = selectWebhookConsole(this.getState());
        if (view.tab !== "receipts" || !view.selected?.sessionId || view.receipts.detailError || view.loading) return;
        const id = view.selected.sessionId;
        this.openWorkspace();
        this.setNavigationIntent(id); // Existing scoped navigation; never open a URL.
    },
    getWebhookCapability() {
        const state = this.getState();
        const capability = transient.get(this)?.capability;
        if (!capability || !webhookIsOpen(state) || state.admin.webhooks.capabilityId !== capability.id) return null;
        return { token: capability.token, url: capability.url };
    },
    async copyWebhookCapability(copy) {
        const state = this.getState();
        const capability = this.getWebhookCapability();
        if (!capability) return;
        const id = state.admin.webhooks.capabilityId;
        return this._copyWebhookUrl(copy, capability.url, {
            isCurrent: () => this.getState().admin.webhooks.capabilityId === id,
            success: "Capability URL copied. Treat the clipboard as sensitive.",
            failure: "Copy failed. Copy the one-time text manually before closing.",
        });
    },
    async copyWebhookConnectorUrl(copy) {
        const state = this.getState();
        const view = selectWebhookConsole(state);
        if (!view.visible || !view.canCopyConnector) return;
        const { url, relative } = view.connectorDelivery;
        const generation = state.admin.webhooks.generation;
        return this._copyWebhookUrl(copy, url, {
            isCurrent: () => {
                if (!stillCurrent(this, generation)) return false;
                const current = selectWebhookConsole(this.getState());
                return current.selectedId === view.selectedId && current.connectorDelivery?.url === url;
            },
            success: relative ? "Relative delivery path copied. No public origin was supplied." : "Delivery URL copied. Provider authentication is still required.",
            failure: "Copy failed. Copy the displayed delivery URL/path manually.",
        });
    },
    async _copyWebhookUrl(copy, url, { isCurrent, success, failure }) {
        try {
            const result = await copy(url);
            if (result === false || result?.ok === false) throw new Error("Clipboard unavailable");
            if (isCurrent()) this._patchWebhooks({ copyStatus: success });
        } catch {
            if (isCurrent()) this._patchWebhooks({ copyStatus: failure });
        }
    },
};
