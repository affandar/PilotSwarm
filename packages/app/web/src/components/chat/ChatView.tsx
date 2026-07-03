import { useRef, useEffect } from "react";
import MessageCard from "./MessageCard";
import ThinkingIndicator from "./ThinkingIndicator";
import { usePortal } from "../../hooks/PortalContext";

interface ChatViewProps {
  sessionId: string;
}

export default function ChatView({ sessionId }: ChatViewProps) {
  const { messages, thinking } = usePortal();
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionMessages = messages.get(sessionId) || [];
  const isThinking = thinking.has(sessionId);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionMessages.length, isThinking]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {sessionMessages.length === 0 && !isThinking && (
        <div className="text-gray-500 text-sm text-center py-8">
          Send a message to get started
        </div>
      )}
      {sessionMessages.map((msg, i) => (
        <MessageCard
          key={i}
          role={msg.role}
          content={msg.content}
          timestamp={new Date(msg.timestamp).toLocaleTimeString("en-GB", { hour12: false })}
          toolCalls={msg.toolCalls}
        />
      ))}
      {isThinking && <ThinkingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
