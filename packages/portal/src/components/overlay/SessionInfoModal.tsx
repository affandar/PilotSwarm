interface SessionInfoModalProps {
  sessionId: string;
  onClose: () => void;
}

export default function SessionInfoModal({ sessionId, onClose }: SessionInfoModalProps) {
  // TODO: Fetch session info from server
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#16213e] border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">Session Info</h2>
        <div className="space-y-2 text-sm">
          <Row label="Session ID" value={sessionId} />
          {/* TODO: model, iteration, affinity, hydration, blob */}
        </div>
        <div className="mt-4 text-right">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-mono text-xs">{value}</span>
    </div>
  );
}
