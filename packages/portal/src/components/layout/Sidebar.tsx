import { usePortal } from "../../hooks/PortalContext";

interface SidebarProps {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession?: () => void;
}

export default function Sidebar({ activeSessionId, onSelectSession, onNewSession }: SidebarProps) {
  const { sessions } = usePortal();
  const userSessions = sessions.filter((s) => !s.isSystem);
  const systemSessions = sessions.filter((s) => s.isSystem);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-3 border-b border-gray-700">
        <button
          onClick={onNewSession}
          className="w-full py-2 px-3 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium"
        >
          + New Session
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 text-sm">
        <div className="text-xs text-gray-500 uppercase tracking-wider px-2 py-1">
          Sessions
        </div>
        {userSessions.length === 0 && (
          <div className="px-2 py-1 text-gray-500 italic">No sessions yet</div>
        )}
        {userSessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm ${
              s.id === activeSessionId
                ? "bg-cyan-900/40 text-cyan-300"
                : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={s.status === "running" ? "text-green-400" : "text-gray-500"}>●</span>
              <span className="truncate">{s.title}</span>
            </div>
            <div className="text-xs text-gray-500 ml-5 truncate">{s.id.slice(0, 8)}</div>
          </button>
        ))}

        {systemSessions.length > 0 && (
          <>
            <div className="text-xs text-gray-500 uppercase tracking-wider px-2 py-1 mt-3">
              System
            </div>
            {systemSessions.map((s) => (
              <div key={s.id} className="px-2 py-1 text-xs text-yellow-600">
                ≋ {s.title}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="border-t border-gray-700 p-2 text-xs text-gray-500">
        {sessions.length} session{sessions.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}
