interface LogViewerProps {
  sessionId: string | null;
}

export default function LogViewer({ sessionId }: LogViewerProps) {
  // TODO: Wire to WebSocket for streaming worker logs
  return (
    <div className="p-3 text-xs font-mono space-y-1">
      {!sessionId ? (
        <div className="text-gray-500 italic">No active session</div>
      ) : (
        <div className="text-gray-500 italic">Waiting for logs…</div>
      )}
    </div>
  );
}
