import { useState, useCallback } from "react";
import SlashCommandMenu from "./SlashCommandMenu";
import { usePortal } from "../../hooks/PortalContext";

interface InputBarProps {
  sessionId: string;
}

export default function InputBar({ sessionId }: InputBarProps) {
  const { sendMessage } = usePortal();
  const [value, setValue] = useState("");
  const [showSlash, setShowSlash] = useState(false);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    sendMessage(sessionId, text);
    setValue("");
    setShowSlash(false);
  }, [value, sessionId, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.altKey) {
        e.preventDefault();
        handleSend();
      }
      if (value === "" && e.key === "/") {
        setShowSlash(true);
      }
    },
    [handleSend, value],
  );

  return (
    <div className="relative border-t border-gray-700 bg-[#0d0d1a]">
      {showSlash && (
        <SlashCommandMenu
          onSelect={(cmd) => {
            setValue(cmd);
            setShowSlash(false);
          }}
          onDismiss={() => setShowSlash(false)}
        />
      )}
      <div className="flex items-end p-3 gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message PilotSwarm…"
          rows={1}
          className="flex-1 bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-cyan-500"
        />
        <button
          onClick={handleSend}
          className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm text-white"
        >
          ⏎
        </button>
      </div>
    </div>
  );
}
