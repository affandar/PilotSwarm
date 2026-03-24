import { useEffect } from "react";

interface KeyboardHandlers {
  onHelp?: () => void;
}

/**
 * Global keyboard shortcut handler.
 * Registers document-level keydown listeners for portal-wide shortcuts.
 *
 * TODO: Expand with full keybinding set matching TUI parity.
 */
export function useKeyboard({ onHelp }: KeyboardHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;

      if (e.key === "?") {
        e.preventDefault();
        onHelp?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onHelp]);
}
