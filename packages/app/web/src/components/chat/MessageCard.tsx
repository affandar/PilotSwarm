import ToolCallAccordion from "./ToolCallAccordion";

interface MessageCardProps {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: { name: string; args: string; result?: string; durationMs?: number }[];
}

export default function MessageCard({ role, content, timestamp, toolCalls }: MessageCardProps) {
  const isUser = role === "user";

  return (
    <div className={`rounded-lg p-4 ${isUser ? "bg-[#1e2a3a] border border-gray-700" : "bg-[#162030]"}`}>
      <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
        <span className={`font-semibold ${isUser ? "text-white" : "text-cyan-400"}`}>
          {isUser ? "You" : "Copilot"}
        </span>
        <span>{timestamp}</span>
      </div>

      {/* TODO: Render content as Markdown for assistant messages */}
      <div className="text-sm text-gray-200 whitespace-pre-wrap">{content}</div>

      {toolCalls?.map((tc, i) => (
        <ToolCallAccordion key={i} {...tc} />
      ))}
    </div>
  );
}
