import { usePortal } from "../../hooks/PortalContext";

interface StatusBarProps {
  activeSessionId: string | null;
}

export default function StatusBar({ activeSessionId }: StatusBarProps) {
  const { connected, sessions } = usePortal();

  return (
    <div className="flex items-center justify-between px-4 py-1 border-t border-gray-700 bg-[#0d0d1a] text-xs text-gray-500">
      <span>
        {activeSessionId
          ? "p prompt · ? help · Esc quit"
          : "n new session · ? help"}
      </span>
      <span className="flex items-center gap-3">
        <span className={connected ? "text-green-500" : "text-red-500"}>
          {connected ? "● Connected" : "○ Disconnected"}
        </span>
        <span>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        <span>v0.1.0</span>
      </span>
    </div>
  );
}
