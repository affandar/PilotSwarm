export default function NodeMap() {
  // TODO: Wire to WebSocket for worker node status
  return (
    <div className="p-3">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Workers</div>
      <div className="text-gray-500 text-sm italic">Waiting for worker data…</div>
    </div>
  );
}
