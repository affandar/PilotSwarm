import { useState, useCallback } from "react";

type InspectorTab = "activity" | "logs" | "sequence" | "nodes" | "files";
const TAB_ORDER: InspectorTab[] = ["activity", "logs", "sequence", "nodes", "files"];

/**
 * Hook for managing inspector panel tab state and cycling.
 */
export function useInspector() {
  const [tab, setTab] = useState<InspectorTab>("activity");

  const cycleTab = useCallback(() => {
    setTab((current) => {
      const idx = TAB_ORDER.indexOf(current);
      return TAB_ORDER[(idx + 1) % TAB_ORDER.length];
    });
  }, []);

  return { tab, setTab, cycleTab };
}
