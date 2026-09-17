import React from "react";
import "./compact-view-navigation.css";

// Keep the same history available when a focus view hides the main toolbar.
export function CompactViewNavigation({ navigation }) {
    if (!navigation) return null;
    return <nav className="ps-compact-view-navigation" aria-label="View navigation">
        {["back", "forward"].map(direction => <button key={direction} type="button"
            className="ps-mini-button" aria-label={navigation[`${direction}Label`]}
            title={navigation[`${direction}Label`]}
            disabled={!navigation[direction === "back" ? "canBack" : "canForward"]}
            onClick={navigation[direction]}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={direction === "back" ? "M19 12H5m7-7-7 7 7 7" : "M5 12h14m-7-7 7 7-7 7"} />
            </svg>
        </button>)}
    </nav>;
}
