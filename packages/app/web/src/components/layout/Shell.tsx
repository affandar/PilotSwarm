import { useState, useEffect } from "react";
import Sidebar from "./Sidebar";
import Inspector from "./Inspector";
import StatusBar from "./StatusBar";
import PanelDivider from "./PanelDivider";
import ChatView from "../chat/ChatView";
import InputBar from "../chat/InputBar";
import StartupSplash from "../splash/StartupSplash";
import AgentPicker from "../splash/AgentPicker";
import HelpOverlay from "../overlay/HelpOverlay";
import { useKeyboard } from "../../hooks/useKeyboard";
import { usePortal } from "../../hooks/PortalContext";

export default function Shell() {
  const portal = usePortal();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(360);

  // Auto-switch to newly created sessions
  useEffect(() => {
    return portal.on("sessionCreated", (data: any) => {
      setActiveSessionId(data.sessionId);
      setShowPicker(false);
    });
  }, [portal]);

  useKeyboard({
    onHelp: () => setShowHelp((v) => !v),
  });

  const handleNewSession = () => setShowPicker(true);
  const handlePickAgent = (agentId: string | null) => {
    portal.createSession(agentId);
  };

  return (
    <div className="flex flex-col h-screen bg-[#1a1a2e] text-gray-200">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-[#0d0d1a]">
        <span className="font-bold text-white tracking-wide">● PilotSwarm</span>
        <div className="flex items-center gap-3 text-sm text-gray-400">
          <button onClick={() => setShowHelp(true)} title="Help">?</button>
          <span>⚙️</span>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {activeSessionId ? (
          <>
            {/* Sidebar */}
            <div style={{ width: sidebarWidth, minWidth: 200 }} className="flex-shrink-0 border-r border-gray-700">
              <Sidebar
                activeSessionId={activeSessionId}
                onSelectSession={setActiveSessionId}
                onNewSession={handleNewSession}
              />
            </div>

            <PanelDivider onResize={(delta) => setSidebarWidth((w) => Math.max(200, w + delta))} />

            {/* Center: Chat */}
            <div className="flex flex-col flex-1 min-w-0">
              <ChatView sessionId={activeSessionId} />
              <InputBar sessionId={activeSessionId} />
            </div>

            <PanelDivider onResize={(delta) => setInspectorWidth((w) => Math.max(280, w - delta))} />

            {/* Inspector */}
            <div style={{ width: inspectorWidth, minWidth: 280 }} className="flex-shrink-0 border-l border-gray-700">
              <Inspector sessionId={activeSessionId} />
            </div>
          </>
        ) : (
          /* Full-width splash when no session is active */
          <StartupSplash onNewSession={handleNewSession} />
        )}
      </div>

      {/* Status bar */}
      <StatusBar activeSessionId={activeSessionId} />

      {/* Agent picker */}
      {showPicker && <AgentPicker onSelect={handlePickAgent} onCancel={() => setShowPicker(false)} />}

      {/* Help overlay */}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}
