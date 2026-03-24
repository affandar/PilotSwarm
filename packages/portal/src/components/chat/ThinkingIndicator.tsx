export default function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-2 text-gray-400 text-sm">
      <span className="animate-pulse">●</span>
      <span className="animate-pulse [animation-delay:150ms]">●</span>
      <span className="animate-pulse [animation-delay:300ms]">●</span>
      <span className="ml-2">Thinking…</span>
    </div>
  );
}
