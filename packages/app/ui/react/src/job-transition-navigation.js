export async function activateJobTransitionSession(controller, transition) {
    const sessionId = typeof transition?.sessionId === "string"
        ? transition.sessionId.trim()
        : "";
    if (!sessionId) return false;

    controller.dispatch({
        type: "ui/rightPaneMode",
        mode: "panes",
        sessionId,
        manual: true,
    });
    await controller.loadSession(sessionId);
    return true;
}
