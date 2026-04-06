export function createStore(reducer, initialState) {
    let state = initialState;
    const listeners = new Set();

    return {
        getState() {
            return state;
        },
        dispatch(action) {
            const nextState = reducer(state, action);
            if (Object.is(nextState, state)) {
                return action;
            }
            state = nextState;
            for (const listener of listeners) listener(state, action);
            return action;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
