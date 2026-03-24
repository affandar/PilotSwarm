import { useState } from "react";

interface ToolCallAccordionProps {
  name: string;
  args: string;
  result?: string;
  durationMs?: number;
}

export default function ToolCallAccordion({ name, args, result, durationMs }: ToolCallAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const done = result !== undefined;
  const icon = done ? "✓" : "▶";
  const iconColor = done ? "text-green-400" : "text-yellow-400";

  return (
    <div className="mt-2 border border-gray-700 rounded text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-gray-800"
      >
        <span className={iconColor}>{icon}</span>
        <span className="text-gray-300 font-mono">{name}</span>
        {durationMs !== undefined && (
          <span className="text-gray-500 ml-auto">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className="text-gray-600">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-gray-700 bg-[#0d0d1a] font-mono text-gray-400">
          <div className="mb-1">
            <span className="text-gray-500">args: </span>
            {args}
          </div>
          {result && (
            <div>
              <span className="text-gray-500">result: </span>
              <span className="text-gray-300">{result.slice(0, 500)}</span>
              {result.length > 500 && <span className="text-gray-600">…</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
