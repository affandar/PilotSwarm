import React from "react";

export function useControllerState(controller) {
    const [state, setState] = React.useState(controller.getState());

    React.useEffect(() => {
        return controller.subscribe((nextState) => {
            setState(nextState);
        });
    }, [controller]);

    return state;
}

export function useControllerSelector(controller, selector, isEqual = Object.is) {
    const selectorRef = React.useRef(selector);
    const isEqualRef = React.useRef(isEqual);
    selectorRef.current = selector;
    isEqualRef.current = isEqual;

    const [selected, setSelected] = React.useState(() => selector(controller.getState()));
    const selectedRef = React.useRef(selected);

    React.useEffect(() => {
        selectedRef.current = selected;
    }, [selected]);

    React.useEffect(() => controller.subscribe((nextState) => {
        const nextSelected = selectorRef.current(nextState);
        if (isEqualRef.current(selectedRef.current, nextSelected)) {
            return;
        }
        selectedRef.current = nextSelected;
        setSelected(nextSelected);
    }), [controller]);

    return selected;
}
