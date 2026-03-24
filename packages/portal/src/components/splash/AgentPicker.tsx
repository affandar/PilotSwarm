interface AgentPickerProps {
  onSelect: (agentId: string | null) => void;
  onCancel: () => void;
}

const AGENTS = [
  { id: null, name: "Generic", description: "Open-ended work, any topic", accent: "#888" },
  { id: "investigator", name: "Investigator", description: "Incident response + root cause analysis", accent: "#ff4444" },
  { id: "deployer", name: "Deployer", description: "Deployment automation + rollback management", accent: "#0088ff" },
  { id: "reporter", name: "Reporter", description: "Status reports + summaries", accent: "#00ff88" },
];

export default function AgentPicker({ onSelect, onCancel }: AgentPickerProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#16213e] border border-gray-700 rounded-xl p-6 max-w-2xl w-full mx-4">
        <h2 className="text-lg font-semibold text-white mb-4 text-center">
          Choose an Agent
        </h2>

        <div className="grid grid-cols-2 gap-4 mb-6">
          {AGENTS.map((agent) => (
            <button
              key={agent.id ?? "generic"}
              onClick={() => onSelect(agent.id)}
              className="text-left p-4 rounded-lg border border-gray-700 hover:border-opacity-100 hover:-translate-y-0.5 transition-all"
              style={{ borderColor: `${agent.accent}44`, ["--hover-border" as string]: agent.accent }}
            >
              <div className="font-medium text-white mb-1">{agent.name}</div>
              <div className="text-xs text-gray-400">{agent.description}</div>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
