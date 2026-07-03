interface ActivityPaneProps {
  sessionId: string | null;
}

export default function ActivityPane({ sessionId }: ActivityPaneProps) {
  // TODO: Wire to useSession() hook for tool call events
  return (
    <div className="p-3 text-xs font-mono space-y-1">
      {!sessionId ? (
        <div className="text-gray-500 italic">No active session</div>
      ) : (
        <div className="text-gray-500 italic">Waiting for tool calls…</div>
      )}
    </div>
  );
}
