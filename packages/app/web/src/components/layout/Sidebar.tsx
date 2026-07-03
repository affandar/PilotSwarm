import { useState, useMemo, useCallback } from "react";
import { usePortal } from "../../hooks/PortalContext";
import type { SessionInfo } from "../../hooks/PortalContext";

interface FlatEntry {
  session: SessionInfo;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  collapsed: boolean;
}

function buildSessionTree(
  sessions: SessionInfo[],
  collapsedIds: Set<string>,
): FlatEntry[] {
  const byId = new Map<string, SessionInfo>();
  for (const s of sessions) byId.set(s.id, s);

  const childrenMap = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const pid = s.parentId;
    if (!pid || !byId.has(pid)) continue;
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid)!.push(s);
  }

  // Count all descendants (not just direct children)
  const descendantCounts = new Map<string, number>();
  function countDescendants(id: string): number {
    if (descendantCounts.has(id)) return descendantCounts.get(id)!;
    const kids = childrenMap.get(id) || [];
    let total = kids.length;
    for (const kid of kids) total += countDescendants(kid.id);
    descendantCounts.set(id, total);
    return total;
  }

  const roots = sessions.filter(
    (s) => !s.parentId || !byId.has(s.parentId),
  );

  const flat: FlatEntry[] = [];
  function visit(session: SessionInfo, depth: number) {
    const kids = childrenMap.get(session.id) || [];
    const totalDesc = countDescendants(session.id);
    const isCollapsed = collapsedIds.has(session.id);
    flat.push({
      session,
      depth,
      hasChildren: kids.length > 0,
      childCount: totalDesc,
      collapsed: isCollapsed,
    });
    if (isCollapsed) return;
    for (const child of kids) visit(child, depth + 1);
  }

  for (const root of roots) visit(root, 0);
  return flat;
}

interface SidebarProps {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession?: () => void;
}

export default function Sidebar({ activeSessionId, onSelectSession, onNewSession }: SidebarProps) {
  const { sessions } = usePortal();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const userSessions = useMemo(() => sessions.filter((s) => !s.isSystem), [sessions]);
  const systemSessions = useMemo(() => sessions.filter((s) => s.isSystem), [sessions]);

  const flatTree = useMemo(
    () => buildSessionTree(userSessions, collapsedIds),
    [userSessions, collapsedIds],
  );

  const toggleCollapse = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

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
        {flatTree.length === 0 && (
          <div className="px-2 py-1 text-gray-500 italic">No sessions yet</div>
        )}
        {flatTree.map(({ session: s, depth, hasChildren, childCount, collapsed }) => (
          <button
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className={`w-full text-left rounded text-sm ${
              s.id === activeSessionId
                ? "bg-cyan-900/40 text-cyan-300"
                : "text-gray-300 hover:bg-gray-800"
            }`}
            style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}
          >
            <div className="flex items-center gap-1.5">
              {depth > 0 && (
                <span className="text-gray-600 text-xs mr-0.5">└</span>
              )}
              {hasChildren ? (
                <span
                  role="button"
                  onClick={(e) => toggleCollapse(s.id, e)}
                  className="text-gray-400 hover:text-cyan-400 text-xs w-4 flex-shrink-0 cursor-pointer select-none"
                  title={collapsed ? "Expand children" : "Collapse children"}
                >
                  {collapsed ? "▶" : "▼"}
                </span>
              ) : (
                <span className="w-4 flex-shrink-0" />
              )}
              <span className={`flex-shrink-0 ${s.status === "running" ? "text-green-400" : "text-gray-500"}`}>●</span>
              <span className="truncate">{s.title}</span>
              {collapsed && childCount > 0 && (
                <span className="text-cyan-500 text-xs ml-1 flex-shrink-0">[+{childCount}]</span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate" style={{ marginLeft: depth > 0 ? 34 : 24 }}>
              {s.id.slice(0, 8)}
            </div>
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
