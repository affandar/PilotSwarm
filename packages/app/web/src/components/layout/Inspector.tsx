import { useState } from "react";
import ActivityPane from "../inspector/ActivityPane";
import LogViewer from "../inspector/LogViewer";
import SequenceDiagram from "../inspector/SequenceDiagram";
import NodeMap from "../inspector/NodeMap";
import MarkdownViewer from "../inspector/MarkdownViewer";

type InspectorTab = "activity" | "logs" | "sequence" | "nodes" | "files";

interface InspectorProps {
  sessionId: string | null;
}

const TABS: { key: InspectorTab; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "logs", label: "Logs" },
  { key: "sequence", label: "Sequence" },
  { key: "nodes", label: "Nodes" },
  { key: "files", label: "📄 Files" },
];

export default function Inspector({ sessionId }: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("activity");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 text-xs">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 ${
              tab === t.key
                ? "text-cyan-400 border-b-2 border-cyan-400"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "activity" && <ActivityPane sessionId={sessionId} />}
        {tab === "logs" && <LogViewer sessionId={sessionId} />}
        {tab === "sequence" && <SequenceDiagram sessionId={sessionId} />}
        {tab === "nodes" && <NodeMap />}
        {tab === "files" && <MarkdownViewer sessionId={sessionId} />}
      </div>
    </div>
  );
}
