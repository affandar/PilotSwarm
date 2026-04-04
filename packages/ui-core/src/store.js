export function createStore(reducer, initialState) {
    let state = initialState;
    const listeners = new Set();

    return {
        getState() {
            return state;
        },
        dispatch(action) {
            state = reducer(state, action);
            for (const listener of listeners) listener(state, action);
            return action;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
