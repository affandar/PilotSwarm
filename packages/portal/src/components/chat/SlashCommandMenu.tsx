const COMMANDS = [
  { command: "/models", description: "List available models" },
  { command: "/model", description: "Switch model" },
  { command: "/info", description: "Session info" },
  { command: "/done", description: "Close session" },
  { command: "/new", description: "New session" },
  { command: "/help", description: "Show all commands" },
];

interface SlashCommandMenuProps {
  onSelect: (command: string) => void;
  onDismiss: () => void;
}

export default function SlashCommandMenu({ onSelect, onDismiss }: SlashCommandMenuProps) {
  return (
    <div className="absolute bottom-full left-3 right-3 mb-1 bg-[#16213e] border border-gray-700 rounded-lg shadow-lg overflow-hidden">
      {COMMANDS.map((c) => (
        <button
          key={c.command}
          onClick={() => onSelect(c.command)}
          className="flex items-center justify-between w-full px-4 py-2 text-sm hover:bg-[#1e2a3a] text-left"
        >
          <span className="text-cyan-400 font-mono">{c.command}</span>
          <span className="text-gray-500 text-xs">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
