import { UI_COMMANDS, WEBHOOK_TABS } from "pilotswarm/ui-core";

/** Terminal keys only. All state/validation/action decisions live in ui-core. */
export function handleWebhookInput(controller, input, key = {}, platform = {}) {
    const state = controller.getState();
    if (!state.admin?.visible || state.admin.section !== "webhooks") return false;
    const value = state.admin.webhooks;
    const run = promise => { Promise.resolve(promise).catch(() => {}); };
    if (state.ui.modal?.type === "confirm") {
        if (key.escape || input === "n" || input === "q") run(controller.handleCommand(UI_COMMANDS.CLOSE_MODAL));
        else if (key.return || input === "y") run(controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM));
        return true;
    }
    if (value.capabilityId) {
        if (key.escape) controller.closeWebhookDialog();
        else if (key.ctrl && (input === "d" || input === "\u0004" || key.name === "d") || key.pageDown) controller.scrollWebhookDetails(10);
        else if (key.ctrl && (input === "u" || input === "\u0015" || key.name === "u") || key.pageUp) controller.scrollWebhookDetails(-10);
        else if (!key.ctrl && !key.meta && input === "c") {
            run(controller.copyWebhookCapability(text => platform.copyText?.(text) ?? false));
        }
        return true;
    }
    if (value.editor) {
        if (key.escape) { controller.closeWebhookDialog(); return true; }
        if (value.pending || value.editor.stale) return true;
        if (key.tab) { controller.stepWebhookEditorField(key.shift ? -1 : 1); return true; }
        if (key.ctrl && (input === "j" || input === "\n" || key.name === "j")) {
            if (value.editor.fields[value.editor.fieldIndex].type === "json") controller.editWebhookFieldInput("insert", "\n");
            return true;
        }
        if (key.return) { run(controller.submitWebhookEditor()); return true; }
        if (key.leftArrow) controller.editWebhookFieldInput("left");
        else if (key.rightArrow) controller.editWebhookFieldInput("right");
        else if (key.home) controller.editWebhookFieldInput("home");
        else if (key.end) controller.editWebhookFieldInput("end");
        else if (key.upArrow) controller.editWebhookFieldInput("prevChoice");
        else if (key.downArrow) controller.editWebhookFieldInput("nextChoice");
        else if (key.backspace || key.delete) controller.editWebhookFieldInput("delete");
        else if (!key.ctrl && !key.meta && input) controller.editWebhookFieldInput("insert", input);
        return true; // q and ordinary session keys are text while editing.
    }
    if (key.escape) { controller.closeAdminConsole(); return true; }
    if (key.ctrl && (input === "d" || input === "\u0004" || key.name === "d") || key.pageDown) {
        controller.scrollWebhookDetails(10); return true;
    }
    if (key.ctrl && (input === "u" || input === "\u0015" || key.name === "u") || key.pageUp) {
        controller.scrollWebhookDetails(-10); return true;
    }
    if (key.ctrl || key.meta) return true;
    // Existing section-navigation/quit shortcuts keep their original owner.
    if (["m", "M", "a", "w", "h", "q"].includes(input)) return false;
    const tab = WEBHOOK_TABS[Number(input) - 1];
    if (/^[1-6]$/u.test(input) && tab) { run(controller.setWebhookTab(tab.id)); return true; }
    if (key.tab || key.leftArrow || key.rightArrow) {
        const index = WEBHOOK_TABS.findIndex(tab => tab.id === value.tab);
        const delta = key.leftArrow || key.tab && key.shift ? -1 : 1;
        run(controller.setWebhookTab(WEBHOOK_TABS[(index + delta + WEBHOOK_TABS.length) % WEBHOOK_TABS.length].id));
    } else if (input === "j" || key.downArrow) run(controller.stepWebhookResource(1));
    else if (input === "k" || key.upArrow) run(controller.stepWebhookResource(-1));
    else if (input === "r") run(controller.refreshAdminWebhooks());
    else if (input === "n") controller.openWebhookEditor();
    else if (input === "e") controller.openWebhookEditor(value.tab, "edit");
    else if (input === "c" && value.tab === "connectors") run(controller.copyWebhookConnectorUrl(text => platform.copyText?.(text) ?? false));
    else if (input === "d") controller.requestWebhookRevoke();
    else if (input === "t" && value.tab === "bindings") controller.openWebhookEditor("test");
    else if (input === "s") controller.openWebhookEditor("session");
    else if (input === "u" && value.tab === "endpoints") controller.openWebhookEditor("signal");
    else if (input === "f" && value.tab === "receipts") controller.openWebhookEditor("receipts");
    else if (input === "p" && value.tab === "receipts") controller.requestWebhookReplay();
    else if (input === "o" && value.tab === "receipts") controller.openWebhookReceiptSession();
    else if (input === "v") run(controller.showWebhookResourceReceipts());
    else if (input === "[" && value.tab === "receipts") run(controller.pageWebhookReceipts(-1));
    else if (input === "]" && value.tab === "receipts") run(controller.pageWebhookReceipts(1));
    return true;
}
